package gr.argyrismitsos.fleetserver;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Set;

/**
 * Strict, fail-closed decoder for frozen D1 export schema v3.
 * Produces typed values for an isolated SQLite importer; never changes authority.
 * The caller must use a transaction, verify complete table counts and restore
 * evidence, and hold the Worker writer fence before any primary activation.
 */
public final class NativeFrozenExportV3 {
    public interface CellReader {
        JSONObject read(String table, long rowid, String column, int offset, int size) throws Exception;
    }
    public static final int SCHEMA_VERSION = 3;
    public static final int CHUNK_BYTES = 32768;
    // Avoid an unbounded allocation on a phone. A larger source cell fails closed.
    public static final int MAX_CELL_BYTES = 8 * 1024 * 1024;
    private static final long SAFE_INTEGER = 9007199254740991L;
    private static final BigInteger MIN_LONG = BigInteger.valueOf(Long.MIN_VALUE);
    private static final BigInteger MAX_LONG = BigInteger.valueOf(Long.MAX_VALUE);

    private NativeFrozenExportV3() {}

    private static IOException invalid(String detail) {
        return new IOException("Μη έγκυρη παγωμένη μεταφορά v3: " + detail);
    }
    private static boolean name(String value) {
        return value != null && value.matches("[A-Za-z_][A-Za-z0-9_]{0,120}")
            && !value.equalsIgnoreCase("_primaryRowid")
            && !value.equalsIgnoreCase("_primaryOversize");
    }
    private static long safeNumber(Object value, String label) throws IOException {
        if (!(value instanceof Number) || value instanceof Float || value instanceof Double)
            throw invalid(label);
        try {
            BigInteger number = new BigInteger(value.toString());
            if (number.signum() < 0 || number.compareTo(BigInteger.valueOf(SAFE_INTEGER)) > 0)
                throw invalid(label);
            return number.longValueExact();
        } catch (NumberFormatException | ArithmeticException error) {
            throw invalid(label);
        }
    }
    private static long signedSafeNumber(Number value) throws IOException {
        if (value instanceof Float || value instanceof Double) throw invalid("inline integer");
        try {
            BigInteger number=new BigInteger(value.toString());
            if (number.compareTo(BigInteger.valueOf(-SAFE_INTEGER))<0
                || number.compareTo(BigInteger.valueOf(SAFE_INTEGER))>0)
                throw invalid("inline integer");
            return number.longValueExact();
        } catch (NumberFormatException | ArithmeticException error) {
            throw invalid("inline integer");
        }
    }
    private static String required(JSONObject object, String field) throws IOException {
        Object value = object.opt(field);
        if (!(value instanceof String)) throw invalid(field);
        return (String)value;
    }
    private static int version(JSONObject value) throws IOException {
        if (safeNumber(value.opt("schemaVersion"), "schemaVersion") != SCHEMA_VERSION)
            throw invalid("schemaVersion");
        return SCHEMA_VERSION;
    }
    private static byte[] bytes(JSONObject part, String table, String generation, String column,
                                long rowid, int offset, int count, int total, String kind) throws IOException {
        version(part);
        if (!generation.equals(required(part,"generation"))
            || !table.equals(required(part,"table"))
            || !column.equals(required(part,"column"))
            || safeNumber(part.opt("rowid"),"rowid") != rowid
            || safeNumber(part.opt("offset"),"offset") != offset
            || safeNumber(part.opt("bytes"),"bytes") != total
            || !kind.equals(required(part,"kind")))
            throw invalid("cell identity/generation");
        String hex = required(part,"hex");
        if (hex.length() != count * 2) throw invalid("cell length");
        byte[] result = new byte[count];
        for (int i=0;i<count;i++) {
            int a=Character.digit(hex.charAt(i*2),16), b=Character.digit(hex.charAt(i*2+1),16);
            if (a<0 || b<0) throw invalid("cell hex");
            result[i]=(byte)((a<<4)|b);
        }
        if (part.opt("complete") != Boolean.valueOf(offset+count==total))
            throw invalid("cell completion");
        return result;
    }
    private static Object deferred(JSONObject descriptor, String table, String generation,
                                   String column, long rowid, CellReader reader) throws Exception {
        if (!column.equals(required(descriptor,"name"))) throw invalid("descriptor column");
        String kind=required(descriptor,"type");
        if (kind.equals("integer")) {
            if (descriptor.has("bytes")) throw invalid("integer descriptor");
            String decimal=required(descriptor,"decimal");
            if (!decimal.matches("-?(0|[1-9][0-9]*)")) throw invalid("integer decimal");
            BigInteger value;
            try { value=new BigInteger(decimal); } catch (NumberFormatException error) { throw invalid("integer decimal"); }
            if (value.compareTo(MIN_LONG)<0 || value.compareTo(MAX_LONG)>0
                || (value.compareTo(BigInteger.valueOf(-SAFE_INTEGER))>=0
                    && value.compareTo(BigInteger.valueOf(SAFE_INTEGER))<=0))
                throw invalid("integer bounds");
            return Long.valueOf(value.longValueExact());
        }
        if (!kind.equals("text") && !kind.equals("blob")) throw invalid("deferred type");
        long exactSize=safeNumber(descriptor.opt("bytes"),"cell bytes");
        if (exactSize>MAX_CELL_BYTES || (kind.equals("text") && exactSize<=4096)) throw invalid("cell size");
        int size=(int)exactSize;
        if (size>0 && reader==null) throw invalid("missing cell reader");
        ByteArrayOutputStream output=new ByteArrayOutputStream(Math.min(size,CHUNK_BYTES));
        for (int offset=0;offset<size;offset+=CHUNK_BYTES) {
            if (Thread.currentThread().isInterrupted()) throw new java.io.InterruptedIOException("Migration interrupted");
            int count=Math.min(CHUNK_BYTES,size-offset);
            JSONObject part=reader.read(table,rowid,column,offset,count);
            if (part==null) throw invalid("missing cell");
            output.write(bytes(part,table,generation,column,rowid,offset,count,size,kind));
        }
        byte[] content=output.toByteArray();
        if (kind.equals("blob")) return content; // x'' remains byte[0], not SQL NULL.
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(content)).toString();
        } catch (CharacterCodingException error) { throw invalid("UTF-8"); }
    }

    /**
     * One frozen row, in inventory column order. SQL NULL is represented by null;
     * BLOB is byte[], INTEGER is Long, REAL is finite Double, TEXT is String.
     */
    public static LinkedHashMap<String,Object> decode(JSONObject inventory, JSONObject table,
            JSONObject page, JSONObject row, CellReader reader) throws Exception {
        version(inventory);version(page);
        String generation=required(inventory,"generation"), tableName=required(table,"name");
        if (generation.isEmpty() || !generation.equals(required(page,"generation"))
            || !name(tableName) || !tableName.equals(required(page,"table")))
            throw invalid("table/generation");
        long rowid=safeNumber(row.opt("_primaryRowid"),"rowid");
        if (rowid==0) throw invalid("rowid");
        JSONArray columns=table.optJSONArray("columns");
        if (columns==null || columns.length()==0 || columns.length()>256) throw invalid("columns");
        Object raw=row.opt("_primaryOversize");
        if (!(raw instanceof String)) throw invalid("descriptors");
        JSONArray metadata;
        try { metadata=new JSONArray((String)raw); } catch (Exception error) { throw invalid("descriptors"); }
        if (metadata.length()!=columns.length()) throw invalid("descriptor count");
        if (row.length()!=columns.length()+2) throw invalid("row shape");
        LinkedHashMap<String,Object> result=new LinkedHashMap<>();
        Set<String> seen=new HashSet<>();
        for (int i=0;i<columns.length();i++) {
            JSONObject definition=columns.optJSONObject(i);
            if (definition==null) throw invalid("column definition");
            String column=required(definition,"name");
            if (!name(column) || column.equalsIgnoreCase("rowid")
                || column.equalsIgnoreCase("_rowid_") || column.equalsIgnoreCase("oid")
                || !seen.add(column.toLowerCase(java.util.Locale.ROOT)) || !row.has(column))
                throw invalid("column names");
            Object inline=row.opt(column), marker=metadata.opt(i), value;
            if (marker!=null && marker!=JSONObject.NULL) {
                if (!(marker instanceof JSONObject) || inline!=JSONObject.NULL) throw invalid("deferred marker");
                value=deferred((JSONObject)marker,tableName,generation,column,rowid,reader);
            } else if (inline==JSONObject.NULL) {
                value=null;
            } else if (inline instanceof String) {
                value=inline;
            } else if (inline instanceof Number) {
                Number number=(Number)inline;
                if (number instanceof Double || number instanceof Float) {
                    double real=number.doubleValue();
                    if (!Double.isFinite(real)) throw invalid("non-finite REAL");
                    value=Double.valueOf(real);
                } else {
                    long integer=signedSafeNumber(number);
                    value=Long.valueOf(integer);
                }
            } else throw invalid("inline type");
            if (value==null && (definition.optInt("notnull",0)!=0 || definition.optInt("pk",0)!=0))
                throw invalid("non-null column");
            result.put(column,value);
        }
        return result;
    }
}
