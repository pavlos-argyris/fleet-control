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
    private static final long LIMIT = 50L * 1024L * 1024L;
    private OtaManager() {}
    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences(BackupManager.PREFS, Context.MODE_PRIVATE); }
    private static File file(Context c) { return new File(c.getCacheDir(), "fleet-server-update.apk"); }
    private static void stage(Context c, String stage, String value) { prefs(c).edit().putString("ota_stage", stage).putString("ota_message", value).apply(); }
    private static int currentCode(Context c) throws Exception { return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionCode; }
    public static void check(final Context c, boolean force) {
        final SharedPreferences p = prefs(c);
        if (!OtaPolicy.checkDue(System.currentTimeMillis(), p.getLong("ota_checked_at", 0), force, p.getBoolean("automatic_ota", true))) return;
        if (!checking.compareAndSet(false, true)) return;
        p.edit().putLong("ota_checked_at", System.currentTimeMillis()).apply();
        stage(c, "checking", "Έλεγχος νέας έκδοσης…");
        new Thread(new Runnable() { public void run() {
            try {
                String base = p.getString("worker_url", ServerConfig.DEFAULT_WORKER_URL).replaceAll("/+$", "");
                HttpURLConnection connection = open(new URL(base + "/api/server-update"));
                JSONObject info;
                try {
                    if (connection.getResponseCode() == 404) { stage(c, "failed", "Ο Worker δεν έχει ακόμη ενεργοποιήσει τις OTA ενημερώσεις."); return; }
                    if (connection.getResponseCode() != 200) throw new IllegalStateException("Δεν ήταν δυνατός ο έλεγχος OTA.");
                    InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream();
                    try { byte[] buffer = new byte[4096]; int count; while ((count = in.read(buffer)) != -1) { if (out.size() + count > 65536) throw new IllegalStateException("Μεγάλο manifest."); out.write(buffer, 0, count); } }
                    finally { in.close(); }
                    info = new JSONObject(out.toString("UTF-8"));
                } finally { connection.disconnect(); }
                if (!info.optBoolean("available") || info.optInt("versionCode") <= currentCode(c)) {
                    p.edit().remove("ota_ready").remove("ota_apply_requested").remove("ota_force_requested").remove("ota_quiescing").apply(); BackupJobs.resumePending(c);file(c).delete();
                    stage(c, "current", "Ο Server έχει την τελευταία διαθέσιμη έκδοση."); return;
                }
                if (!c.getPackageName().equals(info.optString("packageName")) || !info.optString("sha256").matches("[a-f0-9]{64}") || info.optLong("sizeBytes") < 1 || info.optLong("sizeBytes") > LIMIT) throw new IllegalStateException("Μη έγκυρη ενημέρωση Server.");
                String old = p.getString("ota_ready", "");
                if (old.length() > 0 && file(c).isFile() && new JSONObject(old).optString("releaseId").equals(info.optString("releaseId"))) { stage(c, "waiting", "Η έκδοση " + info.getString("version") + " είναι έτοιμη. Δες παρακάτω ποια εργασία αναμένεται ή το στάδιο του backup."); return; }
                URL endpoint = new URL(info.getString("downloadUrl")), origin = new URL(base);
                if (!"https".equalsIgnoreCase(endpoint.getProtocol()) || !origin.getHost().equalsIgnoreCase(endpoint.getHost()) || origin.getPort() != endpoint.getPort() || !"/download/server.apk".equals(endpoint.getPath())) throw new IllegalStateException("Μη έγκυρη διεύθυνση OTA.");
                stage(c, "downloading", "Γίνεται λήψη Server " + info.getString("version") + "…");
                p.edit().putLong("ota_total_bytes", info.getLong("sizeBytes")).putLong("ota_downloaded_bytes", 0).putInt("ota_download_percent", 0).apply();
                File part = new File(c.getCacheDir(), "fleet-server-update.part"); connection = open(endpoint);
                try {
                    if (connection.getResponseCode() != 200) throw new IllegalStateException("Η λήψη OTA απέτυχε.");
                    InputStream in = connection.getInputStream(); FileOutputStream out = new FileOutputStream(part);
                    try {
                        byte[] buffer = new byte[65536]; long total = 0, lastProgress = 0; int count;
                        while ((count = in.read(buffer)) != -1) {
                            total += count; if (total > LIMIT) throw new IllegalStateException("Μεγάλο APK."); out.write(buffer, 0, count);
                            long now = System.currentTimeMillis();
                            if (now - lastProgress >= 250 || total >= info.getLong("sizeBytes")) {
                                p.edit().putLong("ota_downloaded_bytes", total).putInt("ota_download_percent", (int)Math.min(100, total * 100L / info.getLong("sizeBytes"))).apply();
                                lastProgress = now;
                            }
                        }
                        out.getFD().sync();
                    }
                    finally { in.close(); out.close(); }
                    stage(c, "validating", "Έλεγχος αρχείου και υπογραφής…");
                    OtaInstaller.validate(c, part, info.getInt("versionCode"), info.getString("version"), info.getLong("sizeBytes"), info.getString("sha256"));
                    file(c).delete(); if (!part.renameTo(file(c))) throw new IllegalStateException("Δεν αποθηκεύτηκε η λήψη.");
                    p.edit().remove("ota_checkpoint_job").remove("ota_checkpoint_error").remove("ota_hold").putString("ota_ready", info.toString()).putString("ota_stage", "waiting").putString("ota_message", "Έτοιμη η έκδοση " + info.getString("version") + ". Θα προηγηθεί backup.").apply();
                } finally { connection.disconnect(); part.delete(); }
            } catch (Exception error) { stage(c, "failed", error.getMessage() == null ? "Ο έλεγχος OTA θα επαναληφθεί." : error.getMessage()); }
            finally { checking.set(false); }
        } }, "fleet-server-ota").start();
    }
    private static HttpURLConnection open(URL url) throws Exception {
        if (!"https".equalsIgnoreCase(url.getProtocol())) throw new IllegalStateException("Οι ενημερώσεις απαιτούν HTTPS.");
        HttpURLConnection c = (HttpURLConnection) url.openConnection(); c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(15000); c.setReadTimeout(30000); c.setUseCaches(false);
        c.setRequestProperty("X-Fleet-Server-Key", ServerConfig.SERVER_KEY); return c;
    }
    public static void requestApply(Context c) { if(!prefs(c).getBoolean("ota_quiescing",false))prefs(c).edit().remove("ota_checkpoint_job").commit();prefs(c).edit().putBoolean("ota_apply_requested", true).putBoolean("ota_hold",false).remove("ota_checkpoint_error").putLong("ota_attempt_at", 0).apply(); }
    public static void requestForce(Context c){requestApply(c);prefs(c).edit().putBoolean("ota_force_requested",true).putBoolean("ota_quiescing",true).commit();BackupJobs.pauseExports(c);stage(c,"waiting","Ζητήθηκε παύση εργασιών. Η εγκατάσταση θα ξεκινήσει μόνο μετά από ασφαλές σημείο και επαληθευμένο τοπικό backup.");}
    public static void cancelWait(Context c){if(installationPending(c))return;prefs(c).edit().putBoolean("ota_hold",true).putBoolean("ota_quiescing",false).putBoolean("ota_force_requested",false).putBoolean("ota_apply_requested",false).remove("ota_checkpoint_job").remove("ota_checkpoint_error").commit();BackupJobs.resumePending(c);stage(c,"waiting","Η ενημέρωση αναβλήθηκε. Οι εργασίες συνεχίζονται. Πάτησε Εγκατάσταση ενημέρωσης όταν είσαι έτοιμος.");}
    public static boolean forceRequested(Context c){return prefs(c).getBoolean("ota_force_requested",false);}
    public static boolean shouldYieldForUpdate(Context c) {
        SharedPreferences p=prefs(c);if(installationPending(c))return true;
        if(p.getBoolean("ota_quiescing",false))return true;
        return !p.getBoolean("ota_hold",false)&&!checking.get()&&OtaPolicy.yieldForUpdate(System.currentTimeMillis(),p.getLong("ota_attempt_at",0),p.getString("ota_ready","").length()>0&&file(c).isFile(),p.getBoolean("ota_apply_requested",false),p.getBoolean("automatic_ota",true),OtaInstaller.canInstall(c),p.getString(BackupManager.KEY_FOLDER_URI,"").length()>0);
    }
    public static void resumeAfterRestart(Context c){
        BackupJobs.recoverAfterRestart(c);
        try{String raw=prefs(c).getString("ota_ready","");if(raw.length()==0||new JSONObject(raw).optInt("versionCode")<=currentCode(c)){prefs(c).edit().remove("ota_ready").remove("ota_quiescing").remove("ota_force_requested").remove("ota_apply_requested").remove("ota_checkpoint_job").remove("ota_checkpoint_error").apply();BackupJobs.resumePending(c);}}catch(Exception ignored){}
    }
    public static boolean installationPending(Context c) {
        SharedPreferences p = OtaInstaller.preferences(c);
        String status = p.getString("status", "");
        int id = p.getInt("session_id", -1);
        return ("installing".equals(status) || "confirmation".equals(status)) && id >= 0
            && c.getPackageManager().getPackageInstaller().getSessionInfo(id) != null;
    }
    public static boolean installationInProgress(Context c) { return installationPending(c) && "installing".equals(OtaInstaller.preferences(c).getString("status", "")); }
    public static synchronized void maybeApply(Context c, FleetDataStore store) {
        SharedPreferences p=prefs(c);boolean requested=p.getBoolean("ota_apply_requested",false),force=forceRequested(c);
        if(p.getBoolean("ota_hold",false)||(!requested&&!p.getBoolean("automatic_ota",true))||installationPending(c))return;
        String raw=p.getString("ota_ready","");if(raw.length()==0||checking.get())return;
        if(!requested&&!p.getBoolean("ota_quiescing",false)&&System.currentTimeMillis()-p.getLong("ota_attempt_at",0)<OtaPolicy.RETRY_INTERVAL_MS)return;
        if(!OtaInstaller.canInstall(c)){stage(c,"permission","Χρειάζεται άδεια εγκατάστασης. Πάτησε «Εγκατάσταση ενημέρωσης».");return;}
        if(!force&&p.getString(BackupManager.KEY_FOLDER_URI,"").length()==0){stage(c,"backup_folder","Επίλεξε φάκελο backup. Η «Παύση & ενημέρωση» μπορεί να χρησιμοποιήσει επαληθευμένο τοπικό αντίγραφο, που δεν αντέχει σε απεγκατάσταση.");return;}
        try{
            JSONObject info=new JSONObject(raw);if(info.optInt("versionCode")<=currentCode(c)){resumeAfterRestart(c);return;}
            synchronized(ServerWorkTracker.class){p.edit().putBoolean("ota_quiescing",true).apply();if(ServerWorkTracker.busy()){stage(c,"waiting","Αναμονή ασφαλούς σημείου της εργασίας που εμφανίζεται παρακάτω. Η παύση δεν εγκαταλείπει καταχωρήσεις.");return;}}
            JSONObject job=BackupJobs.requestForUpdate(c,store,info.getString("releaseId"));
            if(job==null){String error=p.getString("ota_checkpoint_error","");stage(c,error.length()>0?"backup_failed":"backup",error.length()>0?error:"Προετοιμασία τοπικού αντιγράφου πριν την ενημέρωση. Δες το αναλυτικό στάδιο στα Αντίγραφα.");return;}
            if(!job.optBoolean("localReady")){stage(c,"backup","Αναμονή ολοκλήρωσης τοπικού αντιγράφου.");return;}
            if(!force&&!job.optBoolean("exported")){stage(c,"backup","Το τοπικό αντίγραφο είναι έτοιμο. Αναμονή αποστολής στον φάκελο backup· δες πρόοδο ή επίλεξε Επανάληψη αποστολής / Παύση & ενημέρωση.");return;}
            if(!BackupJobs.localReady(c,job))throw new IllegalStateException("Δεν υπάρχει επαληθευμένο τοπικό αντίγραφο.");
            OtaInstaller.validate(c,file(c),info.getInt("versionCode"),info.getString("version"),info.getLong("sizeBytes"),info.getString("sha256"));
            p.edit().putLong("ota_attempt_at",System.currentTimeMillis()).putBoolean("ota_apply_requested",false).putString("ota_backup_name",job.getString("fileName")).putLong("ota_backup_at",System.currentTimeMillis()).commit();
            OtaInstaller.install(c,file(c));stage(c,"installing",job.optBoolean("exported")?"Το backup αποθηκεύτηκε. Γίνεται εγκατάσταση…":"Το τοπικό backup επαληθεύτηκε. Γίνεται εγκατάσταση· η εκκρεμής αποστολή θα επαναληφθεί μετά.");
        }catch(Exception error){p.edit().remove("ota_checkpoint_job").putBoolean("ota_quiescing",false).putBoolean("ota_apply_requested",false).putBoolean("ota_force_requested",false).putLong("ota_attempt_at",System.currentTimeMillis()).apply();BackupJobs.resumePending(c);stage(c,"failed","Η ενημέρωση δεν εφαρμόστηκε: "+(error.getMessage()==null?"Δοκίμασε ξανά.":error.getMessage()));}
    }
    public static JSONObject state(Context c) throws Exception {
        SharedPreferences p = prefs(c), install = OtaInstaller.preferences(c); JSONObject value = new JSONObject();
        value.put("stage", p.getString("ota_stage", "idle"));
        value.put("blockers",ServerWorkTracker.get()).put("backupProgress",BackupStatus.get(c)).put("pauseRequested",p.getBoolean("ota_quiescing",false)).put("forceRequested",forceRequested(c)).put("held",p.getBoolean("ota_hold",false));
        value.put("downloadPercent", p.getInt("ota_download_percent", 0));
        value.put("downloadedBytes", p.getLong("ota_downloaded_bytes", 0));
        value.put("totalBytes", p.getLong("ota_total_bytes", 0));
        value.put("automatic", p.getBoolean("automatic_ota", true)); value.put("message", p.getString("ota_message", "Έλεγχος ενημερώσεων κάθε ώρα."));
        value.put("installStatus", install.getString("status", "")); value.put("installMessage", install.getString("message", ""));
        value.put("checkedAt", p.getLong("ota_checked_at", 0)); value.put("backupName", p.getString("ota_backup_name", ""));
        String raw = p.getString("ota_ready", ""); if (raw.length() > 0) value.put("ready", new JSONObject(raw));
        return value;
    }
}
