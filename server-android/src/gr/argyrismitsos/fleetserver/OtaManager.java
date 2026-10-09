package gr.argyrismitsos.fleetserver;

import android.content.Context;
import android.content.SharedPreferences;
import gr.argyrismitsos.fleetupdates.OtaInstaller;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.atomic.AtomicBoolean;

/** Downloads independently; installation runs only after the sync cycle finishes. */
public final class OtaManager {
    private static final AtomicBoolean checking = new AtomicBoolean(false);
    private static final long INTERVAL = 15L * 60L * 1000L;
    private static final long LIMIT = 50L * 1024L * 1024L;
    private OtaManager() {}
    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences(BackupManager.PREFS, Context.MODE_PRIVATE); }
    private static File file(Context c) { return new File(c.getCacheDir(), "fleet-server-update.apk"); }
    private static void message(Context c, String value) { prefs(c).edit().putString("ota_message", value).apply(); }
    private static int currentCode(Context c) throws Exception { return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionCode; }
    public static void check(final Context c, boolean force) {
        final SharedPreferences p = prefs(c);
        if (!force && (!p.getBoolean("automatic_ota", true) || System.currentTimeMillis() - p.getLong("ota_checked_at", 0) < INTERVAL)) return;
        if (!checking.compareAndSet(false, true)) return;
        p.edit().putLong("ota_checked_at", System.currentTimeMillis()).apply();
        new Thread(new Runnable() { public void run() {
            try {
                String base = p.getString("worker_url", ServerConfig.DEFAULT_WORKER_URL).replaceAll("/+$", "");
                HttpURLConnection connection = open(new URL(base + "/api/server-update"));
                JSONObject info;
                try {
                    if (connection.getResponseCode() == 404) { message(c, "Ο Worker δεν έχει ακόμη ενεργοποιήσει τις OTA ενημερώσεις."); return; }
                    if (connection.getResponseCode() != 200) throw new IllegalStateException("Δεν ήταν δυνατός ο έλεγχος OTA.");
                    InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream();
                    try { byte[] buffer = new byte[4096]; int count; while ((count = in.read(buffer)) != -1) { if (out.size() + count > 65536) throw new IllegalStateException("Μεγάλο manifest."); out.write(buffer, 0, count); } }
                    finally { in.close(); }
                    info = new JSONObject(out.toString("UTF-8"));
                } finally { connection.disconnect(); }
                if (!info.optBoolean("available") || info.optInt("versionCode") <= currentCode(c)) {
                    p.edit().remove("ota_ready").remove("ota_apply_requested").apply(); file(c).delete();
                    message(c, "Ο Server έχει την τελευταία διαθέσιμη έκδοση."); return;
                }
                if (!c.getPackageName().equals(info.optString("packageName")) || !info.optString("sha256").matches("[a-f0-9]{64}") || info.optLong("sizeBytes") < 1 || info.optLong("sizeBytes") > LIMIT) throw new IllegalStateException("Μη έγκυρη ενημέρωση Server.");
                String old = p.getString("ota_ready", "");
                if (old.length() > 0 && file(c).isFile() && new JSONObject(old).optString("releaseId").equals(info.optString("releaseId"))) return;
                URL endpoint = new URL(info.getString("downloadUrl")), origin = new URL(base);
                if (!"https".equalsIgnoreCase(endpoint.getProtocol()) || !origin.getHost().equalsIgnoreCase(endpoint.getHost()) || origin.getPort() != endpoint.getPort() || !"/download/server.apk".equals(endpoint.getPath())) throw new IllegalStateException("Μη έγκυρη διεύθυνση OTA.");
                message(c, "Γίνεται λήψη Server " + info.getString("version") + "…");
                File part = new File(c.getCacheDir(), "fleet-server-update.part"); connection = open(endpoint);
                try {
                    if (connection.getResponseCode() != 200) throw new IllegalStateException("Η λήψη OTA απέτυχε.");
                    InputStream in = connection.getInputStream(); FileOutputStream out = new FileOutputStream(part);
                    try { byte[] buffer = new byte[65536]; long total = 0; int count; while ((count = in.read(buffer)) != -1) { total += count; if (total > LIMIT) throw new IllegalStateException("Μεγάλο APK."); out.write(buffer, 0, count); } out.getFD().sync(); }
                    finally { in.close(); out.close(); }
                    OtaInstaller.validate(c, part, info.getInt("versionCode"), info.getString("version"), info.getLong("sizeBytes"), info.getString("sha256"));
                    file(c).delete(); if (!part.renameTo(file(c))) throw new IllegalStateException("Δεν αποθηκεύτηκε η λήψη.");
                    p.edit().putString("ota_ready", info.toString()).putString("ota_message", "Έτοιμη η έκδοση " + info.getString("version") + ". Θα προηγηθεί backup.").apply();
                } finally { connection.disconnect(); part.delete(); }
            } catch (Exception error) { message(c, error.getMessage() == null ? "Ο έλεγχος OTA θα επαναληφθεί." : error.getMessage()); }
            finally { checking.set(false); }
        } }, "fleet-server-ota").start();
    }
    private static HttpURLConnection open(URL url) throws Exception {
        if (!"https".equalsIgnoreCase(url.getProtocol())) throw new IllegalStateException("Οι ενημερώσεις απαιτούν HTTPS.");
        HttpURLConnection c = (HttpURLConnection) url.openConnection(); c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(15000); c.setReadTimeout(30000); c.setUseCaches(false);
        c.setRequestProperty("X-Fleet-Server-Key", ServerConfig.SERVER_KEY); return c;
    }
    public static void requestApply(Context c) { prefs(c).edit().putBoolean("ota_apply_requested", true).putLong("ota_attempt_at", 0).apply(); }
    public static synchronized void maybeApply(Context c, FleetDataStore store) {
        SharedPreferences p = prefs(c);
        boolean requested = p.getBoolean("ota_apply_requested", false);
        if (!requested && !p.getBoolean("automatic_ota", true)) return;
        String raw = p.getString("ota_ready", ""); if (raw.length() == 0 || checking.get()) return;
        SharedPreferences install = OtaInstaller.preferences(c);
        String status = install.getString("status", "");
        if ("installing".equals(status) || "confirmation".equals(status)) {
            int id = install.getInt("session_id", -1);
            if (id >= 0 && c.getPackageManager().getPackageInstaller().getSessionInfo(id) != null) return;
            install.edit().putString("status", "failed").putInt("session_id", -1).apply();
        }
        if (!requested && System.currentTimeMillis() - p.getLong("ota_attempt_at", 0) < INTERVAL) return;
        if (!OtaInstaller.canInstall(c)) { message(c, "Χρειάζεται άδεια εγκατάστασης. Πάτησε «Εγκατάσταση ενημέρωσης»."); return; }
        if (p.getString(BackupManager.KEY_FOLDER_URI, "").length() == 0) { message(c, "Επίλεξε πρώτα φάκελο backup για την ενημέρωση Server."); return; }
        try {
            JSONObject info = new JSONObject(raw);
            if (info.optInt("versionCode") <= currentCode(c)) { p.edit().remove("ota_ready").remove("ota_apply_requested").apply(); return; }
            p.edit().putLong("ota_attempt_at", System.currentTimeMillis()).putBoolean("ota_apply_requested", false).apply();
            OtaInstaller.validate(c, file(c), info.getInt("versionCode"), info.getString("version"), info.getLong("sizeBytes"), info.getString("sha256"));
            message(c, "Δημιουργία backup πριν από την ενημέρωση…");
            String backup = BackupManager.createBackup(c, store);
            p.edit().putString("ota_backup_name", backup).putLong("ota_backup_at", System.currentTimeMillis()).apply();
            OtaInstaller.install(c, file(c)); message(c, "Το backup ολοκληρώθηκε. Γίνεται εγκατάσταση…");
        } catch (Exception error) { message(c, "Η ενημέρωση δεν εφαρμόστηκε: " + (error.getMessage() == null ? "Δοκίμασε ξανά." : error.getMessage())); }
    }
    public static JSONObject state(Context c) throws Exception {
        SharedPreferences p = prefs(c), install = OtaInstaller.preferences(c); JSONObject value = new JSONObject();
        value.put("automatic", p.getBoolean("automatic_ota", true)); value.put("message", p.getString("ota_message", "Έλεγχος ενημερώσεων κάθε 15 λεπτά."));
        value.put("installStatus", install.getString("status", "")); value.put("installMessage", install.getString("message", ""));
        value.put("checkedAt", p.getLong("ota_checked_at", 0)); value.put("backupName", p.getString("ota_backup_name", ""));
        String raw = p.getString("ota_ready", ""); if (raw.length() > 0) value.put("ready", new JSONObject(raw));
        return value;
    }
}
