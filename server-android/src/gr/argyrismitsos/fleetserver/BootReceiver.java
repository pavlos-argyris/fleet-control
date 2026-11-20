package gr.argyrismitsos.fleetserver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import java.lang.reflect.Method;

public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return;
        boolean direct = BackendMode.direct(context);
        // Direct validates and processes its own recovery state inside its scoped process.
        if (!direct && NativeColdRuntime.blocked(context)) return;
        String preferencesName = direct ? BackendMode.DIRECT_PREFERENCES_PREFIX + BackupManager.PREFS : BackupManager.PREFS;
        SharedPreferences preferences = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE);
        if (!preferences.getBoolean("automatic_start", true)) return;
        Intent service = direct?new Intent().setClassName(context,"gr.argyrismitsos.fleetdirect.IndependentService"):new Intent(context, SyncService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                Method method = Context.class.getMethod("startForegroundService", Intent.class);
                method.invoke(context, service);
            } else {
                context.startService(service);
            }
        } catch (Exception ignored) {
        }
    }
}
