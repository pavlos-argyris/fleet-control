package gr.argyrismitsos.fleetcontrol;

import gr.argyrismitsos.fleetupdates.OtaInstaller;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
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
import android.content.res.Configuration;
import android.graphics.Color;
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
import android.view.ViewGroup;
import android.view.Window;
import android.widget.Toast;

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
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

public class MainActivity extends Activity {
    private static final String CHANNEL_ID = "fleet_service_alerts";
    private static final int NOTIFICATION_PERMISSION_REQUEST = 41;
    private static final int HISTORY_EXPORT_REQUEST = 209;
    private byte[] pendingHistoryExport;
    private static final int INVOICE_ZIP_REQUEST=210,DIAGNOSTIC_EXPORT_REQUEST=211;
    private String pendingInvoiceZipJson, pendingInvoiceZipToken;
    private byte[] pendingDiagnosticReport;
    private final AtomicBoolean invoiceZipCancelled=new AtomicBoolean(false);
    private volatile boolean invoiceZipRunning=false;

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
    private static final long UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000L;
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
    private volatile UpdateInfo availableUpdate;
    private volatile String updateStateJson = "{}";
    private volatile long updateDownloadedBytes;
    private void clientUpdateStage(String stage,String message,boolean offer) {
        try {
            final org.json.JSONObject state=new org.json.JSONObject().put("stage",stage).put("message",message).put("offer",offer)
                .put("downloadedBytes",updateDownloadedBytes).put("currentVersion",currentVersionName());
            UpdateInfo info=availableUpdate;
            if (info!=null) state.put("ready",new org.json.JSONObject().put("version",info.version).put("notes",formatUpdateNotes(info.notes)).put("sizeBytes",info.sizeBytes));
            updateStateJson=state.toString();
            mainHandler.post(new Runnable(){public void run(){if(webView!=null) webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('fleet-client-ota',{detail:"+state.toString()+"}));",null);}});
        }catch(Exception ignored){}
    }

    private PermissionRequest pendingCameraPermissionRequest;
    private volatile boolean historyReportOpen = false;
    private volatile boolean clientOtaOpen = false;

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

    // Keep the live page (open card/dialog, unsaved inputs and scroll) on rotation
    // and window resizing. The manifest opts into these configuration changes;
    // Android resizes the same WebView and its existing responsive CSS reflows.
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (webView != null) webView.requestLayout();
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
        OtaInstaller.resume(this);
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
        OtaInstaller.pause(this);
        activityResumed = false;
        mainHandler.removeCallbacks(periodicUpdateCheck);
        super.onPause();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if(requestCode==INVOICE_ZIP_REQUEST){
            final String manifest=pendingInvoiceZipJson,token=pendingInvoiceZipToken;pendingInvoiceZipJson=null;pendingInvoiceZipToken=null;
            if(resultCode==RESULT_OK&&data!=null&&data.getData()!=null&&manifest!=null&&token!=null)writeInvoiceZip(data.getData(),manifest,token);
            else {invoiceZipRunning=false;emitInvoiceZip("cancelled",0,0);}
        }
        if(requestCode==DIAGNOSTIC_EXPORT_REQUEST){
            final byte[] bytes=pendingDiagnosticReport;pendingDiagnosticReport=null;
            if(resultCode==RESULT_OK&&data!=null&&data.getData()!=null&&bytes!=null){final Uri target=data.getData();new Thread(new Runnable(){public void run(){try{OutputStream output=getContentResolver().openOutputStream(target);if(output==null)throw new Exception();try{output.write(bytes);}finally{output.close();}}catch(Exception ignored){runOnUiThread(new Runnable(){public void run(){Toast.makeText(MainActivity.this,"Δεν αποθηκεύτηκε η αναφορά.",Toast.LENGTH_LONG).show();}});}}}).start();}
        }
        if (requestCode == HISTORY_EXPORT_REQUEST) {
            final byte[] bytes = pendingHistoryExport; pendingHistoryExport = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null && bytes != null) {
                final Uri target = data.getData();
                new Thread(new Runnable() { public void run() {
                    try { OutputStream output = getContentResolver().openOutputStream(target); if(output == null) throw new IllegalStateException("Δεν άνοιξε το αρχείο.");
                        try { output.write(bytes); output.flush(); } finally { output.close(); }
                        runOnUiThread(new Runnable() { public void run() { Toast.makeText(MainActivity.this,"Το Excel αποθηκεύτηκε.",Toast.LENGTH_SHORT).show(); }});
                    } catch(Exception error) { runOnUiThread(new Runnable() { public void run() { Toast.makeText(MainActivity.this,"Δεν αποθηκεύτηκε το Excel. Δοκίμασε ξανά.",Toast.LENGTH_LONG).show(); }}); }
                }}).start();
            }
        }
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
        @JavascriptInterface public void setClientOtaOpen(boolean open){clientOtaOpen=open;}
        @JavascriptInterface public String getClientUpdateState() {
            try {
                org.json.JSONObject state=new org.json.JSONObject(updateStateJson);
                SharedPreferences installer=OtaInstaller.preferences(MainActivity.this);
                String nativeStage=installer.getString("status","");
                if (!updateCheckInFlight.get() && !updateDownloadInFlight.get() && ("installing".equals(nativeStage)||"confirmation".equals(nativeStage)||("failed".equals(nativeStage) && ("installing".equals(state.optString("stage")) || "confirmation".equals(state.optString("stage")))))) {
                    state.put("stage",nativeStage).put("message",installer.getString("message",""));
                }
                return state.toString();
            } catch(Exception error){return updateStateJson;}
        }
        @JavascriptInterface public void checkClientUpdate(){mainHandler.post(new Runnable(){public void run(){checkForUpdates(true);}});}
        @JavascriptInterface public void installClientUpdate(){mainHandler.post(new Runnable(){public void run(){
            String status=OtaInstaller.preferences(MainActivity.this).getString("status","");
            if ("confirmation".equals(status)) {OtaInstaller.openConfirmation(MainActivity.this);return;}
            if(availableUpdate!=null) startUpdate(availableUpdate);
        }});}
        @JavascriptInterface public void dismissClientUpdate(){UpdateInfo info=availableUpdate;if(info!=null)rememberPrompt(info.version);clientUpdateStage("waiting","Η ενημέρωση είναι διαθέσιμη όταν είσαι έτοιμος.",false);}
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
        public void exportInvoiceZip(final String manifest,final String token){
            if(manifest==null||manifest.length()>512*1024||token==null||token.length()<20||token.length()>4096)return;
            runOnUiThread(new Runnable(){public void run(){if(invoiceZipRunning)return;try{
                org.json.JSONArray files=new org.json.JSONObject(manifest).getJSONArray("files");if(files.length()<1||files.length()>500)return;
                invoiceZipRunning=true;invoiceZipCancelled.set(false);pendingInvoiceZipJson=manifest;pendingInvoiceZipToken=token;
                Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT);intent.addCategory(Intent.CATEGORY_OPENABLE);intent.setType("application/zip");intent.putExtra(Intent.EXTRA_TITLE,"Fleet_Invoices.zip");startActivityForResult(intent,INVOICE_ZIP_REQUEST);
            }catch(Exception error){pendingInvoiceZipJson=null;pendingInvoiceZipToken=null;invoiceZipRunning=false;emitInvoiceZip("error",0,0);}}});
        }
        @JavascriptInterface public void cancelInvoiceZip(){invoiceZipCancelled.set(true);}
        @JavascriptInterface public void exportDiagnosticReport(final String json){
            if(json==null||json.length()>65536)return;
            try{final org.json.JSONObject report=new org.json.JSONObject(json);if(!"Fleet Control diagnostics".equals(report.optString("report")))return;final byte[] bytes=json.getBytes("UTF-8");runOnUiThread(new Runnable(){public void run(){if(pendingDiagnosticReport!=null)return;try{pendingDiagnosticReport=bytes;Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT);intent.addCategory(Intent.CATEGORY_OPENABLE);intent.setType("application/json");intent.putExtra(Intent.EXTRA_TITLE,"Fleet_Diagnostics.json");startActivityForResult(intent,DIAGNOSTIC_EXPORT_REQUEST);}catch(Exception ignored){pendingDiagnosticReport=null;}}});}catch(Exception ignored){}
        }

        @JavascriptInterface
        public void exportHistoryExcel(final String encoded, final String requestedName) {
            if (encoded == null || encoded.length() > 36 * 1024 * 1024 || pendingHistoryExport != null) return;
            try {
                final byte[] bytes = Base64.decode(encoded,Base64.DEFAULT);
                if(bytes.length < 4 || bytes[0] != 80 || bytes[1] != 75) return;
                runOnUiThread(new Runnable() { public void run() {
                    pendingHistoryExport = bytes;
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT); intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
                    intent.putExtra(Intent.EXTRA_TITLE,requestedName!=null&&requestedName.matches("[A-Za-z0-9_-]{1,90}\\.xlsx")?requestedName:"Fleet_Service_History.xlsx");
                    try { startActivityForResult(intent,HISTORY_EXPORT_REQUEST); } catch(Exception error) { pendingHistoryExport=null;Toast.makeText(MainActivity.this,"Δεν υπάρχει εφαρμογή αποθήκευσης αρχείων.",Toast.LENGTH_LONG).show(); }
                }});
            } catch(Exception ignored) {}
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

    private static String formatUpdateNotes(String value) {
        String text = value == null ? "" : value.trim();
        if (text.length() == 0) return "• Βελτιώσεις λειτουργίας και ασφάλειας.";
        StringBuilder result = new StringBuilder();
        for (String line : text.split("\\r?\\n|,\\s+")) {
            String item = line.replaceFirst("^\\s*[•*-]\\s*", "").trim();
            if (item.length() == 0) continue;
            if (result.length() > 0) result.append("\n");
            result.append("• ").append(item);
        }
        return result.toString();
    }

    private static final class UpdateInfo {
        final String version;
        final long sizeBytes;
        final String sha256;
        final String notes;
        final int versionCode;
        final String downloadUrl;

        UpdateInfo(String version, long sizeBytes, String sha256, String notes, int versionCode, String downloadUrl) {
            this.version = version;
            this.sizeBytes = sizeBytes;
            this.sha256 = sha256;
            this.notes = notes;
            this.versionCode = versionCode;
            this.downloadUrl = downloadUrl;
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

    private void checkForUpdates() { checkForUpdates(false); }
    private void checkForUpdates(final boolean force) {
        if (isFinishing() || !updateCheckInFlight.compareAndSet(false, true)) return;
        final SharedPreferences preferences = getSharedPreferences(UPDATE_PREFERENCES, MODE_PRIVATE);
        final long now = System.currentTimeMillis();
        if (!force && now - preferences.getLong(LAST_UPDATE_CHECK_KEY, 0L) < UPDATE_CHECK_INTERVAL_MS) {
            updateCheckInFlight.set(false);
            return;
        }
        preferences.edit().putLong(LAST_UPDATE_CHECK_KEY, now).apply();
        clientUpdateStage("checking","Έλεγχος νέας έκδοσης…",false);

        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    final UpdateInfo update = fetchUpdateInfo();
                    if (update != null && isNewerVersion(update.version, currentVersionName())) {
                        mainHandler.post(new Runnable() {
                            @Override
                            public void run() {
                                availableUpdate=update;
                                if(force) clientUpdateStage("waiting","Νέα έκδοση διαθέσιμη.",false);else offerUpdate(update);
                            }
                        });
                    } else {availableUpdate=null;clientUpdateStage("current","Έχεις την τελευταία έκδοση.",false);}
                } catch (Exception error) {
                    clientUpdateStage("failed","Ο έλεγχος δεν ολοκληρώθηκε: " + (error.getMessage()==null ? "έλεγξε τη σύνδεση" : error.getMessage()),false);
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
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) throw new IllegalStateException("HTTP " + connection.getResponseCode());
            org.json.JSONObject body = new org.json.JSONObject(readResponse(connection.getInputStream(), 64 * 1024));
            if (!body.optBoolean("available", false)) return null;
            String version = body.optString("version", "").trim();
            if (version.isEmpty()) return null;
            return new UpdateInfo(
                    version,
                    Math.max(0L, body.optLong("sizeBytes", 0L)),
                    body.optString("sha256", "").trim().toLowerCase(Locale.US),
                    body.optString("notes", "").trim(),
                    body.optInt("versionCode", 0),
                    body.optString("downloadUrl", UPDATE_DOWNLOAD_URL));
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

        availableUpdate=update;
        clientUpdateStage("waiting","Νέα έκδοση διαθέσιμη · επιβεβαίωσε την εγκατάσταση στο Android όταν ζητηθεί.",true);
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
            clientUpdateStage("permission","Χρειάζεται άδεια εγκατάστασης. Ενεργοποίησέ την στις ρυθμίσεις Android και επέστρεψε.",false);
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
        updateDownloadedBytes=0;
        clientUpdateStage("downloading","Γίνεται λήψη της νέας έκδοσης…",false);
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
                            clientUpdateStage("failed","Η ενημέρωση δεν ολοκληρώθηκε: " + (error.getMessage()==null ? "δοκίμασε ξανά" : error.getMessage()),false);
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
            URL endpoint = new URL(update.downloadUrl);
            URL trusted = new URL(UPDATE_DOWNLOAD_URL);
            if (!trusted.getHost().equalsIgnoreCase(endpoint.getHost()) || trusted.getPort() != endpoint.getPort() || !trusted.getPath().equals(endpoint.getPath())) throw new IllegalStateException("Μη έγκυρη διεύθυνση APK.");
            if (!"https".equalsIgnoreCase(endpoint.getProtocol())) throw new IllegalStateException("Μη ασφαλής σύνδεση APK.");
            connection = (HttpURLConnection) endpoint.openConnection();
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(30000);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/vnd.android.package-archive");
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) throw new IllegalStateException("Η λήψη απέτυχε.");
            long expectedSize = update.sizeBytes;
            if (expectedSize > MAX_UPDATE_BYTES) throw new IllegalStateException("Το APK είναι υπερβολικά μεγάλο.");
            try (InputStream input = new BufferedInputStream(connection.getInputStream());
                 OutputStream output = new BufferedOutputStream(new FileOutputStream(part))) {
                byte[] buffer = new byte[8192];
                int count;
                long total = 0L, lastUpdateProgress = 0L;
                while ((count = input.read(buffer)) != -1) {
                    total += count;
                    if (total > MAX_UPDATE_BYTES) throw new IllegalStateException("Το APK είναι υπερβολικά μεγάλο.");
                    output.write(buffer, 0, count);
                    if (System.currentTimeMillis()-lastUpdateProgress>=250 || total>=expectedSize) {
                        lastUpdateProgress=System.currentTimeMillis();updateDownloadedBytes=total;
                        clientUpdateStage("downloading","Λήψη νέας έκδοσης…",false);
                    }
                }
                output.flush();
                if (expectedSize > 0L && total != expectedSize) throw new IllegalStateException("Το APK δεν κατέβηκε πλήρως.");
            }
        } finally {
            if (connection != null) connection.disconnect();
        }

        clientUpdateStage("validating","Έλεγχος αρχείου και υπογραφής…",false);
        try { OtaInstaller.validate(this, part, update.versionCode, update.version, update.sizeBytes, update.sha256); }
        catch (Exception error) { part.delete(); throw error; }
        if (!part.renameTo(apk)) throw new IllegalStateException("Δεν αποθηκεύτηκε το APK.");
        return apk;
    }

    private void installUpdate(File apk) {
        try {clientUpdateStage("installing","Προετοιμασία εγκατάστασης Android…",false); OtaInstaller.install(this, apk); }
        catch (Exception error) {clientUpdateStage("failed","Δεν ξεκίνησε η εγκατάσταση: " + error.getMessage(),false);}
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

    private void emitInvoiceZip(final String status,final int files,final int total){
        try{final String json=new org.json.JSONObject().put("status",status).put("files",files).put("total",total).toString();mainHandler.post(new Runnable(){public void run(){if(webView!=null)webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('fleet-invoice-zip',{detail:"+json+"}));",null);}});}catch(Exception ignored){}
    }
    private void writeInvoiceZip(final Uri target,final String manifest,final String token){
        new Thread(new Runnable(){public void run(){boolean success=false;int count=0;try{
            org.json.JSONArray rows=new org.json.JSONObject(manifest).getJSONArray("files");final java.util.List<InvoiceZipWriter.Item> files=new java.util.ArrayList<InvoiceZipWriter.Item>();for(int i=0;i<rows.length();i++){org.json.JSONObject row=rows.getJSONObject(i);files.add(new InvoiceZipWriter.Item(row.getString("key"),row.getString("name")));}count=files.size();
            OutputStream output=getContentResolver().openOutputStream(target);if(output==null)throw new Exception("Output unavailable");
            try{InvoiceZipWriter.write(files,output,new InvoiceZipWriter.Source(){public InputStream open(String key)throws Exception{
                final HttpURLConnection connection=(HttpURLConnection)new URL("https://fleet-control.pavlosargyris.workers.dev/api/service-documents/"+Uri.encode(key,"/")).openConnection();connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(20000);connection.setReadTimeout(45000);connection.setRequestProperty("Authorization","Bearer "+token);
                try{if(connection.getResponseCode()!=200||connection.getContentLength()>InvoiceZipWriter.MAX_FILE)throw new Exception("PDF unavailable");return new java.io.FilterInputStream(connection.getInputStream()){@Override public void close()throws java.io.IOException{try{super.close();}finally{connection.disconnect();}}};}catch(Exception error){connection.disconnect();throw error;}
            }},new InvoiceZipWriter.Control(){public boolean cancelled(){return invoiceZipCancelled.get();}public void progress(int done,int total,long bytes){emitInvoiceZip("progress",done,total);}});}finally{output.close();}
            success=true;emitInvoiceZip("complete",count,count);
        }catch(Exception error){emitInvoiceZip(invoiceZipCancelled.get()?"cancelled":"error",0,count);}finally{
            if(!success){try{android.provider.DocumentsContract.deleteDocument(getContentResolver(),target);}catch(Exception ignored){}}
            invoiceZipRunning=false;
        }}}).start();
    }

    private boolean backNavigationPending = false;

    @Override
    public void onBackPressed() {
        if (clientOtaOpen && webView != null) {
            webView.evaluateJavascript("if(window.FleetClientOta)window.FleetClientOta.close();", null);
            return;
        }
        if (backNavigationPending) return;
        if (webView == null) { finishBackNavigation(); return; }
        backNavigationPending = true;
        webView.evaluateJavascript("(function(){return !!(window.FleetNavigation && window.FleetNavigation.back());})()", new android.webkit.ValueCallback<String>() {
            @Override public void onReceiveValue(String handled) {
                backNavigationPending = false;
                if (!"true".equals(handled) && webView != null) finishBackNavigation();
            }
        });
    }

    private void finishBackNavigation() {
        if (historyReportOpen && webView != null) {
            historyReportOpen = false;
            webView.evaluateJavascript("(function(){if(window.FleetControlCloseHistoryReport){window.FleetControlCloseHistoryReport();}else{history.back();}})();", null);
            return;
        }
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        invoiceZipCancelled.set(true);pendingInvoiceZipJson=null;pendingInvoiceZipToken=null;
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
