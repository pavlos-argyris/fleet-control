package gr.argyrismitsos.fleetserver;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.widget.TextView;

/** Emulator-only document owner, launched after target-package instrumentation starts. */
public final class SyntheticBackupActivity extends Activity {
    @Override public void onCreate(Bundle state){
        super.onCreate(state);
        // Launch the provider as its owning UID before the target app needs
        // the real tree grant. The protected provider cannot bootstrap itself
        // from an unauthorized first ContentResolver.call in the target UID.
        Bundle ready=getContentResolver().call(Uri.parse("content://"+getPackageName()+".backup"),"prepare",null,null);
        if(ready==null||!ready.getBoolean("ready"))throw new IllegalStateException("Synthetic document tree was not granted");
        TextView message=new TextView(this);message.setText("Synthetic backup tree ready");setContentView(message);
    }
}
