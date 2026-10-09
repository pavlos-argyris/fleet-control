package gr.argyrismitsos.fleetupdates;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/** Shared self-update installer. Android always remains the final authority. */
public final class OtaInstaller {
    public static final String PREFS = "fleet_ota_install";
    private static WeakReference<Activity> foreground = new WeakReference<Activity>(null);
    private OtaInstaller() {}
    public static SharedPreferences preferences(Context context) { return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    public static boolean canInstall(Context context) {
        if (Build.VERSION.SDK_INT < 26) return true;
        try { return Boolean.TRUE.equals(PackageManager.class.getMethod("canRequestPackageInstalls").invoke(context.getPackageManager())); }
        catch (Exception ignored) { return false; }
    }
    public static void openPermission(Activity activity) {
        Intent intent = new Intent("android.settings.MANAGE_UNKNOWN_APP_SOURCES", Uri.parse("package:" + activity.getPackageName()));
        activity.startActivity(intent);
    }
    public static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        InputStream in = new FileInputStream(file);
        try { byte[] buffer = new byte[65536]; int read; while ((read = in.read(buffer)) != -1) digest.update(buffer, 0, read); }
        finally { in.close(); }
        StringBuilder text = new StringBuilder(); for (byte b : digest.digest()) text.append(String.format(Locale.US, "%02x", b & 255)); return text.toString();
    }
    private static Set<String> certificates(Signature[] signatures) throws Exception {
        Set<String> result = new HashSet<String>();
        if (signatures != null) for (Signature signature : signatures) {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(signature.toByteArray());
            StringBuilder text = new StringBuilder(); for (byte b : bytes) text.append(String.format(Locale.US, "%02x", b & 255)); result.add(text.toString());
        }
        return result;
    }
    public static void validate(Context context, File apk, int versionCode, String version, long size, String checksum) throws Exception {
        if (!apk.isFile() || size < 1 || size > 50L * 1024L * 1024L || apk.length() != size || checksum == null || !checksum.matches("[a-fA-F0-9]{64}") || !sha256(apk).equalsIgnoreCase(checksum)) throw new IllegalStateException("Το APK δεν πέρασε τον έλεγχο SHA-256/μεγέθους.");
        PackageManager pm = context.getPackageManager();
        PackageInfo archive = pm.getPackageArchiveInfo(apk.getAbsolutePath(), PackageManager.GET_SIGNATURES);
        PackageInfo installed = pm.getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNATURES);
        if (archive == null || !context.getPackageName().equals(archive.packageName) || !version.equals(archive.versionName) || archive.versionCode <= installed.versionCode || (versionCode > 0 && archive.versionCode != versionCode)) throw new IllegalStateException("Το APK δεν είναι έγκυρη νεότερη έκδοση της εφαρμογής.");
        Set<String> trusted = certificates(installed.signatures), supplied = certificates(archive.signatures);
        if (trusted.isEmpty() || !trusted.equals(supplied)) throw new IllegalStateException("Το APK έχει διαφορετική υπογραφή.");
    }
    public static synchronized void install(Context context, File apk) throws Exception {
        if (!canInstall(context)) throw new IllegalStateException("Ενεργοποίησε την άδεια εγκατάστασης ενημερώσεων.");
        PackageInstaller installer = context.getPackageManager().getPackageInstaller();
        SharedPreferences prefs = preferences(context);
        int previous = prefs.getInt("session_id", -1);
        if (previous >= 0 && installer.getSessionInfo(previous) != null) throw new IllegalStateException("Υπάρχει ήδη εγκατάσταση σε εξέλιξη.");
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(context.getPackageName()); params.setSize(apk.length());
        if (Build.VERSION.SDK_INT >= 31) PackageInstaller.SessionParams.class.getMethod("setRequireUserAction", int.class).invoke(params, 2);
        int id = installer.createSession(params);
        PackageInstaller.Session session = null;
        try {
            session = installer.openSession(id);
            InputStream in = new FileInputStream(apk); OutputStream out = session.openWrite("base.apk", 0, apk.length());
            try { byte[] buffer = new byte[65536]; int read; while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read); session.fsync(out); }
            finally { in.close(); out.close(); }
            Intent callback = new Intent(context, OtaInstallReceiver.class).setAction(context.getPackageName() + ".OTA_RESULT");
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? 0x02000000 : 0);
            PendingIntent result = PendingIntent.getBroadcast(context, id, callback, flags);
            prefs.edit().putInt("session_id", id).putString("status", "installing").putString("message", "Γίνεται εγκατάσταση της ενημέρωσης…").remove("confirmation").commit();
            session.commit(result.getIntentSender());
        } catch (Exception error) {
            installer.abandonSession(id);
            prefs.edit().putInt("session_id", -1).putString("status", "failed").putString("message", "Η εγκατάσταση δεν ξεκίνησε.").apply();
            throw error;
        } finally { if (session != null) session.close(); }
    }
    public static void resume(Activity activity) { foreground = new WeakReference<Activity>(activity); openConfirmation(activity); }
    public static void pause(Activity activity) { if (foreground.get() == activity) foreground.clear(); }
    public static void openConfirmation(Activity activity) {
        SharedPreferences prefs = preferences(activity); String raw = prefs.getString("confirmation", "");
        if (raw.length() == 0) return;
        try { activity.startActivity(Intent.parseUri(raw, 0)); prefs.edit().remove("confirmation").apply(); }
        catch (Exception ignored) { prefs.edit().putString("message", "Πάτησε την ειδοποίηση για εγκατάσταση.").apply(); }
    }
    static void pending(Context context, final Intent confirmation) {
        preferences(context).edit().putString("status", "confirmation").putString("message", "Το Android χρειάζεται επιβεβαίωση εγκατάστασης.").putString("confirmation", confirmation.toUri(0)).apply();
        try {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            String channel = "fleet_ota_updates";
            if (Build.VERSION.SDK_INT >= 26) {
                Class<?> type = Class.forName("android.app.NotificationChannel");
                Object value = type.getConstructor(String.class, CharSequence.class, int.class).newInstance(channel, "Ενημερώσεις Fleet Control", 3);
                NotificationManager.class.getMethod("createNotificationChannel", type).invoke(manager, value);
            }
            confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent action = PendingIntent.getActivity(context, 7199, confirmation, PendingIntent.FLAG_UPDATE_CURRENT | 0x04000000);
            Notification.Builder builder = new Notification.Builder(context).setSmallIcon(context.getApplicationInfo().icon).setContentTitle("Ενημέρωση Fleet Control").setContentText("Πάτησε για επιβεβαίωση εγκατάστασης.").setContentIntent(action).setAutoCancel(true);
            if (Build.VERSION.SDK_INT >= 26) Notification.Builder.class.getMethod("setChannelId", String.class).invoke(builder, channel);
            manager.notify(7199, builder.build());
        } catch (Exception ignored) { /* The status remains accessible in the app even without notifications. */ }
        final Activity activity = foreground.get();
        if (activity != null && !activity.isFinishing() && activity.hasWindowFocus()) activity.runOnUiThread(new Runnable() { public void run() { openConfirmation(activity); } });
    }
}
