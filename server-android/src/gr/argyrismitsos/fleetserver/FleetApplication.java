package gr.argyrismitsos.fleetserver;
import android.app.Application;

/** Install the local-only business route before Activity, receivers or jobs can issue HTTP. */
public final class FleetApplication extends Application {
    @Override public void onCreate(){super.onCreate();String process=NativeRestartActivity.processName(this);if(process.equals(getPackageName()+":restore"))return;if(!process.equals(getPackageName())){getSharedPreferences(BackupManager.PREFS,MODE_PRIVATE).edit().putBoolean("native_recovery_blocked",true).commit();return;}NativeColdRuntime.prepareStartup(this);if(!NativeColdRuntime.blocked(this))NativePrimaryService.install(this);}
}
