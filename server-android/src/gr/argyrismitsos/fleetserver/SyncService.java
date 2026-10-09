package gr.argyrismitsos.fleetserver;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.net.URLEncoder;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public final class SyncService extends Service {
    private static final String CHANNEL_ID = "fleet_server_status";
    private static final int NOTIFICATION_ID = 7101;
    private static final String PREF_INVOICE_REPROCESS_STATE = "invoice_reprocess_state";
    private static final String PREF_INVOICE_REPROCESS_UPDATED_AT = "invoice_reprocess_updated_at";
    private ScheduledExecutorService executor;
    private FleetDataStore store;
    private boolean foregroundReady;

    @Override
    public void onCreate() {
        super.onCreate();
        store = new FleetDataStore(getApplicationContext());
        SharedPreferences preferences = getSharedPreferences(BackupManager.PREFS, MODE_PRIVATE);
        boolean unexpectedRestart = preferences.getBoolean("service_running", false);
        if (unexpectedRestart) {
            preferences.edit()
                    .putBoolean("unexpected_restart", true)
                    .putString("unexpected_restart_at", isoNow())
                    .putInt("restart_count", preferences.getInt("restart_count", 0) + 1)
                    .apply();
        }
        try {
            createChannel();
            startForeground(NOTIFICATION_ID, buildNotification("Εκκίνηση server…"));
            foregroundReady = true;
        } catch (RuntimeException error) {
            String message = error.getMessage() == null
                    ? "Η υπηρεσία παρασκηνίου δεν μπόρεσε να ξεκινήσει."
                    : error.getMessage();
            preferences.edit()
                    .putBoolean("service_running", false)
                    .putBoolean("server_online", false)
                    .putString("last_error", message)
                    .apply();
            stopSelf();
            return;
        }
        preferences.edit().putBoolean("service_running", true).apply();
        executor = Executors.newSingleThreadScheduledExecutor();
        executor.scheduleWithFixedDelay(new Runnable() {
            @Override
            public void run() {
                syncSafely();
            }
        }, 0, 5, TimeUnit.SECONDS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return foregroundReady ? START_STICKY : START_NOT_STICKY;
    }

    private void syncSafely() {
        SharedPreferences preferences = getSharedPreferences(BackupManager.PREFS, MODE_PRIVATE);
        OtaManager.check(getApplicationContext(), false);
        long lastAttempt = preferences.getLong("last_sync_attempt_ms", 0);
        int seconds = Math.max(10, preferences.getInt("sync_seconds", 30));
        if (System.currentTimeMillis() - lastAttempt < seconds * 1000L) {
            // Keep the Server screen live while the full mirror sync remains
            // throttled. The batch endpoint is lightweight and is polled at
            // every scheduled tick.
            refreshInvoiceReprocessStatus(preferences);
            return;
        }
        preferences.edit().putLong("last_sync_attempt_ms", System.currentTimeMillis()).apply();
        // The scheduled Drive backup is independent of the Cloudflare connection.
        BackupManager.maybeAutomatic(getApplicationContext(), store);
        try {
            syncOnce(preferences);
            OtaManager.maybeApply(getApplicationContext(), store);
        } catch (Exception error) {
            String message = error.getMessage() == null ? "Αποτυχία σύνδεσης" : error.getMessage();
            preferences.edit()
                    .putBoolean("server_online", false)
                    .putString("last_error", message)
                    .apply();
            updateNotification("Εκτός σύνδεσης • θα ξαναδοκιμάσει");
        }
    }

    private void syncOnce(SharedPreferences preferences) throws Exception {
        String base = preferences.getString("worker_url", ServerConfig.DEFAULT_WORKER_URL);
        if (base == null || base.length() == 0) base = ServerConfig.DEFAULT_WORKER_URL;
        base = base.replaceAll("/+$", "");
        Map<String, String> headers = serverHeaders();

        // Pull the online cache first. A fresh/reinstalled server must never
        // replace a valid Cloudflare snapshot with an empty local database.
        JSONObject remoteSnapshot = FleetHttp.getJson(base + "/api/snapshot", headers);
        store.mergeFleet(remoteSnapshot);
        ServiceDocumentStore.syncFromFleet(getApplicationContext(), remoteSnapshot, base, headers);

        JSONObject pending = FleetHttp.getJson(base + "/api/server/pending?limit=50", headers);
        JSONObject fullExport = FleetHttp.getJson(base + "/api/server/system-export", headers);
        store.setSystemExport(fullExport);
        JSONArray operations = pending.optJSONArray("operations");
        int invoiceParallelism = Math.max(1, Math.min(10, preferences.getInt("invoice_parallelism", 4)));
        List<String> applied = new ArrayList<String>();
        List<String> backupRequests = new ArrayList<String>();
        String serviceDocumentNotice = preferences.getString("last_service_document_error", "").length() > 0
                ? "Σφάλμα PDF τιμολογίου • πάτησε Επανάληψη"
                : "";
        if (operations != null) {
            for (int i = 0; i < operations.length(); i++) {
                JSONObject operation = operations.optJSONObject(i);
                if (operation == null) continue;
                String id = operation.optString("id", "");
                if (id.length() == 0 || store.wasApplied(id)) {
                    if (id.length() > 0) applied.add(id);
                    continue;
                }
                String type = operation.optString("type", "");
                if ("snapshot_merge".equals(type)) {
                    store.mergeFleet(operation.optJSONObject("payload") == null ? new JSONObject() : operation.optJSONObject("payload"));
                } else if ("snapshot_replace_bike".equals(type)) {
                    JSONObject payload = operation.optJSONObject("payload");
                    store.replaceBike(payload == null ? null : payload.optJSONObject("bike"));
                } else if ("service_document_render".equals(type)) {
                    try {
                        JSONObject result = renderAndUploadServiceDocument(base, id, operation.optJSONObject("payload"), headers);
                        if (result.optJSONObject("attachment") != null) {
                            JSONObject payload = operation.optJSONObject("payload");
                            if (payload != null) {
                                store.attachServiceDocument(payload.optString("bikeId", ""), payload.optString("entryId", ""), result.optJSONObject("attachment"));
                            }
                        }
                        preferences.edit()
                                .putString("last_service_document_at", isoNow())
                                .putString("last_service_document_error", "")
                                .putString("last_error", "")
                                .apply();
                    } catch (Exception error) {
                        String message = error.getMessage() == null ? "Αποτυχία δημιουργίας PDF τιμολογίου" : error.getMessage();
                        preferences.edit().putString("last_service_document_error", message).apply();
                        try {
                            JSONObject failure = reportOperationError(base, id, message, headers);
                            serviceDocumentNotice = "error".equals(failure.optString("status", ""))
                                    ? "Σφάλμα PDF τιμολογίου • πάτησε Επανάληψη"
                                    : "Προσωρινό σφάλμα PDF • θα ξαναδοκιμάσει";
                        } catch (Exception ignored) {
                            serviceDocumentNotice = "Προσωρινό σφάλμα PDF • θα ξαναδοκιμάσει";
                        }
                        // The Worker keeps the operation pending for the first
                        // failures and marks it error after the retry budget.
                        continue;
                    }
                } else if ("service_document_reprocess_batch".equals(type)) {
                    try {
                        boolean batchComplete = false;
                        String previousCursor = "";
                        // Process the queue consecutively in this sync run.
                        // The old behavior handled only one PDF and waited
                        // for the next full mirror cycle (normally 30 sec).
                        for (int batchStep = 0; batchStep < 5000; batchStep++) {
                            JSONObject result = processInvoiceReprocessBatch(base, headers, preferences, invoiceParallelism);
                            if (result.optBoolean("complete", false)) {
                                batchComplete = true;
                                break;
                            }
                            JSONObject progressBatch = result.optJSONObject("batch");
                            serviceDocumentNotice = "Νέα ανάγνωση τιμολογίων • "
                                    + (progressBatch == null ? 0 : progressBatch.optInt("progress", 0)) + "%";
                            updateNotification(serviceDocumentNotice);
                            if (progressBatch == null) break;
                            String cursor = progressBatch.optString("id", "") + "|"
                                    + progressBatch.optInt("currentIndex", -1) + "|"
                                    + progressBatch.optInt("completed", -1);
                            if (cursor.equals(previousCursor)) break;
                            previousCursor = cursor;
                        }
                        if (!batchComplete) continue;
                    } catch (Exception error) {
                        String message = error.getMessage() == null ? "Αποτυχία τοπικής ανάγνωσης τιμολογίων" : error.getMessage();
                        preferences.edit().putString("last_service_document_error", message).apply();
                        markInvoiceReprocessError(preferences, message);
                        serviceDocumentNotice = "Σφάλμα νέας ανάγνωσης τιμολογίων • θα ξαναδοκιμάσει";
                        continue;
                    }
                } else if ("backup_request".equals(type)) {
                    backupRequests.add(id);
                    continue;
                }
                store.markApplied(id);
                applied.add(id);
            }
        }

        if (!backupRequests.isEmpty()) {
            try {
                BackupManager.createBackup(getApplicationContext(), store);
                for (String id : backupRequests) {
                    store.markApplied(id);
                    applied.add(id);
                }
            } catch (Exception error) {
                preferences.edit().putString(BackupManager.KEY_LAST_RESULT, error.getMessage()).apply();
            }
        }

        if (!applied.isEmpty()) {
            JSONArray ids = new JSONArray();
            for (String id : applied) ids.put(id);
            JSONObject acknowledgement = new JSONObject();
            acknowledgement.put("ids", ids);
            FleetHttp.sendJson(base + "/api/server/ack", "POST", acknowledgement, headers);
        }

        JSONObject snapshot = store.getFleet();
        snapshot.put("version", System.currentTimeMillis());
        FleetHttp.sendJson(base + "/api/server/snapshot", "PUT", snapshot, headers);
        JSONObject heartbeat = new JSONObject();
        heartbeat.put("serverVersion", ServerConfig.SERVER_VERSION);
        heartbeat.put("lastBackup", preferences.getString(BackupManager.KEY_LAST_TIME, ""));
        heartbeat.put("backupResult", preferences.getString(BackupManager.KEY_LAST_RESULT, ""));
        heartbeat.put("unexpectedRestart", preferences.getBoolean("unexpected_restart", false));
        heartbeat.put("restartAt", preferences.getString("unexpected_restart_at", ""));
        heartbeat.put("health", DeviceHealth.collect(getApplicationContext()));
        FleetHttp.sendJson(base + "/api/server/heartbeat", "POST", heartbeat, headers);
        JSONObject status = FleetHttp.getJson(base + "/api/status", headers);
        String now = isoNow();
        preferences.edit()
                .putBoolean("server_online", true)
                .putBoolean("database_ok", status.optBoolean("databaseOk", false))
                .putBoolean("storage_ok", status.optBoolean("storageOk", false))
                .putBoolean("fleet_control_ok", status.optBoolean("fleetControlOk", false))
                .putBoolean("watchdog_active", status.optBoolean("watchdogActive", false))
                .putBoolean("pwa_connected", status.optBoolean("pwaConnected", false))
                .putString("pwa_last_seen", status.optString("pwaLastSeen", ""))
                .putInt("remote_users", status.optInt("users", 0))
                .putInt("remote_active_shifts", status.optInt("activeShifts", 0))
                .putInt("remote_pending_alerts", status.optInt("pendingAlerts", 0))
                .putBoolean("unexpected_restart", false)
                .putString("last_sync_time", now)
                .putString("last_error", "")
                .putInt("last_applied_count", applied.size())
                .apply();
        updateNotification(serviceDocumentNotice.length() > 0 ? serviceDocumentNotice : "Online • συγχρονίστηκε τώρα");
    }

    private void refreshInvoiceReprocessStatus(SharedPreferences preferences) {
        String base = preferences.getString("worker_url", ServerConfig.DEFAULT_WORKER_URL);
        if (base == null || base.length() == 0) base = ServerConfig.DEFAULT_WORKER_URL;
        base = base.replaceAll("/+$", "");
        try {
            refreshInvoiceReprocessStatus(base, serverHeaders(), preferences);
        } catch (Exception error) {
            markInvoiceReprocessError(preferences, error.getMessage() == null
                    ? "Δεν ήταν δυνατή η ενημέρωση της προόδου."
                    : error.getMessage());
        }
    }

    private JSONObject refreshInvoiceReprocessStatus(String base, Map<String, String> headers, SharedPreferences preferences) throws Exception {
        JSONObject response = FleetHttp.getJson(base + "/api/server/service-documents/reprocess-batch", headers);
        JSONObject batch = response.optJSONObject("batch");
        if (batch == null) {
            preferences.edit()
                    .remove(PREF_INVOICE_REPROCESS_STATE)
                    .remove(PREF_INVOICE_REPROCESS_UPDATED_AT)
                    .apply();
            return null;
        }
        saveInvoiceReprocessState(preferences, batch, "");
        return batch;
    }

    private void saveInvoiceReprocessState(SharedPreferences preferences, JSONObject batch, String stage) {
        if (batch == null) return;
        try {
            JSONObject copy = new JSONObject(batch.toString());
            if (stage != null && stage.length() > 0) copy.put("serverStage", stage);
            copy.put("serverUpdatedAt", isoNow());
            preferences.edit()
                    .putString(PREF_INVOICE_REPROCESS_STATE, copy.toString())
                    .putString(PREF_INVOICE_REPROCESS_UPDATED_AT, isoNow())
                    .apply();
        } catch (Exception ignored) {
        }
    }

    private void markInvoiceReprocessError(SharedPreferences preferences, String message) {
        String raw = preferences.getString(PREF_INVOICE_REPROCESS_STATE, "");
        if (raw.length() == 0) return;
        try {
            JSONObject state = new JSONObject(raw);
            state.put("serverError", message == null
                    ? "Δεν ήταν δυνατή η ενημέρωση της προόδου."
                    : message);
            state.put("serverUpdatedAt", isoNow());
            preferences.edit()
                    .putString(PREF_INVOICE_REPROCESS_STATE, state.toString())
                    .putString(PREF_INVOICE_REPROCESS_UPDATED_AT, isoNow())
                    .apply();
        } catch (Exception ignored) {
        }
    }

    private JSONObject renderAndUploadServiceDocument(String base, String jobId, JSONObject payload, Map<String, String> headers) throws Exception {
        if (payload == null) throw new Exception("Λείπουν τα στοιχεία της εργασίας τιμολογίου.");
        String bikeId = payload.optString("bikeId", "");
        String entryId = payload.optString("entryId", "");
        String qrValue = payload.optString("qrValue", "");
        String qrUrl = payload.optString("qrUrl", "");
        if (bikeId.length() == 0 || entryId.length() == 0 || qrUrl.length() == 0) {
            throw new Exception("Το QR δεν έχει έγκυρη σύνδεση με service.");
        }
        reportOperationProgress(base, jobId, 5, "Ο Server ξεκίνησε την επεξεργασία", headers);
        ServiceDocumentRenderer.RenderedDocument renderedDocument = ServiceDocumentRenderer.renderToPdfWithText(this, qrUrl, "invoice-qr-" + jobId + ".pdf");
        File rendered = renderedDocument.output;
        try {
            JSONObject localOcr;
            try {
                localOcr = LocalInvoiceReader.readBest(rendered, renderedDocument.pageText);
            } catch (Exception localError) {
                localOcr = new JSONObject();
                localOcr.put("source", "server-local");
                localOcr.put("ocrSource", "server-local");
                localOcr.put("localReadStatus", "failed");
                localOcr.put("ocrConfidence", 0);
                localOcr.put("ocrFallbackUsed", false);
                localOcr.put("ocrFallbackReason", localError.getMessage() == null ? "Η τοπική ανάγνωση του PDF απέτυχε." : localError.getMessage());
            }
            int localConfidence = localOcr.optInt("ocrConfidence", 0);
            String localStatus = localOcr.optString("localReadStatus", "ambiguous");
            reportOperationProgress(base, jobId, 55, "Το PDF δημιουργήθηκε · τοπικός έλεγχος στοιχείων", headers);
            String endpoint = base + "/api/server/service-documents/rendered"
                    + "?jobId=" + encodeQuery(jobId)
                    + "&bikeId=" + encodeQuery(bikeId)
                    + "&entryId=" + encodeQuery(entryId)
                    + "&qrValue=" + encodeQuery(qrValue)
                    + "&qrUrl=" + encodeQuery(qrUrl)
                    + "&name=" + encodeQuery("invoice-qr-" + jobId + ".pdf");
            reportOperationProgress(base, jobId, 70, localStatus.equals("confident")
                    ? "Ανεβαίνει το PDF · η τοπική ανάγνωση ολοκληρώθηκε"
                    : "Ανεβαίνει το PDF · ελέγχεται και θα γίνει fallback αν χρειαστεί", headers);
            Map<String, String> uploadHeaders = new HashMap<String, String>(headers);
            uploadHeaders.put("X-Fleet-Local-Ocr", encodeJsonHeader(localOcr));
            uploadHeaders.put("X-Fleet-Ocr-Source", "server-local");
            uploadHeaders.put("X-Fleet-Ocr-Confidence", String.valueOf(localConfidence));
            FileInputStream input = new FileInputStream(rendered);
            JSONObject result = FleetHttp.putStream(endpoint, input, rendered.length(), "application/pdf", uploadHeaders);
            if (result.optBoolean("fallbackUsed", false)) {
                updateNotification("Τοπική ανάγνωση αμφίβολη • χρησιμοποιήθηκε Workers AI");
            }
            reportOperationProgress(base, jobId, 95, "Το PDF αποθηκεύτηκε · ολοκληρώνεται η καταχώρηση", headers);
            JSONObject attachment = result.optJSONObject("attachment");
            if (attachment != null) {
                ServiceDocumentStore.cacheLocalCopy(this, attachment.optString("key", ""), rendered, attachment.optString("name", "invoice.pdf"));
            }
            return result;
        } finally {
            if (rendered.exists()) rendered.delete();
        }
    }

    private JSONObject processInvoiceReprocessBatch(String base, Map<String, String> headers, SharedPreferences preferences, int parallelism) throws Exception {
        int workerCount = Math.max(1, Math.min(10, parallelism));
        JSONObject state = FleetHttp.getJson(base + "/api/server/service-documents/reprocess-batch?window=" + workerCount, headers);
        JSONObject batch = state.optJSONObject("batch");
        if (state.optBoolean("complete", false) || batch == null || !"processing".equals(batch.optString("status", ""))) {
            if (batch != null) saveInvoiceReprocessState(preferences, batch, "");
            return new JSONObject().put("complete", true).put("batch", batch == null ? JSONObject.NULL : batch);
        }
        JSONArray window = state.optJSONArray("items");
        if (window == null || window.length() == 0) {
            JSONObject item = state.optJSONObject("item");
            if (item == null) return new JSONObject().put("complete", true).put("batch", batch);
            window = new JSONArray().put(item);
        }
        int count = Math.min(workerCount, window.length());
        String batchId = batch.optString("id", "");
        if (batchId.length() == 0) throw new Exception("Η νέα ανάγνωση δεν έχει έγκυρη εργασία.");

        List<String> activeNames = new ArrayList<String>();
        for (int index = 0; index < count; index++) {
            JSONObject item = window.optJSONObject(index);
            activeNames.add(item == null ? "invoice.pdf" : item.optString("name", "invoice.pdf"));
        }
        saveInvoiceReprocessParallelState(preferences, batch, activeNames);

        ExecutorService workers = Executors.newFixedThreadPool(count);
        List<Future<JSONObject>> results = new ArrayList<Future<JSONObject>>();
        try {
            for (int index = 0; index < count; index++) {
                final JSONObject item = window.optJSONObject(index);
                results.add(workers.submit(new Callable<JSONObject>() {
                    @Override
                    public JSONObject call() throws Exception {
                        return readInvoiceLocally(base, item, headers);
                    }
                }));
            }

            JSONObject result = new JSONObject().put("complete", false).put("batch", batch);
            for (int index = 0; index < count; index++) {
                JSONObject item = window.optJSONObject(index);
                if (item == null) throw new Exception("Η νέα ανάγνωση περιέχει μη έγκυρο τιμολόγιο.");
                JSONObject localOcr = results.get(index).get();
                String name = item.optString("name", "invoice.pdf");
                JSONObject body = new JSONObject();
                body.put("action", "result");
                body.put("batchId", batchId);
                body.put("index", batch.optInt("currentIndex", 0) + index);
                body.put("id", item.optString("id", ""));
                body.put("key", item.optString("key", ""));
                body.put("localOcr", localOcr);
                result = FleetHttp.sendJson(base + "/api/server/service-documents/reprocess-batch", "POST", body, headers);
                JSONObject next = result.optJSONObject("batch");
                if (result.optBoolean("fallbackUsed", false)) {
                    updateNotification("Νέα ανάγνωση: τοπικό αμφίβολο στοιχείο • fallback Workers AI");
                    saveInvoiceReprocessState(preferences, next == null ? batch : next, "Fallback Workers AI: " + name);
                } else if (result.optBoolean("skipped", false)) {
                    saveInvoiceReprocessState(preferences, next == null ? batch : next, "Παραλείφθηκε: το τιμολόγιο διαγράφηκε");
                } else {
                    saveInvoiceReprocessState(preferences, next == null ? batch : next, "Αποθηκεύτηκε: " + name);
                }
                if (result.optBoolean("complete", false)) break;
            }
            return result.put("complete", result.optBoolean("complete", false));
        } finally {
            workers.shutdownNow();
        }
    }

    private JSONObject readInvoiceLocally(String base, JSONObject item, Map<String, String> headers) throws Exception {
        if (item == null) throw new Exception("Η νέα ανάγνωση δεν έχει έγκυρο τιμολόγιο.");
        String key = item.optString("key", "");
        String name = item.optString("name", "invoice.pdf");
        if (key.length() == 0) throw new Exception("Η νέα ανάγνωση δεν έχει έγκυρο αρχείο.");
        try {
            File local = ServiceDocumentStore.localFile(getApplicationContext(), key, name);
            if (!local.exists() || local.length() == 0) {
                FleetHttp.downloadToFile(base + "/api/service-documents/" + encodePath(key), local, headers);
            }
            return LocalInvoiceReader.read(local);
        } catch (Exception localError) {
            JSONObject localOcr = new JSONObject();
            localOcr.put("source", "server-local");
            localOcr.put("ocrSource", "server-local");
            localOcr.put("localReadStatus", "failed");
            localOcr.put("ocrConfidence", 0);
            localOcr.put("ocrFallbackUsed", false);
            localOcr.put("ocrFallbackReason", localError.getMessage() == null ? "Η τοπική ανάγνωση του PDF απέτυχε." : localError.getMessage());
            return localOcr;
        }
    }

    private void saveInvoiceReprocessParallelState(SharedPreferences preferences, JSONObject batch, List<String> names) {
        if (batch == null) return;
        try {
            JSONObject copy = new JSONObject(batch.toString());
            JSONArray active = new JSONArray();
            for (String name : names) active.put(name);
            copy.put("activeItems", active);
            copy.put("serverStage", "Παράλληλη τοπική ανάγνωση (" + names.size() + ")");
            copy.put("serverUpdatedAt", isoNow());
            preferences.edit()
                    .putString(PREF_INVOICE_REPROCESS_STATE, copy.toString())
                    .putString(PREF_INVOICE_REPROCESS_UPDATED_AT, isoNow())
                    .apply();
        } catch (Exception ignored) {
        }
    }

    private static String encodeJsonHeader(JSONObject value) {
        try {
            byte[] bytes = value.toString().getBytes(Charset.forName("UTF-8"));
            return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP);
        } catch (Exception error) {
            return "";
        }
    }

    private static String encodePath(String value) {
        String[] parts = String.valueOf(value == null ? "" : value).split("/", -1);
        StringBuilder result = new StringBuilder();
        for (String part : parts) {
            if (result.length() > 0) result.append('/');
            try { result.append(URLEncoder.encode(part, "UTF-8").replace("+", "%20")); }
            catch (Exception ignored) { result.append(part); }
        }
        return result.toString();
    }

    private void reportOperationProgress(String base, String jobId, int progress, String stage, Map<String, String> headers) {
        try {
            JSONObject body = new JSONObject();
            body.put("jobId", jobId);
            body.put("progress", progress);
            body.put("stage", stage);
            FleetHttp.sendJson(base + "/api/server/operation-progress", "POST", body, headers);
        } catch (Exception ignored) {
            // Progress is informative. A temporary failure must not prevent
            // the actual PDF upload from completing.
        }
    }

    private JSONObject reportOperationError(String base, String jobId, String message, Map<String, String> headers) throws Exception {
        JSONObject body = new JSONObject();
        body.put("jobId", jobId);
        body.put("error", message);
        return FleetHttp.sendJson(base + "/api/server/operation-error", "POST", body, headers);
    }

    private static String encodeQuery(String value) throws Exception {
        return URLEncoder.encode(value == null ? "" : value, "UTF-8").replace("+", "%20");
    }

    public static Map<String, String> serverHeaders() {
        Map<String, String> headers = new HashMap<String, String>();
        headers.put("X-Fleet-Server-Key", ServerConfig.SERVER_KEY);
        return headers;
    }

    private Notification buildNotification(String text) {
        Intent intent = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | 0x04000000);
        try {
            Notification.Builder builder;
            if (Build.VERSION.SDK_INT >= 26) {
                Constructor<Notification.Builder> constructor = Notification.Builder.class.getConstructor(Context.class, String.class);
                builder = constructor.newInstance(this, CHANNEL_ID);
            } else {
                builder = new Notification.Builder(this);
            }
            return builder.setSmallIcon(android.R.drawable.stat_sys_upload_done)
                    .setContentTitle("Fleet Control Server")
                    .setContentText(text)
                    .setContentIntent(pending)
                    .setOngoing(true)
                    .setPriority(Notification.PRIORITY_LOW)
                    .build();
        } catch (Exception error) {
            return new Notification.Builder(this)
                    .setSmallIcon(android.R.drawable.stat_sys_upload_done)
                    .setContentTitle("Fleet Control Server")
                    .setContentText(text)
                    .setOngoing(true)
                    .build();
        }
    }

    private void updateNotification(String text) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.notify(NOTIFICATION_ID, buildNotification(text));
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            Class<?> channelClass = Class.forName("android.app.NotificationChannel");
            Constructor<?> constructor = channelClass.getConstructor(String.class, CharSequence.class, int.class);
            Object channel = constructor.newInstance(CHANNEL_ID, "Λειτουργία Fleet Control Server", 2);
            Method description = channelClass.getMethod("setDescription", String.class);
            description.invoke(channel, "Μόνιμη ένδειξη ότι ο κεντρικός server συγχρονίζει.");
            Method create = NotificationManager.class.getMethod("createNotificationChannel", channelClass);
            create.invoke(manager, channel);
        } catch (Exception ignored) {
        }
    }

    private static String isoNow() {
        java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        format.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return format.format(new java.util.Date());
    }

    @Override
    public void onDestroy() {
        if (executor != null) executor.shutdownNow();
        getSharedPreferences(BackupManager.PREFS, MODE_PRIVATE).edit().putBoolean("service_running", false).apply();
        if (store != null) store.close();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
