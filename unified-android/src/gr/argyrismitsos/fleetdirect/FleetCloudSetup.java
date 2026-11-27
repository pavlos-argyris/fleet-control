package gr.argyrismitsos.fleetdirect;

import android.content.Context;
import android.net.Uri;
import android.util.Base64;
import gr.argyrismitsos.fleetserver.SealedLocalState;
import gr.argyrismitsos.fleetserver.ServerConfig;
import org.json.JSONObject;

import javax.net.ssl.HttpsURLConnection;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.ByteArrayInputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

final class FleetCloudSetup {
    private static final String STORE = "direct.hybrid-fleet.device.v1";
    private static final String KEY = "fleet.direct.hybrid.device.v1";
    private static final String BASE = ServerConfig.DEFAULT_WORKER_URL;
    private static final String SETUP = "/fleet-cloud/setup";
    private static final String STATE = "/api/fleet-sync/v1/state";
    private static final String DELTA = "/api/fleet-sync/v1/delta?cursor=";
    private static final String DOCUMENT = "/api/fleet-sync/v1/invoice-document?sha256=";
    private static final int DEFAULT_MINUTES = 15;
    private static final int RESPONSE_LIMIT = 4096;
    private static final SecureRandom random = new SecureRandom();
    private static final ExecutorService worker = Executors.newSingleThreadExecutor(command -> new Thread(command,"fleet-cloud-approval"));
    private static final AtomicBoolean checking = new AtomicBoolean();

    private FleetCloudSetup() { }

    private static JSONObject stored(Context context) throws Exception {
        if (!ScopedContext.owns(context)) throw new SecurityException("Private Fleet setup");
        return SealedLocalState.read(context, STORE, KEY);
    }

    static synchronized JSONObject configure(Context context, String action, int minutes) throws Exception {
        // DirectControlProvider has checked the active local owner session.
        JSONObject state = stored(context);
        if ("interval".equals(action)) {
            if (minutes != 5 && minutes != 15 && minutes != 30 && minutes != 60 && minutes != 1440) {
                throw new IOException("Η συχνότητα Fleet δεν αναγνωρίστηκε.");
            }
            state.put("minutes",minutes);
            SealedLocalState.write(context, STORE, KEY, state);
            return status(state);
        }
        if ("settings".equals(action)) {
            requireDeployment();
            JSONObject result = status(state);
            result.put("setupUrl", BASE + SETUP);
            return result;
        }
        if ("approve".equals(action) || "rotate".equals(action)) {
            requireDeployment();
            JSONObject active = state.optJSONObject("active");
            JSONObject candidate = state.optJSONObject("candidate");
            if ("rotate".equals(action) && active == null) throw new IOException("Εκκρεμεί η πρώτη έγκριση του Server.");
            if ("approve".equals(action) && active != null && candidate == null) throw new IOException("Ο Server είναι ήδη εγκεκριμένος.");
            if (candidate == null) {
                candidate = new JSONObject().put("id", token(24)).put("secret", token(32));
                if (active != null) candidate.put("replaces", active.getString("id"));
                state.put("candidate", candidate);
                SealedLocalState.write(context, STORE, KEY, state);
            }
            String digest = digest(candidate.getString("secret"));
            Uri.Builder fragment = new Uri.Builder().appendQueryParameter("device", candidate.getString("id"))
                    .appendQueryParameter("proof", digest);
            if (candidate.has("replaces")) fragment.appendQueryParameter("replace", candidate.getString("replaces"));
            return status(state).put("setupUrl", BASE + SETUP + "#" + fragment.build().getEncodedQuery())
                    .put("approvalCode", digest.substring(0, 8).toUpperCase(Locale.ROOT));
        }
        if ("replay".equals(action)) {
            if (!isStaged(state)) throw new IOException("Εκκρεμεί η δοκιμαστική μεταφορά Fleet.");
            state.put("nextReplayAt",0);
            SealedLocalState.write(context,STORE,KEY,state);
            schedule(context);
            return status(state);
        }
        if (!"status".equals(action)) throw new IOException("Η ενέργεια Fleet δεν αναγνωρίστηκε.");
        refresh(context, state, true);
        return status(state);
    }

    static void schedule(Context context) {
        if (!checking.compareAndSet(false,true)) return;
        worker.execute(() -> {
            try {
                if (!DirectHost.paused(context)) {
                    refreshIfDue(context);
                    prepareBaselineIfDue(context);
                    stageBaselineIfDue(context);
                    replayIfDue(context);
                }
            }
            finally { checking.set(false); }
        });
    }

