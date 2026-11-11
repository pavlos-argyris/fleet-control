package gr.argyrismitsos.fleetserver;
import android.app.*;import android.content.*;import android.os.*;import android.net.*;import org.json.*;import java.net.*;import java.io.*;import java.util.concurrent.*;

/** User-started always-on origin. No SyncService, OTA, cloud coordinator or cloud jobs. */
public final class IndependentService extends Service {
    private ScheduledExecutorService jobs,maintenance,invoices;private IndependentInvoices invoiceWorker;private IndependentRuntime runtime;private IndependentHttps https;private PowerManager.WakeLock awake;private long dnsAt,certificateAt;private int dnsFailures,certFailures;
    @Override public void onCreate(){super.onCreate();foreground();jobs=Executors.newSingleThreadScheduledExecutor();maintenance=Executors.newSingleThreadScheduledExecutor();invoices=Executors.newSingleThreadScheduledExecutor();invoices.scheduleWithFixedDelay(new Runnable(){public void run(){try{if(blocked())return;IndependentRuntime backend=IndependentRuntime.get(IndependentService.this);if(invoiceWorker==null)invoiceWorker=new IndependentInvoices(IndependentService.this,backend);invoiceWorker.tick();}catch(Exception error){message("invoice","Η τοπική ουρά χρειάζεται επανάληψη.");}}},5,5,TimeUnit.SECONDS);
        jobs.scheduleWithFixedDelay(new Runnable(){public void run(){try{if(blocked())return;if(runtime==null)runtime=IndependentRuntime.get(IndependentService.this);if(awake==null){awake=((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"FleetIndependent:origin");awake.setReferenceCounted(false);}if(!awake.isHeld())awake.acquire(600000);runtime.jobs();}catch(Exception error){message("runtime","Η τοπική υπηρεσία χρειάζεται έλεγχο. Τα δεδομένα διατηρούνται.");}}},0,1,TimeUnit.SECONDS);
        maintenance.scheduleWithFixedDelay(new Runnable(){public void run(){maintain();}},0,30,TimeUnit.SECONDS);
    }
    private boolean blocked(){return !getSharedPreferences("independent_ui",MODE_PRIVATE).getString("blocked","").isEmpty();}
    private void message(String name,String text){getSharedPreferences("independent_ui",MODE_PRIVATE).edit().putString(name,text).apply();}
    private boolean wifi(){ConnectivityManager manager=(ConnectivityManager)getSystemService(CONNECTIVITY_SERVICE);NetworkInfo active=manager.getActiveNetworkInfo();return active!=null&&active.isConnected()&&active.getType()==ConnectivityManager.TYPE_WIFI;}
    private synchronized void maintain(){
        if(blocked())return;
        try{
            JSONObject config=IndependentConfig.read(this);if(!config.has("backupSha256"))return;if(runtime==null)runtime=IndependentRuntime.get(this);
            String host=config.optString("hostname");if(host.isEmpty()){message("network","Εκκρεμεί το δικό σου καταχωρισμένο όνομα DuckDNS. Ο τοπικός έλεγχος είναι διαθέσιμος.");return;}
            long now=System.currentTimeMillis();boolean connected=wifi();if(!connected){message("network","Server εκτός σταθερού Wi-Fi. Εκκρεμεί εξωτερική σύνδεση.");return;}
            if(now>=dnsAt){try{String ipv4=IndependentAcme.updateDns(this);dnsFailures=0;dnsAt=now+300000;getSharedPreferences("independent_ui",MODE_PRIVATE).edit().putString("ipv4",ipv4).putString("network","Το DNS ενημερώθηκε. Η εισερχόμενη πρόσβαση 4G/5G χρειάζεται χωριστό έλεγχο.").apply();}catch(Exception error){dnsFailures=Math.min(7,dnsFailures+1);dnsAt=now+Math.min(21600000L,300000L*(1L<<dnsFailures));message("network","Η ενημέρωση DNS δεν επιβεβαιώθηκε. Ασφαλής επανάληψη με αναμονή.");}}
            boolean valid=IndependentTls.valid(this,host);long expires=valid?IndependentTls.expires(this):0;
            if(now>=certificateAt&&(!valid||expires-now<30L*86400000)&&config.optBoolean("acmeTermsAccepted")){
                try{message("certificate","Έκδοση/ανανέωση πιστοποιητικού μέσω DNS-01…");IndependentAcme.issue(this);certFailures=0;certificateAt=now+43200000;if(https!=null){https.close();https=null;}message("certificate","Το πιστοποιητικό ελέγχθηκε ως έμπιστο. Εκκρεμεί φυσική δοκιμή HTTPS από δεύτερο δίκτυο.");}catch(Exception error){certFailures=Math.min(7,certFailures+1);certificateAt=now+Math.min(21600000L,300000L*(1L<<certFailures));message("certificate","Η έκδοση πιστοποιητικού δεν επιβεβαιώθηκε. Δεν ανοίγει ανασφαλής HTTP υπηρεσία.");}
            }
            if(https==null&&IndependentTls.valid(this,host)){
                final IndependentRuntime backend=runtime;https=new IndependentHttps(IndependentTls.context(this,host),null,8443,backend.realm(),new IndependentHttps.Handler(){public JSONObject api(JSONObject request)throws Exception{return backend.external(request);}public InputStream asset(String path)throws Exception{return getAssets().open("independent-www/"+path);}public long revision(){return backend.revision();}public long await(long revision)throws Exception{return backend.await(revision);}});https.start();message("runtime","HTTPS Server online στη θύρα 8443. Προώθηση μόνο εξωτερικής TCP443 → 8443 μετά τον έλεγχο.");
            }
            if(https!=null&&!IndependentTls.valid(this,host)){https.close();https=null;message("runtime","Το πιστοποιητικό έληξε ή δεν είναι έγκυρο. Ο HTTPS listener έκλεισε με ασφάλεια.");}
        }catch(Exception error){message("runtime","Ο HTTPS Server χρειάζεται έλεγχο ρυθμίσεων. Καμία cloud υπηρεσία δεν χρησιμοποιήθηκε.");}
    }
    private void foreground(){
        final String channel="fleet-independent-origin";Notification.Builder builder=new Notification.Builder(this);
        if(Build.VERSION.SDK_INT>=26)try{Class<?> type=Class.forName("android.app.NotificationChannel");Object value=type.getConstructor(String.class,CharSequence.class,int.class).newInstance(channel,"Fleet ανεξάρτητος Server",2);Object manager=getSystemService(NOTIFICATION_SERVICE);manager.getClass().getMethod("createNotificationChannel",type).invoke(manager,value);builder=Notification.Builder.class.getConstructor(Context.class,String.class).newInstance(this,channel);}catch(Exception error){throw new IllegalStateException("Notification channel unavailable");}
        Intent open=new Intent(this,IndependentActivity.class);PendingIntent pending=PendingIntent.getActivity(this,90,open,PendingIntent.FLAG_UPDATE_CURRENT|0x04000000);
        builder.setSmallIcon(android.R.drawable.stat_notify_sync).setContentTitle("Fleet — ανεξάρτητος Server").setContentText("Δοκιμαστική βάση · HTTPS και συγχρονισμοί στη συσκευή").setOngoing(true).setContentIntent(pending);startForeground(90,builder.build());
    }
    @Override public int onStartCommand(Intent intent,int flags,int id){return START_STICKY;}
    @Override public IBinder onBind(Intent intent){return null;}
    @Override public void onDestroy(){if(jobs!=null)jobs.shutdownNow();if(maintenance!=null)maintenance.shutdownNow();if(invoices!=null)invoices.shutdownNow();if(invoiceWorker!=null)invoiceWorker.close();try{if(https!=null)https.close();}catch(Exception ignored){}if(awake!=null&&awake.isHeld())awake.release();super.onDestroy();}
    static void start(Context c){Intent intent=new Intent(c,IndependentService.class);if(Build.VERSION.SDK_INT>=26)try{Context.class.getMethod("startForegroundService",Intent.class).invoke(c,intent);}catch(Exception error){throw new IllegalStateException("Foreground service did not start");}else c.startService(intent);}
}
