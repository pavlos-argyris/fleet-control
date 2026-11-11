package gr.argyrismitsos.fleettunnelpoc;
import android.content.*;

public final class PocBootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context,Intent intent){
        if(intent==null||!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())&&!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction()))return;
        if(!context.getSharedPreferences("poc",0).getBoolean("enabled",false))return;
        try{PocService.start(context);}catch(Exception error){context.getSharedPreferences("poc",0).edit().putString("status","Το Android εμπόδισε την αυτόματη εκκίνηση • άνοιξε τη δοκιμή").apply();}
    }
}
