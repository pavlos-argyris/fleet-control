package gr.argyrismitsos.fleetserver;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.os.BatteryManager;
import android.os.Build;
import android.os.PowerManager;
import android.os.StatFs;
import android.os.SystemClock;

import org.json.JSONObject;

import java.lang.reflect.Method;

public final class DeviceHealth {
    private DeviceHealth() {}

    public static JSONObject collect(Context context) {
        JSONObject result = new JSONObject();
        try {
            Intent battery = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            int level = battery == null ? -1 : battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = battery == null ? -1 : battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            int status = battery == null ? -1 : battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            int temperature = battery == null ? Integer.MIN_VALUE : battery.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE);
            result.put("batteryPercent", level >= 0 && scale > 0 ? Math.round(level * 1000f / scale) / 10.0 : JSONObject.NULL);
            result.put("batteryCharging", status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL);
            result.put("batteryTemperatureC", temperature == Integer.MIN_VALUE ? JSONObject.NULL : temperature / 10.0);

            StatFs storage = new StatFs(context.getFilesDir().getAbsolutePath());
            result.put("storageFreeBytes", storage.getAvailableBytes());
            result.put("storageTotalBytes", storage.getTotalBytes());

            PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            result.put("powerSaveMode", power != null && power.isPowerSaveMode());
            result.put("ignoringBatteryOptimizations", power == null || power.isIgnoringBatteryOptimizations(context.getPackageName()));
            result.put("thermalStatus", thermalStatus(power));

            ConnectivityManager connectivity = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            NetworkInfo network = connectivity == null ? null : connectivity.getActiveNetworkInfo();
            result.put("networkConnected", network != null && network.isConnected());
            result.put("networkType", network == null ? "Χωρίς δίκτυο" : network.getTypeName() + (network.getSubtypeName().length() > 0 ? " • " + network.getSubtypeName() : ""));
            result.put("androidVersion", Build.VERSION.RELEASE == null ? String.valueOf(Build.VERSION.SDK_INT) : Build.VERSION.RELEASE);
            result.put("deviceModel", (Build.MANUFACTURER + " " + Build.MODEL).trim());
            result.put("uptimeSeconds", SystemClock.elapsedRealtime() / 1000L);
            result.put("measuredAt", isoNow());
        } catch (Exception error) {
            try { result.put("collectionError", error.getMessage() == null ? "Άγνωστο σφάλμα" : error.getMessage()); }
            catch (Exception ignored) {}
        }
        return result;
    }

    private static String thermalStatus(PowerManager power) {
        if (power == null || Build.VERSION.SDK_INT < 29) return "μη διαθέσιμο";
        try {
            Method method = PowerManager.class.getMethod("getCurrentThermalStatus");
            int status = ((Integer) method.invoke(power)).intValue();
            String[] labels = {"none", "light", "moderate", "severe", "critical", "emergency", "shutdown"};
            return status >= 0 && status < labels.length ? labels[status] : String.valueOf(status);
        } catch (Exception ignored) { return "μη διαθέσιμο"; }
    }

    private static String isoNow() {
        java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        format.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return format.format(new java.util.Date());
    }
}
