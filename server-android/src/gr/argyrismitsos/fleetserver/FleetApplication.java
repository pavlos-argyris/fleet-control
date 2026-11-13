package gr.argyrismitsos.fleetserver;
import android.app.Application;

/** Install the local-only business route before Activity, receivers or jobs can issue HTTP. */
public final class FleetApplication extends Application {
    @Override public void onCreate(){
        super.onCreate();BackendMode.initialize(this);FleetHttp.installOperationFence(()->BackendMode.cloudRequest());
        String process=NativeRestartActivity.processName(this);
        if(process.equals(getPackageName()+":direct")){
            if(android.os.Build.VERSION.SDK_INT>=28)try{android.webkit.WebView.class.getMethod("setDataDirectorySuffix",String.class).invoke(null,"fleet-direct");}catch(Exception error){throw new IllegalStateException("Direct WebView storage unavailable",error);}
            return;
        }
        if(process.equals(getPackageName()+":restore"))return;
        if(!process.equals(getPackageName())){getSharedPreferences(BackupManager.PREFS,MODE_PRIVATE).edit().putBoolean("native_recovery_blocked",true).commit();return;}
        NativeColdRuntime.prepareStartup(this);if(!NativeColdRuntime.blocked(this))NativePrimaryService.install(this);
    }
}
