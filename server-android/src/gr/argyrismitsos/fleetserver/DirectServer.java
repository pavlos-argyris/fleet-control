package gr.argyrismitsos.fleetserver;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.*;
import java.io.*;
import java.util.concurrent.*;

/** Outbound encrypted relay; works behind mobile NAT without router changes. */
public final class DirectServer {
    private static volatile DirectServer instance;
    private static final Object ACCESS_LOCK=new Object();
    private final Context context;
    private final SharedPreferences preferences;
    private final FleetDataStore store;
    private final ScheduledExecutorService reader=Executors.newSingleThreadScheduledExecutor();
    private final ScheduledExecutorService heartbeat=Executors.newSingleThreadScheduledExecutor();
    private final DirectAccess api;
    private volatile DirectWebSocket socket;
    private volatile String socketBase="",identityGeneration="";
    private volatile boolean closed,connected;
    public DirectServer(Context context,FleetDataStore store)throws Exception {
        this.context=context;this.store=store;this.preferences=context.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);
        ByteArrayOutputStream out=new ByteArrayOutputStream();InputStream input=context.getAssets().open("direct-permissions.json");try{byte[] buffer=new byte[4096];int n;while((n=input.read(buffer))>=0)out.write(buffer,0,n);}finally{input.close();}
        api=new DirectAccess(new DirectAccess.Storage(){
            private String capturedAt="";
            public JSONObject state()throws Exception{String base=preferences.getString("worker_url",ServerConfig.DEFAULT_WORKER_URL).replaceAll("/+$","");JSONObject state=new JSONObject(DirectServer.this.store.getSetting("direct_auth_v1","{}"));if(!base.equals(state.optString("realm",base)))state=new JSONObject();return state.put("realm",base).put("enabled",preferences.getBoolean("direct_access_enabled",false));}
            public void save(JSONObject state)throws Exception{DirectServer.this.store.getWritableDatabase().execSQL("INSERT INTO settings(key,value) VALUES('direct_auth_v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",new Object[]{state.toString()});}
            public JSONObject snapshot(JSONObject request)throws Exception{String path=request.optString("path"),view=path.startsWith("/api/direct-local/view/")?path.substring(23):"";String city="",scope="";if(view.equals("shifts")||view.equals("stores"))try{JSONObject source=OrdexaSync.storesContext(DirectServer.this.context);if(source.optBoolean("configured")){city=source.optString("cityId");scope=source.optString("scope");}}catch(Exception unavailable){}JSONObject body=request.optJSONObject("body");JSONObject captured=DirectServer.this.store.getDirectSnapshot(view,body==null?0:body.optInt("offset"),city,scope);capturedAt=captured.optString("at");JSONObject value=captured.optJSONObject("snapshot");if(value==null)value=new JSONObject();String base=preferences.getString("worker_url",ServerConfig.DEFAULT_WORKER_URL).replaceAll("/+$","");if(!base.equals((value.isNull("sourceWorker")?ServerConfig.DEFAULT_WORKER_URL:value.getString("sourceWorker"))))capturedAt="";value.put("directStoreScope",scope).put("directCityId",city);return value;}
            public JSONObject fleet()throws Exception{return DirectServer.this.store.getDirectFleet();}
            public String snapshotAt(){return capturedAt;}
        },new JSONObject(new String(out.toByteArray(),"UTF-8")));
        instance=this;
    }
    public void start(){
        reader.execute(new Runnable(){public void run(){connect();}});
        heartbeat.scheduleWithFixedDelay(new Runnable(){public void run(){DirectWebSocket current=socket;if(current!=null&&connected)try{if(!socketBase.equals(preferences.getString("worker_url",ServerConfig.DEFAULT_WORKER_URL))||!identityGeneration.equals(DirectIdentity.generation(context)))current.close();else current.send("ping");}catch(Exception e){current.close();}}},20,20,TimeUnit.SECONDS);
    }
    private void connect(){
        if(closed)return;
        DirectWebSocket current=null;
        try{
            if(!preferences.getBoolean("direct_access_enabled",false))return;
            JSONObject identity=DirectIdentity.read(context);String key=identity.optString("secret"),generation=DirectIdentity.generation(context);if(key.length()!=43)return;
            current=new DirectWebSocket();socket=current;
            String base=preferences.getString("worker_url",ServerConfig.DEFAULT_WORKER_URL);
            socketBase=base;identityGeneration=generation;
            current.connect(base,ServerConfig.SERVER_KEY,DirectAccess.digest(key));
            while(!closed&&preferences.getBoolean("direct_access_enabled",false)){
                String raw=current.read();if("pong".equals(raw))continue;
                JSONObject message=new JSONObject(raw);
                if("ready".equals(message.optString("type"))){connected=true;continue;}
                if(!"request".equals(message.optString("type"))||!message.optString("id").matches("[a-f0-9-]{36}"))continue;
                JSONObject response,packet=message.getJSONObject("request");
                try{synchronized(ACCESS_LOCK){if(!generation.equals(DirectIdentity.generation(context))||!base.equals(preferences.getString("worker_url",ServerConfig.DEFAULT_WORKER_URL)))break;JSONObject clear=DirectCipher.open(identity,packet);response=api.claimRequest(packet.getString("nonce"),System.currentTimeMillis())?api.handle(clear,System.currentTimeMillis()):new JSONObject().put("status",409).put("body",new JSONObject().put("error","Το αίτημα έχει ήδη εξυπηρετηθεί ή ο Server είναι απασχολημένος. Επανάλαβε από την εφαρμογή.").toString());}}
                catch(Exception error){response=new JSONObject().put("status",400).put("body",new JSONObject().put("error","Δεν επιβεβαιώθηκε το ασφαλές αίτημα ή η ανάγνωση του τοπικού αντιγράφου. Έλεγξε τη σύζευξη και την ώρα των συσκευών.").toString());}
                if(response.toString().getBytes("UTF-8").length>1024*1024)response=new JSONObject().put("status",413).put("body",new JSONObject().put("error","Η προβολή είναι πολύ μεγάλη. Δοκίμασε μικρότερο εύρος.").toString());
                String reply=new JSONObject().put("id",message.getString("id")).put("response",DirectCipher.seal(identity,packet,response)).toString();
                current.send(reply);
            }
        }catch(Exception error){preferences.edit().putString("direct_access_error","Η απευθείας σύνδεση αναμένει επανασύνδεση. Έλεγξε το δίκτυο και τη διεύθυνση της πύλης.").apply();}
        finally{connected=false;if(current!=null)current.close();socket=null;if(!closed)reader.schedule(new Runnable(){public void run(){connect();}},5,TimeUnit.SECONDS);}
    }
    public void close(){closed=true;connected=false;DirectWebSocket current=socket;if(current!=null)current.close();reader.shutdownNow();heartbeat.shutdownNow();if(instance==this)instance=null;}
    public static JSONObject state(Context context,FleetDataStore store)throws Exception{
        SharedPreferences p=context.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);DirectServer current=instance;
        String code=p.getBoolean("direct_access_enabled",false)?DirectIdentity.pairingCode(context):"";
        return new JSONObject().put("enabled",p.getBoolean("direct_access_enabled",false)&&code.length()>0).put("connected",current!=null&&current.connected)
            .put("pairingCode",code)
            .put("snapshotAt",store.getSystemUpdatedAt()).put("readOnly",true).put("error",current!=null&&current.connected?"":p.getString("direct_access_error",""));
    }
    public static void configure(Context context,FleetDataStore store,boolean enabled)throws Exception{
        DirectServer current=instance;
        synchronized(ACCESS_LOCK){configureLocked(context,store,enabled,current);}
    }
    private static void configureLocked(Context context,FleetDataStore store,boolean enabled,DirectServer current)throws Exception{
        SharedPreferences p=context.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);
        // Every enable/disable rotates the pairing secret and revokes sessions.
        store.getWritableDatabase().execSQL("DELETE FROM settings WHERE key='direct_auth_v1'");
        DirectIdentity.rotate(context);
        if(!p.edit().putBoolean("direct_access_enabled",enabled).putString("direct_access_error","").commit())throw new IOException("Δεν αποθηκεύτηκε η ρύθμιση πρόσβασης.");
        if(current!=null&&current.socket!=null)current.socket.close();
    }
}
