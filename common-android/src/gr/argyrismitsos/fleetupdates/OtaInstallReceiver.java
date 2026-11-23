package gr.argyrismitsos.fleetupdates;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

public final class OtaInstallReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null || !(context.getPackageName() + ".OTA_RESULT").equals(intent.getAction())) return;
        context=OtaInstaller.resultContext(context,intent);
        int session=intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID,-1);
        if(session<0||session!=OtaInstaller.preferences(context).getInt("session_id",-2))return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmation = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirmation != null) OtaInstaller.pending(context, session, confirmation);
            else OtaInstaller.finish(context,session,false);
            return;
        }
        OtaInstaller.finish(context,session,status==PackageInstaller.STATUS_SUCCESS);
    }
}