    private static synchronized void refreshIfDue(Context context) {
        try {
            JSONObject state = stored(context);
            refresh(context, state, false);
        } catch (Exception unavailable) {
            // Old installations and locked/offline devices keep serving Direct.
        }
    }

    private static void prepareBaselineIfDue(Context context) {
        String checkpoint = null;
        try {
            JSONObject baseline = reserveBaseline(context);
            if (baseline == null) return;
            checkpoint = baseline.getString("job");
            IndependentRuntime.get(context).armFleetCloudSource(baseline.getString("epoch"),baseline.getString("generation"));
            try (FleetDataStore store = new FleetDataStore(context)) {
                JSONObject proof = BackupJobs.fleetMigrationBaseline(context, store, checkpoint);
                completeBaseline(context, checkpoint, proof, false);
            }
        } catch (Exception failure) {
            if (checkpoint != null) try { completeBaseline(context, checkpoint, null, true); }
            catch (Exception unavailable) { }
        }
    }

    private static synchronized JSONObject reserveBaseline(Context context) throws Exception {
        JSONObject state=stored(context);
        long now=System.currentTimeMillis();
        if (state.optInt("baselineVersion")!=1 || !state.has("active") || state.has("candidate") ||
                !state.optString("connection").equals("approved") ||
                now-state.optLong("lastContactAt") > (state.optInt("minutes",DEFAULT_MINUTES)+1)*60000L ||
                !DirectHost.primary(context).optBoolean("ready") || DirectHost.paused(context)) return null;
        String generation=IndependentConfig.read(context).optString("generation");
        if (generation.isEmpty()) return null;
        String key=state.getString("epoch")+":"+generation;
        String checkpoint=UUID.nameUUIDFromBytes(("fleet-cloud-baseline:"+key).getBytes(StandardCharsets.UTF_8)).toString();
        if (checkpoint.equals(state.optString("backupJob")) &&
                (state.has("backupSha256") || state.optLong("nextBackupAt")>now)) return null;
        if (!checkpoint.equals(state.optString("backupJob"))) {
            state.remove("backupSha256");
            state.remove("sourceCursor");
            state.remove("sourceGeneration");
            state.remove("sourceJournal");
        }
        state.put("backupJob",checkpoint).put("migration","preparing_backup").put("nextBackupAt",now+300000L);
        SealedLocalState.write(context, STORE, KEY, state);
        return new JSONObject().put("job",checkpoint).put("epoch",state.getString("epoch")).put("generation",generation);
    }

    private static synchronized void completeBaseline(Context context,String checkpoint,JSONObject proof,boolean failed) throws Exception {
        JSONObject state=stored(context);
        if (!checkpoint.equals(state.optString("backupJob"))) return;
        if (proof!=null && checkpoint.equals(proof.optString("id")) && proof.getString("databaseSha256").matches("[a-f0-9]{64}")) {
            state.put("backupSha256",proof.getString("databaseSha256"));
            state.put("migration","backup_verified").put("backupVerifiedAt",proof.getLong("verifiedAt"));
        } else {
            state.put("migration",failed?"backup_verification_failed":"waiting_for_backup_slot");
            state.put("nextBackupAt",System.currentTimeMillis()+(failed?3600000L:60000L));
        }
        SealedLocalState.write(context, STORE, KEY, state);
    }

    private static void stageBaselineIfDue(Context context) {
        JSONObject transfer=null;
        try {
            transfer=reserveTransfer(context);
            if (transfer==null) return;
            JSONObject credential=transfer.getJSONObject("credential");
            String epoch=transfer.getString("epoch");
            long sourceCursor=FleetCloudArchive.stage(context,transfer.getString("job"),transfer.getString("source"),transfer.getString("generation"),
                    epoch,new FleetCloudBaseline.Transport() {
                @Override public JSONObject send(String path,JSONObject payload) throws Exception {
                    if (DirectHost.paused(context)) throw new java.io.InterruptedIOException();
                    byte[] bytes=payload.toString().getBytes(StandardCharsets.UTF_8);
                    return request(path,credential,epoch,"POST","application/json",bytes.length,new ByteArrayInputStream(bytes));
                }
                @Override public JSONObject putFile(String sha,String type,long size,InputStream input) throws Exception {
                    if (DirectHost.paused(context)) throw new java.io.InterruptedIOException();
                    return request("/api/fleet-sync/v1/invoice-file?sha256="+sha,credential,epoch,"PUT",type,size,input);
                }
            });
            completeTransfer(context,transfer,sourceCursor,true);
        } catch (Exception failure) {
            if (transfer!=null) try { completeTransfer(context,transfer,-1,false); }
            catch (Exception unavailable) { }
        }
    }

