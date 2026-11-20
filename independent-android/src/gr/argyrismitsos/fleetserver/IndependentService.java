package gr.argyrismitsos.fleetserver;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import org.json.JSONObject;

import java.io.InputStream;
import java.net.BindException;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLContext;

/** The Android foreground service owns HTTPS for the lifetime of the origin. */
public final class IndependentService extends Service {
    private static final String TAG = "FleetDirectOrigin";
    private static final int PORT = 8443;
    private static final int NOTIFICATION_ID = 90;
    private static volatile IndependentService live;

    private final Object originLock = new Object();
    private final long startedAt = System.currentTimeMillis();
    private ScheduledExecutorService listener, provisioning, jobs, invoices, hostMaintenance;
    private SharedPreferences ui;
    private PowerManager power;
    private ConnectivityManager connectivity;
    private PowerManager.WakeLock cpuLock;
    private WifiManager.WifiLock wifiLock;
    private IndependentInvoices invoiceWorker;
    private volatile IndependentHttps https;
    private volatile JSONObject originState;
    private volatile boolean initialized, stopping;
    private String servingHost = "", servingChain = "", lastListenerLog = "";
    private long dnsAt, certificateAt;
    private int dnsFailures, certFailures;

    static boolean listenerOnline() {
        IndependentService service = live;
        IndependentHttps origin = service == null ? null : service.https;
        return origin != null && origin.online();
    }

    static JSONObject diagnostics() throws Exception {
        IndependentService service = live;
        JSONObject snapshot = service == null ? null : service.originState;
        return (snapshot == null ? new JSONObject() : new JSONObject(snapshot.toString()))
                .put("serviceRunning", service != null && !service.stopping)
                .put("listenerActive", listenerOnline());
    }

    @Override public void onCreate() {
        super.onCreate();
        foreground();
        live = this;
        Log.i(TAG, "foreground started");
        ui = getSharedPreferences("independent_ui", MODE_PRIVATE);
        certificateAt = ui.getLong("certificateRetryAt", 0);
        power = (PowerManager) getSystemService(POWER_SERVICE);
        connectivity = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        listener = executor("listener");
        listener.execute(() -> {
            prepareRuntime();
            initialized = true;
        });
        listener.scheduleWithFixedDelay(this::maintainListener, 0, 15, TimeUnit.SECONDS);
        provisioning = executor("provisioning");
        provisioning.scheduleWithFixedDelay(this::maintainProvisioning, 0, 30, TimeUnit.SECONDS);
        jobs = executor("jobs");
        jobs.scheduleWithFixedDelay(this::runJobs, 0, 1, TimeUnit.SECONDS);
        invoices = executor("invoices");
        invoices.scheduleWithFixedDelay(this::runInvoices, 5, 5, TimeUnit.SECONDS);
        scheduleHostMaintenance();
    }

    private ScheduledExecutorService executor(String name) {
        return Executors.newSingleThreadScheduledExecutor(task -> new Thread(task, "fleet-direct-" + name));
    }

    private void prepareRuntime() {
        // The integrated Server supplies its process and restore initialization.
    }

    private void scheduleHostMaintenance() {
        // The integrated Server supplies its own backup and OTA lane.
    }

    private boolean ready() {
        return initialized && !stopping && ui.getString("blocked", "").isEmpty();
    }

    private void runJobs() {
        if (!ready()) return;
        try {
            IndependentRuntime.get(this).jobs();
        } catch (Exception error) {
            message("runtime", "Η τοπική υπηρεσία χρειάζεται έλεγχο. Τα δεδομένα διατηρούνται.");
        }
    }

    private synchronized void runInvoices() {
        if (!ready()) return;
        try {
            if (invoiceWorker == null) invoiceWorker = new IndependentInvoices(this, IndependentRuntime.get(this));
            invoiceWorker.tick();
        } catch (Exception error) {
            message("invoice", "Η τοπική ουρά χρειάζεται επανάληψη.");
        }
    }

    private void message(String name, String text) {
        if (!stopping && !text.equals(ui.getString(name, ""))) ui.edit().putString(name, text).apply();
    }

    private boolean isWifi(Network network) {
        if (network == null || connectivity == null) return false;
        NetworkCapabilities capabilities = connectivity.getNetworkCapabilities(network);
        return capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
    }

    private boolean wifiConnected() {
        if (connectivity == null) return false;
        for (Network network : connectivity.getAllNetworks()) if (isWifi(network)) return true;
        return false;
    }

