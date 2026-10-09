package gr.argyrismitsos.fleetserver;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URLEncoder;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public final class UpdateManager {
    private static final int MAX_WEB_FILES = 250;
    private static final int MAX_WEB_FILE_BYTES = 10 * 1024 * 1024;
    private static final int MAX_WEB_TOTAL_BYTES = 60 * 1024 * 1024;

    private UpdateManager() {
    }

    public static JSONObject uploadClientApk(Context context, Uri uri) throws Exception {
        File temporary = new File(context.getCacheDir(), "fleet-client-upload.apk");
        copy(context.getContentResolver().openInputStream(uri), new FileOutputStream(temporary), MAX_WEB_TOTAL_BYTES * 3L);
        PackageInfo info = context.getPackageManager().getPackageArchiveInfo(temporary.getAbsolutePath(), 0);
        if (info == null || !"gr.argyrismitsos.fleetcontrol".equals(info.packageName)) {
            temporary.delete();
            throw new IllegalArgumentException("Το αρχείο δεν είναι έγκυρο Fleet Control Client APK.");
        }
        String version = info == null || info.versionName == null
                ? new SimpleDateFormat("yyyyMMdd-HHmm", Locale.US).format(new Date())
                : info.versionName;

        Map<String, String> headers = SyncService.serverHeaders();
        headers.put("X-Release-Version", version);
        headers.put("X-Release-Notes", "Ανέβηκε από το Fleet Control Server");
        JSONObject result = FleetHttp.putStream(workerUrl(context) + "/api/admin/releases/client",
                new FileInputStream(temporary), temporary.length(), "application/vnd.android.package-archive", headers);
        temporary.delete();
        return result;
    }

    public static JSONObject uploadWebPackage(Context context, Uri uri) throws Exception {
        String release = "web-" + new SimpleDateFormat("yyyyMMddHHmmss", Locale.US).format(new Date());
        String version = new SimpleDateFormat("yyyy.MM.dd-HHmm", Locale.US).format(new Date());
        JSONArray files = new JSONArray();
        int total = 0;
        int count = 0;
        ZipInputStream zip = new ZipInputStream(context.getContentResolver().openInputStream(uri));
        try {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (entry.isDirectory()) continue;
                String path = safePath(entry.getName());
                if (path.length() == 0) throw new IllegalArgumentException("Το web πακέτο περιέχει μη έγκυρη διαδρομή.");
                if (++count > MAX_WEB_FILES) throw new IllegalArgumentException("Το web πακέτο έχει πάρα πολλά αρχεία.");
                byte[] data = readEntry(zip, MAX_WEB_FILE_BYTES);
                total += data.length;
                if (total > MAX_WEB_TOTAL_BYTES) throw new IllegalArgumentException("Το web πακέτο είναι πολύ μεγάλο.");
                String endpoint = workerUrl(context) + "/api/admin/web-assets/" + release + "/" + encodePath(path);
                FleetHttp.putStream(endpoint, new ByteArrayInputStream(data), data.length, contentType(path), SyncService.serverHeaders());
                files.put(path);
            }
        } finally {
            zip.close();
        }
        boolean hasIndex = false;
        for (int i = 0; i < files.length(); i++) if ("index.html".equals(files.optString(i))) hasIndex = true;
        if (!hasIndex) throw new IllegalArgumentException("Το web πακέτο πρέπει να περιέχει index.html στην αρχή του ZIP.");

        JSONObject activate = new JSONObject();
        activate.put("release", release);
        activate.put("version", version);
        activate.put("notes", "Ανέβηκε από το Fleet Control Server");
        activate.put("files", files);
        return FleetHttp.sendJson(workerUrl(context) + "/api/admin/web-assets/activate", "POST", activate, SyncService.serverHeaders());
    }

    public static JSONObject listReleases(Context context) throws Exception {
        return FleetHttp.getJson(workerUrl(context) + "/api/admin/releases", SyncService.serverHeaders());
    }

    public static JSONObject activateRelease(Context context, String id) throws Exception {
        JSONObject body = new JSONObject();
        body.put("id", id);
        return FleetHttp.sendJson(workerUrl(context) + "/api/admin/releases/activate", "POST", body, SyncService.serverHeaders());
    }

    private static String workerUrl(Context context) {
        SharedPreferences preferences = context.getSharedPreferences(BackupManager.PREFS, Context.MODE_PRIVATE);
        String value = preferences.getString("worker_url", ServerConfig.DEFAULT_WORKER_URL);
        return (value == null || value.length() == 0 ? ServerConfig.DEFAULT_WORKER_URL : value).replaceAll("/+$", "");
    }

    private static String safePath(String value) {
        String result = value == null ? "" : value.replace('\\', '/').replaceAll("^/+", "");
        if (result.contains("..") || result.length() > 220) return "";
        return result;
    }

    private static String encodePath(String path) throws Exception {
        String[] parts = path.split("/");
        StringBuilder result = new StringBuilder();
        for (String part : parts) {
            if (result.length() > 0) result.append('/');
            result.append(URLEncoder.encode(part, "UTF-8").replace("+", "%20"));
        }
        return result.toString();
    }

    private static String contentType(String path) {
        String lower = path.toLowerCase(Locale.US);
        if (lower.endsWith(".html")) return "text/html; charset=utf-8";
        if (lower.endsWith(".css")) return "text/css; charset=utf-8";
        if (lower.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (lower.endsWith(".json") || lower.endsWith(".webmanifest")) return "application/json; charset=utf-8";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    private static byte[] readEntry(InputStream input, int limit) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = input.read(buffer)) >= 0) {
            if (output.size() + read > limit) throw new IllegalArgumentException("Ένα αρχείο του web πακέτου είναι πολύ μεγάλο.");
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static void copy(InputStream input, FileOutputStream output, long limit) throws Exception {
        if (input == null) throw new IllegalArgumentException("Το αρχείο δεν είναι διαθέσιμο.");
        long total = 0;
        try {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                total += read;
                if (total > limit) throw new IllegalArgumentException("Το APK είναι πολύ μεγάλο.");
                output.write(buffer, 0, read);
            }
        } finally {
            input.close();
            output.close();
        }
    }
}
