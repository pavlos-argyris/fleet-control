package gr.argyrismitsos.fleetserver;
import android.app.Activity;import android.os.Handler;import android.view.View;import android.widget.*;
import java.util.concurrent.ExecutorService;import java.util.concurrent.atomic.AtomicBoolean;

/** Responsive startup gate: no Activity/Service database helper exists until cold apply completes. */
public final class NativeRecoveryStartup {
    private NativeRecoveryStartup(){}
    public static void show(final Activity activity,final ExecutorService executor,final Runnable completed){
        final Handler handler=new Handler();final AtomicBoolean working=new AtomicBoolean();LinearLayout layout=new LinearLayout(activity);layout.setOrientation(LinearLayout.VERTICAL);layout.setPadding(32,64,32,32);
        final TextView message=new TextView(activity);message.setText("Ασφαλής ανάκτηση Server πριν ανοίξει η βάση. Τα προηγούμενα αρχεία διατηρούνται.");layout.addView(message);final Button retry=new Button(activity);retry.setText("Επανάληψη ανάκτησης");layout.addView(retry);activity.setContentView(layout);
        final Runnable begin=new Runnable(){public void run(){if(!working.compareAndSet(false,true))return;retry.setEnabled(false);executor.execute(new Runnable(){public void run(){NativeColdRuntime.applyIfPending(activity.getApplicationContext());handler.post(new Runnable(){public void run(){working.set(false);if(activity.isFinishing()||activity.isDestroyed())return;if(NativeColdRuntime.blocked(activity)){message.setText("Η ανάκτηση χρειάζεται αποκατάσταση πριν ανοίξει η βάση. Τα προηγούμενα αρχεία διατηρούνται. Πάτησε επανάληψη όταν η συσκευή είναι έτοιμη.");retry.setEnabled(true);}else completed.run();}});}});}};
        retry.setOnClickListener(new View.OnClickListener(){public void onClick(View view){begin.run();}});
        handler.post(new Runnable(){public void run(){if(activity.isFinishing()||activity.isDestroyed())return;if(working.get())message.setText("Ασφαλής ανάκτηση Server…\n"+activity.getSharedPreferences(BackupManager.PREFS,Activity.MODE_PRIVATE).getString("native_recovery_step","Έλεγχος προετοιμασμένου αντιγράφου"));handler.postDelayed(this,500);}});
        if(activity.getSharedPreferences(BackupManager.PREFS,Activity.MODE_PRIVATE).getBoolean("native_recovery_startup_pending",false))begin.run();
    }
}
