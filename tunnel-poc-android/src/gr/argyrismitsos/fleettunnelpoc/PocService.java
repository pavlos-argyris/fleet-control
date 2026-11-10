package gr.argyrismitsos.fleettunnelpoc;

import android.app.*;
import android.content.*;
import android.net.*;
import android.os.*;
import org.json.JSONObject;
import java.io.*;
import java.lang.Process;
import java.net.InetAddress;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;

/** Explicitly enabled test service. No Fleet runtime, database, relay, or tokens. */
public final class PocService extends Service {
    private ScheduledExecutorService supervisor;
    private volatile Process connector;
    private PocOrigin origin;
    private PowerManager.WakeLock wake;
    private String network="";
    private long nextStart,processStarted;
    private int failures;
    public static void start(Context context)throws Exception {Context.class.getMethod("startForegroundService",Intent.class).invoke(context,new Intent(context,PocService.class));}
    private void status(String text){SharedPreferences prefs=getSharedPreferences("poc",0);if(!text.equals(prefs.getString("status","")))prefs.edit().putString("status",text).apply();}
    @Override public void onCreate(){
        super.onCreate();
        try{
            Class<?> channel=Class.forName("android.app.NotificationChannel");Object value=channel.getConstructor(String.class,CharSequence.class,int.class).newInstance("tunnel-poc","Fleet Tunnel TEST",2);
            NotificationManager manager=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);manager.getClass().getMethod("createNotificationChannel",channel).invoke(manager,value);
            Notification.Builder builder=Notification.Builder.class.getConstructor(Context.class,String.class).newInstance(this,"tunnel-poc");
            Intent launch=new Intent(this,PocActivity.class);PendingIntent pending=PendingIntent.getActivity(this,0,launch,0x04000000);
            startForeground(8701,builder.setSmallIcon(android.R.drawable.stat_notify_sync).setContentTitle("Fleet Tunnel TEST").setContentText("Μόνο συνθετική δοκιμή • χωρίς δεδομένα Fleet").setOngoing(true).setContentIntent(pending).build());
            PocConfig.cleanRuntime(this);
            supervisor=Executors.newSingleThreadScheduledExecutor();supervisor.scheduleWithFixedDelay(new Runnable(){public void run(){tick();}},0,5,TimeUnit.SECONDS);
        }catch(Exception error){status("Αδυναμία εκκίνησης υπηρεσίας δοκιμής");stopSelf();}
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId){return getSharedPreferences("poc",0).getBoolean("enabled",false)?START_STICKY:stopDisabled();}
    private int stopDisabled(){stopSelf();return START_NOT_STICKY;}
    private static boolean running(Process process){if(process==null)return false;try{process.exitValue();return false;}catch(IllegalThreadStateException active){return true;}}
    private static String digest(File file)throws Exception {MessageDigest hash=MessageDigest.getInstance("SHA-256");try(InputStream input=new FileInputStream(file)){byte[] bytes=new byte[65536];int n;while((n=input.read(bytes))!=-1)hash.update(bytes,0,n);}StringBuilder out=new StringBuilder();for(byte b:hash.digest())out.append(String.format(Locale.US,"%02x",b&255));return out.toString();}
    private File verifiedBinary()throws Exception {
        if(!Arrays.asList(Build.SUPPORTED_ABIS).contains("arm64-v8a"))throw new IOException("Unsupported ABI");
        JSONObject info;try(InputStream input=getAssets().open("connector.json");ByteArrayOutputStream output=new ByteArrayOutputStream()){byte[] bytes=new byte[4096];int n;while((n=input.read(bytes))!=-1){if(output.size()+n>8192)throw new IOException("Invalid connector metadata");output.write(bytes,0,n);}info=new JSONObject(new String(output.toByteArray(),"UTF-8"));}
        File binary=new File(getApplicationInfo().nativeLibraryDir,"libcloudflared.so");
        if(!info.getString("sha256").matches("[a-f0-9]{64}")||!binary.isFile()||!binary.canExecute()||!digest(binary).equals(info.getString("sha256")))throw new IOException("Unverified packaged binary");
        getSharedPreferences("poc",0).edit().putString("connectorSha256",info.getString("sha256")).apply();return binary;
    }
    private synchronized void stopConnector(){Process prior=connector;connector=null;if(prior!=null){prior.destroy();try{if(!prior.waitFor(2,TimeUnit.SECONDS))prior.destroyForcibly();}catch(InterruptedException interrupted){Thread.currentThread().interrupt();}}PocConfig.cleanRuntime(this);}
    private synchronized void tick(){
        if(!getSharedPreferences("poc",0).getBoolean("enabled",false)){stopSelf();return;}
        try{
            JSONObject config=PocConfig.read(this);
            if(origin==null){origin=new PocOrigin(PocOrigin.PORT);getSharedPreferences("poc",0).edit().putString("instanceId",origin.instance()).apply();}
            if(wake==null){wake=((PowerManager)getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"FleetTunnelPoc:Test");wake.setReferenceCounted(false);wake.acquire();}
            ConnectivityManager connectivity=(ConnectivityManager)getSystemService(CONNECTIVITY_SERVICE);Network current=connectivity.getActiveNetwork();LinkProperties properties=current==null?null:connectivity.getLinkProperties(current);
            StringBuilder dns=new StringBuilder();if(properties!=null)for(InetAddress server:properties.getDnsServers()){if(dns.length()>0)dns.append(',');dns.append(server.getHostAddress());}
            String signature=String.valueOf(current)+"|"+dns;
            if(!signature.equals(network)){stopConnector();network=signature;nextStart=0;failures=0;}
            if(current==null||dns.length()==0){status("Χωρίς ενεργό δίκτυο/DNS • η δοκιμή περιμένει");return;}
            if(running(connector)){if(SystemClock.elapsedRealtime()-processStarted>60000)failures=0;status("Connector σε λειτουργία • απαιτείται εξωτερική επαλήθευση");return;}
            if(SystemClock.elapsedRealtime()<nextStart){status("Αποσύνδεση connector • αυτόματη επανάληψη");return;}
            stopConnector();File binary=verifiedBinary(),file=PocConfig.runtime(this,config);
            ProcessBuilder builder=new ProcessBuilder(binary.getAbsolutePath(),"tunnel","--config",file.getAbsolutePath(),"--no-autoupdate","run",config.getJSONObject("credentials").getString("TunnelID"));
            builder.environment().clear();builder.environment().put("FLEET_POC_DNS",dns.toString());builder.environment().put("TMPDIR",getCacheDir().getAbsolutePath());
            builder.environment().put("SSL_CERT_DIR","/apex/com.android.conscrypt/cacerts:/system/etc/security/cacerts");builder.redirectErrorStream(true);
            final Process started=builder.start();connector=started;processStarted=SystemClock.elapsedRealtime();nextStart=processStarted+Math.min(60000,1000L<<Math.min(6,failures++));
            new Thread(new Runnable(){public void run(){try(InputStream input=started.getInputStream()){byte[] discard=new byte[4096];while(input.read(discard)!=-1){/* Never persist/forward connector logs or credentials. */}}catch(IOException ignored){}}},"fleet-poc-log-drain").start();
            status("Connector ξεκίνησε • δεν έχει επιβεβαιωθεί η δημόσια σύνδεση");
        }catch(Exception error){stopConnector();nextStart=SystemClock.elapsedRealtime()+30000;status("Η δοκιμή χρειάζεται έλεγχο ρύθμισης, binary ή δικτύου");}
    }
    @Override public synchronized void onDestroy(){if(supervisor!=null)supervisor.shutdownNow();stopConnector();if(origin!=null)origin.close();if(wake!=null&&wake.isHeld())wake.release();status("Η δοκιμή σταμάτησε • κανένα δεδομένο Fleet δεν άλλαξε");super.onDestroy();}
    @Override public IBinder onBind(Intent intent){return null;}
}
