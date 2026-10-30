package gr.argyrismitsos.fleetserver;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.*;
import java.io.*;
import java.util.concurrent.*;
import java.security.SecureRandom;
import android.util.Base64;

/** Outbound encrypted relay; works behind mobile NAT without router changes. */
public final class DirectServer {
    private static volatile DirectServer instance;
    private final Context context;
    private final SharedPreferences preferences;
    private final FleetDataStore store;
    private final ScheduledExecutorService reader=Executors.newSingleThreadScheduledExecutor();
    private final ScheduledExecutorService heartbeat=Executors.newSingleThreadScheduledExecutor();
    private final DirectAccess api;
    private volatile DirectWebSocket socket;
    private volatile boolean closed,connected;
    public DirectServer(Context context,FleetDataStore store)throws Exception {
        this.context=context;this.store=store;this.preferences=context.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);
        ByteArrayOutputStream out=new ByteArrayOutputStream();InputStream input=context.getAssets().open("direct-permissions.json");try{byte[] buffer=new byte[4096];int n;while((n=input.read(buffer))>=0)out.write(buffer,0,n);}finally{input.close();}
        api=new DirectAccess(new DirectAccess.Storage(){
            public JSONObject state()throws Exception{return new JSONObject(DirectServer.this.store.getSetting("direct_auth_v1","{}")).put("enabled",preferences.getBoolean("direct_access_enabled",false));}
            public void save(JSONObject state)throws Exception{DirectServer.this.store.getWritableDatabase().execSQL("INSERT INTO settings(key,value) VALUES('direct_auth_v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",new Object[]{state.toString()});}
            public JSONObject snapshot()throws Exception{JSONObject value=DirectServer.this.store.getSystemExport();try{JSONObject source=OrdexaSync.storesContext(DirectServer.this.context);value.put("directStoreScope",source.optString("scope")).put("directCityId",source.optString("cityId"));}catch(Exception unavailable){}return value;}
            public JSONObject fleet()throws Exception{return DirectServer.this.store.getFleet();}
            public String snapshotAt(){return DirectServer.this.store.getSystemUpdatedAt();}
        },new JSONObject(new String(out.toByteArray(),"UTF-8")));
        instance=this;
    }
    public void start(){
        reader.execute(new Runnable(){public void run(){connect();}});
        heartbeat.scheduleWithFixedDelay(new Runnable(){public void run(){DirectWebSocket current=socket;if(current!=null&&connected)try{current.send("ping");}catch(Exception e){current.close();}}},20,20,TimeUnit.SECONDS);
    }
    private void connect(){
        if(closed)return;
        DirectWebSocket current=null;
        try{
            if(!preferences.getBoolean("direct_access_enabled",false))return;
            String key=preferences.getString("direct_pair_key","");if(key.length()!=43)return;
            current=new DirectWebSocket();socket=current;
            current.connect(preferences.getString("worker_url",ServerConfig.DEFAULT_WORKER_URL),ServerConfig.SERVER_KEY,DirectAccess.digest(key));
            while(!closed&&preferences.getBoolean("direct_access_enabled",false)){
                String raw=current.read();if("pong".equals(raw))continue;
                JSONObject message=new JSONObject(raw);
                if("ready".equals(message.optString("type"))){connected=true;continue;}
                if(!"request".equals(message.optString("type"))||!message.optString("id").matches("[a-f0-9-]{36}"))continue;
                JSONObject response;
                try{synchronized(api){if(!key.equals(preferences.getString("direct_pair_key","")))break;response=api.handle(message.getJSONObject("request"),System.currentTimeMillis());response.put("snapshotAt",store.getSystemUpdatedAt());}}
                catch(Exception error){response=new JSONObject().put("status",500).put("body",new JSONObject().put("error","Δεν διαβάστηκαν τα τοπικά δεδομένα. Το αποθηκευμένο αντίγραφο διατηρήθηκε.").toString());}
                String reply=new JSONObject().put("id",message.getString("id")).put("response",response).toString();
                if(reply.getBytes("UTF-8").length>2*1024*1024)reply=new JSONObject().put("id",message.getString("id")).put("response",new JSONObject().put("status",413).put("body",new JSONObject().put("error","Η προβολή είναι πολύ μεγάλη. Δοκίμασε μικρότερο εύρος.").toString())).toString();
                current.send(reply);
            }
        }catch(Exception error){preferences.edit().putString("direct_access_error","Η απευθείας σύνδεση αναμένει επανασύνδεση. Έλεγξε το δίκτυο και τη διεύθυνση της πύλης.").apply();}
        finally{connected=false;if(current!=null)current.close();socket=null;if(!closed)reader.schedule(new Runnable(){public void run(){connect();}},5,TimeUnit.SECONDS);}
    }
    public void close(){closed=true;connected=false;DirectWebSocket current=socket;if(current!=null)current.close();reader.shutdownNow();heartbeat.shutdownNow();if(instance==this)instance=null;}
    public static JSONObject state(Context context,FleetDataStore store)throws Exception{
        SharedPreferences p=context.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);DirectServer current=instance;
        return new JSONObject().put("enabled",p.getBoolean("direct_access_enabled",false)).put("connected",current!=null&&current.connected)
            .put("pairingCode",p.getBoolean("direct_access_enabled",false)?p.getString("direct_pair_key",""):"")
            .put("snapshotAt",store.getSystemUpdatedAt()).put("readOnly",true).put("error",current!=null&&current.connected?"":p.getString("direct_access_error",""));
    }
    public static void configure(Context context,FleetDataStore store,boolean enabled)throws Exception{
        DirectServer current=instance;Object lock=current==null?DirectServer.class:current.api;
        synchronized(lock){configureLocked(context,store,enabled,current);}
    }
    private static void configureLocked(Context context,FleetDataStore store,boolean enabled,DirectServer current)throws Exception{
        SharedPreferences p=context.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);
        byte[] bytes=new byte[32];new SecureRandom().nextBytes(bytes);
        String pair=Base64.encodeToString(bytes,Base64.URL_SAFE|Base64.NO_WRAP|Base64.NO_PADDING);
        // Every enable/disable rotates the pairing secret and revokes sessions.
        store.getWritableDatabase().execSQL("DELETE FROM settings WHERE key='direct_auth_v1'");
        if(!p.edit().putBoolean("direct_access_enabled",enabled).putString("direct_pair_key",pair).putString("direct_access_error","").commit())throw new IOException("Δεν αποθηκεύτηκε η ρύθμιση πρόσβασης.");
        if(current!=null&&current.socket!=null)current.socket.close();
    }
}
