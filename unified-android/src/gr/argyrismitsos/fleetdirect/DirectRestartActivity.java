package gr.argyrismitsos.fleetdirect;
import android.app.*;import android.content.*;import android.os.*;import android.widget.TextView;import java.io.*;

/** Separate helper drains/kills only :direct before its cold directory swap. */
public final class DirectRestartActivity extends Activity{
    @Override protected void attachBaseContext(Context c){super.attachBaseContext(new ScopedContext(c));}
    @Override public void onCreate(Bundle state){super.onCreate(state);TextView message=new TextView(this);message.setPadding(32,64,32,32);message.setText("Ασφαλής επανεκκίνηση Direct…");setContentView(message);
        try{
            if(!NativeRestartActivity.helperProcess(this)||!NativeColdRuntime.core(this).state().optString("phase").equals("ready"))throw new IOException("Δεν υπάρχει έτοιμη ανάκτηση.");
            ActivityManager manager=(ActivityManager)getSystemService(ACTIVITY_SERVICE);int found=-1;
            if(manager!=null&&manager.getRunningAppProcesses()!=null)for(ActivityManager.RunningAppProcessInfo p:manager.getRunningAppProcesses())if(p.uid==android.os.Process.myUid()&&p.processName.equals(getPackageName()+":direct"))found=p.pid;
            final int previous=found;if(previous>0)android.os.Process.killProcess(previous);
            final Handler handler=new Handler();handler.postDelayed(new Runnable(){int attempts;public void run(){
                if(previous>0&&new File("/proc/"+previous).exists()){if(++attempts<40){handler.postDelayed(this,250);return;}message.setText("Κλείσε και άνοιξε ξανά τον Server για να εφαρμοστεί η έτοιμη ανάκτηση.");return;}
                startActivity(new Intent().setClassName(DirectRestartActivity.this,"gr.argyrismitsos.fleetserver.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TASK));finish();android.os.Process.killProcess(android.os.Process.myPid());
            }},250);
        }catch(Exception error){message.setText("Η ανάκτηση διατηρήθηκε. Άνοιξε ξανά τον Server από το εικονίδιό του.");}
    }
}