    private static synchronized JSONObject reserveTransfer(Context context) throws Exception {
        JSONObject state=stored(context);
        long now=System.currentTimeMillis();
        if (state.optInt("baselineVersion")!=1||!state.has("active")||!state.has("backupSha256")||
                !"approved".equals(state.optString("connection"))||state.has("candidate")||DirectHost.paused(context)||
                now-state.optLong("lastContactAt")>(state.optInt("minutes",DEFAULT_MINUTES)+1)*60000L||
                state.optLong("nextTransferAt")>now) return null;
        String job=state.getString("backupJob");
        if (job.equals(state.optString("stagedBackupJob"))) return null;
        String generation=IndependentConfig.read(context).optString("generation");
        if (generation.isEmpty()) return null;
        state.put("migration","copying_baseline").put("nextTransferAt",now+60000L);
        SealedLocalState.write(context,STORE,KEY,state);
        return new JSONObject().put("job",job).put("source",state.getString("backupSha256"))
                .put("generation",generation).put("epoch",state.getString("epoch")).put("credential",state.getJSONObject("active"));
    }

    private static synchronized void completeTransfer(Context context,JSONObject transfer,long sourceCursor,boolean saved) throws Exception {
        JSONObject state=stored(context);
        String job=transfer.getString("job");
        String generation=transfer.getString("generation");
        if (!job.equals(state.optString("backupJob"))||!transfer.getString("epoch").equals(state.optString("epoch"))||
                !generation.equals(IndependentConfig.read(context).optString("generation"))) return;
        if (saved) {
            state.put("migration","baseline_staged").put("stagedBackupJob",job).put("baselineStagedAt",System.currentTimeMillis())
                    .put("sourceGeneration",generation).put("sourceCursor",sourceCursor);
            state.remove("transferFailures");
        } else {
            int attempts=Math.min(10,state.optInt("transferFailures")+1);
            state.put("migration","baseline_retry").put("transferFailures",attempts)
                    .put("nextTransferAt",System.currentTimeMillis()+Math.min(3600000L,30000L<<attempts));
        }
        SealedLocalState.write(context,STORE,KEY,state);
    }

    private static boolean isStaged(JSONObject state) {
        String job=state.optString("backupJob");
        return !job.isEmpty()&&job.equals(state.optString("stagedBackupJob"))&&state.optInt("baselineVersion")==1;
    }

    private static void replayIfDue(Context context) {
        JSONObject replica=null;
        try {
            replica=reserveReplay(context);
            if (replica==null) return;
            String epoch=replica.getString("epoch");
            JSONObject credential=replica.getJSONObject("credential");
            JSONObject progress=FleetCloudReplica.sync(context,epoch,cursor->{
                if (DirectHost.paused(context)) throw new java.io.InterruptedIOException();
                return request(DELTA+cursor,credential,epoch,"GET",null,0,null);
            },(sha,size,output)->{
                if (DirectHost.paused(context)) throw new java.io.InterruptedIOException();
                downloadDocument(credential,epoch,sha,size,output);
            });
            long sourceCursor=replica.getLong("sourceCursor");
            JSONObject sourceProof=new JSONObject().put("verified",false);
            if (sourceCursor>=0) try {
                sourceProof=IndependentRuntime.get(context).fleetCloudSourceProgress(epoch,replica.getString("sourceGeneration"),sourceCursor);
            } catch (Exception unavailable) { }
            progress.put("sourceJournal",sourceProof);
            completeReplay(context,epoch,progress);
        } catch (Exception failure) {
            if (replica!=null) try { completeReplay(context,replica.getString("epoch"),null); }
            catch (Exception unavailable) { }
        }
    }

    private static synchronized JSONObject reserveReplay(Context context) throws Exception {
        JSONObject state=stored(context);
        long now=System.currentTimeMillis();
        if (!isStaged(state)||!state.has("active")||!"approved".equals(state.optString("connection"))||
                state.has("candidate")||state.optLong("nextReplayAt")>now||DirectHost.paused(context)) return null;
        state.put("nextReplayAt",now+60000L);
        SealedLocalState.write(context,STORE,KEY,state);
        return new JSONObject().put("epoch",state.getString("epoch")).put("credential",state.getJSONObject("active"))
                .put("sourceCursor",state.optLong("sourceCursor",-1)).put("sourceGeneration",state.optString("sourceGeneration"));
    }

