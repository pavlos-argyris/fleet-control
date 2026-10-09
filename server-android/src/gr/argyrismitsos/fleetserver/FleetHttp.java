package gr.argyrismitsos.fleetserver;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;
import java.util.Map;

public final class FleetHttp {
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final int MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

    private FleetHttp() {
    }

    public static JSONObject getJson(String url, Map<String, String> headers) throws Exception {
        HttpURLConnection connection = open(url, "GET", headers);
        return readJson(connection);
    }

    public static JSONObject sendJson(String url, String method, JSONObject body, Map<String, String> headers) throws Exception {
        HttpURLConnection connection = open(url, method, headers);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        connection.setDoOutput(true);
        byte[] data = body.toString().getBytes(UTF8);
        connection.setFixedLengthStreamingMode(data.length);
        OutputStream output = new BufferedOutputStream(connection.getOutputStream());
        try {
            output.write(data);
        } finally {
            output.close();
        }
        return readJson(connection);
    }

    public static JSONObject putStream(String url, InputStream input, long length, String contentType, Map<String, String> headers) throws Exception {
        HttpURLConnection connection = open(url, "PUT", headers);
        connection.setRequestProperty("Content-Type", contentType);
        connection.setDoOutput(true);
        if (length >= 0 && length <= Integer.MAX_VALUE) connection.setFixedLengthStreamingMode((int) length);
        else connection.setChunkedStreamingMode(64 * 1024);
        OutputStream output = new BufferedOutputStream(connection.getOutputStream());
        try {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
        } finally {
            try { input.close(); } catch (IOException ignored) {}
            output.close();
        }
        return readJson(connection);
    }

    public static void downloadToFile(String url, File target, Map<String, String> headers) throws Exception {
        HttpURLConnection connection = open(url, "GET", headers);
        int code = connection.getResponseCode();
        if (code < 200 || code >= 300) throw new IOException("HTTP " + code);
        InputStream input = new BufferedInputStream(connection.getInputStream());
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("Δεν δημιουργήθηκε ο φάκελος τιμολογίων.");
        File temporary = new File(target.getPath() + ".part");
        FileOutputStream output = new FileOutputStream(temporary, false);
        try {
            byte[] buffer = new byte[64 * 1024];
            int read;
            long total = 0;
            while ((read = input.read(buffer)) >= 0) {
                total += read;
                if (total > 15L * 1024L * 1024L) throw new IOException("Το τιμολόγιο είναι πολύ μεγάλο.");
                output.write(buffer, 0, read);
            }
        } finally {
            try { input.close(); } catch (IOException ignored) {}
            output.close();
        }
        if (!temporary.renameTo(target)) {
            if (target.exists()) target.delete();
            if (!temporary.renameTo(target)) throw new IOException("Δεν αποθηκεύτηκε το τιμολόγιο στον Server.");
        }
    }

    private static HttpURLConnection open(String url, String method, Map<String, String> headers) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(45000);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("User-Agent", "Fleet-Control-Server/" + ServerConfig.SERVER_VERSION);
        if (headers != null) {
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                connection.setRequestProperty(entry.getKey(), entry.getValue());
            }
        }
        return connection;
    }

    private static JSONObject readJson(HttpURLConnection connection) throws Exception {
        int code = connection.getResponseCode();
        InputStream raw = code >= 200 && code < 300 ? connection.getInputStream() : connection.getErrorStream();
        String text = raw == null ? "" : readText(raw);
        JSONObject result;
        try {
            result = text.length() == 0 ? new JSONObject() : new JSONObject(text);
        } catch (Exception error) {
            result = new JSONObject();
            result.put("raw", text);
        }
        if (code < 200 || code >= 300) {
            throw new IOException(result.optString("error", "HTTP " + code));
        }
        return result;
    }

    private static String readText(InputStream input) throws IOException {
        BufferedInputStream stream = new BufferedInputStream(input);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = stream.read(buffer)) >= 0) {
                if (output.size() + read > MAX_RESPONSE_BYTES) {
                    throw new IOException("Η απάντηση του Worker είναι υπερβολικά μεγάλη.");
                }
                output.write(buffer, 0, read);
            }
            return new String(output.toByteArray(), UTF8);
        } finally {
            stream.close();
            output.close();
        }
    }
}
