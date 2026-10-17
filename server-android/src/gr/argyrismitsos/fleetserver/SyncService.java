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
    private ScheduledExecutorService pulseExecutor;
    private ScheduledExecutorService invoiceExecutor;
    private ScheduledExecutorService mirrorExecutor;
    private LocalWorkQueue workQueue;
    private volatile boolean queueValidated;
    private volatile JSONObject pendingProgress;
    private int idleCycles, syncFailures;
    private long statusFetchedAt, reportVersion=-1;
    private JSONObject preparedReport;

    private final java.util.concurrent.atomic.AtomicBoolean invoiceRunning = new java.util.concurrent.atomic.AtomicBoolean();
    private final java.util.concurrent.atomic.AtomicBoolean mirrorRunning = new java.util.concurrent.atomic.AtomicBoolean();
    private volatile java.util.concurrent.atomic.AtomicBoolean activeCancellation;
    private volatile String activeJobId = "";
    public static final String SYNC_NOW="fleet.sync.now", RETRY_INVOICE="fleet.invoice.retry", MIRROR_NOW="fleet.mirror.now";

    private FleetDataStore store;
    private boolean foregroundReady;

    @Override
    public void onCreate() {
        super.onCreate();
        store = new FleetDataStore(getApplicationContext());
        workQueue=new LocalWorkQueue(new LocalWorkQueue.Storage(){
            public JSONObject read(){return store.getLocalWorkState();}
            public void write(JSONObject value){store.setLocalWorkState(value);}
        });
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
        invoiceExecutor=Executors.newSingleThreadScheduledExecutor();
        invoiceExecutor.scheduleWithFixedDelay(new Runnable(){public void run(){invoiceSafely();}},0,3,TimeUnit.SECONDS);
        mirrorExecutor=Executors.newSingleThreadScheduledExecutor();
        mirrorExecutor.scheduleWithFixedDelay(new Runnable(){public void run(){mirrorSafely();}},0,300,TimeUnit.SECONDS);
        // Connectivity must stay live even during ten parallel local reads,
        // lengthy AI results, Drive backup or a full mirror download.
        pulseExecutor = Executors.newSingleThreadScheduledExecutor();
        pulseExecutor.scheduleWithFixedDelay(new Runnable() {
            @Override public void run() { pulseSafely(); }
        }, 0, 30, TimeUnit.SECONDS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && foregroundReady) {
            if (SYNC_NOW.equals(intent.getAction())) {
                getSharedPreferences(BackupManager.PREFS,MODE_PRIVATE).edit().putLong("last_sync_attempt_ms",0).apply();
                executor.execute(new Runnable(){public void run(){syncSafely();}});
            } else if (MIRROR_NOW.equals(intent.getAction())) mirrorExecutor.execute(new Runnable(){public void run(){mirrorSafely(true);}});
            else if (RETRY_INVOICE.equals(intent.getAction())) {
                final String job=intent.getStringExtra("jobId");
                if (job == null || job.length()==0) {invoiceExecutor.execute(new Runnable(){public void run(){invoiceSafely();}});return START_STICKY;}
                if (job != null && job.equals(activeJobId) && activeCancellation != null) activeCancellation.set(true);
                pulseExecutor.execute(new Runnable(){public void run(){restartInvoice(job);}});
            }
        }
        return foregroundReady ? START_STICKY : START_NOT_STICKY;
    }

    private void pulseSafely() {
        SharedPreferences p = getSharedPreferences(BackupManager.PREFS, MODE_PRIVATE);
        if(System.currentTimeMillis()-p.getLong("last_connection_success_ms",0)<90000L)return;
        String base = p.getString("worker_url", ServerConfig.DEFAULT_WORKER_URL).replaceAll("/+$", "");
        try {
            FleetHttp.sendJson(base + "/api/server/pulse", "POST", new JSONObject(), serverHeaders());
            p.edit().putLong("last_connection_success_ms", System.currentTimeMillis()).putBoolean("server_online", true)
                .putString("last_connection_error", "").apply();
        } catch (Exception error) {
            boolean recentlyConnected = System.currentTimeMillis() - p.getLong("last_connection_success_ms", 0) < 90000L;
            p.edit().putBoolean("server_online", recentlyConnected).putString("last_connection_error", error.getMessage() == null ? "Σύνδεση σε αναμονή" : error.getMessage()).apply();
        }
    }

    private void syncSafely() {
        SharedPreferences preferences = getSharedPreferences(BackupManager.PREFS, MODE_PRIVATE);
        // Use the completed previous cycle as a safe checkpoint. Do not wait
        // for the user-configured mirror interval to apply a downloaded update.
        if (!invoiceRunning.get() && !mirrorRunning.get()) OtaManager.maybeApply(getApplicationContext(), store);
        if (OtaManager.installationInProgress(getApplicationContext())) return;
        OtaManager.check(getApplicationContext(), false);
        long lastAttempt = preferences.getLong("last_sync_attempt_ms", 0);
        boolean busy=invoiceRunning.get();
        try{busy=busy||workQueue.hasWork();}catch(RuntimeException error){preferences.edit().putString("invoice_queue_error",safeMessage(error)).apply();}
        int seconds=SyncPollPolicy.seconds(preferences.getInt("sync_seconds",30),busy,idleCycles,syncFailures);
        if (System.currentTimeMillis() - lastAttempt < seconds * 1000L) {
            // Keep the Server screen live while the full mirror sync remains
            // throttled. The batch endpoint is lightweight and is polled at
            // every scheduled tick.
            return;
        }
        preferences.edit().putLong("last_sync_attempt_ms", System.currentTimeMillis()).apply();

        try {
            syncOnce(preferences);
            syncFailures=0;
            if (!invoiceRunning.get() && !mirrorRunning.get()) OtaManager.maybeApply(getApplicationContext(), store);
        } catch (Exception error) {
            syncFailures++;
            String message = error.getMessage() == null ? "Αποτυχία σύνδεσης" : error.getMessage();
            preferences.edit()
                    .putBoolean("server_online", System.currentTimeMillis() - preferences.getLong("last_connection_success_ms", 0) < 90000L)
                    .putString("last_error", message)
                    .putLong("sync_error_at",System.currentTimeMillis())
                    .apply();
            updateNotification(preferences.getBoolean("server_online", false) ? "Συνδεδεμένος • προσωρινή καθυστέρηση συγχρονισμού" : "Εκτός σύνδεσης • θα ξαναδοκιμάσει");
        }
    }

    private void syncOnce(SharedPreferences preferences) throws Exception {
        String base = preferences.getString("worker_url", ServerConfig.DEFAULT_WORKER_URL);
        if (base == null || base.length() == 0) base = ServerConfig.DEFAULT_WORKER_URL;
        base = base.replaceAll("/+$", "");
        Map<String, String> headers = serverHeaders();

        // Pull the online cache first. A fresh/reinstalled server must never
        // replace a valid Cloudflare snapshot with an empty local database.
        long started=System.currentTimeMillis();
        syncStage(preferences,"Συγχρονισμός αλλαγών και τοπικής ουράς","/api/server/exchange");
        JSONObject canonical=store.getCanonicalSnapshot();
        boolean includeStatus=System.currentTimeMillis()-statusFetchedAt>=300000L;
        JSONObject request=new JSONObject().put("serverVersion",ServerConfig.SERVER_VERSION)
            .put("sinceVersion",canonical.has("version")?canonical.optLong("version"):-1)
            .put("includeStatus",includeStatus).put("knownJobs",workQueue.known()).put("acknowledgements",workQueue.acknowledgements())
            .put("lastBackup",preferences.getString(BackupManager.KEY_LAST_TIME,""))
            .put("backupResult",preferences.getString(BackupManager.KEY_LAST_RESULT,""))
            .put("unexpectedRestart",preferences.getBoolean("unexpected_restart",false))
            .put("restartAt",preferences.getString("unexpected_restart_at",""));
        if(includeStatus)request.put("health",DeviceHealth.collect(getApplicationContext()));
        JSONObject sentProgress=pendingProgress;
        if(sentProgress!=null)request.put("progress",sentProgress);
        if(preparedReport!=null)request.put("preparedReport",preparedReport);
        JSONObject exchange=FleetHttp.sendJson(base+"/api/server/exchange","POST",request,headers);
        if(exchange.optInt("protocol",0)!=1)throw new Exception("Απαιτείται ενημέρωση Worker για τον νέο συγχρονισμό.");
        if(sentProgress==pendingProgress)pendingProgress=null;
        if(exchange.optBoolean("reportAccepted",false))preparedReport=null;
        workQueue.reconcile(exchange.optJSONArray("invoices"),exchange.optJSONArray("knownJobs"),exchange.optJSONArray("acknowledged"));
        queueValidated=true;
        JSONObject mirrorHead=exchange.optJSONObject("mirrorHead");
        if(mirrorHead!=null)preferences.edit().putBoolean("mirror_hint_ready",true).putString("mirror_remote_epoch",mirrorHead.optString("epoch")).putLong("mirror_remote_cursor",mirrorHead.optLong("cursor",-1)).putString("invoice_rules_revision_remote",mirrorHead.optString("rulesRevision")).apply();
        JSONArray known=exchange.optJSONArray("knownJobs");
        if(known!=null)for(int i=0;i<known.length();i++){JSONObject job=known.getJSONObject(i);if(activeJobId.equals(job.optString("id"))&&!"pending".equals(job.optString("status"))&&activeCancellation!=null)activeCancellation.set(true);}
        JSONObject batch=exchange.optJSONObject("batch");
        if(batch!=null){saveInvoiceReprocessState(preferences,batch,"");
            JSONArray queued=workQueue.ready(Long.MAX_VALUE);for(int i=0;i<queued.length();i++){JSONObject job=queued.getJSONObject(i);if("service_document_reprocess_batch".equals(job.optString("type")))workQueue.update(job.optString("id"),"retryAt","paused".equals(batch.optString("status"))?Long.MAX_VALUE:0L);}}
        JSONObject response=exchange.getJSONObject("snapshot");
        JSONObject remoteSnapshot=response.optBoolean("unchanged",false)?canonical:response;
        if(remoteSnapshot.optJSONArray("bikes")==null)throw new Exception("Δεν επιστράφηκε έγκυρος στόλος.");
        if(!response.optBoolean("unchanged",false)){store.setCanonicalSnapshot(remoteSnapshot);store.mergeFleet(remoteSnapshot);}
        if(reportVersion!=remoteSnapshot.optLong("version",0)){preparedReport=FleetAuditReport.build(remoteSnapshot);reportVersion=remoteSnapshot.optLong("version",0);}
        JSONArray operations=exchange.optJSONArray("operations");
        idleCycles=response.optBoolean("unchanged",false)&&(operations==null||operations.length()==0)&&!workQueue.hasWork()?idleCycles+1:0;
        List<String> applied = new ArrayList<String>();
        List<String> backupRequests = new ArrayList<String>();
        String serviceDocumentNotice = preferences.getString("last_service_document_error", "").length() > 0
                ? "Σφάλμα PDF τιμολογίου • πάτησε Επανάληψη"
                : "";
        boolean yieldForUpdate = false;
        if (operations != null) {
            for (int i = 0; i < operations.length(); i++) {
                OtaManager.check(getApplicationContext(), false);
                if (OtaManager.shouldYieldForUpdate(getApplicationContext())) { yieldForUpdate = true; break; }
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
                } else if ("backup_request".equals(type)) {
                    backupRequests.add(id);
                    continue;
                }
                store.markApplied(id);
                applied.add(id);
            }
        }

        if (yieldForUpdate) {
            // OCR results live in the Worker. Refresh both mirrors before the
            // pre-install backup so it includes every completed invoice result.
            store.mergeFleet(FleetHttp.getJson(base + "/api/snapshot", headers));
            refreshSystemMirror(base,headers,preferences);
        }
        if (!backupRequests.isEmpty()) {
            try {
                refreshSystemMirror(base,headers,preferences);
                ServiceDocumentStore.syncFromFleet(getApplicationContext(),store.getFleet(),base,headers);
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
            syncStage(preferences,"Επιβεβαίωση εφαρμοσμένων αλλαγών","/api/server/ack");
            JSONArray ids = new JSONArray();
            for (String id : applied) ids.put(id);
            JSONObject acknowledgement = new JSONObject();
            acknowledgement.put("ids", ids);
            FleetHttp.sendJson(base + "/api/server/ack", "POST", acknowledgement, headers);
        }

        syncStage(preferences,"Αποστολή τοπικών αλλαγών","/api/server/snapshot/bike");
        JSONArray changedBikes = FleetSnapshotSync.bikesToPublish(store.getFleet(), remoteSnapshot);
        for (int bikeIndex=0; bikeIndex<changedBikes.length(); bikeIndex++) {
            JSONObject body = new JSONObject().put("bike", changedBikes.optJSONObject(bikeIndex));
            FleetHttp.sendJson(base + "/api/server/snapshot/bike", "PUT", body, headers);
        }
        JSONObject status=exchange.optJSONObject("status");
        if(status!=null){statusFetchedAt=System.currentTimeMillis();preferences.edit().putString("cached_system_status",status.toString()).apply();}
        else status=new JSONObject(preferences.getString("cached_system_status","{}"));
        String now = isoNow();
        preferences.edit()
                .putBoolean("server_online", true)
                .putString("last_connection_error","")
                .putLong("last_connection_success_ms",System.currentTimeMillis())
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
                .putString("sync_stage","Συγχρονίστηκε")
                .putString("sync_endpoint","")
                .putLong("sync_duration_ms",System.currentTimeMillis()-started)
                .putString("last_sync_time", now)
                .putString("last_error", "")
                .putInt("last_applied_count", applied.size())
                .apply();
        updateNotification(serviceDocumentNotice.length() > 0 ? serviceDocumentNotice : "Online • συγχρονίστηκε τώρα");
    }

    private void syncStage(SharedPreferences p,String stage,String endpoint) {
        p.edit().putString("sync_stage",stage).putString("sync_endpoint",endpoint).apply();
    }
    private void refreshSystemMirror(String base,Map<String,String> headers,final SharedPreferences p) throws Exception {
        JSONObject value=SystemMirror.update(base,headers,store.getFleet(),store.getSystemExport(),new SystemMirror.Progress(){public void stage(String stage){p.edit().putString("mirror_stage",stage).apply();}});
        store.setSystemExport(value);
        p.edit().putString("mirror_error","").putString("mirror_stage","Το αντίγραφο προσωπικού ενημερώθηκε").putLong("mirror_success_ms",System.currentTimeMillis()).apply();
    }
    private void mirrorSafely(){mirrorSafely(false);}
    private void mirrorSafely(boolean force) {
        if (!mirrorRunning.compareAndSet(false,true)) return;
        SharedPreferences p=getSharedPreferences(BackupManager.PREFS,MODE_PRIVATE);
        String base=p.getString("worker_url",ServerConfig.DEFAULT_WORKER_URL).replaceAll("/+$", "");
        try {
            String remoteRules=p.getString("invoice_rules_revision_remote","");
            if(MirrorPollPolicy.rules(force,p.getBoolean("mirror_hint_ready",false),p.getBoolean("invoice_rules_cached",false),p.getString("invoice_rules_cached_revision",""),remoteRules)){
                try {JSONObject rules=FleetHttp.getJson(base+"/api/server/invoice-reader-rules",serverHeaders());p.edit().putString("invoice_rules_error","").putString("invoice_reader_rules",rules.optJSONArray("rules")==null?"[]":rules.getJSONArray("rules").toString()).putBoolean("invoice_rules_cached",true).putString("invoice_rules_cached_revision",remoteRules).apply();}
                catch(Exception rulesError){p.edit().putString("invoice_rules_error",safeMessage(rulesError)).apply();}
            }
            JSONObject saved=store.getSystemExport().optJSONObject("mirror");
            if(MirrorPollPolicy.mirror(force,p.getBoolean("mirror_hint_ready",false),saved==null?null:saved.optString("epoch"),saved==null?-1:saved.optLong("cursor",-1),p.getString("mirror_remote_epoch",""),p.getLong("mirror_remote_cursor",-2),System.currentTimeMillis(),p.getLong("mirror_success_ms",0)))refreshSystemMirror(base,serverHeaders(),p);
            else p.edit().putString("mirror_stage","Το αντίγραφο είναι ενημερωμένο · χωρίς νέα λήψη").apply();
            ServiceDocumentStore.syncFromFleet(getApplicationContext(),store.getFleet(),base,serverHeaders());
            BackupManager.maybeAutomatic(getApplicationContext(),store);
        } catch (Exception error) { p.edit().putString("mirror_error",safeMessage(error)).apply(); }
        finally { mirrorRunning.set(false); }
    }
    private static String safeMessage(Exception error) { return error.getMessage()==null ? "Δεν ολοκληρώθηκε η ενέργεια." : error.getMessage(); }
    private void invoiceState(String job,String stage,int progress,String error) {
        try {
            JSONObject value=new JSONObject().put("jobId",job).put("stage",stage).put("progress",progress).put("error",error).put("updatedAt",isoNow());
            getSharedPreferences(BackupManager.PREFS,MODE_PRIVATE).edit().putString("invoice_job_state",value.toString()).apply();
        } catch (Exception ignored) {}
    }
    private void restartInvoice(String job) {
        SharedPreferences p=getSharedPreferences(BackupManager.PREFS,MODE_PRIVATE);
        String base=p.getString("worker_url",ServerConfig.DEFAULT_WORKER_URL).replaceAll("/+$", "");
        try {
            JSONObject response=FleetHttp.sendJson(base+"/api/server/service-documents/restart","POST",new JSONObject().put("jobId",job),serverHeaders());
            invoiceState(response.optString("jobId",job),response.has("attachment")||response.has("document") ? "Ολοκληρώθηκε" : "Νέα προσπάθεια στην ουρά",response.has("attachment")||response.has("document") ? 100 : 5,response.optString("ocrWarning",""));
        } catch (Exception error) { invoiceState(job,"Η επανεκκίνηση δεν ολοκληρώθηκε",0,safeMessage(error)); }
    }
    private void invoiceSafely() {
        if (OtaManager.installationInProgress(getApplicationContext()) || OtaManager.shouldYieldForUpdate(getApplicationContext())) return;
        if (!invoiceRunning.compareAndSet(false,true)) return;
        SharedPreferences p=getSharedPreferences(BackupManager.PREFS,MODE_PRIVATE);
        String base=p.getString("worker_url",ServerConfig.DEFAULT_WORKER_URL).replaceAll("/+$", "");
        Map<String,String> headers=serverHeaders();
        try {
            p.edit().putString("invoice_queue_error","").apply();
            if(!queueValidated||System.currentTimeMillis()-p.getLong("last_connection_success_ms",0)>120000L)return;
            JSONArray ops=workQueue.ready(System.currentTimeMillis());
            if (ops==null) return;
            for (int i=0;i<ops.length();i++) {
                if (Thread.currentThread().isInterrupted()) return;
                JSONObject op=ops.getJSONObject(i);String id=op.optString("id");
                if (store.wasApplied(id)) { acknowledgeOne(base,id,headers); continue; }
                if ("service_document_reprocess_batch".equals(op.optString("type"))) {
                    JSONObject result=processInvoiceReprocessBatch(base,headers,p,Math.max(1,Math.min(10,p.getInt("invoice_parallelism",4))));
                    if (result.optBoolean("complete",false)) {store.markApplied(id);acknowledgeOne(base,id,headers);}
                    continue;
                }
                activeJobId=id; activeCancellation=new java.util.concurrent.atomic.AtomicBoolean();
                try {
                    JSONObject result=op.optJSONObject("payload")!=null&&op.getJSONObject("payload").has("documentKey")
                        ?analyzeStoredDocument(base,op,headers):renderAndUploadServiceDocument(base,id,op.optJSONObject("payload"),headers);
                    if (activeCancellation.get()) continue;
                    JSONObject payload=op.optJSONObject("payload");
                    if (result.optJSONObject("attachment")!=null && payload!=null && !payload.has("draftId") && !payload.has("documentKey")) store.attachServiceDocument(payload.optString("bikeId"),payload.optString("entryId"),result.optJSONObject("attachment"));
                    store.markApplied(id);
                    try {acknowledgeOne(base,id,headers);} catch(Exception acknowledgementError){p.edit().putString("invoice_queue_error",safeMessage(acknowledgementError)).apply();}
                    invoiceState(id,"Ολοκληρώθηκε · PDF και στοιχεία αποθηκεύτηκαν",100,result.optString("extractionError",""));
                    p.edit().putString("last_service_document_error",result.optString("extractionError","")).apply();
                } catch (Exception error) {
                    if (error instanceof java.util.concurrent.CancellationException || (activeCancellation!=null && activeCancellation.get()) || (error instanceof FleetHttp.HttpStatusException && ((FleetHttp.HttpStatusException)error).statusCode==410)) {acknowledgeOne(base,id,headers);continue;}
                    workQueue.update(id,"retryAt",System.currentTimeMillis()+60000L);
                    invoiceState(id,"Χρειάζεται έλεγχος",0,safeMessage(error));
                    p.edit().putString("last_service_document_error",safeMessage(error)).apply();
                    try {reportOperationError(base,id,safeMessage(error),error,headers);} catch(Exception ignored){}
                } finally {activeJobId="";activeCancellation=null;}
            }
        } catch (Exception error) {markInvoiceReprocessError(p,safeMessage(error));p.edit().putString("invoice_queue_error",safeMessage(error)).apply();}
        finally {invoiceRunning.set(false);}
    }
    private void acknowledgeOne(String base,String id,Map<String,String> headers) throws Exception {
        workQueue.update(id,"localComplete",true);
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
        long qrStarted=System.nanoTime();
        ServiceDocumentRenderer.RenderedDocument renderedDocument = ServiceDocumentRenderer.renderToPdfWithText(this, qrUrl, "invoice-qr-" + jobId + ".pdf", activeCancellation);
        File rendered = renderedDocument.output;
        try {
            invoiceState(jobId,"Ανάγνωση PDF στον Server · έλεγχος πινακίδας, χιλιομέτρων και ποσών",45,"");
            if (activeCancellation!=null && activeCancellation.get()) throw new java.util.concurrent.CancellationException();
            JSONObject localOcr;
            try {
                localOcr = InvoicePipeline.read(this, rendered, renderedDocument.pageText, false, new InvoicePipeline.Progress(){public void stage(String text){invoiceState(jobId,text,50,"");}},activeCancellation);
            } catch (Exception | LinkageError | OutOfMemoryError localError) {
                localOcr = new JSONObject();
                localOcr.put("source", "server-local");
                localOcr.put("ocrSource", "server-local");
                localOcr.put("localReadStatus", "failed");
                localOcr.put("ocrConfidence", 0);
                localOcr.put("ocrFallbackUsed", false);
                localOcr.put("ocrFallbackReason", localError.getMessage() == null ? "Η τοπική ανάγνωση του PDF απέτυχε." : localError.getMessage());
            }
            JSONObject times=localOcr.optJSONObject("analysisTimings");if(times==null)times=new JSONObject();times.put("qrPdfMs",(System.nanoTime()-qrStarted)/1000000-localOcr.optLong("analysisDurationMs",0));localOcr.put("analysisTimings",times);
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
            if (activeCancellation!=null && activeCancellation.get()) throw new java.util.concurrent.CancellationException();
            FileInputStream input = new FileInputStream(rendered);
            long uploadStarted=System.nanoTime();
            JSONObject result = FleetHttp.putStream(endpoint, input, rendered.length(), "application/pdf", uploadHeaders);
            times.put("uploadMs",(System.nanoTime()-uploadStarted)/1000000);getSharedPreferences(BackupManager.PREFS,MODE_PRIVATE).edit().putString("invoice_analysis_metrics",times.toString()).putString("invoice_reader_stage",localOcr.optString("analysisEngine")+(localOcr.optBoolean("analysisCacheHit")?" · cache":"")).apply();
            if (result.optBoolean("fallbackUsed", false)) {
                updateNotification("Τοπική ανάγνωση αμφίβολη • χρησιμοποιήθηκε Workers AI");
            }
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
        final boolean forceWorkersAi = "workers-ai".equals(batch.optString("mode", "server-first"));
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
                        if (forceWorkersAi) return new JSONObject();
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
                if (forceWorkersAi && result.optBoolean("aiUsed", false)) {
                    updateNotification("Νέα ανάγνωση: υποχρεωτικά Workers AI");
                    saveInvoiceReprocessState(preferences, next == null ? batch : next, "Workers AI: " + name);
                } else if (result.optBoolean("fallbackUsed", false)) {
                    updateNotification("Νέα ανάγνωση: τοπικό αμφίβολο στοιχείο • fallback Workers AI");
                    saveInvoiceReprocessState(preferences, next == null ? batch : next, "Fallback Workers AI: " + name);
                } else if (result.optBoolean("skipped", false)) {
                    saveInvoiceReprocessState(preferences, next == null ? batch : next, "Παραλείφθηκε: το τιμολόγιο διαγράφηκε");
                } else {
                    saveInvoiceReprocessState(preferences, next == null ? batch : next, "Αποθηκεύτηκε: " + name);
                }
                OtaManager.check(getApplicationContext(), false);
                if (result.optBoolean("complete", false) || OtaManager.shouldYieldForUpdate(getApplicationContext())) break;
                // Let a newly scanned QR run before the next window of historical invoices.
                JSONArray ops=workQueue.ready(System.currentTimeMillis());boolean urgent=false;
                for(int j=0;j<ops.length();j++)if("service_document_render".equals(ops.getJSONObject(j).optString("type")))urgent=true;
                if(urgent)break;
            }
            return result.put("complete", result.optBoolean("complete", false));
        } finally {
            workers.shutdownNow();
        }
    }

    private JSONObject analyzeStoredDocument(String base,JSONObject job,Map<String,String> headers)throws Exception {
        String id=job.getString("id");JSONObject payload=job.getJSONObject("payload"),local=job.optJSONObject("localResult");
        reportOperationProgress(base,id,15,"Τοπική ανάγνωση αποθηκευμένου τιμολογίου",headers);
        if(local==null){local=readInvoiceLocally(base,new JSONObject().put("key",payload.getString("documentKey")).put("name",payload.optString("name","invoice.pdf")).put("forceRead",payload.optBoolean("forceRead",false)),headers);workQueue.update(id,"localResult",local);}
        if(activeCancellation!=null&&activeCancellation.get())throw new java.util.concurrent.CancellationException();
        reportOperationProgress(base,id,75,"Αποθήκευση στοιχείων · AI μόνο αν χρειάζεται",headers);
        return FleetHttp.sendJson(base+"/api/server/service-documents/analysis-result","POST",new JSONObject().put("jobId",id).put("localOcr",local),headers);
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
            return InvoicePipeline.read(this,local,"",item.optBoolean("forceRead",false),new InvoicePipeline.Progress(){public void stage(String text){getSharedPreferences(BackupManager.PREFS,MODE_PRIVATE).edit().putString("invoice_reader_stage",text).apply();}});
        } catch (Exception | LinkageError | OutOfMemoryError localError) {
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
        invoiceState(jobId,stage,progress,"");
        try {
            JSONObject body = new JSONObject();
            body.put("jobId", jobId);
            body.put("progress", progress);
            body.put("stage", stage);
            pendingProgress=body;
        } catch (Exception ignored) {
            // Progress is informative. A temporary failure must not prevent
            // the actual PDF upload from completing.
        }
    }

    private JSONObject reportOperationError(String base, String jobId, String message, Exception error, Map<String, String> headers) throws Exception {
        JSONObject body = new JSONObject();
        body.put("jobId", jobId);
        body.put("error", message);
        body.put("retryable", error instanceof FleetHttp.HttpStatusException
                ? ((FleetHttp.HttpStatusException) error).transientFailure()
                : error instanceof java.io.IOException);
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
        if (pulseExecutor != null) pulseExecutor.shutdownNow();
        if (invoiceExecutor != null) invoiceExecutor.shutdownNow();
        if (mirrorExecutor != null) mirrorExecutor.shutdownNow();
        if (activeCancellation != null) activeCancellation.set(true);
        getSharedPreferences(BackupManager.PREFS, MODE_PRIVATE).edit().putBoolean("service_running", false).apply();
        if (store != null) store.close();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
