package gr.argyrismitsos.fleetserver;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.Set;
import java.util.zip.InflaterInputStream;

/**
 * Small, dependency-free text reader for PDFs produced by the Android WebView
 * print pipeline. It intentionally does not try to OCR photographs. When a
 * PDF has no usable text layer, or the extracted fields are not reliable, the
 * result is marked ambiguous and the Worker performs the AI fallback.
 */
public final class LocalInvoiceReader {
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final Charset LATIN = Charset.forName("ISO-8859-1");
    private static final int MAX_BYTES = 15 * 1024 * 1024;
    private static final int MAX_RAW_TEXT = 6000;
    private static final int MAX_PARSE_TEXT = 128000;
    private static final String PDF_NUMBER = "[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?";
    private static final Pattern TEXT_BLOCK = Pattern.compile("(?s)BT(.*?)ET");
    private static final Pattern TEXT_MATRIX = Pattern.compile("(" + PDF_NUMBER + ")\\s+(" + PDF_NUMBER + ")\\s+(" + PDF_NUMBER + ")\\s+(" + PDF_NUMBER + ")\\s+(" + PDF_NUMBER + ")\\s+(" + PDF_NUMBER + ")\\s+Tm\\b");
    private static final Pattern TEXT_TOKEN = Pattern.compile("/(\\w+)\\b|(" + PDF_NUMBER + ")\\s+(" + PDF_NUMBER + ")\\s+Td\\b|(<[0-9A-Fa-f\\s]+>|\\((?:\\\\.|[^\\\\)])*\\))\\s*Tj\\b");

    private LocalInvoiceReader() {}

    public static JSONObject read(File pdf) throws Exception {
        if (pdf == null || !pdf.exists() || pdf.length() <= 0) {
            throw new IOException("Δεν βρέθηκε το τοπικό PDF τιμολογίου.");
        }
        if (pdf.length() > MAX_BYTES) {
            throw new IOException("Το τοπικό PDF τιμολογίου είναι πολύ μεγάλο.");
        }
        byte[] bytes = readBytes(pdf);
        if (bytes.length < 4 || bytes[0] != '%' || bytes[1] != 'P' || bytes[2] != 'D' || bytes[3] != 'F') {
            throw new IOException("Το τοπικό αρχείο δεν είναι έγκυρο PDF.");
        }
        String text = extractPdfText(bytes);
        return extractFields(text);
    }

    public static JSONObject readText(String text) throws Exception {
        return extractFields(normalizeExtractedText(text));
    }

    /** Prefer the live DOM text, but use the PDF text layer to fill gaps. */
    public static JSONObject readBest(File pdf, String pageText) throws Exception {
        JSONObject dom = null;
        JSONObject embedded = null;
        try { if (pageText != null && pageText.trim().length() > 40) dom = readText(pageText); } catch (Exception ignored) {}
        try { embedded = read(pdf); } catch (Exception ignored) {}
        if (dom == null && embedded == null) throw new IOException("Δεν βρέθηκε αναγνώσιμο κείμενο στο τιμολόγιο.");
        JSONObject selected = score(dom) >= score(embedded) ? dom : embedded;
        JSONObject other = selected == dom ? embedded : dom;
        if (selected == null) selected = other;
        if (selected == null) throw new IOException("Δεν βρέθηκε αναγνώσιμο κείμενο στο τιμολόγιο.");
        if (other != null) {
            boolean conflict = false;
            for (String field : new String[] { "plate", "odometerKm", "invoiceDate", "totalAmount" }) {
                String left = comparableField(field, selected.optString(field, ""));
                String right = comparableField(field, other.optString(field, ""));
                if (left.length() > 0 && right.length() > 0 && !left.equals(right)) conflict = true;
            }
            if (conflict) {
                selected.put("localReadStatus", "ambiguous");
                selected.put("ocrConfidence", Math.min(60, score(selected)));
                selected.put("ocrFallbackReason", "Το κείμενο της σελίδας και το PDF διαφωνούν σε βασικά στοιχεία. Απαιτείται επιπλέον έλεγχος.");
            }
            copyIfMissing(selected, other, "supplier", "invoiceNumber", "invoiceDate", "plate", "odometerKm", "totalAmount");
            JSONArray work = selected.optJSONArray("workPerformed");
            JSONArray otherWork = other.optJSONArray("workPerformed");
            if ((work == null || work.length() == 0) && otherWork != null) selected.put("workPerformed", otherWork);
            if ((selected.optJSONArray("lineItems") == null || selected.optJSONArray("lineItems").length() == 0) && other.optJSONArray("lineItems") != null) selected.put("lineItems", other.optJSONArray("lineItems"));
        }
        selected.put("source", "server-local");
        selected.put("ocrSource", "server-local");
        return selected;
    }

    private static int score(JSONObject value) {
        return value == null ? -1 : value.optInt("ocrConfidence", 0);
    }

    private static void copyIfMissing(JSONObject target, JSONObject source, String... fields) throws Exception {
        for (String field : fields) {
            if (target.optString(field, "").trim().length() == 0 && source.optString(field, "").trim().length() > 0) {
                target.put(field, source.optString(field));
            }
        }
    }

