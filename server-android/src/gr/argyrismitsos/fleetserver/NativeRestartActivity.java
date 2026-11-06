package gr.argyrismitsos.fleetserver;
import android.app.*;import android.content.*;import android.os.*;import android.widget.TextView;
import java.io.*;

/** Private helper process. It never opens SQLite; the old process must exit before cold restore. */
public final class NativeRestartActivity extends Activity {
    private final Handler handler=new Handler();
    static String processName(Context context){
        try{return (String)Application.class.getMethod("getProcessName").invoke(null);}catch(Exception ignored){}
        try(InputStream input=new FileInputStream("/proc/self/cmdline")){byte[] bytes=new byte[1024];int length=input.read(bytes),end=0;while(end<length&&bytes[end]!=0)end++;return new String(bytes,0,end,"UTF-8");}catch(Exception error){return "";}
    }
    static boolean helperProcess(Context context){return processName(context).equals(context.getPackageName()+":restore");}
    @Override public void onCreate(Bundle state){super.onCreate(state);final TextView message=new TextView(this);message.setPadding(32,64,32,32);message.setText("Ασφαλής επανεκκίνηση Server…");setContentView(message);
        try{
            if(!helperProcess(this)||!NativeColdRuntime.core(this).state().optString("phase").equals("ready"))throw new IOException("Δεν υπάρχει έτοιμη ανάκτηση για επανεκκίνηση.");
            ActivityManager manager=(ActivityManager)getSystemService(ACTIVITY_SERVICE);int found=-1;if(manager!=null&&manager.getRunningAppProcesses()!=null)for(ActivityManager.RunningAppProcessInfo process:manager.getRunningAppProcesses())if(process.processName.equals(getPackageName())&&process.uid==android.os.Process.myUid()){found=process.pid;break;}
            final int previous=found>0?found:getIntent().getIntExtra("previousPid",-1);if(previous==android.os.Process.myPid())throw new IOException("Μη έγκυρη διαδικασία επανεκκίνησης.");if(previous>0)android.os.Process.killProcess(previous);
            handler.postDelayed(new Runnable(){int attempts;public void run(){if(previous>0&&new File("/proc/"+previous).exists()){if(++attempts<20){handler.postDelayed(this,250);return;}message.setText("Κλείσε και άνοιξε ξανά τον Server για να συνεχιστεί η έτοιμη ανάκτηση.");return;}startActivity(new Intent(NativeRestartActivity.this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TASK));finish();android.os.Process.killProcess(android.os.Process.myPid());}},250);
        }catch(Exception error){message.setText("Δεν ξεκίνησε η επανεκκίνηση. Άνοιξε ξανά τον Server από το εικονίδιό του.");}
    }
}
