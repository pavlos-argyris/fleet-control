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
        if(NativeColdRuntime.blocked(context))return;
        SharedPreferences preferences = context.getSharedPreferences(BackupManager.PREFS, Context.MODE_PRIVATE);
        if (!preferences.getBoolean("automatic_start", true)) return;
        Intent service = BackendMode.direct(context)?new Intent().setClassName(context,"gr.argyrismitsos.fleetdirect.IndependentService"):new Intent(context, SyncService.class);
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