    private void holdWakeLocks(boolean configured, boolean wifi) {
        synchronized (originLock) {
            if (stopping) return;
            if (configured && power != null) {
                if (cpuLock == null) {
                    cpuLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FleetIndependent:origin");
                    cpuLock.setReferenceCounted(false);
                }
                if (!cpuLock.isHeld()) cpuLock.acquire();
            } else if (cpuLock != null && cpuLock.isHeld()) {
                cpuLock.release();
            }

            // On Android 14+ this mode maps to a low-latency lock that only
            // applies while interactive, so it cannot keep the origin awake.
            if (configured && wifi && Build.VERSION.SDK_INT < 34) {
                if (wifiLock == null) {
                    WifiManager manager = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
                    if (manager == null) return;
                    wifiLock = manager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "FleetIndependent:origin");
                    wifiLock.setReferenceCounted(false);
                }
                if (!wifiLock.isHeld()) wifiLock.acquire();
            } else if (wifiLock != null && wifiLock.isHeld()) {
                wifiLock.release();
            }
        }
    }

    private void maintainListener() {
        if (stopping) return;
        boolean wifi = false;
        String error = "";
        try {
            wifi = wifiConnected();
            JSONObject config = ready() ? IndependentConfig.read(this) : new JSONObject();
            String host = config.has("backupSha256") ? config.optString("hostname") : "";
            holdWakeLocks(!host.isEmpty(), wifi);
            if (host.isEmpty()) {
                stopListener();
                return;
            }

            JSONObject material;
            try {
                material = IndependentTls.read(this);
                IndependentTls.chain(material, host, true);
            } catch (Exception invalid) {
                stopListener();
                error = "LISTENER_TLS_UNAVAILABLE";
                return;
            }

            String chain = material.getString("chain");
            IndependentHttps origin = https;
            if (origin != null && origin.online() && host.equals(servingHost) && chain.equals(servingChain)) return;
            SSLContext context = IndependentTls.context(material, host, true);
            IndependentRuntime backend = IndependentRuntime.get(this);
            synchronized (originLock) {
                if (stopping) return;
                stopListener();
                IndependentHttps replacement = new IndependentHttps(context, null, PORT, backend.realm(), handler(backend));
                try {
                    replacement.start();
                    https = replacement;
                    servingHost = host;
                    servingChain = chain;
                } catch (RuntimeException startError) {
                    replacement.close();
                    throw startError;
                }
            }
        } catch (Exception failure) {
            error = failure instanceof BindException ? "LISTENER_BIND_FAILED" : "LISTENER_SETUP_FAILED";
        } finally {
            recordListener(wifi, error);
        }
    }

    private IndependentHttps.Handler handler(IndependentRuntime backend) {
        return new IndependentHttps.Handler() {
            public JSONObject api(JSONObject request) throws Exception { return backend.external(request); }
            public InputStream asset(String path) throws Exception { return getAssets().open("independent-www/" + path); }
            public long revision() { return backend.revision(); }
            public long await(long revision) throws Exception { return backend.await(revision); }
        };
    }

    private void stopListener() {
        synchronized (originLock) {
            IndependentHttps origin = https;
            https = null;
            if (origin != null) try {
                origin.close();
            } catch (Exception failure) {
                Log.w(TAG, "listener close failed");
            }
        }
    }

    private void recordListener(boolean wifi, String error) {
        synchronized (originLock) {
            if (stopping) return;
            try {
                IndependentHttps origin = https;
                boolean listening = origin != null && origin.online();
                boolean cpuHeld = cpuLock != null && cpuLock.isHeld(), wifiHeld = wifiLock != null && wifiLock.isHeld();
                boolean interactive = power != null && power.isInteractive();
                boolean idle = power != null && power.isDeviceIdleMode();
                boolean exempt = power != null && power.isIgnoringBatteryOptimizations(getPackageName());
                long now = System.currentTimeMillis();
                originState = new JSONObject().put("serviceStartedAt", startedAt).put("listenerObservedAt", now)
                        .put("listenerError", error).put("wifiConnected", wifi).put("cpuLockHeld", cpuHeld)
                        .put("wifiLockHeld", wifiHeld).put("interactive", interactive).put("deviceIdle", idle)
                        .put("ignoringBatteryOptimizations", exempt);
                String state = "listener=" + listening + " wifi=" + wifi + " cpuLock=" + cpuHeld
                        + " wifiLock=" + wifiHeld + " interactive=" + interactive + " idle=" + idle
                        + " batteryExempt=" + exempt + " code=" + error;
                if (!state.equals(lastListenerLog)) {
                    lastListenerLog = state;
                    Log.i(TAG, state);
                    ui.edit().putBoolean("listenerActive", listening).putLong("listenerObservedAt", now)
                            .putString("listener", listening ? "HTTPS listener ενεργός · θύρα " + PORT
                                    : "HTTPS listener ανενεργός · θύρα " + PORT)
                            .putString("listenerError", error).apply();
                }
            } catch (Exception failure) {
                Log.w(TAG, "listener state unavailable");
            }
        }
    }

    private void maintainProvisioning() {
        if (!ready()) return;
        try {
            JSONObject config = IndependentConfig.read(this);
            if (!config.has("backupSha256")) return;
            String host = config.optString("hostname");
            if (host.isEmpty()) {
                message("network", "Εκκρεμεί το καταχωρισμένο όνομα DuckDNS.");
                return;
            }
            if (connectivity == null || !isWifi(connectivity.getActiveNetwork())) {
                message("network", "Server εκτός σταθερού Wi-Fi. Εκκρεμεί εξωτερική σύνδεση.");
                return;
            }
            if (ui.getBoolean("certificateRetryRequested", false)) {
                certificateAt = 0;
                certFailures = 0;
                ui.edit().remove("certificateRetryRequested").commit();
            }
            long now = System.currentTimeMillis();
            if (now >= dnsAt) updateDns();
            if (stopping || now < certificateAt || !config.optBoolean("acmeTermsAccepted")) return;
            boolean valid = IndependentTls.valid(this, host);
            if (!valid || IndependentTls.expires(this) - now < 30L * 86400000) updateCertificate();
        } catch (Exception error) {
            message("network", "Ο έλεγχος DNS ή πιστοποιητικού δεν ολοκληρώθηκε.");
        }
    }

    private void updateDns() {
        long now = System.currentTimeMillis();
        try {
            String ipv4 = IndependentAcme.updateDns(this);
            dnsFailures = 0;
            dnsAt = now + 300000;
            ui.edit().putString("ipv4", ipv4).apply();
            message("network", "Το DNS ενημερώθηκε. Η εισερχόμενη πρόσβαση 4G/5G χρειάζεται χωριστό έλεγχο.");
        } catch (Exception error) {
            dnsFailures = Math.min(7, dnsFailures + 1);
            dnsAt = now + Math.min(21600000L, 300000L * (1L << dnsFailures));
            message("network", "Η ενημέρωση DNS δεν επιβεβαιώθηκε. Ασφαλής επανάληψη με αναμονή.");
        }
    }

    private void updateCertificate() {
        try {
            IndependentAcme.issue(this, phase -> message("certificate", IndependentCertificate.phase(phase) + "…"));
            certFailures = 0;
            certificateAt = System.currentTimeMillis() + 43200000;
            ui.edit().remove("certificateRetryAt").remove("certificateFailureCode").apply();
            message("certificate", "Το πιστοποιητικό επαληθεύτηκε. Εκκρεμεί φυσική δοκιμή HTTPS από δεύτερο δίκτυο.");
        } catch (Exception error) {
            certFailures = Math.min(7, certFailures + 1);
            certificateAt = IndependentCertificate.nextRetry(System.currentTimeMillis(), certFailures, error);
            ui.edit().putLong("certificateRetryAt", certificateAt)
                    .putString("certificateFailureCode", IndependentCertificate.classify("https", error).getMessage()).apply();
            message("certificate", IndependentCertificate.describe(error, certificateAt));
        }
    }

    private void foreground() {
        String channel = "fleet-independent-origin";
        Notification.Builder builder = new Notification.Builder(this);
        if (Build.VERSION.SDK_INT >= 26) try {
            Class<?> type = Class.forName("android.app.NotificationChannel");
            Object value = type.getConstructor(String.class, CharSequence.class, int.class)
                    .newInstance(channel, "Fleet ανεξάρτητος Server", 2);
            Object manager = getSystemService(NOTIFICATION_SERVICE);
            manager.getClass().getMethod("createNotificationChannel", type).invoke(manager, value);
            builder = Notification.Builder.class.getConstructor(Context.class, String.class).newInstance(this, channel);
        } catch (Exception error) {
            throw new IllegalStateException("Notification channel unavailable", error);
        }
        Intent open = new Intent(this, IndependentActivity.class);
        PendingIntent pending = PendingIntent.getActivity(this, NOTIFICATION_ID, open, PendingIntent.FLAG_UPDATE_CURRENT | 0x04000000);
        builder.setSmallIcon(android.R.drawable.stat_notify_sync).setContentTitle("Fleet — ανεξάρτητος Server")
                .setContentText("Δοκιμαστική βάση · HTTPS και συγχρονισμοί στη συσκευή").setOngoing(true).setContentIntent(pending);
        startForeground(NOTIFICATION_ID, builder.build());
    }

    @Override public int onStartCommand(Intent intent, int flags, int id) { return START_STICKY; }
    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() {
        stopping = true;
        for (ScheduledExecutorService lane : new ScheduledExecutorService[]{listener, provisioning, jobs, invoices, hostMaintenance}) {
            if (lane != null) lane.shutdownNow();
        }
        IndependentInvoices worker = invoiceWorker;
        if (worker != null) worker.close();
        stopListener();
        synchronized (originLock) {
            if (cpuLock != null && cpuLock.isHeld()) cpuLock.release();
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        }
        if (live == this) live = null;
        ui.edit().putBoolean("listenerActive", false).putLong("listenerObservedAt", System.currentTimeMillis())
                .putString("listener", "HTTPS listener ανενεργός · θύρα " + PORT).putString("listenerError", "").apply();
        Log.i(TAG, "foreground stopped");
        super.onDestroy();
    }

    static void start(Context context) {
        Intent intent = new Intent(context, IndependentService.class);
        if (Build.VERSION.SDK_INT >= 26) try {
            Context.class.getMethod("startForegroundService", Intent.class).invoke(context, intent);
        } catch (Exception error) {
            throw new IllegalStateException("Foreground service did not start", error);
        } else context.startService(intent);
    }
}
