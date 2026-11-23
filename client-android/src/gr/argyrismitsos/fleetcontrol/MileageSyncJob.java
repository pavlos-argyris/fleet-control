package gr.argyrismitsos.fleetcontrol;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;
import gr.argyrismitsos.fleetupdates.SessionVault;
import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/** Keeps delivery available to Android after the WebView leaves the foreground. */
public final class MileageSyncJob extends JobService {
    private static final String PREFS = "fleet_mileage_pending";
    private static final int JOB_ID = 7413;
    private static final String UUID = "[a-f0-9-]{36}";
    private volatile Thread worker;

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private static String savedSession(Context context) {
        if (!BackendSelection.direct(context)) return "";
        return SessionVault.read(context, context.getSharedPreferences(AlertJobService.PREFS, MODE_PRIVATE),
                BackendSelection.tokenKey(context), BackendSelection.DIRECT);
    }

    private static String fingerprint(String token) throws Exception {
        return android.util.Base64.encodeToString(MessageDigest.getInstance("SHA-256")
                .digest(token.getBytes("UTF-8")), android.util.Base64.NO_WRAP);
    }

    static synchronized void stage(Context context, String body, String instance, String token) throws Exception {
        if (body == null || body.length() > 1024 || instance == null || !instance.matches("[A-Za-z0-9-]{1,100}")
                || !token.equals(savedSession(context))) return;
        JSONObject mileage = new JSONObject(body).getJSONObject("mileage");
        String id = mileage.getString("id");
        if (!id.matches(UUID) || mileage.getString("bikeId").isEmpty()
                || !mileage.getString("date").matches("\\d{4}-\\d{2}-\\d{2}") || mileage.getLong("km") < 0) return;
        SharedPreferences prefs = preferences(context);
        String session = fingerprint(token);
        String prior = prefs.getString(id, "");
        boolean added = prior.isEmpty() || !new JSONObject(prior).optString("session").equals(session);
        if (added) {
            JSONObject row = new JSONObject().put("id", id).put("body", body).put("instance", instance)
                    .put("session", session).put("at", System.currentTimeMillis());
            if (!prefs.edit().putString(id, row.toString()).commit()) throw new IOException("Mileage write failed");
        }
        JobScheduler scheduler = (JobScheduler) context.getSystemService(JOB_SCHEDULER_SERVICE);
        if (scheduler == null) return;
        if (!added) for (JobInfo pending : scheduler.getAllPendingJobs()) if (pending.getId() == JOB_ID) return;
        scheduler.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(context, MileageSyncJob.class))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true).setMinimumLatency(5000)
                .setBackoffCriteria(10000, JobInfo.BACKOFF_POLICY_EXPONENTIAL).build());
    }

    static synchronized void discard(Context context, String id, String token) throws Exception {
        if (id == null || !id.matches(UUID)) return;
        SharedPreferences prefs = preferences(context);
        String prior = prefs.getString(id, "");
        if (!prior.isEmpty() && new JSONObject(prior).optString("session").equals(fingerprint(token))) {
            prefs.edit().remove(id).commit();
        }
    }

    @Override public boolean onStartJob(final JobParameters parameters) {
        worker = new Thread(new Runnable() {
            @Override public void run() {
                boolean retry = true;
                try { retry = deliver(); } catch (Exception ignored) { /* Keep the durable request. */ }
                if (worker == Thread.currentThread()) jobFinished(parameters, retry);
            }
        }, "fleet-mileage-sync");
        worker.start();
        return true;
    }

    @Override public boolean onStopJob(JobParameters parameters) {
        Thread stopped = worker;
        worker = null;
        if (stopped != null) stopped.interrupt();
        return true;
    }

    private boolean deliver() throws Exception {
        String token = savedSession(this);
        if (token.isEmpty()) return false;
        String session = fingerprint(token);
        List<JSONObject> rows = new ArrayList<>();
        for (Object raw : preferences(this).getAll().values()) {
            JSONObject row = new JSONObject(String.valueOf(raw));
            if (session.equals(row.optString("session"))) rows.add(row);
        }
        Collections.sort(rows, new Comparator<JSONObject>() {
            @Override public int compare(JSONObject first, JSONObject second) {
                return Long.compare(first.optLong("at"), second.optLong("at"));
            }
        });
        long deadline = SystemClock.elapsedRealtime() + 45000;
        for (JSONObject row : rows) {
            if (Thread.currentThread().isInterrupted() || SystemClock.elapsedRealtime() >= deadline) return true;
            if (!token.equals(savedSession(this))) return false;
            if (!preferences(this).contains(row.getString("id"))) continue;
            int result = send(row, token);
            if (result == 0) return true;
            if (result < 0) return false;
            discard(this, row.getString("id"), token);
        }
        return false;
    }

    /** 1 is a confirmed or terminal response, 0 is retryable, -1 needs a session. */
    private int send(JSONObject row, String token) throws Exception {
        String id = row.getString("id");
        String body = row.getString("body");
        byte[] bytes = body.getBytes("UTF-8");
        HttpsURLConnection connection = (HttpsURLConnection) new URL(BackendSelection.DIRECT + "/api/sync/bike").openConnection();
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(10000);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Authorization", "Bearer " + token);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("X-Fleet-Backend-Revision", String.valueOf(BackendSelection.revision(this)));
        connection.setRequestProperty("X-Fleet-Instance", row.getString("instance"));
        connection.setRequestProperty("X-Fleet-Operation", id);
        connection.setFixedLengthStreamingMode(bytes.length);
        try {
            try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            int status = connection.getResponseCode();
            if (status == 401 || status == 403) return -1;
            if (status == 400 || status == 404 || status == 422) return 1;
            if (status != 200 && status != 409) return 0;
            JSONObject value = readJson(status == 200 ? connection.getInputStream() : connection.getErrorStream());
            if (status == 409) {
                String code = value.optString("code");
                return ("bike_archived".equals(code) || "mileage_outdated".equals(code) || "mileage_id_conflict".equals(code)
                        || "mileage_instance_changed".equals(code) || "operation_conflict".equals(code)
                        || "operation_authorization_changed".equals(code)) ? 1 : 0;
            }
            JSONObject entry = value.optJSONObject("entry"), card = value.optJSONObject("card");
            String bike = new JSONObject(body).getJSONObject("mileage").getString("bikeId");
            return value.optBoolean("saved") && entry != null && id.equals(entry.optString("id"))
                    && card != null && bike.equals(card.optString("id")) && value.optLong("version", -1) >= 0 ? 1 : 0;
        } finally { connection.disconnect(); }
    }

    private static JSONObject readJson(InputStream input) throws Exception {
        if (input == null) throw new IOException("Missing mileage response");
        try (InputStream source = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = source.read(buffer)) != -1) {
                if (output.size() + count > 65536) throw new IOException("Oversized mileage response");
                output.write(buffer, 0, count);
            }
            return new JSONObject(output.toString("UTF-8"));
        }
    }
}
