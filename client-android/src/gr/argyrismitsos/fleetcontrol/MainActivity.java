package gr.argyrismitsos.fleetcontrol;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentValues;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.PermissionRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.View;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Toast;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.File;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends Activity {
    private static final String CHANNEL_ID = "fleet_service_alerts";
    private static final int NOTIFICATION_PERMISSION_REQUEST = 41;
    private static final int FILE_CHOOSER_REQUEST = 42;
    private static final int CAMERA_PERMISSION_REQUEST = 43;
    private static final String SESSION_PREFERENCES = "fleet_control_session";
    private static final String AUTH_TOKEN_KEY = "auth_token";
    private static final String UPDATE_PREFERENCES = "fleet_control_updates";
    private static final String LAST_UPDATE_CHECK_KEY = "last_update_check_ms";
    private static final String LAST_UPDATE_PROMPT_KEY = "last_update_prompt_version";
    private static final String LAST_UPDATE_PROMPT_AT_KEY = "last_update_prompt_at_ms";
    private static final String UPDATE_CHECK_URL = "https://fleet-control.pavlosargyris.workers.dev/api/client-update";
    private static final String UPDATE_DOWNLOAD_URL = "https://fleet-control.pavlosargyris.workers.dev/download/client.apk";
    private static final String UPDATE_FILE_NAME = FleetUpdateProvider.UPDATE_FILE_NAME;
    private static final long UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000L;
    private static final long UPDATE_PROMPT_INTERVAL_MS = 12 * 60 * 60 * 1000L;
    private static final long MAX_UPDATE_BYTES = 50L * 1024L * 1024L;
    private WebView webView;
    private String transientAuthToken = "";
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final AtomicBoolean updateCheckInFlight = new AtomicBoolean(false);
    private final AtomicBoolean updateDownloadInFlight = new AtomicBoolean(false);
    private boolean activityResumed = false;
    private final Runnable periodicUpdateCheck = new Runnable() {
        @Override
        public void run() {
            if (!activityResumed || isFinishing()) return;
            checkForUpdates();
            mainHandler.postDelayed(this, UPDATE_CHECK_INTERVAL_MS);
        }
    };
    private UpdateInfo pendingUpdate;
    private PermissionRequest pendingCameraPermissionRequest;
    private volatile boolean historyReportOpen = false;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().setStatusBarColor(Color.rgb(17, 24, 39));
        getWindow().setNavigationBarColor(Color.rgb(17, 24, 39));
        createNotificationChannel();
        requestNotificationPermissionIfNeeded();
        transientAuthToken = getSharedPreferences(SESSION_PREFERENCES, MODE_PRIVATE)
                .getString(AUTH_TOKEN_KEY, "");
        AlertJobService.schedule(getApplicationContext());

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(242, 246, 248));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setAllowContentAccess(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(false);
        settings.setTextZoom(100);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);

        webView.addJavascriptInterface(new FleetBridge(), "AndroidFleet");
        webView.setWebViewClient(localWebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                boolean requestsVideo = false;
                String[] resources = request.getResources();
                if (resources != null) {
                    for (String resource : resources) {
                        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                            requestsVideo = true;
                            break;
                        }
                    }
                }
                if (!requestsVideo) {
                    request.deny();
                    return;
                }
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (Build.VERSION.SDK_INT < 23 || checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                        } else {
                            pendingCameraPermissionRequest = request;
                            requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST);
                        }
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                Intent intent = params.createIntent();
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                fileChooserCallback = callback;
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception error) {
                    fileChooserCallback = null;
                    return false;
                }
            }
        });
        setContentView(webView);
        webView.loadUrl("file:///android_asset/www/portal.html");
        scheduleUpdateCheck(2500L);
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

    private android.webkit.ValueCallback<Uri[]> fileChooserCallback;

    @Override
    protected void onResume() {
        super.onResume();
        activityResumed = true;
        mainHandler.removeCallbacks(periodicUpdateCheck);
        mainHandler.postDelayed(periodicUpdateCheck, UPDATE_CHECK_INTERVAL_MS);
        if (pendingUpdate != null && canInstallPackages()) {
            final UpdateInfo update = pendingUpdate;
            pendingUpdate = null;
            mainHandler.postDelayed(new Runnable() {
                @Override
                public void run() {
                    offerUpdate(update);
                }
            }, 500L);
        } else {
            scheduleUpdateCheck(1000L);
        }
    }

    @Override
    protected void onPause() {
        activityResumed = false;
        mainHandler.removeCallbacks(periodicUpdateCheck);
        super.onPause();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (fileChooserCallback != null) {
                Uri[] result = null;
                if (resultCode == RESULT_OK && data != null) {
                    android.content.ClipData clips = data.getClipData();
                    if (clips != null && clips.getItemCount() > 0) {
                        java.util.ArrayList<Uri> selected = new java.util.ArrayList<Uri>();
                        for (int index = 0; index < clips.getItemCount(); index++) {
                            Uri uri = clips.getItemAt(index).getUri();
                            if (uri != null) selected.add(uri);
                        }
                        if (!selected.isEmpty()) result = selected.toArray(new Uri[selected.size()]);
                    } else if (data.getData() != null) {
                        result = new Uri[]{data.getData()};
                    }
                }
                fileChooserCallback.onReceiveValue(result);
                fileChooserCallback = null;
            }
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, NOTIFICATION_PERMISSION_REQUEST);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != CAMERA_PERMISSION_REQUEST || pendingCameraPermissionRequest == null) return;
        PermissionRequest request = pendingCameraPermissionRequest;
        pendingCameraPermissionRequest = null;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            request.deny();
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            Class<?> channelClass = Class.forName("android.app.NotificationChannel");
            Constructor<?> constructor = channelClass.getConstructor(String.class, CharSequence.class, int.class);
            Object channel = constructor.newInstance(CHANNEL_ID, "Ειδοποιήσεις Fleet Control", 4);
            Method description = channelClass.getMethod("setDescription", String.class);
            description.invoke(channel, "Service, βάρδιες, backup και κατάσταση της συσκευής Server.");
            Method create = NotificationManager.class.getMethod("createNotificationChannel", channelClass);
            create.invoke(manager, channel);
        } catch (Exception ignored) {
        }
    }

    private void showServiceNotification(String bikeName, String message, String severity) {
        try {
            Intent intent = new Intent(this, MainActivity.class);
            intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | 0x04000000);

            Notification.Builder builder;
            if (Build.VERSION.SDK_INT >= 26) {
                Constructor<Notification.Builder> constructor = Notification.Builder.class.getConstructor(Context.class, String.class);
                builder = constructor.newInstance(this, CHANNEL_ID);
            } else {
                builder = new Notification.Builder(this);
            }
            builder.setSmallIcon(android.R.drawable.stat_notify_more)
                    .setContentTitle("Fleet Control • " + bikeName)
                    .setContentText(message)
                    .setStyle(new Notification.BigTextStyle().bigText(message))
                    .setContentIntent(pendingIntent)
                    .setAutoCancel(true)
                    .setPriority(("overdue".equals(severity) || "urgent".equals(severity)) ? Notification.PRIORITY_HIGH : Notification.PRIORITY_DEFAULT);

            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            manager.notify(Math.abs(bikeName.hashCode()), builder.build());
        } catch (Exception ignored) {
        }
    }

    public final class FleetBridge {
        @JavascriptInterface
        public void notifyService(final String bikeName, final String message, final String severity) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    showServiceNotification(bikeName, message, severity);
                }
            });
        }

        @JavascriptInterface
        public void notifyAlert(String id, String title, String message, String severity) {
            AlertJobService.show(getApplicationContext(), id, title, message, severity);
        }

        @JavascriptInterface
        public String getAlertNotificationStatus() {
            try {
                SharedPreferences preferences = getSharedPreferences(SESSION_PREFERENCES, MODE_PRIVATE);
                boolean enabled = preferences.getBoolean(AlertJobService.ENABLED_KEY, false)
                        && AlertJobService.notificationsAllowed(getApplicationContext());
                return new org.json.JSONObject()
                        .put("enabled", enabled)
                        .put("remembered", preferences.getString(AUTH_TOKEN_KEY, "").length() > 0)
                        .toString();
            } catch (Exception error) { return "{\"enabled\":false}"; }
        }

        @JavascriptInterface
        public String enableAlertNotifications(boolean enabled) {
            try {
                if (enabled && !AlertJobService.notificationsAllowed(getApplicationContext())) {
                    runOnUiThread(new Runnable() { @Override public void run() { requestNotificationPermissionIfNeeded(); } });
                    return new org.json.JSONObject().put("enabled", false)
                            .put("message", "Δώσε την άδεια ειδοποιήσεων του Android και πάτησε ξανά.").toString();
                }
                getSharedPreferences(SESSION_PREFERENCES, MODE_PRIVATE).edit()
                        .putBoolean(AlertJobService.ENABLED_KEY, enabled).apply();
                if (enabled) AlertJobService.schedule(getApplicationContext());
                else AlertJobService.cancel(getApplicationContext());
                return new org.json.JSONObject().put("enabled", enabled).toString();
            } catch (Exception error) {
                try { return new org.json.JSONObject().put("enabled", false).put("message", error.getMessage()).toString(); }
                catch (Exception ignored) { return "{\"enabled\":false}"; }
            }
        }

        @JavascriptInterface
        public String getPlatform() {
            return "android";
        }

        @JavascriptInterface
        public String getAuthToken() {
            return transientAuthToken == null ? "" : transientAuthToken;
        }

        @JavascriptInterface
        public void saveAuthToken(String token, boolean remember) {
            transientAuthToken = token == null ? "" : token;
            SharedPreferences.Editor editor = getSharedPreferences(SESSION_PREFERENCES, MODE_PRIVATE).edit();
            if (remember && !transientAuthToken.isEmpty()) editor.putString(AUTH_TOKEN_KEY, transientAuthToken);
            else editor.remove(AUTH_TOKEN_KEY);
            editor.apply();
            if (remember && !transientAuthToken.isEmpty()) AlertJobService.schedule(getApplicationContext());
        }

        @JavascriptInterface
        public void clearAuthToken() {
            transientAuthToken = "";
            getSharedPreferences(SESSION_PREFERENCES, MODE_PRIVATE).edit().remove(AUTH_TOKEN_KEY).apply();
            AlertJobService.cancel(getApplicationContext());
        }

        @JavascriptInterface
        public void setHistoryReportOpen(boolean open) {
            historyReportOpen = open;
        }

        @JavascriptInterface
        public void openFleet() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (webView != null) webView.loadUrl("file:///android_asset/www/index.html?from=portal&embedded=1");
                }
            });
        }

        @JavascriptInterface
        public void openPdf(final String base64Data, final String requestedName) {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        byte[] bytes = Base64.decode(base64Data == null ? "" : base64Data, Base64.DEFAULT);
                        if (bytes.length == 0) throw new IllegalStateException("Το PDF είναι κενό.");
                        File preview = new File(getCacheDir(), FleetPdfProvider.PDF_FILE_NAME);
                        try (FileOutputStream stream = new FileOutputStream(preview)) { stream.write(bytes); }
                        String displayName = requestedName == null ? "τιμολόγιο.pdf" : requestedName;
                        displayName = displayName.replaceAll("[\\\\/:*?\"<>|]", "_");
                        if (!displayName.toLowerCase(Locale.ROOT).endsWith(".pdf")) displayName += ".pdf";
                        getSharedPreferences("fleet_control_pdf", MODE_PRIVATE).edit()
                                .putString("fleet_control_preview_name", displayName).apply();
                        final Uri uri = FleetPdfProvider.uri();
                        final Intent intent = new Intent(Intent.ACTION_VIEW);
                        intent.setDataAndType(uri, "application/pdf");
                        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        intent.setClipData(ClipData.newRawUri("Fleet Control PDF", uri));
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                try {
                                    startActivity(Intent.createChooser(intent, "Άνοιγμα τιμολογίου PDF"));
                                } catch (Exception error) {
                                    Toast.makeText(MainActivity.this, "Δεν βρέθηκε εφαρμογή για άνοιγμα PDF.", Toast.LENGTH_LONG).show();
                                }
                            }
                        });
                    } catch (Exception error) {
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                Toast.makeText(MainActivity.this, "Δεν ήταν δυνατή η προεπισκόπηση του PDF.", Toast.LENGTH_LONG).show();
                            }
                        });
                    }
                }
            }, "fleet-pdf-open").start();
        }

        @JavascriptInterface
        public void printCurrentPage() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (webView == null) return;
                        PrintManager printManager = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                        if (printManager == null) throw new IllegalStateException("Η εκτύπωση δεν είναι διαθέσιμη.");
                        PrintAttributes attributes = new PrintAttributes.Builder()
                                .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                                .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
                                .build();
                        printManager.print("Fleet Control - Ιστορικό service",
                                webView.createPrintDocumentAdapter("Fleet_Control_History"), attributes);
                    } catch (Exception error) {
                        Toast.makeText(MainActivity.this, "Δεν ήταν δυνατή η εκτύπωση. Χρησιμοποίησε τη Λήψη PDF.", Toast.LENGTH_LONG).show();
                    }
                }
            });
        }

        @JavascriptInterface
        public void savePdf(final String base64Data, final String requestedName) {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    Uri savedUri = null;
                    String savedPath = "";
                    try {
                        String fileName = requestedName == null ? "Fleet_Control_Program.pdf" : requestedName;
                        fileName = fileName.replaceAll("[\\\\/:*?\"<>|]", "_");
                        if (!fileName.toLowerCase().endsWith(".pdf")) fileName += ".pdf";
                        byte[] bytes = Base64.decode(base64Data == null ? "" : base64Data, Base64.DEFAULT);
                        if (Build.VERSION.SDK_INT >= 29) {
                            ContentValues values = new ContentValues();
                            values.put("_display_name", fileName);
                            values.put("mime_type", "application/pdf");
                            values.put("relative_path", Environment.DIRECTORY_DOWNLOADS + "/Fleet Control");
                            values.put("is_pending", 1);
                            savedUri = getContentResolver().insert(Uri.parse("content://media/external/downloads"), values);
                            if (savedUri == null) throw new IllegalStateException("Δεν δημιουργήθηκε αρχείο.");
                            try (OutputStream stream = getContentResolver().openOutputStream(savedUri)) {
                                if (stream == null) throw new IllegalStateException("Δεν άνοιξε το αρχείο.");
                                stream.write(bytes);
                            }
                            values.clear();
                            values.put("is_pending", 0);
                            getContentResolver().update(savedUri, values, null, null);
                            savedPath = "Λήψεις/Fleet Control/" + fileName;
                        } else {
                            File directory = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Fleet Control");
                            if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Δεν δημιουργήθηκε ο φάκελος.");
                            File file = new File(directory, fileName);
                            try (FileOutputStream stream = new FileOutputStream(file)) { stream.write(bytes); }
                            savedPath = file.getAbsolutePath();
                        }
                        final String message = "Το PDF αποθηκεύτηκε: " + savedPath;
                        runOnUiThread(new Runnable() { @Override public void run() { Toast.makeText(MainActivity.this, message, Toast.LENGTH_LONG).show(); } });
                    } catch (Exception error) {
                        if (savedUri != null && Build.VERSION.SDK_INT >= 29) getContentResolver().delete(savedUri, null, null);
                        runOnUiThread(new Runnable() { @Override public void run() { Toast.makeText(MainActivity.this, "Δεν αποθηκεύτηκε το PDF.", Toast.LENGTH_LONG).show(); } });
                    }
                }
            }).start();
        }
    }

    private static final class UpdateInfo {
        final String version;
        final long sizeBytes;
        final String sha256;
        final String notes;

        UpdateInfo(String version, long sizeBytes, String sha256, String notes) {
            this.version = version;
            this.sizeBytes = sizeBytes;
            this.sha256 = sha256;
            this.notes = notes;
        }
    }

    private void scheduleUpdateCheck(long delayMs) {
        mainHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                checkForUpdates();
            }
        }, delayMs);
    }

    private void checkForUpdates() {
        if (isFinishing() || !updateCheckInFlight.compareAndSet(false, true)) return;
        final SharedPreferences preferences = getSharedPreferences(UPDATE_PREFERENCES, MODE_PRIVATE);
        final long now = System.currentTimeMillis();
        if (now - preferences.getLong(LAST_UPDATE_CHECK_KEY, 0L) < UPDATE_CHECK_INTERVAL_MS) {
            updateCheckInFlight.set(false);
            return;
        }
        preferences.edit().putLong(LAST_UPDATE_CHECK_KEY, now).apply();

        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    final UpdateInfo update = fetchUpdateInfo();
                    if (update != null && isNewerVersion(update.version, currentVersionName())) {
                        mainHandler.post(new Runnable() {
                            @Override
                            public void run() {
                                offerUpdate(update);
                            }
                        });
                    }
                } catch (Exception ignored) {
                    // An update check must never interrupt normal Fleet Control use.
                } finally {
                    updateCheckInFlight.set(false);
                }
            }
        }, "fleet-update-check").start();
    }

    private UpdateInfo fetchUpdateInfo() throws Exception {
        HttpURLConnection connection = null;
        try {
            URL endpoint = new URL(UPDATE_CHECK_URL);
            if (!"https".equalsIgnoreCase(endpoint.getProtocol())) throw new IllegalStateException("Μη ασφαλής σύνδεση ενημέρωσης.");
            connection = (HttpURLConnection) endpoint.openConnection();
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(10000);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return null;
            org.json.JSONObject body = new org.json.JSONObject(readResponse(connection.getInputStream(), 64 * 1024));
            if (!body.optBoolean("available", false)) return null;
            String version = body.optString("version", "").trim();
            if (version.isEmpty()) return null;
            return new UpdateInfo(
                    version,
                    Math.max(0L, body.optLong("sizeBytes", 0L)),
                    body.optString("sha256", "").trim().toLowerCase(Locale.US),
                    body.optString("notes", "").trim());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private String readResponse(InputStream input, int maxBytes) throws Exception {
        try (InputStream stream = new BufferedInputStream(input)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int count;
            int total = 0;
            while ((count = stream.read(buffer)) != -1) {
                total += count;
                if (total > maxBytes) throw new IllegalStateException("Η απάντηση είναι υπερβολικά μεγάλη.");
                output.write(buffer, 0, count);
            }
            return output.toString("UTF-8");
        }
    }

    private void offerUpdate(final UpdateInfo update) {
        if (isFinishing() || update == null || !isNewerVersion(update.version, currentVersionName())) return;
        SharedPreferences preferences = getSharedPreferences(UPDATE_PREFERENCES, MODE_PRIVATE);
        String promptedVersion = preferences.getString(LAST_UPDATE_PROMPT_KEY, "");
        long promptedAt = preferences.getLong(LAST_UPDATE_PROMPT_AT_KEY, 0L);
        if (update.version.equals(promptedVersion) && System.currentTimeMillis() - promptedAt < UPDATE_PROMPT_INTERVAL_MS) return;

        final int teal = Color.rgb(18, 191, 165);
        final int ink = Color.rgb(23, 32, 51);
        final int muted = Color.rgb(96, 111, 132);
        final int line = Color.rgb(223, 232, 237);
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(24), dp(22), dp(24), dp(18));
        card.setBackground(roundBackground(Color.WHITE, dp(22), line));

        TextView eyebrow = updateText("FLEET CONTROL  •  UPDATE", 11, teal, true);
        eyebrow.setLetterSpacing(.12f);
        card.addView(eyebrow, matchWrap(0));

        TextView title = updateText("Νέα έκδοση διαθέσιμη", 23, ink, true);
        LinearLayout.LayoutParams titleParams = matchWrap(0);
        titleParams.topMargin = dp(7);
        card.addView(title, titleParams);

        TextView version = updateText("Έκδοση " + update.version, 13, teal, true);
        version.setGravity(Gravity.CENTER);
        version.setPadding(dp(12), dp(7), dp(12), dp(7));
        version.setBackground(roundBackground(Color.rgb(231, 250, 246), dp(999), Color.TRANSPARENT));
        LinearLayout.LayoutParams versionParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        versionParams.topMargin = dp(13);
        card.addView(version, versionParams);

        TextView message = updateText("Το Fleet Control έχει έτοιμη μια νεότερη έκδοση. Μπορείς να την εγκαταστήσεις τώρα και η εφαρμογή θα ανοίξει ξανά αυτόματα μετά την εγκατάσταση.", 14, muted, false);
        message.setLineSpacing(0f, 1.18f);
        LinearLayout.LayoutParams messageParams = matchWrap(0);
        messageParams.topMargin = dp(16);
        card.addView(message, messageParams);

        TextView notes = updateText(update.notes.isEmpty() ? "Περιλαμβάνει βελτιώσεις λειτουργίας και ασφάλειας." : update.notes, 12, ink, false);
        notes.setLineSpacing(0f, 1.18f);
        notes.setPadding(dp(13), dp(11), dp(13), dp(11));
        notes.setBackground(roundBackground(Color.rgb(246, 249, 250), dp(13), Color.rgb(232, 239, 241)));
        LinearLayout.LayoutParams notesParams = matchWrap(0);
        notesParams.topMargin = dp(13);
        card.addView(notes, notesParams);

        TextView security = updateText(formatUpdateSize(update.sizeBytes) + "  •  Έλεγχος έκδοσης και SHA-256 πριν την εγκατάσταση", 11, muted, false);
        security.setLineSpacing(0f, 1.15f);
        LinearLayout.LayoutParams securityParams = matchWrap(0);
        securityParams.topMargin = dp(12);
        card.addView(security, securityParams);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams actionsParams = matchWrap(0);
        actionsParams.topMargin = dp(19);
        card.addView(actions, actionsParams);

        Button later = updateButton("Αργότερα", muted, Color.WHITE, line);
        Button install = updateButton("Ενημέρωση τώρα", Color.WHITE, teal, teal);
        LinearLayout.LayoutParams laterParams = new LinearLayout.LayoutParams(0, dp(50), 1f);
        laterParams.rightMargin = dp(7);
        LinearLayout.LayoutParams installParams = new LinearLayout.LayoutParams(0, dp(50), 1f);
        actions.addView(later, laterParams);
        actions.addView(install, installParams);

        final AlertDialog dialog = new AlertDialog.Builder(this).setView(card).create();
        later.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) {
                rememberPrompt(update.version);
                dialog.dismiss();
            }
        });
        install.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View view) {
                dialog.dismiss();
                startUpdate(update);
            }
        });
        dialog.setCancelable(true);
        dialog.setCanceledOnTouchOutside(true);
        dialog.setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
            @Override public void onCancel(android.content.DialogInterface ignored) {
                rememberPrompt(update.version);
            }
        });
        dialog.show();
        Window window = dialog.getWindow();
        if (window != null) {
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            WindowManager.LayoutParams attributes = window.getAttributes();
            attributes.width = (int) (getResources().getDisplayMetrics().widthPixels * .91f);
            attributes.height = WindowManager.LayoutParams.WRAP_CONTENT;
            window.setAttributes(attributes);
        }
    }

    private TextView updateText(String value, float sizeSp, int color, boolean bold) {
        TextView text = new TextView(this);
        text.setText(value);
        text.setTextSize(sizeSp);
        text.setTextColor(color);
        text.setGravity(Gravity.START);
        text.setTypeface(android.graphics.Typeface.DEFAULT, bold ? android.graphics.Typeface.BOLD : android.graphics.Typeface.NORMAL);
        return text;
    }

    private Button updateButton(String value, int textColor, int backgroundColor, int strokeColor) {
        Button button = new Button(this);
        button.setText(value);
        button.setTextSize(12);
        button.setTextColor(textColor);
        button.setAllCaps(false);
        button.setGravity(Gravity.CENTER);
        button.setMinHeight(0);
        button.setPadding(dp(8), 0, dp(8), 0);
        button.setBackground(roundBackground(backgroundColor, dp(13), strokeColor));
        return button;
    }

    private LinearLayout.LayoutParams matchWrap(int topMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = topMargin;
        return params;
    }

    private GradientDrawable roundBackground(int color, int radius, int strokeColor) {
        GradientDrawable background = new GradientDrawable();
        background.setColor(color);
        background.setCornerRadius(radius);
        if (strokeColor != Color.TRANSPARENT) background.setStroke(dp(1), strokeColor);
        return background;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private String formatUpdateSize(long bytes) {
        if (bytes <= 0) return "Ασφαλής λήψη";
        if (bytes >= 1024L * 1024L) return String.format(Locale.US, "%.1f MB", bytes / (1024d * 1024d));
        return String.format(Locale.US, "%.0f KB", bytes / 1024d);
    }

    private void rememberPrompt(String version) {
        getSharedPreferences(UPDATE_PREFERENCES, MODE_PRIVATE).edit()
                .putString(LAST_UPDATE_PROMPT_KEY, version)
                .putLong(LAST_UPDATE_PROMPT_AT_KEY, System.currentTimeMillis())
                .apply();
    }

    private void clearPrompt(String version) {
        SharedPreferences preferences = getSharedPreferences(UPDATE_PREFERENCES, MODE_PRIVATE);
        if (version.equals(preferences.getString(LAST_UPDATE_PROMPT_KEY, ""))) {
            preferences.edit().remove(LAST_UPDATE_PROMPT_KEY).remove(LAST_UPDATE_PROMPT_AT_KEY).apply();
        }
    }

    private void startUpdate(final UpdateInfo update) {
        if (!canInstallPackages()) {
            pendingUpdate = update;
            clearPrompt(update.version);
            try {
                Intent settings = new Intent("android.settings.MANAGE_UNKNOWN_APP_SOURCES");
                settings.setData(Uri.parse("package:" + getPackageName()));
                startActivity(settings);
                Toast.makeText(this, "Ενεργοποίησε την εγκατάσταση εφαρμογών και επέστρεψε στην εφαρμογή.", Toast.LENGTH_LONG).show();
            } catch (Exception error) {
                Toast.makeText(this, "Άνοιξε τις ρυθμίσεις Android για εγκατάσταση άγνωστων εφαρμογών.", Toast.LENGTH_LONG).show();
            }
            return;
        }
        if (!updateDownloadInFlight.compareAndSet(false, true)) return;
        Toast.makeText(this, "Γίνεται λήψη της νέας έκδοσης…", Toast.LENGTH_SHORT).show();
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    final File apk = downloadUpdate(update);
                    mainHandler.post(new Runnable() {
                        @Override
                        public void run() {
                            updateDownloadInFlight.set(false);
                            installUpdate(apk);
                        }
                    });
                } catch (final Exception error) {
                    updateDownloadInFlight.set(false);
                    clearPrompt(update.version);
                    mainHandler.post(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(MainActivity.this, "Η ενημέρωση δεν ολοκληρώθηκε. Δοκίμασε ξανά όταν υπάρχει σύνδεση.", Toast.LENGTH_LONG).show();
                        }
                    });
                }
            }
        }, "fleet-update-download").start();
    }

    private File downloadUpdate(UpdateInfo update) throws Exception {
        HttpURLConnection connection = null;
        File part = new File(getCacheDir(), UPDATE_FILE_NAME + ".part");
        File apk = new File(getCacheDir(), UPDATE_FILE_NAME);
        if (part.exists() && !part.delete()) throw new IllegalStateException("Δεν καθαρίστηκε η προσωρινή λήψη.");
        if (apk.exists() && !apk.delete()) throw new IllegalStateException("Δεν καθαρίστηκε η προηγούμενη ενημέρωση.");
        try {
            URL endpoint = new URL(UPDATE_DOWNLOAD_URL);
            if (!"https".equalsIgnoreCase(endpoint.getProtocol())) throw new IllegalStateException("Μη ασφαλής σύνδεση APK.");
            connection = (HttpURLConnection) endpoint.openConnection();
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(30000);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) throw new IllegalStateException("Η λήψη απέτυχε.");
            long expectedSize = update.sizeBytes;
            if (expectedSize > MAX_UPDATE_BYTES) throw new IllegalStateException("Το APK είναι υπερβολικά μεγάλο.");
            try (InputStream input = new BufferedInputStream(connection.getInputStream());
                 OutputStream output = new BufferedOutputStream(new FileOutputStream(part))) {
                byte[] buffer = new byte[8192];
                int count;
                long total = 0L;
                while ((count = input.read(buffer)) != -1) {
                    total += count;
                    if (total > MAX_UPDATE_BYTES) throw new IllegalStateException("Το APK είναι υπερβολικά μεγάλο.");
                    output.write(buffer, 0, count);
                }
                output.flush();
                if (expectedSize > 0L && total != expectedSize) throw new IllegalStateException("Το APK δεν κατέβηκε πλήρως.");
            }
        } finally {
            if (connection != null) connection.disconnect();
        }

        if (!update.sha256.isEmpty() && !update.sha256.equalsIgnoreCase(sha256File(part))) {
            if (part.exists()) part.delete();
            throw new IllegalStateException("Ο έλεγχος ασφαλείας του APK απέτυχε.");
        }
        PackageInfo archive = getPackageManager().getPackageArchiveInfo(part.getAbsolutePath(), PackageManager.GET_META_DATA);
        if (archive == null || !getPackageName().equals(archive.packageName)
                || !update.version.equals(archive.versionName)
                || !isNewerVersion(archive.versionName, currentVersionName())) {
            if (part.exists()) part.delete();
            throw new IllegalStateException("Το APK δεν είναι η σωστή έκδοση Fleet Control.");
        }
        if (!part.renameTo(apk)) throw new IllegalStateException("Δεν αποθηκεύτηκε το APK.");
        return apk;
    }

    private String sha256File(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new BufferedInputStream(new FileInputStream(file))) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        byte[] bytes = digest.digest();
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.US, "%02x", value & 0xff));
        return result.toString();
    }

    private void installUpdate(File apk) {
        try {
            Uri uri = Uri.parse("content://" + FleetUpdateProvider.AUTHORITY + "/update.apk");
            Intent intent = new Intent("android.intent.action.INSTALL_PACKAGE");
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(intent);
        } catch (Exception error) {
            Toast.makeText(this, "Δεν άνοιξε η εγκατάσταση της νέας έκδοσης.", Toast.LENGTH_LONG).show();
        }
    }

    private boolean canInstallPackages() {
        if (Build.VERSION.SDK_INT < 26) return true;
        try {
            Method method = PackageManager.class.getMethod("canRequestPackageInstalls");
            Object result = method.invoke(getPackageManager());
            return Boolean.TRUE.equals(result);
        } catch (Exception error) {
            return false;
        }
    }

    private String currentVersionName() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.versionName == null ? "0" : info.versionName;
        } catch (Exception error) {
            return "0";
        }
    }

    private static boolean isNewerVersion(String remote, String local) {
        String[] remoteParts = String.valueOf(remote).replaceFirst("^[vV]", "").split("\\.");
        String[] localParts = String.valueOf(local).replaceFirst("^[vV]", "").split("\\.");
        int length = Math.max(remoteParts.length, localParts.length);
        for (int index = 0; index < length; index++) {
            long remotePart = versionPart(index < remoteParts.length ? remoteParts[index] : "0");
            long localPart = versionPart(index < localParts.length ? localParts[index] : "0");
            if (remotePart != localPart) return remotePart > localPart;
        }
        return false;
    }

    private static long versionPart(String value) {
        String digits = String.valueOf(value).replaceFirst("[^0-9].*$", "");
        if (digits.isEmpty()) return 0L;
        try { return Long.parseLong(digits); } catch (NumberFormatException error) { return 0L; }
    }

    @Override
    public void onBackPressed() {
        if (historyReportOpen && webView != null) {
            historyReportOpen = false;
            webView.evaluateJavascript("(function(){if(window.FleetControlCloseHistoryReport){window.FleetControlCloseHistoryReport();}else{history.back();}})();", null);
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        activityResumed = false;
        mainHandler.removeCallbacks(periodicUpdateCheck);
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
