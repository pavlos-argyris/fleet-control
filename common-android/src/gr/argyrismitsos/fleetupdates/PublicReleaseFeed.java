package gr.argyrismitsos.fleetupdates;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Public signed-APK channel. Never receives Fleet/Ordexa credentials. */
public final class PublicReleaseFeed {
    private static final String ROOT = "https://github.com/pavlos-argyris/fleet-control/releases/";
    private static final String LATEST = ROOT + "latest/download/release-manifest.json";
    private static final long APK_LIMIT = 192L * 1024 * 1024;

    interface ConnectionFactory { HttpURLConnection open(URL url) throws IOException; }

    private PublicReleaseFeed() { }

    public static boolean downloadUrl(String value) {
        try {
            URL url = new URL(value);
            return standardHttps(url) && url.getHost().equals("github.com") && url.getQuery() == null
                    && url.getPath().matches("/pavlos-argyris/fleet-control/releases/download/fleet-v[0-9.]+/Fleet_Control_(Client|Server)_v[0-9.]+\\.apk");
        } catch (Exception invalid) {
            return false;
        }
    }

    private static boolean standardHttps(URL url) {
        return "https".equals(url.getProtocol()) && url.getUserInfo() == null && url.getPort() == -1 && url.getRef() == null;
    }

    /** Returns the final connection with response headers already available. */
    public static HttpURLConnection open(URL initial) throws Exception {
        return open(initial, new ConnectionFactory() {
            @Override public HttpURLConnection open(URL url) throws IOException {
                return (HttpURLConnection) url.openConnection();
            }
        });
    }

    static HttpURLConnection open(URL initial, ConnectionFactory factory) throws Exception {
        boolean manifest = LATEST.equals(initial.toString());
        if (!manifest && !downloadUrl(initial.toString())) throw new IOException("Μη έγκυρη διεύθυνση έκδοσης.");
        URL next = initial;
        for (int redirects = 0; redirects < 6; redirects++) {
            if (!standardHttps(next) || !(next.getHost().equals("github.com") || next.getHost().equals("release-assets.githubusercontent.com"))) {
                throw new IOException("Μη έγκυρη ανακατεύθυνση έκδοσης.");
            }
            HttpURLConnection connection = factory.open(next);
            boolean keepOpen = false;
            try {
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(30000);
                connection.setInstanceFollowRedirects(false);
                connection.setUseCaches(false);
                connection.setRequestProperty("Accept", manifest ? "application/json" : "application/vnd.android.package-archive");
                int status = connection.getResponseCode();
                if (status < 300 || status >= 400) {
                    keepOpen = true;
                    return connection;
                }
                String location = connection.getHeaderField("Location");
                if (location == null) throw new IOException("Η λήψη έκδοσης δεν επιβεβαιώθηκε.");
                next = new URL(next, location);
            } finally {
                if (!keepOpen) connection.disconnect();
            }
        }
        throw new IOException("Πολλές ανακατευθύνσεις έκδοσης.");
    }

    public static JSONObject latest(String kind) throws Exception {
        if (!"client".equals(kind) && !"server".equals(kind)) throw new IllegalArgumentException("Invalid component");
        HttpURLConnection connection = open(new URL(LATEST));
        try {
            if (connection.getResponseCode() != 200) throw new IOException("Δεν επιβεβαιώθηκε η διαθέσιμη έκδοση GitHub.");
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    if (output.size() + read > 131072) throw new IOException("Μεγάλο manifest έκδοσης.");
                    output.write(buffer, 0, read);
                }
                return parse(new JSONObject(output.toString("UTF-8")), kind);
            }
        } finally {
            connection.disconnect();
        }
    }

    static JSONObject parse(JSONObject manifest, String kind) throws Exception {
        boolean client = "client".equals(kind);
        if (!client && !"server".equals(kind)) throw new IllegalArgumentException("Invalid component");
        JSONObject value = new JSONObject(manifest.getJSONObject(kind).toString());
        String release = manifest.getString("releaseId"), version = value.getString("version"), file = value.getString("file");
        String packageName = client ? "gr.argyrismitsos.fleetcontrol" : "gr.argyrismitsos.fleetserver";
        long bytes = value.getLong("sizeBytes");
        if (!version.matches("[0-9]+\\.[0-9]+\\.[0-9]+") || !release.matches("v[0-9]+\\.[0-9]+\\.[0-9]+-[a-f0-9]{12}")
                || !packageName.equals(value.optString("packageName")) || value.optInt("versionCode") < 1
                || !value.getString("sha256").matches("[a-f0-9]{64}") || bytes < 1 || bytes > APK_LIMIT
                || !file.equals("Fleet_Control_" + (client ? "Client" : "Server") + "_v" + version + ".apk")) {
            throw new IOException("Μη έγκυρο manifest έκδοσης.");
        }
        String tag = "fleet-" + release.substring(0, release.lastIndexOf('-'));
        return value.put("available", true).put("releaseId", release).put("notes", manifest.optString("notes"))
                .put("downloadUrl", ROOT + "download/" + tag + "/" + file);
    }
}
