package gr.argyrismitsos.fleetserver;
import android.content.*;
/** No automatic launch from BOOT_COMPLETED where Android restricts foreground starts. */
public final class IndependentBootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context c,Intent intent){try{if(!IndependentConfig.read(c).has("backupSha256"))return;IndependentService.start(c);}catch(Exception restricted){c.getSharedPreferences("independent_ui",Context.MODE_PRIVATE).edit().putString("runtime","Μετά την επανεκκίνηση το Android περιόρισε την αυτόματη εκκίνηση. Άνοιξε μία φορά Fleet Independent Server.").apply();}}
}
