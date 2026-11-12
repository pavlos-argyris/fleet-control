package gr.argyrismitsos.fleetdirect;
import android.content.*;
/** Installer callbacks share the Direct process preference cache. */
public final class DirectOtaReceiver extends BroadcastReceiver{
    @Override public void onReceive(Context c,Intent intent){new gr.argyrismitsos.fleetupdates.OtaInstallReceiver().onReceive(c,intent);}
}
