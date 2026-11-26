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
            if (minutes != 5 && minutes != 15 && minutes != 30 && minutes != 60) throw new IOException("Η συχνότητα Fleet δεν αναγνωρίστηκε.");
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
            checkpoint = reserveBaseline(context);
            if (checkpoint == null) return;
            try (FleetDataStore store = new FleetDataStore(context)) {
                JSONObject proof = BackupJobs.fleetMigrationBaseline(context, store, checkpoint);
                completeBaseline(context, checkpoint, proof, false);
            }
        } catch (Exception failure) {
            if (checkpoint != null) try { completeBaseline(context, checkpoint, null, true); }
            catch (Exception unavailable) { }
        }
    }

    private static synchronized String reserveBaseline(Context context) throws Exception {
        JSONObject state=stored(context);
        long now=System.currentTimeMillis();
        if (!state.has("active") || !state.optString("connection").equals("approved") ||
                now-state.optLong("lastContactAt") > (state.optInt("minutes",DEFAULT_MINUTES)+1)*60000L ||
                !DirectHost.primary(context).optBoolean("ready") || DirectHost.paused(context)) return null;
        String generation=IndependentConfig.read(context).optString("generation");
        if (generation.isEmpty()) return null;
        String key=state.getString("epoch")+":"+generation;
        String checkpoint=UUID.nameUUIDFromBytes(("fleet-cloud-baseline:"+key).getBytes(StandardCharsets.UTF_8)).toString();
        if (checkpoint.equals(state.optString("backupJob")) &&
                (state.has("backupSha256") || state.optLong("nextBackupAt")>now)) return null;
        if (!checkpoint.equals(state.optString("backupJob"))) state.remove("backupSha256");
        state.put("backupJob",checkpoint).put("migration","preparing_backup").put("nextBackupAt",now+300000L);
        SealedLocalState.write(context, STORE, KEY, state);
        return checkpoint;
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

    private static void refresh(Context context, JSONObject state, boolean manual) throws Exception {
        JSONObject candidate = state.optJSONObject("candidate");
        JSONObject active = state.optJSONObject("active"), credential = candidate == null ? active : candidate;
        long interval=state.optInt("minutes", DEFAULT_MINUTES) * 60000L;
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
                state.put("epoch", epoch).put("connection", "approved").put("lastContactAt", started);
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
                .put("backupVerifiedAt",state.optLong("backupVerifiedAt"));
    }

    private static void requireDeployment() throws Exception {
        JSONObject info = request("/api/fleet-web/v1/setup-info", null);
        if (info.optInt("protocol") != 1 || !info.optString("mode").equals("rehearsal") || !info.optString("setupPath").equals(SETUP)) {
            throw new IOException("Εκκρεμεί η επαλήθευση του Cloudflare Fleet.");
        }
    }

    private static JSONObject request(String path, JSONObject credential) throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) new URL(BASE + path).openConnection();
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(5000);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        if (credential != null) connection.setRequestProperty("Authorization", "Bearer " +
                credential.getString("id") + "." + credential.getString("secret"));
        try {
            int status = connection.getResponseCode();
            if (status == 401 || status == 403) throw new Rejected();
            if (status != 200) throw new IOException("Εκκρεμεί η διαθεσιμότητα του Cloudflare Fleet.");
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] block = new byte[1024];
                for (int length; (length = input.read(block)) >= 0;) {
                    if (output.size() + length > RESPONSE_LIMIT) throw new IOException("Μη έγκυρη απάντηση Fleet.");
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
