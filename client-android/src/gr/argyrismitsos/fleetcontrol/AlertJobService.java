package gr.argyrismitsos.fleetcontrol;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.LinkedHashSet;
import java.util.Set;

public final class AlertJobService extends JobService {
    public static final String PREFS = "fleet_control_session";
    public static final String AUTH_TOKEN_KEY = "auth_token";
    public static final String ENABLED_KEY = "admin_alert_notifications";
    private static final String NOTIFIED_IDS_KEY = "native_alert_notification_ids";
    private static final String CHANNEL_ID = "fleet_service_alerts";
    private static final String API_BASE = "https://fleet-control.pavlosargyris.workers.dev";
    private static final int JOB_ID = 7412;
    private volatile Thread worker;

    public static void schedule(Context context) {
        SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!preferences.getBoolean(ENABLED_KEY, false) || preferences.getString(AUTH_TOKEN_KEY, "").length() == 0) return;
        try {
            JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (scheduler == null) return;
            JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(context, AlertJobService.class))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPersisted(true)
                    .setPeriodic(15 * 60 * 1000L)
                    .setBackoffCriteria(30 * 1000L, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
                    .build();
            scheduler.schedule(job);
        } catch (RuntimeException ignored) {
            // A background notification check must never close the main app.
        }
    }

    public static void cancel(Context context) {
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler != null) scheduler.cancel(JOB_ID);
    }

    public static boolean notificationsAllowed(Context context) {
        return Build.VERSION.SDK_INT < 33 || context.checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
    }

    public static void show(Context context, String id, String title, String message, String severity) {
        if (!notificationsAllowed(context)) return;
        createChannel(context);
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(context, Math.abs(String.valueOf(id).hashCode()), intent,
                PendingIntent.FLAG_UPDATE_CURRENT | 0x04000000);
        try {
            Notification.Builder builder;
            if (Build.VERSION.SDK_INT >= 26) {
                Constructor<Notification.Builder> constructor = Notification.Builder.class.getConstructor(Context.class, String.class);
                builder = constructor.newInstance(context, CHANNEL_ID);
            } else builder = new Notification.Builder(context);
            builder.setSmallIcon(android.R.drawable.stat_notify_more)
                    .setContentTitle("Fleet Control • " + (title == null ? "Ειδοποίηση" : title))
                    .setContentText(message == null ? "" : message)
                    .setStyle(new Notification.BigTextStyle().bigText(message == null ? "" : message))
                    .setContentIntent(pending)
                    .setAutoCancel(true)
                    .setPriority("critical".equals(severity) ? Notification.PRIORITY_HIGH : Notification.PRIORITY_DEFAULT);
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.notify(Math.abs(("fleet-alert-" + id).hashCode()), builder.build());
        } catch (Exception ignored) {
        }
    }

    private static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
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

    @Override
    public boolean onStartJob(final JobParameters params) {
        worker = new Thread(new Runnable() {
            @Override public void run() {
                try { poll(); } catch (Exception ignored) {}
                jobFinished(params, false);
            }
        }, "fleet-alert-poll");
        worker.start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        Thread current = worker;
        if (current != null) current.interrupt();
        return true;
    }

    private void poll() throws Exception {
        SharedPreferences preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (!preferences.getBoolean(ENABLED_KEY, false)) return;
        String token = preferences.getString(AUTH_TOKEN_KEY, "");
        if (token.length() == 0) return;
        HttpURLConnection connection = (HttpURLConnection) new URL(API_BASE + "/api/admin/alerts").openConnection();
        connection.setConnectTimeout(12000);
        connection.setReadTimeout(12000);
        connection.setRequestMethod("GET");
        connection.setRequestProperty("Authorization", "Bearer " + token);
        connection.setRequestProperty("Accept", "application/json");
        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        StringBuilder body = new StringBuilder();
        if (stream != null) {
            BufferedReader reader = new BufferedReader(new InputStreamReader(stream, "UTF-8"));
            String line;
            while ((line = reader.readLine()) != null) body.append(line);
            reader.close();
        }
        connection.disconnect();
        if (status == 401 || status == 403) return;
        if (status < 200 || status >= 300) throw new IllegalStateException("HTTP " + status);
        JSONArray alerts = new JSONObject(body.toString()).optJSONArray("alerts");
        if (alerts == null) return;
        Set<String> seen = new LinkedHashSet<String>();
        try {
            JSONArray stored = new JSONArray(preferences.getString(NOTIFIED_IDS_KEY, "[]"));
            for (int i = 0; i < stored.length(); i++) seen.add(stored.optString(i, ""));
        } catch (Exception ignored) {}
        int delivered = 0;
        for (int i = 0; i < alerts.length() && delivered < 3; i++) {
            JSONObject alert = alerts.optJSONObject(i);
            if (alert == null) continue;
            String channel = alert.optString("channel", "in_app");
            String id = alert.optString("id", "");
            if (!("push".equals(channel) || "both".equals(channel)) || id.length() == 0 || seen.contains(id)) continue;
            show(getApplicationContext(), id, alert.optString("title", "Ειδοποίηση"), alert.optString("message", ""), alert.optString("severity", "warning"));
            seen.add(id);
            delivered += 1;
        }
        JSONArray saved = new JSONArray();
        int skip = Math.max(0, seen.size() - 200);
        int index = 0;
        for (String id : seen) {
            if (index++ >= skip) saved.put(id);
        }
        preferences.edit().putString(NOTIFIED_IDS_KEY, saved.toString()).apply();
    }
}
