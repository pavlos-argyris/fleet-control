package gr.argyrismitsos.fleetserver;
import android.app.Application;

/** Install the local-only business route before Activity, receivers or jobs can issue HTTP. */
public final class FleetApplication extends Application {
    @Override public void onCreate(){super.onCreate();NativePrimaryService.install(this);}
}