    private static synchronized void completeReplay(Context context,String epoch,JSONObject progress) throws Exception {
        JSONObject state=stored(context);
        if (!epoch.equals(state.optString("epoch"))||!isStaged(state)) return;
        long now=System.currentTimeMillis();
        state.put("replicaPending",progress==null||progress.optBoolean("hasMore"));
        if (progress!=null) {
            state.put("replicaCursor",progress.getLong("cursor")).put("lastReplicaAt",now)
                    .put("replicaPendingInvoices",progress.getInt("pendingInvoices"))
                    .put("sourceJournal",progress.getJSONObject("sourceJournal"));
            if (!progress.optBoolean("hasMore")) state.put("nextReplayAt",now+state.optInt("minutes",DEFAULT_MINUTES)*60000L);
        }
        SealedLocalState.write(context,STORE,KEY,state);
    }

    private static void refresh(Context context, JSONObject state, boolean manual) throws Exception {
        JSONObject candidate = state.optJSONObject("candidate");
        JSONObject active = state.optJSONObject("active"), credential = candidate == null ? active : candidate;
        long interval=state.optInt("minutes", DEFAULT_MINUTES) * 60000L;
        JSONObject progress=state.optJSONObject("baselineProgress");
        JSONObject invoiceImport=progress==null?null:progress.optJSONObject("invoiceImport");
        boolean preparing=state.optInt("baselineVersion")==1&&
                (invoiceImport==null||!"ready".equals(invoiceImport.optString("state")));
        if (candidate!=null||preparing||"offline".equals(state.optString("connection"))) interval=Math.min(interval,300000L);
        if (credential == null || (!manual && System.currentTimeMillis() - state.optLong("lastCheckedAt") < interval)) return;
        long started = System.currentTimeMillis();
        state.put("lastCheckedAt", started);
        try {
            JSONObject remote = request(STATE, credential);
            String epoch = remote.optString("epoch");
            if (remote.optInt("schemaVersion") != 1 || !remote.optString("mode").equals("rehearsal") ||
                    !epoch.matches("[a-f0-9]{32}")) throw new IOException("Δεν επιβεβαιώθηκε ο δοκιμαστικός Worker Fleet.");
            String previous = state.optString("epoch");
            if (!previous.isEmpty() && !previous.equals(epoch)) {
                state.put("connection", "epoch_changed");
            } else {
                if (candidate != null) {
                    candidate.remove("replaces");
                    state.put("active", candidate);
                    state.remove("candidate");
                }
                state.put("epoch", epoch).put("connection", "approved").put("lastContactAt", started)
                        .put("baselineVersion",remote.optInt("baselineVersion",0))
                        .put("baselineProgress",remote.optJSONObject("baselineProgress"));
            }
        } catch (Rejected unapproved) {
            state.put("connection", candidate == null ? "revoked" : "awaiting_approval");
        } catch (Exception unavailable) {
            state.put("connection", "offline");
        }
        SealedLocalState.write(context, STORE, KEY, state);
    }

    private static JSONObject status(JSONObject state) throws Exception {
        JSONObject candidate = state.optJSONObject("candidate");
        String connection = state.optString("connection", state.has("active") ? "approved" :
                candidate == null ? "waiting_for_setup" : "awaiting_approval");
        return new JSONObject().put("connection", connection).put("approved", state.has("active"))
                .put("pendingApproval", candidate != null).put("lastContactAt", state.optLong("lastContactAt"))
                .put("minutes", state.optInt("minutes",DEFAULT_MINUTES)).put("migration", state.optString("migration","pending_reconciliation"))
                .put("backupVerifiedAt",state.optLong("backupVerifiedAt")).put("baselineStagedAt",state.optLong("baselineStagedAt"))
                .put("lastReplicaAt",state.optLong("lastReplicaAt")).put("replicaCursor",state.optLong("replicaCursor"))
                .put("replicaPending",state.optBoolean("replicaPending"))
                .put("replicaPendingInvoices",state.optInt("replicaPendingInvoices"))
                .put("sourceJournal",state.optJSONObject("sourceJournal"))
                .put("baselineProgress",state.optJSONObject("baselineProgress"));
    }

