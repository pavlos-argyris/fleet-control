package gr.argyrismitsos.fleetupdates;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

public final class OtaInstallReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null || !(context.getPackageName() + ".OTA_RESULT").equals(intent.getAction())) return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmation = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirmation != null) OtaInstaller.pending(context, confirmation);
            return;
        }
        OtaInstaller.preferences(context).edit().putInt("session_id", -1).remove("confirmation")
                .putString("status", status == PackageInstaller.STATUS_SUCCESS ? "success" : "failed")
                .putString("message", status == PackageInstaller.STATUS_SUCCESS ? "Η ενημέρωση εγκαταστάθηκε." : "Η εγκατάσταση ακυρώθηκε ή δεν ολοκληρώθηκε. Μπορείς να δοκιμάσεις ξανά.")
                .putLong("result_at", System.currentTimeMillis()).apply();
    }
}