    private static byte[] readBytes(File file) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream((int) Math.min(file.length(), MAX_BYTES));
        FileInputStream input = new FileInputStream(file);
        try {
            byte[] buffer = new byte[64 * 1024];
            int read;
            int total = 0;
            while ((read = input.read(buffer)) >= 0) {
                total += read;
                if (total > MAX_BYTES) throw new IOException("Το τοπικό PDF τιμολογίου είναι πολύ μεγάλο.");
                output.write(buffer, 0, read);
            }
        } finally {
            input.close();
        }
        return output.toByteArray();
    }

    private static String extractPdfText(byte[] bytes) {
        String mapped = extractMappedPdfText(bytes);
        if (mapped.length() > 0) return normalizeExtractedText(mapped);
        StringBuilder result = new StringBuilder();
        int cursor = 0;
        while (cursor < bytes.length) {
            int stream = indexOf(bytes, "stream".getBytes(LATIN), cursor);
            if (stream < 0) break;
            int dictionaryStart = lastIndexOf(bytes, "<<".getBytes(LATIN), stream);
            int dictionaryEnd = lastIndexOf(bytes, ">>".getBytes(LATIN), stream);
            if (dictionaryStart < 0 || dictionaryEnd < dictionaryStart) {
                cursor = stream + 6;
                continue;
            }
            int dataStart = stream + 6;
            if (dataStart < bytes.length && bytes[dataStart] == '\r') dataStart++;
            if (dataStart < bytes.length && bytes[dataStart] == '\n') dataStart++;
            int dataEnd = indexOf(bytes, "endstream".getBytes(LATIN), dataStart);
            if (dataEnd < 0) break;
            while (dataEnd > dataStart && (bytes[dataEnd - 1] == '\r' || bytes[dataEnd - 1] == '\n')) dataEnd--;
            byte[] streamBytes = slice(bytes, dataStart, dataEnd);
            String dictionary = new String(slice(bytes, dictionaryStart, dictionaryEnd + 2), LATIN);
            if (dictionary.contains("/FlateDecode")) streamBytes = inflate(streamBytes);
            if (streamBytes.length > 0) appendPdfStrings(result, streamBytes);
            cursor = dataEnd + 9;
        }
        return normalizeExtractedText(result.toString());
    }

    /** Decodes Chromium's Type3 font text through each font's ToUnicode CMap. */
    private static String extractMappedPdfText(byte[] bytes) {
        try {
            String source = new String(bytes, LATIN);
            Map<Integer, Integer> offsets = new HashMap<Integer, Integer>();
            Matcher objects = Pattern.compile("(?m)^(\\d+)\\s+0\\s+obj\\b").matcher(source);
            while (objects.find()) offsets.put(Integer.parseInt(objects.group(1)), objects.start());
            Map<Integer, byte[]> streams = new HashMap<Integer, byte[]>();
            Map<String, Map<Integer, String>> fonts = readFontMaps(source, bytes, offsets, streams);
            if (fonts.isEmpty()) return "";
            Matcher contents = Pattern.compile("/Contents\\s+(\\d+\\s+0\\s+R|\\[[^\\]]*\\])").matcher(source);
            StringBuilder output = new StringBuilder();
            boolean parsed = false;
            while (contents.find()) {
                Matcher references = Pattern.compile("(\\d+)\\s+0\\s+R").matcher(contents.group(1));
                while (references.find()) {
                    byte[] stream = streamForObject(source, bytes, Integer.parseInt(references.group(1)), offsets, streams);
                    if (stream.length == 0) continue;
                    appendMappedContent(output, stream, fonts);
                    parsed = true;
                }
            }
            return parsed ? output.toString() : "";
        } catch (Exception ignored) {
            return "";
        }
    }

    private static Map<String, Map<Integer, String>> readFontMaps(String source, byte[] bytes, Map<Integer, Integer> offsets, Map<Integer, byte[]> streams) {
        Map<String, Map<Integer, String>> result = new HashMap<String, Map<Integer, String>>();
        Map<Integer, Map<Integer, String>> decoded = new HashMap<Integer, Map<Integer, String>>();
        Matcher resources = Pattern.compile("/([A-Za-z][A-Za-z0-9]*)\\s+(\\d+)\\s+0\\s+R").matcher(source);
        while (resources.find()) {
            String name = resources.group(1);
            int fontObject;
            try { fontObject = Integer.parseInt(resources.group(2)); } catch (Exception ignored) { continue; }
            Integer start = offsets.get(fontObject);
            int objectStart = start == null ? -1 : start;
            if (objectStart < 0) continue;
            int objectEnd = source.indexOf("endobj", objectStart);
            if (objectEnd < 0) continue;
            String dictionary = source.substring(objectStart, objectEnd);
            Matcher unicodeRef = Pattern.compile("/ToUnicode\\s+(\\d+)\\s+0\\s+R").matcher(dictionary);
            if (!unicodeRef.find()) continue;
            try {
                Map<Integer, String> map = decoded.get(fontObject);
                if (map == null) {
                    map = parseCMap(streamForObject(source, bytes, Integer.parseInt(unicodeRef.group(1)), offsets, streams));
                    decoded.put(fontObject, map);
                }
                if (!map.isEmpty()) result.put(name, map);
            } catch (Exception ignored) {}
        }
        return result;
    }

    private static Map<Integer, String> parseCMap(byte[] bytes) {
        Map<Integer, String> result = new HashMap<Integer, String>();
        if (bytes.length == 0) return result;
        String text = new String(bytes, LATIN);
        Matcher chars = Pattern.compile("(?s)\\d+\\s+beginbfchar(.*?)endbfchar").matcher(text);
        while (chars.find()) {
            Matcher item = Pattern.compile("<([0-9A-Fa-f]+)>\\s+<([0-9A-Fa-f]+)>").matcher(chars.group(1));
            while (item.find()) result.put(hexInt(item.group(1)), unicodeHex(item.group(2)));
        }
        Matcher ranges = Pattern.compile("(?s)\\d+\\s+beginbfrange(.*?)endbfrange").matcher(text);
        while (ranges.find()) {
            Matcher item = Pattern.compile("<([0-9A-Fa-f]+)>\\s+<([0-9A-Fa-f]+)>\\s+<([0-9A-Fa-f]+)>").matcher(ranges.group(1));
            while (item.find()) {
                int from = hexInt(item.group(1));
                int to = hexInt(item.group(2));
                String first = unicodeHex(item.group(3));
                if (first.length() == 0) continue;
                int firstCode = first.codePointAt(0);
                for (int code = from; code <= to && code - from < 256; code++) {
                    result.put(code, new String(Character.toChars(firstCode + code - from)));
                }
            }
        }
        return result;
    }

    private static int hexInt(String value) {
        try { return Integer.parseInt(value, 16); } catch (Exception ignored) { return -1; }
    }

    private static String unicodeHex(String value) {
        StringBuilder result = new StringBuilder();
        for (int index = 0; index + 3 < value.length(); index += 4) {
            int code = hexInt(value.substring(index, index + 4));
            if (code < 0) continue;
            try { result.append((char) code); } catch (Exception ignored) {}
        }
        return result.toString();
    }

    private static byte[] streamForObject(String source, byte[] bytes, int objectNumber, Map<Integer, Integer> offsets, Map<Integer, byte[]> cache) {
        if (cache.containsKey(objectNumber)) return cache.get(objectNumber);
        Integer start = offsets.get(objectNumber);
        int objectStart = start == null ? -1 : start;
        if (objectStart < 0) return new byte[0];
        int stream = source.indexOf("stream", objectStart);
        int objectEnd = source.indexOf("endobj", objectStart);
        if (stream < 0 || objectEnd < 0 || stream > objectEnd) return new byte[0];
        int dataStart = stream + 6;
        if (dataStart < bytes.length && bytes[dataStart] == '\r') dataStart++;
        if (dataStart < bytes.length && bytes[dataStart] == '\n') dataStart++;
        int dataEnd = source.indexOf("endstream", dataStart);
        if (dataEnd < 0 || dataEnd > objectEnd) return new byte[0];
        while (dataEnd > dataStart && (bytes[dataEnd - 1] == '\r' || bytes[dataEnd - 1] == '\n')) dataEnd--;
        byte[] raw = slice(bytes, dataStart, dataEnd);
        String dictionary = source.substring(objectStart, stream);
        byte[] result = dictionary.contains("/FlateDecode") ? inflate(raw) : raw;
        cache.put(objectNumber, result);
        return result;
    }

    private static void appendMappedContent(StringBuilder output, byte[] bytes, Map<String, Map<Integer, String>> fonts) {
        String source = new String(bytes, LATIN);
        List<PositionedText> fragments = new ArrayList<PositionedText>();
        Matcher blocks = TEXT_BLOCK.matcher(source);
        int sequence = 0;
        while (blocks.find()) {
            sequence = parseMappedTextBlock(blocks.group(1), fonts, fragments, sequence);
        }
        if (fragments.isEmpty()) return;
        Collections.sort(fragments, new Comparator<PositionedText>() {
            @Override public int compare(PositionedText left, PositionedText right) {
                int y = Double.compare(left.y, right.y);
                if (y != 0) return y;
                int x = Double.compare(left.x, right.x);
                return x != 0 ? x : left.sequence - right.sequence;
            }
        });
        List<PositionedLine> lines = new ArrayList<PositionedLine>();
        for (PositionedText fragment : fragments) {
            PositionedLine selected = null;
            // Fragments are already ordered by y. Only the final line can
            // be the closest match; avoid scanning every preceding line.
            if (!lines.isEmpty()) {
                PositionedLine last = lines.get(lines.size() - 1);
                if (Math.abs(last.y - fragment.y) <= 2.5d) selected = last;
            }
            if (selected == null) {
                selected = new PositionedLine(fragment.y);
                lines.add(selected);
            }
            selected.fragments.add(fragment);
        }
        Collections.sort(lines, new Comparator<PositionedLine>() {
            @Override public int compare(PositionedLine left, PositionedLine right) {
                return Double.compare(left.y, right.y);
            }
        });
        for (PositionedLine line : lines) appendMappedCandidate(output, line.text());
    }

    private static int parseMappedTextBlock(String block, Map<String, Map<Integer, String>> fonts,
                                            List<PositionedText> fragments, int sequence) {
        Matcher matrix = TEXT_MATRIX.matcher(block);
        double x = 0d;
        double y = 0d;
        if (matrix.find()) {
            try {
                x = Double.parseDouble(matrix.group(5));
                y = Double.parseDouble(matrix.group(6));
            } catch (Exception ignored) {}
        }
        String currentFont = "";
        Matcher token = TEXT_TOKEN.matcher(block);
        while (token.find()) {
            if (token.group(1) != null) {
                String candidate = token.group(1);
                if (fonts.containsKey(candidate)) currentFont = candidate;
            } else if (token.group(2) != null) {
                try {
                    x += Double.parseDouble(token.group(2));
                    y += Double.parseDouble(token.group(3));
                } catch (Exception ignored) {}
            } else if (token.group(4) != null) {
                byte[] raw = decodeContentString(token.group(4));
                if (raw.length > 0) {
                    String value = mapBytes(raw, fonts.get(currentFont));
                    if (value.length() > 0) fragments.add(new PositionedText(value, x, y, sequence++));
                }
            }
        }
        return sequence;
    }

    private static byte[] decodeContentString(String token) {
        if (token == null || token.length() < 2) return new byte[0];
        if (token.charAt(0) == '<') {
            String hex = token.substring(1, token.length() - 1).replaceAll("\\s+", "");
            if (hex.length() == 0 || hex.length() % 2 != 0) return new byte[0];
            byte[] decoded = new byte[hex.length() / 2];
            for (int index = 0; index < decoded.length; index++) {
                try { decoded[index] = (byte) Integer.parseInt(hex.substring(index * 2, index * 2 + 2), 16); }
                catch (Exception ignored) { return new byte[0]; }
            }
            return decoded;
        }
        ParseString parsed = parseLiteral(token, 0);
        return parsed == null ? new byte[0] : parsed.raw;
    }

    private static String mapBytes(byte[] bytes, Map<Integer, String> map) {
        if (map == null || map.isEmpty()) return decodeTextBytes(bytes);
        StringBuilder result = new StringBuilder();
        boolean mapped = false;
        for (byte value : bytes) {
            int code = value & 0xff;
            String text = map.get(code);
            if (text != null) {
                result.append(text);
                mapped = true;
            } else if (code >= 32 && code != 127) {
                result.append((char) code);
            }
        }
        return mapped ? result.toString() : decodeTextBytes(bytes);
    }

    private static byte[] inflate(byte[] value) {
        try {
            InflaterInputStream input = new InflaterInputStream(new ByteArrayInputStream(value));
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                if (output.size() + read > 4 * 1024 * 1024) break;
                output.write(buffer, 0, read);
            }
            input.close();
            return output.toByteArray();
        } catch (Exception ignored) {
            return new byte[0];
        }
    }

    private static void appendPdfStrings(StringBuilder output, byte[] bytes) {
        String source = new String(bytes, LATIN);
        boolean found = false;
        for (int i = 0; i < source.length(); i++) {
            char character = source.charAt(i);
            if (character == '(') {
                ParseString parsed = parseLiteral(source, i);
                if (parsed != null) {
                    appendCandidate(output, parsed.value);
                    i = parsed.end;
                    found = true;
                }
            } else if (character == '<' && (i + 1 >= source.length() || source.charAt(i + 1) != '<')) {
                int end = source.indexOf('>', i + 1);
                if (end > i) {
                    String hex = source.substring(i + 1, end).replaceAll("\\s+", "");
                    if (hex.length() > 1 && hex.length() % 2 == 0) {
                        byte[] decoded = new byte[hex.length() / 2];
                        for (int p = 0; p < decoded.length; p++) {
                            try { decoded[p] = (byte) Integer.parseInt(hex.substring(p * 2, p * 2 + 2), 16); }
                            catch (Exception error) { decoded = new byte[0]; break; }
                        }
                        if (decoded.length > 0) {
                            appendCandidate(output, decodeTextBytes(decoded));
                            found = true;
                        }
                    }
                    i = end;
                }
            }
        }
        if (!found) {
            String fallback = new String(bytes, UTF8).replace('\u0000', ' ');
            appendCandidate(output, fallback);
        }
    }

    private static ParseString parseLiteral(String source, int start) {
        StringBuilder value = new StringBuilder();
        int depth = 0;
        for (int i = start; i < source.length(); i++) {
            char character = source.charAt(i);
            if (character == '(') {
                depth++;
                if (depth > 1) value.append(character);
                continue;
            }
            if (character == ')') {
                depth--;
                if (depth <= 0) return new ParseString(decodeEscapes(value.toString()), decodeEscapesRaw(value.toString()), i);
                value.append(character);
                continue;
            }
            if (character == '\\' && i + 1 < source.length()) {
                value.append(character).append(source.charAt(++i));
            } else if (depth > 0) {
                value.append(character);
            }
        }
        return null;
    }

    private static String decodeEscapes(String value) {
        return decodeTextBytes(decodeEscapesRaw(value));
    }

    private static byte[] decodeEscapesRaw(String value) {
        ByteArrayOutputStream result = new ByteArrayOutputStream();
        for (int i = 0; i < value.length(); i++) {
            char character = value.charAt(i);
            if (character != '\\' || i + 1 >= value.length()) {
                result.write((byte) character);
                continue;
            }
            char next = value.charAt(++i);
            if (next == 'n') result.write('\n');
            else if (next == 'r') result.write('\r');
            else if (next == 't') result.write('\t');
            else if (next == 'b') result.write('\b');
            else if (next == 'f') result.write('\f');
            else if (next >= '0' && next <= '7') {
                StringBuilder octal = new StringBuilder().append(next);
                while (octal.length() < 3 && i + 1 < value.length() && value.charAt(i + 1) >= '0' && value.charAt(i + 1) <= '7') octal.append(value.charAt(++i));
                try { result.write((byte) Integer.parseInt(octal.toString(), 8)); } catch (Exception ignored) {}
            } else result.write((byte) next);
        }
        return result.toByteArray();
    }

    private static String decodeTextBytes(byte[] bytes) {
        if (bytes.length >= 2) {
            boolean unicode = (bytes[0] == (byte) 0xfe && bytes[1] == (byte) 0xff) || (bytes[0] == 0 && bytes[1] != 0);
            if (unicode) {
                try {
                    int offset = bytes[0] == (byte) 0xfe ? 2 : 0;
                    return new String(bytes, offset, bytes.length - offset, Charset.forName("UTF-16BE"));
                } catch (Exception ignored) {}
            }
        }
        String utf = new String(bytes, UTF8);
        if (!utf.contains("�")) return utf;
        try {
            String greek = new String(bytes, Charset.forName("windows-1253"));
            if (!greek.contains("�")) return greek;
        } catch (Exception ignored) {}
        return new String(bytes, LATIN);
    }

    private static void appendCandidate(StringBuilder output, String value) {
        String cleaned = value == null ? "" : value.replace('\u0000', ' ').trim();
        if (cleaned.length() < 2) return;
        if (output.length() > 0) output.append('\n');
        output.append(cleaned);
    }

    private static void appendMappedCandidate(StringBuilder output, String value) {
        String cleaned = value == null ? "" : value.replace('\u0000', ' ').trim();
        if (cleaned.length() == 0) return;
        if (output.length() > 0) output.append('\n');
        output.append(cleaned);
    }

    private static String normalizeExtractedText(String value) {
        String text = String.valueOf(value == null ? "" : value)
                .replace('\u0000', ' ')
                .replaceAll("[ \\t]+", " ")
                .replaceAll("\\n{3,}", "\\n\\n")
                .trim();
        return text.length() > MAX_PARSE_TEXT ? text.substring(0, MAX_PARSE_TEXT) : text;
    }

    private static JSONObject extractFields(String rawText) throws Exception {
        String text = rawText == null ? "" : rawText;
        List<String> lines = lines(text);
        JSONObject result = new JSONObject();
        result.put("rawText", text.substring(0, Math.min(MAX_RAW_TEXT, text.length())));
        result.put("source", "server-local");
        result.put("ocrSource", "server-local");
        result.put("localReadAt", System.currentTimeMillis());

        String comments = findComments(text);
        String plate = findPlate(text);
        if (plate.length() == 0) plate = findPlate(comments);
        String odometer = findNumberNear(text, "χιλιόμετρα|χιλιομετρα|χλμ\\.?|χιλ\\.?|km|odometer|mileage");
        if (odometer.length() == 0) odometer = findCommentNumber(comments);
        String date = findDate(text);
        String total = findInvoiceTotal(text);
        String supplier = findSupplier(lines);
        String invoiceNumber = findInvoiceNumber(lines, text);
        if (plate.length() > 0) result.put("plate", plate);
        if (odometer.length() > 0) result.put("odometerKm", odometer);
        if (date.length() > 0) result.put("invoiceDate", date);
        if (total.length() > 0) result.put("totalAmount", total);
        if (supplier.length() > 0) result.put("supplier", supplier);
        if (invoiceNumber.length() > 0) result.put("invoiceNumber", invoiceNumber);
        if (comments.length() > 0) result.put("comments", comments);

        List<String> work = findWorkAccurate(lines);
        // Impact invoices normally expose a code before the description, but
        // the live WebView text sometimes drops that code or places it on a
        // separate line. Keep the strict table parser first and use the
        // broader, description-aware parser only when it found no items.
        if (work.isEmpty()) work = findWork(lines);
        JSONArray workJson = new JSONArray();
        for (String item : work) workJson.put(item);
        result.put("workPerformed", workJson);
        result.put("lineItems", workJson);
        result.put("parts", new JSONArray());

        int confidence = 0;
        if (text.length() >= 80) confidence += 20;
        if (date.length() > 0) confidence += 20;
        if (total.length() > 0) confidence += 20;
        if (work.size() > 0) confidence += 25;
        if (plate.length() > 0 || odometer.length() > 0 || supplier.length() > 0 || invoiceNumber.length() > 0) confidence += 15;
        boolean hasCoreInvoiceData = text.length() >= 80 && date.length() > 0 && total.length() > 0 && work.size() > 0;
        boolean confident = confidence >= 70 && hasCoreInvoiceData;
        result.put("ocrConfidence", confidence);
        result.put("localReadStatus", confident ? "confident" : "ambiguous");
        result.put("ocrFallbackUsed", false);
        result.put("ocrFallbackReason", confident ? "" : (text.length() == 0 ? "Το PDF δεν έχει αναγνώσιμο text layer." : "Η τοπική ανάγνωση δεν βρήκε αρκετά βέβαια στοιχεία."));
        return result;
    }

    private static List<String> lines(String text) {
        List<String> result = new ArrayList<String>();
        for (String part : String.valueOf(text == null ? "" : text).split("\\r?\\n")) {
            String line = part.replaceAll("\\s+", " ").trim();
            if (line.length() >= 2) result.add(line);
        }
        return result;
    }

    private static String findPlate(String text) {
        String letters = "[ABEZHIKMNOPTYXΑΒΕΖΗΙΚΜΝΟΡΤΥΧ]{3}";
        String candidate = "(" + letters + "[ \\t-]*\\d{3,4})(?![A-ZΑ-Ω0-9])";
        String labelled = findRegex(text, "(?iu)(?:πινακίδα|πινακιδα|αρ\\.?\\s*κυκλ\\.?|plate|registration)[^A-ZΑ-Ω0-9]{0,30}" + candidate);
        if (labelled.length() > 0) return normalizePlate(labelled);
        // Unlabelled matches are accepted only inside invoice comments,
        // never from an item code, model, invoice number or supplier header.
        String comments = findComments(text);
        String contextual = findRegex(comments, "(?iu)(?<![A-ZΑ-Ω0-9])" + candidate);
        return normalizePlate(contextual);
    }

    private static String normalizePlate(String value) {
        String compact = String.valueOf(value == null ? "" : value).replaceAll("\\s+", "").toUpperCase(Locale.ROOT);
        Matcher matcher = Pattern.compile("^([ABEZHIKMNOPTYXΑΒΕΖΗΙΚΜΝΟΡΤΥΧ]{3})-?(\\d{3,4})$").matcher(compact);
        return matcher.find() ? matcher.group(1) + "-" + matcher.group(2) : compact;
    }

    private static String comparableField(String field, String value) {
        String compact = value.trim().toUpperCase(Locale.ROOT);
        if ("plate".equals(field)) {
            String greek = "ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ", latin = "ABEZHIKMNOPTYX";
            for (int index = 0; index < greek.length(); index++) compact = compact.replace(greek.charAt(index), latin.charAt(index));
            return compact.replaceAll("[^A-Z0-9]", "");
        }
        if ("odometerKm".equals(field)) return compact.replaceAll("[^0-9]", "");
        if ("totalAmount".equals(field)) {
            compact = compact.replace(" ", "");
            if (compact.contains(",")) compact = compact.replace(".", "").replace(',', '.');
            try { return new java.math.BigDecimal(compact).stripTrailingZeros().toPlainString(); }
            catch (Exception ignored) { return compact; }
        }
        return compact;
    }

    private static String findDate(String text) {
        List<String> rows = lines(text);
        boolean issuedLabel = false;
        for (int index = 0; index < rows.size(); index++) {
            if (!rows.get(index).matches("(?iu).*(?:ημερομηνία\\s*έκδοσης|ημερομηνια\\s*εκδοσης|invoice\\s*date|issue\\s*date).*")) continue;
            issuedLabel = true;
            String value = findValidDate(rows.get(index));
            boolean hasDateToken = rows.get(index).matches(".*[0-9]{1,4}[./-][0-9]{1,2}[./-][0-9]{1,4}.*");
            if (value.length() == 0 && !hasDateToken && index + 1 < rows.size()
                    && !rows.get(index + 1).matches("(?iu).*(?:ημερομηνία|ημερομηνια|date).*")) value = findValidDate(rows.get(index + 1));
            if (value.length() > 0) return value;
        }
        return issuedLabel ? "" : findValidDate(text);
    }

    private static String findValidDate(String text) {
        Matcher matcher = Pattern.compile("(?<!\\d)(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[./-]\\d{1,2}[./-]\\d{4})(?!\\d)").matcher(text == null ? "" : text);
        while (matcher.find()) {
            String value = matcher.group(1);
            String[] parts = value.split("[./-]");
            String iso = parts[0].length() == 4 ? value : parts[2] + "-" + pad(parts[1]) + "-" + pad(parts[0]);
            try {
                java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("yyyy-MM-dd", Locale.ROOT);
                format.setLenient(false);
                if (format.format(format.parse(iso)).equals(iso)) return iso;
            } catch (Exception ignored) {}
        }
        return "";
    }

    private static String findInvoiceTotal(String text) {
        String value = findMoneyNear(text, "συνολική\\s*αξία|συνολικη\\s*αξια|grand\\s*total|total\\s*amount");
        if (value.length() > 0) return value;
        value = findMoneyNear(text, "ποσό\\s*πληρωμής|ποσο\\s*πληρωμης|πληρωτέο|πληρωτεο");
        if (value.length() > 0) return value;
        return findRegex(text, "(?imu)^\\s*(?:σύνολο|συνολο|total)\\s*[:€]?\\s*([0-9][0-9 .]*(?:[,.]\\d{1,2})?)").trim();
    }

    private static String findNumberNear(String text, String labels) {
        return findRegex(text, "(?iu)(?<![A-ZΑ-Ω0-9])(?:" + labels + ")(?![A-ZΑ-Ω0-9])[^0-9\\n]{0,35}([0-9]{1,3}(?:[ .][0-9]{3}){1,2}|[0-9]{3,7})(?![0-9])").replaceAll("[^0-9]", "");
    }

    private static String findMoneyNear(String text, String labels) {
        String value = findRegex(text, "(?iu)(?:" + labels + ")[^0-9\\n]{0,35}([0-9][0-9 .]*(?:[,.]\\d{1,2})?)");
        return value.trim();
    }

    private static String findLabelValue(List<String> lines, String labels) {
        for (String line : lines) {
            if (line.toLowerCase(Locale.ROOT).matches(".*(?:" + labels + ").*")) {
                String value = line.replaceFirst("(?iu)^.*?(?:" + labels + ")\\s*[:#-]?\\s*", "").trim();
                if (value.length() > 1 && !value.matches("(?iu)(?:ημερομηνία|date|σελίδα|page).*")) return value.substring(0, Math.min(240, value.length()));
            }
        }
        return "";
    }

    private static String findSupplier(List<String> lines) {
        String labelled = findLabelValue(lines, "προμηθευτής|προμηθευτης|συνεργείο|συνεργειο|εκδότης|εκδοτης");
        if (labelled.length() > 1 && !looksLikeCustomerOrHeader(labelled)) return cleanSupplier(labelled);
        int inspected = Math.min(lines.size(), 14);
        for (int index = 0; index < inspected; index++) {
            String line = lines.get(index);
            String candidate = line.replaceFirst("(?ius)\\s*(?:αρ\\.?\\s*εγκατάστασης|αρ\\.?\\s*εγκαταστασης|αφμ|δραστηριότητες|δραστηριοτητες|έδρα|εδρα).*$", "").trim();
            candidate = cleanSupplier(candidate);
            String value = candidate.toLowerCase(Locale.ROOT);
            if (candidate.length() >= 3 && candidate.length() <= 100
                    && !looksLikeCustomerOrHeader(candidate)
                    && !value.matches(".*(?:κωδικός|κωδικος|πελάτης|πελατης|στοιχεία|στοιχεια).*")
                    && candidate.matches("(?iu).*(?:ο\\.?\\s*ε\\.?|α\\.?ε\\.?|yamaha|moto|service|συνεργειο|μοτο).*") ) return candidate;
        }
        return "";
    }

    private static String cleanSupplier(String value) {
        String candidate = String.valueOf(value == null ? "" : value).replaceAll("\\s+", " ").trim();
        String[] words = candidate.split(" ");
        if (words.length == 2 && words[0].equalsIgnoreCase(words[1])) return words[0];
        if (words.length >= 4 && words.length % 2 == 0) {
            int half = words.length / 2;
            boolean repeated = true;
            for (int index = 0; index < half; index++) {
                if (!words[index].equalsIgnoreCase(words[index + half])) { repeated = false; break; }
            }
            if (repeated) {
                StringBuilder first = new StringBuilder();
                for (int index = 0; index < half; index++) {
                    if (index > 0) first.append(' ');
                    first.append(words[index]);
                }
                candidate = first.toString();
            }
        }
        return candidate;
    }

    private static boolean looksLikeCustomerOrHeader(String value) {
        return String.valueOf(value == null ? "" : value).toLowerCase(Locale.ROOT)
                .matches(".*(?:τιμολόγιο|τιμολογιο|παραστατικό|παραστατικο|ανάλυση|αναλυση|πελάτης|πελατης|στοιχεία|στοιχεια|κωδικός|κωδικος|δραστηριότητες|δραστηριοτητες|έδρα|εδρα|αφμ|δου).*");
    }

    private static String findInvoiceNumber(List<String> lines, String text) {
        String labelled = findLabelValue(lines, "αριθμός τιμολογίου|αριθμος τιμολογιου|αρ\\.?\\s*τιμολογίου|αρ\\.?\\s*τιμολογιου|invoice no|invoice number");
        if (labelled.length() > 1) return labelled.replaceAll("\\s+.*$", "");
        String header = text == null ? "" : text;
        int headerStart = header.toLowerCase(Locale.ROOT).indexOf("είδος παραστατικού");
        if (headerStart < 0) headerStart = header.toLowerCase(Locale.ROOT).indexOf("ειδος παραστατικου");
        if (headerStart >= 0) header = header.substring(headerStart, Math.min(header.length(), headerStart + 900));
        String knownPrefix = findRegex(header, "(?iu)((?:ΤΔΑ|ΤΙΜ|ΑΠΥ|INV)[A-ZΑ-Ω0-9-]{3,})");
        if (knownPrefix.length() > 0) return knownPrefix.replaceAll("\\s+", "");
        String candidate = findRegex(header, "(?iu)(?<![A-ZΑ-Ω0-9])([A-ZΑ-Ω]{2,8}\\s*[-/]?\\s*\\d{3,})(?![A-ZΑ-Ω0-9])");
        if (candidate.length() > 0) return candidate.replaceAll("\\s+", "");
        candidate = findRegex(text, "(?iu)(?:αριθμός|αριθμος)\\s*[:#-]?\\s*([A-ZΑ-Ω]{2,8}\\s*[-/]?\\s*\\d{3,})");
        if (candidate.length() > 0) return candidate.replaceAll("\\s+", "");
        return findRegex(text, "(?iu)(?<![A-ZΑ-Ω0-9])((?:ΤΔΑ|ΤΙΜ|ΑΠΥ|INV)[A-ZΑ-Ω0-9-]{3,})(?![A-ZΑ-Ω0-9])").replaceAll("\\s+", "");
    }

    private static String findComments(String text) {
        String[] rows = String.valueOf(text == null ? "" : text).split("\\r?\\n");
        for (int index = 0; index < rows.length; index++) {
            Matcher label = Pattern.compile("(?iu)σχ[όο]λια\\s*[:#-]?\\s*(.*)").matcher(rows[index]);
            if (!label.find()) continue;
            StringBuilder value = new StringBuilder(label.group(1));
            for (int next = index + 1; next < rows.length && next <= index + 3; next++) {
                String line = rows[next].trim();
                if (line.length() == 0 || line.matches("(?iu).*(?:μ\\.?\\s*αρ\\.?\\s*κ|υπογραφή|υπογραφη|αναγν|υ\\.?πα|αδειοδότησης|αδειοδοτησης|https?://).*")) break;
                if (value.length() + line.length() > 240) break;
                value.append(' ').append(line);
            }
            return value.toString().replaceAll("\\s+", " ").trim();
        }
        return "";
    }

    private static String findCommentNumber(String comments) {
        String value = String.valueOf(comments == null ? "" : comments).replaceAll("(?iu)[ABEZHIKMNOPTYXΑΒΕΖΗΙΚΜΝΟΡΤΥΧ]{3}[ \\t-]*\\d{3,4}(?![A-ZΑ-Ω0-9])", " ");
        Matcher matcher = Pattern.compile("(?<![A-ZΑ-Ω0-9])([0-9]{4,7}|[0-9]{1,3}[ .][0-9]{3})(?![A-ZΑ-Ω0-9])").matcher(value);
        String last = "";
        while (matcher.find()) {
            String current = matcher.group(1).replaceAll("[^0-9]", "");
            if (last.length() > 0 && !last.equals(current)) return "";
            last = current;
        }
        return last;
    }

    private static List<String> findWork(List<String> lines) {
        Set<String> unique = new LinkedHashSet<String>();
        StringBuilder current = new StringBuilder();
        for (String line : lines) {
            String normalized = line.replaceAll("^[-•*·]+\\s*", "").trim();
            normalized = cleanInvoiceWorkText(normalized);
            String value = normalized.toLowerCase(Locale.ROOT);
            if (normalized.length() < 3 || normalized.length() > 180) continue;
            if (value.matches("(?iu).*(?:τιμολόγιο|τιμολογιο|ημερομηνία|ημερομηνια|πελάτης|πελατης|διεύθυνση|διευθυνση|σύνολο|συνολο|πληρωτέο|πληρωτεο|αφμ|τηλέφωνο|τηλεφωνο|σελίδα|σελιδα|page|subtotal|vat|φπα|καθαρή αξία|καθαρη αξια).*")) continue;
            if (value.matches("(?iu).*(?:λάδι|λαδι|oil|yamalube|φίλτρο|φιλτρο|εργασία|εργασια|service|σέρβις|σερβις|ανταλλακ|brake|φρέν|φρεν|τροχ|μπουζί|μπουζι|αλυσίδ|αλυσίδα|ελαστικ|λάστιχ|lastix|λιπαντικ|ρύθμιση|ρυθμιση|αλλαγή|αλλαγη).*")) {
                String cleaned = cleanWorkLine(normalized);
                if (cleaned.length() == 0) continue;
                if (startsNewWorkLine(normalized)) {
                    if (current.length() > 0) unique.add(current.toString());
                    current.setLength(0);
                    current.append(cleaned);
                } else if (current.length() > 0 && isContinuationLine(normalized)) {
                    current.append(" ").append(cleaned);
                } else {
                    unique.add(cleaned);
                }
            } else if (current.length() > 0 && isContinuationLine(normalized)) {
                current.append(" ").append(cleanWorkLine(normalized));
            }
        }
        if (current.length() > 0) unique.add(current.toString());
        return new ArrayList<String>(unique);
    }

    private static boolean startsNewWorkLine(String value) {
        return startsInvoiceItem(value) || startsDescriptionItem(value);
    }

    private static boolean isContinuationLine(String value) {
        return value.matches("(?iu).*(?:yamalube|crypton|federal|20w50|/|mhq|t-?\\d+|\\d{2,3}/\\d{2,3}).*")
                && !value.matches("(?iu).*(?:σύνολο|συνολο|τιμή|τιμη|ποσότητα|ποσοτητα|φπα|vat).*");
    }

    private static String cleanInvoiceWorkText(String value) {
        String text = value == null ? "" : value;
        Matcher matcher = Pattern.compile("(?iu)όροι\\s+πληρωμής|οροι\\s+πληρωμης|τρόπος\\s+πληρωμής|τροπος\\s+πληρωμης|πληρωμής\\s+συναλλαγής|πληρωμης\\s+συναλλαγης|τοίς\\s+μετρητοίς|τοις\\s+μετρητοις|payment\\s+terms|cash\\s+payment").matcher(text);
        return (matcher.find() ? text.substring(0, matcher.start()) : text).replaceAll("[\\s:;·—–-]+$", "").trim();
    }

    private static String cleanWorkLine(String value) {
        String cleaned = removeLeadingInvoiceCodes(cleanInvoiceWorkText(value))
                .replaceFirst("(?iu)\\s+[0-9]+[,.][0-9]{2}\\s+(?:τεμάχια|τεμαχια|h87).*?$", "")
                .replaceAll("\\s+", " ").trim();
        return cleaned.length() > 150 ? cleaned.substring(0, 150).trim() : cleaned;
    }

    /** A stricter line-item parser used for the invoice table. */
    private static List<String> findWorkAccurate(List<String> lines) {
        Set<String> unique = new LinkedHashSet<String>();
        StringBuilder current = new StringBuilder();
        boolean inItems = false;
        for (String line : lines) {
            String normalized = line.replaceAll("^[-•*·]+\\s*", "").trim();
            String value = normalized.toLowerCase(Locale.ROOT);
            if (normalized.length() < 3 || normalized.length() > 180) continue;
            boolean startsItem = startsInvoiceItem(normalized) || startsDescriptionItem(normalized);
            if (!inItems) {
                if (value.matches("(?iu).*(?:κωδικός.*περιγραφή|κωδικος.*περιγραφη|cpv.*περιγραφή|cpv.*περιγραφη).*")) inItems = true;
                else if (!startsItem) continue;
            }
            if (cleanInvoiceWorkText(normalized).length() == 0 || value.matches("(?iu).*(?:εκπτώσεις\\s*/\\s*χρεώσεις|εκπτωσεις\\s*/\\s*χρεωσεις|ανάλυση\\s+φπα|αναλυση\\s+φπα|στοιχεία\\s+πληρωμής|στοιχεια\\s+πληρωμης|σχόλια|σχολια).*")) {
                if (current.length() > 0) unique.add(current.toString());
                break;
            }
            if (startsItem) {
                if (current.length() > 0) unique.add(current.toString());
                current.setLength(0);
                String cleaned = cleanInvoiceItem(normalized);
                if (cleaned.length() > 0) current.append(cleaned);
            } else if (current.length() > 0 && isInvoiceContinuation(normalized)) {
                String cleaned = cleanInvoiceItem(normalized);
                if (cleaned.length() > 0) current.append(" ").append(cleaned);
            }
        }
        if (current.length() > 0) unique.add(current.toString());
        return removeRedundantWork(new ArrayList<String>(unique));
    }

    private static boolean startsInvoiceItem(String value) {
        return value.matches("(?iu)^\\s*(?=[A-ZΑ-Ω0-9-_/]*\\d[A-ZΑ-Ω0-9-_/]*\\s+)[A-ZΑ-Ω0-9]{8,}[-_/]?\\s+.*");
    }

    /** A line beginning with a known invoice description, even when its item code is absent. */
    private static boolean startsDescriptionItem(String value) {
        String candidate = String.valueOf(value == null ? "" : value).trim();
        if (candidate.length() < 3) return false;
        if (candidate.matches("(?iu).*\\b(?:κωδικός|κωδικος|περιγραφή|περιγραφη|ποσότητα|ποσοτητα|τιμή|τιμη|σύνολο|συνολο|φπα|vat)\\b.*")) return false;
        return candidate.matches("(?iu)^\\s*(?:λάδ(?:ι|ια)|oil|φίλτρ\\w*|φιλτρ\\w*|λάστιχ\\w*|λαστιχ\\w*|ελαστικ\\w*|σιαγόν\\w*|σιγον\\w*|τακάκ\\w*|τακακ\\w*|φρέν\\w*|φρεν\\w*|μπουζ\\w*|αλυσίδ\\w*|αλυσιδ\\w*|εργασ\\w*|ανταλλακ\\w*|service|σέρβις|σερβις|ρυθμισ\\w*|αλλαγ\\w*|επισκευ\\w*).* ".trim());
    }

    private static boolean isInvoiceContinuation(String value) {
        return value.matches("(?iu).*(?:yamalube|crypton|federal|20w50|/|mhq|t-?\\d+|\\d{2,3}/\\d{2,3}).*")
                || value.matches("(?iu)^\\s*[a-zα-ω][a-zα-ω0-9 .\\-/]{2,50}\\s*$");
    }

    private static String cleanInvoiceItem(String value) {
        String cleaned = cleanInvoiceWorkText(value).replaceAll("\\s+", " ").trim();
        for (int attempt = 0; attempt < 3; attempt++) {
            int separator = cleaned.indexOf(' ');
            if (separator <= 0) break;
            String token = cleaned.substring(0, separator).trim();
            if (!token.matches("(?iu)(?=.*\\d)[A-ZΑ-Ω0-9]{8,}[-_/]?")) break;
            cleaned = cleaned.substring(separator + 1).trim();
        }
        cleaned = cleaned.replaceFirst("^\\s*\\d+\\s+", "");
        Matcher quantity = Pattern.compile("[0-9]{1,3}[,.][0-9]{2}").matcher(cleaned);
        if (quantity.find() && quantity.start() > 1) cleaned = cleaned.substring(0, quantity.start()).trim();
        cleaned = cleaned.replaceFirst("(?iu)\\s+(?:τεμάχια|τεμαχια|h87)\\b.*$", "")
                .replaceAll("\\s+", " ").trim();
        return cleaned.length() > 150 ? cleaned.substring(0, 150).trim() : cleaned;
    }

    private static String removeLeadingInvoiceCodes(String value) {
        String cleaned = String.valueOf(value == null ? "" : value).replaceAll("\\s+", " ").trim();
        for (int attempt = 0; attempt < 3; attempt++) {
            Matcher matcher = Pattern.compile("(?iu)^([A-ZΑ-Ω0-9][A-ZΑ-Ω0-9_-]{7,})\\s+").matcher(cleaned);
            if (!matcher.find() || !matcher.group(1).matches("(?iu).*[0-9].*")) break;
            cleaned = cleaned.substring(matcher.end()).trim();
        }
        return cleaned;
    }

    private static List<String> removeRedundantWork(List<String> values) {
        List<String> result = new ArrayList<String>();
        for (String value : values) {
            String candidate = value == null ? "" : value.trim();
            if (candidate.length() < 3) continue;
            String normalized = canonicalWork(candidate);
            if (normalized.length() < 3) continue;
            boolean redundant = false;
            for (String existing : result) {
                String existingNormalized = canonicalWork(existing);
                if (existingNormalized.equals(normalized) || (normalized.length() >= 4 && existingNormalized.contains(normalized))) {
                    redundant = true;
                    break;
                }
            }
            if (!redundant) {
                for (int index = result.size() - 1; index >= 0; index--) {
                    String existingNormalized = canonicalWork(result.get(index));
                    if (existingNormalized.length() >= 4 && normalized.contains(existingNormalized)) result.remove(index);
                }
                result.add(candidate);
            }
        }
        return result;
    }

    private static String canonicalWork(String value) {
        return String.valueOf(value == null ? "" : value).toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{Nd}]", "");
    }

    private static String findRegex(String text, String pattern) {
        try {
            java.util.regex.Matcher matcher = java.util.regex.Pattern.compile(pattern).matcher(text == null ? "" : text);
            return matcher.find() ? matcher.group(matcher.groupCount()) : "";
        } catch (Exception ignored) {
            return "";
        }
    }

    private static String pad(String value) { return value.length() == 1 ? "0" + value : value; }

    private static byte[] slice(byte[] value, int start, int end) {
        if (start < 0) start = 0;
        if (end < start) end = start;
        if (end > value.length) end = value.length;
        byte[] result = new byte[end - start];
        System.arraycopy(value, start, result, 0, result.length);
        return result;
    }

    private static int indexOf(byte[] source, byte[] needle, int from) {
        outer: for (int i = Math.max(0, from); i <= source.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) if (source[i + j] != needle[j]) continue outer;
            return i;
        }
        return -1;
    }

    private static int lastIndexOf(byte[] source, byte[] needle, int before) {
        for (int i = Math.min(before - needle.length, source.length - needle.length); i >= 0; i--) {
            boolean match = true;
            for (int j = 0; j < needle.length; j++) if (source[i + j] != needle[j]) { match = false; break; }
            if (match) return i;
        }
        return -1;
    }

    private static final class ParseString {
        final String value;
        final byte[] raw;
        final int end;
        ParseString(String value, byte[] raw, int end) { this.value = value; this.raw = raw; this.end = end; }
    }

    private static final class PositionedText {
        final String value;
        final double x;
        final double y;
        final int sequence;
        PositionedText(String value, double x, double y, int sequence) {
            this.value = value;
            this.x = x;
            this.y = y;
            this.sequence = sequence;
        }
    }

    private static final class PositionedLine {
        final double y;
        final List<PositionedText> fragments = new ArrayList<PositionedText>();
        PositionedLine(double y) { this.y = y; }

        String text() {
            Collections.sort(fragments, new Comparator<PositionedText>() {
                @Override public int compare(PositionedText left, PositionedText right) {
                    int x = Double.compare(left.x, right.x);
                    return x != 0 ? x : left.sequence - right.sequence;
                }
            });
            StringBuilder result = new StringBuilder();
            PositionedText previous = null;
            for (PositionedText fragment : fragments) {
                // Chromium's mapped PDF text often stores one glyph per Tj
                // command and omits the actual space glyph between columns.
                // Recreate only the wide column gaps; normal glyph spacing
                // remains untouched.
                if (previous != null && fragment.x - previous.x > 12d
                        && !previous.value.endsWith(" ") && !fragment.value.startsWith(" ")) {
                    result.append(' ');
                }
                result.append(fragment.value);
                previous = fragment;
            }
            return result.toString();
        }
    }
}