    private static void requireDeployment() throws Exception {
        JSONObject info = request("/api/fleet-web/v1/setup-info", null);
        if (info.optInt("protocol") != 1 || !info.optString("mode").equals("rehearsal") || !info.optString("setupPath").equals(SETUP)) {
            throw new IOException("Εκκρεμεί η επαλήθευση του Cloudflare Fleet.");
        }
    }

    private static JSONObject request(String path, JSONObject credential) throws Exception {
        return request(path,credential,"","GET",null,0,null);
    }

    private static HttpsURLConnection connection(String path,JSONObject credential,String epoch,String method,String accept) throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) new URL(BASE + path).openConnection();
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(5000);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestMethod(method);
        connection.setRequestProperty("Accept", accept);
        if (!epoch.isEmpty()) connection.setRequestProperty("X-Fleet-Epoch",epoch);
        if (credential != null) connection.setRequestProperty("Authorization", "Bearer " +
                credential.getString("id") + "." + credential.getString("secret"));
        return connection;
    }

    private static void requireResponse(HttpsURLConnection connection) throws Exception {
        int status=connection.getResponseCode();
        if (status==401||status==403) throw new Rejected();
        if (status!=200) throw new IOException("Εκκρεμεί η διαθεσιμότητα του Cloudflare Fleet.");
    }

    private static void downloadDocument(JSONObject credential,String epoch,String sha,long expectedSize,OutputStream output) throws Exception {
        if (!sha.matches("[a-f0-9]{64}")) throw new IOException("Μη έγκυρο αποτύπωμα Fleet.");
        HttpsURLConnection connection=connection(DOCUMENT+sha,credential,epoch,"GET","*/*");
        connection.setRequestProperty("Accept-Encoding","identity");
        try {
            requireResponse(connection);
            String sizeHeader=connection.getHeaderField("X-Fleet-Size");
            long size=sizeHeader!=null&&sizeHeader.matches("[0-9]{1,8}")?Long.parseLong(sizeHeader):0;
            int transportSize=connection.getContentLength();
            if (!sha.equals(connection.getHeaderField("X-Fleet-Sha256"))||size<=0||size>FleetCloudReplica.MAX_DOCUMENT_BYTES||
                    (transportSize>=0&&transportSize!=size)||(expectedSize!=0&&size!=expectedSize)) {
                throw new IOException("Δεν επιβεβαιώθηκε το μέγεθος του αρχείου Fleet.");
            }
            try (InputStream input=connection.getInputStream()) {
                byte[] block=new byte[8192];
                long copied=0;
                for (int count;(count=input.read(block))!=-1;) {
                    if (Thread.currentThread().isInterrupted()) throw new java.io.InterruptedIOException();
                    copied+=count;
                    if (copied>size) throw new IOException("Το αρχείο Fleet υπερβαίνει το επιβεβαιωμένο μέγεθος.");
                    output.write(block,0,count);
                }
                if (copied!=size) throw new IOException("Η λήψη του αρχείου Fleet δεν ολοκληρώθηκε.");
            }
        } finally { connection.disconnect(); }
    }

    private static JSONObject request(String path,JSONObject credential,String epoch,String method,String type,long size,InputStream upload) throws Exception {
        HttpsURLConnection connection=connection(path,credential,epoch,method,"application/json");
        try {
            if (upload!=null) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type",type);
                connection.setFixedLengthStreamingMode(size);
                try (OutputStream output=connection.getOutputStream()) {
                    byte[] block=new byte[8192];
                    for (int count;(count=upload.read(block))!=-1;) {
                        if (Thread.currentThread().isInterrupted()) throw new java.io.InterruptedIOException();
                        output.write(block,0,count);
                    }
                }
            }
            requireResponse(connection);
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] block = new byte[1024];
                for (int length; (length = input.read(block)) >= 0;) {
                    int limit=path.startsWith(DELTA)?512*1024:RESPONSE_LIMIT;
                    if (output.size() + length > limit) throw new IOException("Μη έγκυρη απάντηση Fleet.");
                    output.write(block, 0, length);
                }
                return new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8));
            }
        } finally {
            connection.disconnect();
        }
    }

    private static String token(int bytes) {
        byte[] secret = new byte[bytes];
        random.nextBytes(secret);
        return Base64.encodeToString(secret, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private static String digest(String secret) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(secret.getBytes(StandardCharsets.UTF_8));
        StringBuilder text = new StringBuilder();
        for (byte value : bytes) text.append(Character.forDigit((value >> 4) & 15, 16)).append(Character.forDigit(value & 15, 16));
        return text.toString();
    }

    private static final class Rejected extends IOException { }
}
