package gr.argyrismitsos.fleetserver;

import gr.argyrismitsos.fleetupdates.OtaInstaller;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.lang.reflect.Method;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.Map;

public final class MainActivity extends Activity {
    private static final int PICK_BACKUP_FOLDER = 201;
    private static final int PICK_CLIENT_APK = 202;
    private static final int PICK_WEB_PACKAGE = 203;
    private static final int PICK_BACKUP_FILE = 204;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 205;
    private WebView webView;
    private FleetDataStore store;
    private SharedPreferences preferences;
    private ExecutorService executor;
    private String pendingRestorePin = "";

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(7, 28, 35));
        getWindow().setNavigationBarColor(Color.rgb(7, 28, 35));
        store = new FleetDataStore(getApplicationContext());
        preferences = getSharedPreferences(BackupManager.PREFS, MODE_PRIVATE);
        executor = Executors.newSingleThreadExecutor();
        setDefaults();
        requestNotificationPermissionIfNeeded();

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(243, 248, 248));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setAllowContentAccess(false);
        settings.setTextZoom(100);
        settings.setSupportZoom(false);
        webView.addJavascriptInterface(new ServerBridge(), "AndroidServer");
        webView.setWebViewClient(localWebViewClient());
        webView.setWebChromeClient(new WebChromeClient());
        setContentView(webView);
        webView.loadUrl("file:///android_asset/www/index.html");
        if (preferences.getBoolean("automatic_start", true)) startServerService();
    }

    private WebViewClient localWebViewClient() {
        return new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (isLocalAppUrl(url)) return false;
                openExternalUrl(url);
                return true;
            }

        };
    }

    private boolean isLocalAppUrl(String url) {
        return url != null && (url.startsWith("file:///android_asset/") || "about:blank".equals(url));
    }

    private void openExternalUrl(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception ignored) {
        }
    }

    private void setDefaults() {
        if (!preferences.contains("worker_url")) preferences.edit()
                .putString("worker_url", ServerConfig.DEFAULT_WORKER_URL)
                .putInt("sync_seconds", 30)
                .putInt("invoice_parallelism", 4)
                .putInt(BackupManager.KEY_HOUR, 3)
                .putInt(BackupManager.KEY_RETENTION, 30)
                .putString(BackupManager.KEY_FREQUENCY, "daily")
                .putBoolean("automatic_start", true)
                .putBoolean("automatic_backup", true)
                .apply();
        if (!preferences.contains("invoice_parallelism")) {
            preferences.edit().putInt("invoice_parallelism", 4).apply();
        }
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, NOTIFICATION_PERMISSION_REQUEST);
        }
    }

    private void startServerService() {
        Intent intent = new Intent(this, SyncService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                Method method = Context.class.getMethod("startForegroundService", Intent.class);
                method.invoke(this, intent);
            } else {
                startService(intent);
            }
        } catch (Exception error) {
            emitError("server", error.getMessage());
        }
    }

    private void stopServerService() {
        stopService(new Intent(this, SyncService.class));
        preferences.edit().putBoolean("service_running", false).apply();
    }

    private JSONObject dashboard() throws Exception {
        JSONObject result = store.getStats();
        result.put("serverVersion", ServerConfig.SERVER_VERSION);
        result.put("ota", OtaManager.state(getApplicationContext()));
        result.put("workerUrl", preferences.getString("worker_url", ServerConfig.DEFAULT_WORKER_URL));
        result.put("serviceRunning", preferences.getBoolean("service_running", false));
        result.put("serverOnline", preferences.getBoolean("server_online", false));
        result.put("lastSyncTime", preferences.getString("last_sync_time", ""));
        result.put("lastError", preferences.getString("last_error", ""));
        result.put("connectionError", preferences.getString("last_connection_error", ""));
        result.put("lastAppliedCount", preferences.getInt("last_applied_count", 0));
        result.put("syncSeconds", preferences.getInt("sync_seconds", 30));
        result.put("invoiceParallelism", Math.max(1, Math.min(10, preferences.getInt("invoice_parallelism", 4))));
        result.put("automaticStart", preferences.getBoolean("automatic_start", true));
        result.put("automaticBackup", preferences.getBoolean("automatic_backup", true));
        result.put("backupHour", preferences.getInt(BackupManager.KEY_HOUR, 3));
        result.put("backupRetention", preferences.getInt(BackupManager.KEY_RETENTION, 30));
        result.put("backupFrequency", preferences.getString(BackupManager.KEY_FREQUENCY, "daily"));
        result.put("backupFolderSelected", preferences.getString(BackupManager.KEY_FOLDER_URI, "").length() > 0);
        result.put("lastBackupTime", preferences.getString(BackupManager.KEY_LAST_TIME, ""));
        result.put("lastBackupResult", preferences.getString(BackupManager.KEY_LAST_RESULT, "Δεν έχει γίνει ακόμη"));
        result.put("databaseOk", preferences.getBoolean("database_ok", false));
        result.put("storageOk", preferences.getBoolean("storage_ok", false));
        result.put("fleetControlOk", preferences.getBoolean("fleet_control_ok", false));
        result.put("watchdogActive", preferences.getBoolean("watchdog_active", false));
        result.put("pwaConnected", preferences.getBoolean("pwa_connected", false));
        result.put("pwaLastSeen", preferences.getString("pwa_last_seen", ""));
        result.put("remoteUsers", preferences.getInt("remote_users", 0));
        result.put("remoteActiveShifts", preferences.getInt("remote_active_shifts", 0));
        result.put("remotePendingAlerts", preferences.getInt("remote_pending_alerts", 0));
        String invoiceReprocessState = preferences.getString("invoice_reprocess_state", "");
        if (invoiceReprocessState.length() > 0) {
            try { result.put("invoiceReprocess", new JSONObject(invoiceReprocessState)); }
            catch (Exception ignored) { result.put("invoiceReprocess", JSONObject.NULL); }
        } else {
            result.put("invoiceReprocess", JSONObject.NULL);
        }
        result.put("health", DeviceHealth.collect(getApplicationContext()));
        return result;
    }

    private void emit(final String event, final JSONObject payload) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView == null) return;
                String script = "window.FleetServer&&window.FleetServer.onNativeEvent(" + JSONObject.quote(event) + "," + payload.toString() + ");";
                webView.evaluateJavascript(script, null);
            }
        });
    }

    private void emitError(String event, String message) {
        try {
            JSONObject payload = new JSONObject();
            payload.put("ok", false);
            payload.put("message", message == null ? "Η ενέργεια απέτυχε." : message);
            emit(event, payload);
        } catch (Exception ignored) {
        }
    }

    private void runTask(final String event, final Task task) {
        executor.submit(new Runnable() {
            @Override
            public void run() {
                try {
                    JSONObject payload = task.run();
                    payload.put("ok", true);
                    emit(event, payload);
                } catch (Exception error) {
                    emitError(event, error.getMessage());
                }
            }
        });
    }

    public final class ServerBridge {
        @JavascriptInterface
        public String getDashboard() {
            try { return dashboard().toString(); } catch (Exception error) { return "{}"; }
        }

        @JavascriptInterface
        public void startServer() {
            runOnUiThread(new Runnable() { @Override public void run() { startServerService(); } });
        }

        @JavascriptInterface
        public void stopServer() {
            runOnUiThread(new Runnable() { @Override public void run() { stopServerService(); } });
        }

        @JavascriptInterface
        public String saveSettings(String json) {
            try {
                JSONObject input = new JSONObject(json);
                String workerUrl = input.optString("workerUrl", ServerConfig.DEFAULT_WORKER_URL).trim().replaceAll("/+$", "");
                if (!workerUrl.matches("^https://[^\\s/]+(?:/.*)?$")) throw new IllegalArgumentException("Η διεύθυνση πρέπει να αρχίζει με https://");
                String backupFrequency = input.optString("backupFrequency", "daily");
                if (!"weekdays".equals(backupFrequency) && !"weekly".equals(backupFrequency)) backupFrequency = "daily";
                preferences.edit()
                        .putString("worker_url", workerUrl)
                        .putInt("sync_seconds", Math.max(10, Math.min(300, input.optInt("syncSeconds", 30))))
                        .putInt("invoice_parallelism", Math.max(1, Math.min(10, input.optInt("invoiceParallelism", 4))))
                        .putInt(BackupManager.KEY_HOUR, Math.max(0, Math.min(23, input.optInt("backupHour", 3))))
                        .putInt(BackupManager.KEY_RETENTION, Math.max(1, Math.min(90, input.optInt("backupRetention", 30))))
                        .putString(BackupManager.KEY_FREQUENCY, backupFrequency)
                        .putBoolean("automatic_start", input.optBoolean("automaticStart", true))
                        .putBoolean("automatic_backup", input.optBoolean("automaticBackup", true))
                        .apply();
                JSONObject result = dashboard();
                result.put("ok", true);
                return result.toString();
            } catch (Exception error) {
                try { return new JSONObject().put("ok", false).put("message", error.getMessage()).toString(); }
                catch (Exception ignored) { return "{\"ok\":false}"; }
            }
        }

        @JavascriptInterface
        public void testConnection() {
            runTask("connection", new Task() {
                @Override public JSONObject run() throws Exception {
                    String base = preferences.getString("worker_url", ServerConfig.DEFAULT_WORKER_URL).replaceAll("/+$", "");
                    return FleetHttp.getJson(base + "/api/server/connection-check", SyncService.serverHeaders());
                }
            });
        }

        @JavascriptInterface
        public void changePin(final String pin) {
            runTask("pin", new Task() {
                @Override public JSONObject run() throws Exception {
                    JSONObject body = new JSONObject();
                    body.put("pin", pin);
                    String base = preferences.getString("worker_url", ServerConfig.DEFAULT_WORKER_URL).replaceAll("/+$", "");
                    return FleetHttp.sendJson(base + "/api/admin/pin", "POST", body, SyncService.serverHeaders());
                }
            });
        }

        @JavascriptInterface
        public void chooseBackupFolder() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                    startActivityForResult(intent, PICK_BACKUP_FOLDER);
                }
            });
        }

        @JavascriptInterface
        public void backupNow() {
            runTask("backup", new Task() {
                @Override public JSONObject run() throws Exception {
                    try {
                        String name = BackupManager.createBackup(getApplicationContext(), store);
                        return new JSONObject().put("fileName", name);
                    } catch (Exception error) {
                        preferences.edit().putString(BackupManager.KEY_LAST_RESULT,
                                "Αποτυχία: " + (error.getMessage() == null ? "άγνωστο σφάλμα" : error.getMessage())).apply();
                        throw error;
                    }
                }
            });
        }

        @JavascriptInterface
        public void chooseBackupFile(String adminPin) {
            String pin = adminPin == null ? "" : adminPin.trim();
            if (!pin.matches("^\\d{4,6}$")) {
                emitError("backupRestore", "Το Admin PIN πρέπει να έχει 4 έως 6 αριθμούς.");
                return;
            }
            pendingRestorePin = pin;
            pickFile("*/*", PICK_BACKUP_FILE);
        }

        @JavascriptInterface public void checkServerUpdate() { OtaManager.check(getApplicationContext(), true); }
        @JavascriptInterface public void setAutomaticOta(boolean enabled) { preferences.edit().putBoolean("automatic_ota", enabled).apply(); }
        @JavascriptInterface public void installServerUpdate() {
            runOnUiThread(new Runnable() { @Override public void run() {
                try {
                    if (!OtaInstaller.canInstall(MainActivity.this)) { OtaInstaller.openPermission(MainActivity.this); return; }
                    OtaInstaller.openConfirmation(MainActivity.this);
                    OtaManager.requestApply(getApplicationContext()); startServerService();
                } catch (Exception error) { emitError("ota", error.getMessage()); }
            } });
        }

        @JavascriptInterface
        public void chooseClientApk() {
            pickFile("application/vnd.android.package-archive", PICK_CLIENT_APK);
        }

        @JavascriptInterface
        public void chooseWebPackage() {
            pickFile("application/zip", PICK_WEB_PACKAGE);
        }

        @JavascriptInterface
        public void loadReleases() {
            runTask("releases", new Task() {
                @Override public JSONObject run() throws Exception { return UpdateManager.listReleases(getApplicationContext()); }
            });
        }

        @JavascriptInterface
        public void activateRelease(final String id) {
            runTask("releaseActivated", new Task() {
                @Override public JSONObject run() throws Exception { return UpdateManager.activateRelease(getApplicationContext(), id); }
            });
        }

        @JavascriptInterface
        public void openBatterySettings() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try { startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); }
                    catch (Exception ignored) { startActivity(new Intent(Settings.ACTION_SETTINGS)); }
                }
            });
        }
    }

    private void pickFile(final String type, final int requestCode) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType(type);
                startActivityForResult(intent, requestCode);
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            if (requestCode == PICK_CLIENT_APK) emitError("clientUpload", "Η επιλογή αρχείου ακυρώθηκε.");
            if (requestCode == PICK_WEB_PACKAGE) emitError("webUpload", "Η επιλογή αρχείου ακυρώθηκε.");
            if (requestCode == PICK_BACKUP_FILE) {
                pendingRestorePin = "";
                emitError("backupRestore", "Η επιλογή backup ακυρώθηκε.");
            }
            return;
        }
        final Uri uri = data.getData();
        if (requestCode == PICK_BACKUP_FOLDER) {
            int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            try { getContentResolver().takePersistableUriPermission(uri, flags); } catch (Exception ignored) {}
            preferences.edit().putString(BackupManager.KEY_FOLDER_URI, uri.toString()).apply();
            try { emit("folder", new JSONObject().put("ok", true)); } catch (Exception ignored) {}
        } else if (requestCode == PICK_CLIENT_APK) {
            runTask("clientUpload", new Task() {
                @Override public JSONObject run() throws Exception { return UpdateManager.uploadClientApk(getApplicationContext(), uri); }
            });
        } else if (requestCode == PICK_WEB_PACKAGE) {
            runTask("webUpload", new Task() {
                @Override public JSONObject run() throws Exception { return UpdateManager.uploadWebPackage(getApplicationContext(), uri); }
            });
        } else if (requestCode == PICK_BACKUP_FILE) {
            runTask("backupRestore", new Task() {
                @Override public JSONObject run() throws Exception {
                    try {
                        JSONObject backup = BackupManager.restoreBackup(getApplicationContext(), store, uri);
                        Map<String, String> headers = SyncService.serverHeaders();
                        headers.put("X-Admin-Pin", pendingRestorePin);
                        String base = preferences.getString("worker_url", ServerConfig.DEFAULT_WORKER_URL).replaceAll("/+$", "");
                        JSONObject remote = FleetHttp.sendJson(base + "/api/server/system-import", "PUT", backup, headers);
                        JSONObject fleet = backup.optJSONObject("fleet");
                        int bikes = fleet == null || fleet.optJSONArray("bikes") == null ? 0 : fleet.optJSONArray("bikes").length();
                        JSONObject documentRestore = backup.optJSONObject("documentRestore");
                        JSONObject documentUpload;
                        try {
                            documentUpload = ServiceDocumentStore.uploadRestoredDocuments(getApplicationContext(), documentRestore, base, headers);
                        } catch (Exception error) {
                            documentUpload = new JSONObject().put("uploaded", 0).put("missing", 0).put("expected", documentRestore == null ? 0 : documentRestore.optInt("expected", 0)).put("error", error.getMessage() == null ? "Δεν ολοκληρώθηκε η μεταφόρτωση τιμολογίων." : error.getMessage());
                        }
                        return new JSONObject().put("bikes", bikes).put("records", remote.optInt("records", 0))
                                .put("documentsExpected", documentRestore == null ? 0 : documentRestore.optInt("expected", 0))
                                .put("documentsRestoredLocally", documentRestore == null ? 0 : documentRestore.optInt("restored", 0))
                                .put("documentsUploaded", documentUpload.optInt("uploaded", 0))
                                .put("documentsMissing", documentUpload.optInt("missing", 0))
                                .put("documentsUploadError", documentUpload.optString("error", ""));
                    } finally {
                        pendingRestorePin = "";
                    }
                }
            });
        }
    }

    private interface Task {
        JSONObject run() throws Exception;
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override protected void onResume() { super.onResume(); OtaInstaller.resume(this); OtaManager.check(getApplicationContext(), preferences.getBoolean("automatic_ota", true)); }
    @Override protected void onPause() { OtaInstaller.pause(this); super.onPause(); }

    @Override
    protected void onDestroy() {
        if (executor != null) executor.shutdownNow();
        if (store != null) store.close();
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
