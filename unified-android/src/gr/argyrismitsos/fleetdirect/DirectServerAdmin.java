package gr.argyrismitsos.fleetdirect;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Calendar;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** Runs only the built-in commands committed by the owner-only Direct API. */
final class DirectServerAdmin {
    private static final ExecutorService worker = Executors.newSingleThreadExecutor(task -> new Thread(task, "fleet-direct-admin"));
    private static final AtomicBoolean running = new AtomicBoolean();
    private static volatile long nextCheckAt;
    private static boolean recovered;

    private DirectServerAdmin() { }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(BackupManager.PREFS, Context.MODE_PRIVATE);
    }

    static JSONObject status(Context context) throws Exception {
        SharedPreferences prefs = preferences(context);
        JSONObject configuration = IndependentConfig.read(context);
        JSONObject hardware = DeviceHealth.collect(context);
        JSONObject provider = OrdexaSync.status(context);
        JSONObject backup = BackupStatus.get(context);
        JSONObject ota = OtaManager.state(context);
        SharedPreferences ui = context.getSharedPreferences("independent_ui", 0);
        JSONObject health = select(hardware, "storageFreeBytes", "storageTotalBytes", "batteryPercent", "batteryCharging",
                "batteryTemperatureC", "thermalStatus", "networkConnected", "androidVersion", "uptimeSeconds");
        JSONObject ordexa = select(provider, "configured", "enabled", "busy", "authState", "lastSuccess");
        JSONObject origin = IndependentService.diagnostics();
        JSONObject https = select(origin, "serviceRunning", "listenerActive", "serviceStartedAt", "listenerObservedAt",
                "listenerError", "wifiConnected", "cpuLockHeld", "wifiLockHeld", "ignoringBatteryOptimizations", "interactive", "deviceIdle");
        String hostname = configuration.optString("hostname");
        long expiresAt = 0;
        if (!hostname.isEmpty()) try { expiresAt = IndependentTls.expires(context); }
        catch (Exception unavailable) { }
        https.put("hostname", hostname).put("certificateExpiresAt", expiresAt)
                .put("dnsLastUpdatedAt", ui.getLong("dnsLastUpdatedAt", 0));

        JSONObject backupView = backupSettings(prefs).put("folderSelected", !prefs.getString(BackupManager.KEY_FOLDER_URI, "").isEmpty())
                .put("lastAt", prefs.getString(BackupManager.KEY_LAST_TIME, ""))
                .put("state", select(backup, "state", "percent", "bytesDone", "bytesTotal", "localReady", "lastProgressAt"));
        JSONObject update = select(ota, "stage", "automatic", "checkedAt", "installStatus", "downloadPercent");
        update.put("availableVersion", ota.optJSONObject("ready") == null ? "" : ota.getJSONObject("ready").optString("version"));
        return new JSONObject().put("observedAt", System.currentTimeMillis()).put("serverVersion", ServerConfig.SERVER_VERSION)
                .put("https", https).put("device", health).put("ordexa", ordexa).put("backup", backupView).put("update", update)
                .put("activeWork", ServerWorkTracker.get().length()).put("invoiceStage", ui.getString("invoice", ""));
    }

    private static JSONObject select(JSONObject value, String... keys) throws Exception {
        JSONObject result = new JSONObject();
        for (String key : keys) if (value.has(key)) result.put(key, value.get(key));
        return result;
    }

    private static JSONObject backupSettings(SharedPreferences prefs) throws Exception {
        boolean enabled = prefs.getBoolean("automatic_backup", true);
        int hour = prefs.getInt(BackupManager.KEY_HOUR, 3);
        int retention = prefs.getInt(BackupManager.KEY_RETENTION, 30);
        String frequency = prefs.getString(BackupManager.KEY_FREQUENCY, "daily");
        return new JSONObject().put("enabled", enabled).put("hour", hour).put("retention", retention).put("frequency", frequency)
                .put("revision", enabled + ":" + hour + ":" + retention + ":" + frequency);
    }

    static void schedule(Context context, IndependentRuntime runtime) {
        long now = SystemClock.elapsedRealtime();
        if (now < nextCheckAt || !running.compareAndSet(false, true)) return;
        nextCheckAt = now + 15000;
        worker.execute(() -> {
            try {
                if (DirectHost.paused(context)) return;
                if (!recovered) {
                    runtime.recoverAdminCommands();
                    recovered = true;
                }
                JSONObject command = runtime.claimAdminCommand();
                if (command == null) return;
                String id = command.getString("id"), action = command.getString("action"), result = "completed";
                try {
                    execute(context, action, new JSONObject(command.getString("payload")));
                } catch (Exception failure) {
                    result = "failed";
                }
                runtime.finishAdminCommand(id, result);
            } catch (Exception error) {
                android.util.Log.w("FleetDirectAdmin", "admin queue unavailable");
            } finally {
                running.set(false);
            }
        });
    }

    private static void execute(Context context, String action, JSONObject payload) throws Exception {
        switch (action) {
            case "check-update":
                OtaManager.check(context, true);
                return;
            case "retry-backup":
                BackupJobs.retry(context);
                return;
            case "create-backup":
                try (FleetDataStore store = new FleetDataStore(context)) {
                    BackupManager.createBackup(context, store);
                }
                return;
            case "sync-ordexa":
                SimpleDateFormat day = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
                Calendar date = Calendar.getInstance(TimeZone.getTimeZone("Europe/Athens"));
                day.setTimeZone(date.getTimeZone());
                String to = day.format(date.getTime());
                date.add(Calendar.DAY_OF_MONTH, -1);
                OrdexaSync.sync(context, new JSONObject().put("from", day.format(date.getTime())).put("to", to));
                return;
            case "backup-settings":
                synchronized (ServerWorkTracker.class) {
                    SharedPreferences prefs = preferences(context);
                    if (!backupSettings(prefs).getString("revision").equals(payload.getString("revision"))) {
                        throw new IOException("Backup settings changed");
                    }
                    int hour = payload.getInt("hour"), retention = payload.getInt("retention");
                    String frequency = payload.getString("frequency");
                    if (hour < 0 || hour > 23 || retention < 1 || retention > 90
                            || !Arrays.asList("daily", "weekdays", "weekly").contains(frequency)) throw new IOException("Invalid backup settings");
                    if (!prefs.edit().putBoolean("automatic_backup", payload.getBoolean("enabled")).putInt(BackupManager.KEY_HOUR, hour)
                            .putInt(BackupManager.KEY_RETENTION, retention).putString(BackupManager.KEY_FREQUENCY, frequency).commit()) {
                        throw new IOException("Backup settings were not saved");
                    }
                }
                return;
            default:
                throw new IOException("Unsupported Admin action");
        }
    }
}
