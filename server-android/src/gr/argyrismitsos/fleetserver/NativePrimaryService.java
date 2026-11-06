package gr.argyrismitsos.fleetserver;

import android.content.*;
import android.os.SystemClock;
import android.os.StatFs;
import org.json.*;
import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;

/** Native authority: one business executor, independent socket reader and lease renewal. */
public final class NativePrimaryService implements FleetHttp.LocalTransport {
    private static NativePrimaryService instance;
    public static synchronized NativePrimaryService get(Context context){if(instance==null)instance=new NativePrimaryService(context.getApplicationContext());return instance;}
    public static void install(Context context){final NativePrimaryService service=get(context);FleetHttp.installLocalTransport(service);NativeDatabaseSnapshot.setCoordinator(new NativeDatabaseSnapshot.Coordinator(){public NativeDatabaseSnapshot.Capture capture(final NativeDatabaseSnapshot.CaptureTask task)throws Exception{return service.execute(new Callable<NativeDatabaseSnapshot.Capture>(){public NativeDatabaseSnapshot.Capture call()throws Exception{return task.capture();}});}});}
    public static boolean jobsAllowed(Context context){try{NativePrimaryService service=get(context);String phase=NativePrimaryState.read(service.store.getReadableDatabase()).optString("phase","cloud");return phase.equals("cloud")||phase.equals("active")&&service.available();}catch(Exception error){return false;}}
    public static boolean cloudMode(Context context){try{return NativePrimaryState.read(get(context).store.getReadableDatabase()).optString("phase","cloud").equals("cloud");}catch(Exception error){return false;}}
    private final Context context;
    private final FleetDataStore store;
    private final ThreadPoolExecutor business=new ThreadPoolExecutor(1,1,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<Runnable>(16));
    private final ScheduledExecutorService heartbeat=Executors.newSingleThreadScheduledExecutor();
    private final NativePrimaryLease lease=new NativePrimaryLease(new NativePrimaryLease.Clock(){public long now(){return SystemClock.elapsedRealtime();}});
    private volatile boolean started,connecting;
    private volatile DirectWebSocket socket;
    private volatile String epoch="",generation="";
    private volatile JSONObject connectedIdentity;
    private volatile Thread businessThread;
    private NativeBusinessEngine engine;
    private NativePrimaryGuard guard;
    private String engineGeneration="";
    private NativePrimaryService(Context context){this.context=context;store=new FleetDataStore(context);heartbeat.scheduleWithFixedDelay(new Runnable(){public void run(){tick();}},1,10,TimeUnit.SECONDS);}
    private SharedPreferences prefs(){return context.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);}
    private static String origin(URL url)throws Exception{if(!url.getProtocol().equals("https")||url.getUserInfo()!=null||url.getRef()!=null)throw new IOException("Χρειάζεται έγκυρη διεύθυνση HTTPS Fleet.");return "https://"+url.getHost()+(url.getPort()<0||url.getPort()==443?"":":"+url.getPort());}
    private boolean local(String address)throws Exception{
        URL url=new URL(address);String path=url.getPath();
        if(!path.startsWith("/api/")||path.startsWith("/api/primary/")||path.startsWith("/api/deploy/releases/")||path.equals("/api/server-update")||path.equals("/api/client-update"))return false;
        JSONObject state=NativePrimaryState.read(store.getReadableDatabase());if(state.optString("phase","cloud").equals("cloud"))return false;
        if(!origin(url).equals(state.optString("realm")))throw new IOException("Η διεύθυνση δεν αντιστοιχεί στην κύρια βάση. Η παλιά βάση cloud δεν χρησιμοποιήθηκε.");
        if(!state.optString("phase").equals("active")||!started)throw new IOException("Η κύρια βάση Server δεν είναι ακόμη διαθέσιμη. Τα αποθηκευμένα δεδομένα διατηρούνται.");
        return true;
    }
    private <T>T execute(final Callable<T> task)throws Exception{
        if(Thread.currentThread()==businessThread)return task.call();
        Future<T> future;
        try{future=business.submit(new Callable<T>(){public T call()throws Exception{businessThread=Thread.currentThread();try{return task.call();}finally{Thread.interrupted();}}});}
        catch(RejectedExecutionException busy){throw new IOException("Ο Server εξυπηρετεί άλλες εργασίες. Δοκίμασε ξανά.");}
        try{return future.get(35000,TimeUnit.MILLISECONDS);}catch(ExecutionException error){Throwable cause=error.getCause();if(cause instanceof Exception)throw(Exception)cause;throw new IOException("Η τοπική εργασία απέτυχε.");}catch(TimeoutException timeout){future.cancel(true);throw new IOException("Δεν επιβεβαιώθηκε η τοπική εργασία. Έλεγξε την κατάσταση πριν επαναλάβεις.");}
    }
    private String asset(String name)throws Exception{try(InputStream input=context.getAssets().open("business-runtime/"+name);ByteArrayOutputStream output=new ByteArrayOutputStream()){byte[] buffer=new byte[65536];int n;while((n=input.read(buffer))!=-1){if(output.size()+n>8*1024*1024)throw new IOException("Μη έγκυρος ενσωματωμένος κώδικας.");output.write(buffer,0,n);}return new String(output.toByteArray(),"UTF-8");}}
    private void engine(JSONObject identity)throws Exception{
        String gen=identity.getString("generation");if(engine!=null&&gen.equals(engineGeneration))return;if(engine!=null)engine.close();
        guard=new NativePrimaryGuard(store.getWritableDatabase(),lease,identity.getString("realm"),gen);
        JSONObject config=new JSONObject(identity.toString()).put("serverKey",ServerConfig.SERVER_KEY);
        JSONObject manifest=new JSONObject(asset("manifest.json"));
        engine=new NativeBusinessEngine(store.getWritableDatabase(),new File(context.getFilesDir(),"service-documents"),new File(context.getCacheDir(),"business-files"),config,asset("runtime.js"),manifest.getString("bundleSha256"),guard,new NativeBusinessEngine.Ports(){public JSONObject call(String command,JSONObject value,BusinessObjects objects)throws Exception{return port(command,value,objects);}});engineGeneration=gen;
    }
    private JSONObject port(String command,JSONObject value,BusinessObjects objects)throws Exception{
        if(command.equals("store.context")){
            JSONObject current=OrdexaSync.storesContext(context);if(current.optBoolean("configured"))return current;
            new StoreBillingStore(store);
            // After recovery credentials are absent, but the imported historical scope remains readable.
            JSONArray rows=new BusinessSqlite(store.getReadableDatabase()).call("sql.query",new JSONObject().put("sql","SELECT DISTINCT scope FROM store_billing_local WHERE kind='store' AND scope<>'' LIMIT 2")).getJSONArray("results");
            return rows.length()==1?new JSONObject().put("configured",true).put("scope",rows.getJSONObject(0).getString("scope")).put("historicalOnly",true):new JSONObject().put("configured",false);
        }
        if(command.equals("health.snapshot")){
            JSONObject proof=new JSONObject(prefs().getString(BackupManager.KEY_RESTORE_TEST,"{}")),verification=new JSONObject(prefs().getString(BackupManager.KEY_VERIFICATION,"{}"));
            JSONObject pending=new BusinessSqlite(store.getReadableDatabase()).call("sql.query",new JSONObject().put("sql","SELECT COUNT(*) n,MIN(created_at) oldest FROM native_event_outbox WHERE generation=?").put("params",new JSONArray().put(engineGeneration))).getJSONArray("results").getJSONObject(0);
            JSONObject raw=new JSONObject().put("at",iso()).put("serverLastSeenAt",prefs().getString("native_primary_last_seen","")).put("ordexaLastSuccessAt",OrdexaSync.status(context).optString("lastSuccess")).put("storesLastSuccessAt",StoreBillingSync.status(store).optString("lastSuccess")).put("freeBytes",new StatFs(context.getFilesDir().getPath()).getAvailableBytes()).put("outboxPending",pending.getLong("n")).put("outboxOldestAt",pending.opt("oldest")).put("versions",new JSONObject().put("server",ServerConfig.SERVER_VERSION).put("business","5.61.0"));
            if(proof.optBoolean("restoreVerified"))raw.put("backupLastVerifiedRestoreAt",proof.optString("checkedAt"));
            if(verification.optBoolean("readable")&&verification.optBoolean("complete"))raw.put("backupFileVerifiedAt",verification.optString("checkedAt"));
            return raw;
        }
        if(command.equals("reports.export")){
            String format=value.getString("format");if(!format.equals("pdf")&&!format.equals("xlsx"))throw new IOException("Μη έγκυρη μορφή αναφοράς.");File file=objects.exportTarget(format);boolean saved=false;
            try{if(format.equals("xlsx"))FinancialExport.writeXlsx(file,value.getJSONObject("spec"));else try(InputStream font=context.getAssets().open("com/tom_roush/pdfbox/resources/ttf/LiberationSans-Regular.ttf")){FinancialExport.writePdf(file,value.getJSONObject("spec"),font);}JSONObject result=objects.registerExport(file,value.optString("name","Fleet-report")+"."+format,format.equals("pdf")?"application/pdf":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");saved=true;return result;}finally{if(!saved)file.delete();}
        }
        if(command.equals("http.read"))return NativePublicRead.fetch(value,objects);
        return null;
    }
    private JSONObject call(JSONObject request,JSONObject identity,String capturedEpoch,boolean internal)throws Exception{
        engine(identity);guard.begin(capturedEpoch,false);return engine.request(request,internal,internal?30000:20000);
    }
    /** Called only by the migration controller before frozen promotion. */
    public JSONObject initializeCandidate(final JSONObject identity)throws Exception{return execute(new Callable<JSONObject>(){public JSONObject call()throws Exception{engine(identity);guard.begin("",true);JSONObject request=new JSONObject().put("url",identity.getString("realm")+"/api/status").put("method","GET").put("headers",new JSONObject().put("X-Fleet-Server-Key",ServerConfig.SERVER_KEY));JSONObject response=engine.request(request,true,30000);if(response.getInt("status")!=200)throw new IOException("Δεν προετοιμάστηκε το τοπικό σχήμα.");return new JSONObject(asset("manifest.json"));}});}
    public void start(){started=true;tick();}
    public void pause(){started=false;disconnect(socket,epoch);}
    public boolean available(){return started&&lease.valid(epoch,generation);}
    public JSONObject status()throws Exception{JSONObject state=NativePrimaryState.read(store.getReadableDatabase());return new JSONObject().put("phase",state.optString("phase","cloud")).put("generation",state.optString("generation")).put("connected",available()).put("leaseRemainingMs",lease.remaining(epoch,generation)).put("error",prefs().getString("native_primary_error",""));}
    private synchronized void tick(){
        if(!started)return;
        try{
            JSONObject state=NativePrimaryState.read(store.getReadableDatabase());if(!state.optString("phase").equals("active")){disconnect(socket,epoch);return;}
            final JSONObject identity=NativeIdentity.read(context);if(!state.optString("generation").equals(identity.optString("generation"))||!state.optString("realm").equals(identity.optString("realm")))throw new IOException("Η ταυτότητα κύριου Server χρειάζεται έλεγχο.");
            if(socket==null){if(!connecting){connecting=true;new Thread(new Runnable(){public void run(){connect(identity);}},"fleet-primary-reader").start();}return;}
            final DirectWebSocket current=socket;final String captured=epoch;current.send(new JSONObject().put("type","lease").put("nonce",lease.renewal(captured)).toString());
            business.execute(new Runnable(){public void run(){businessThread=Thread.currentThread();try{if(!lease.valid(captured,generation)||socket!=current)return;engine(identity);JSONArray pending=engine.pendingSignals();for(int i=0;i<pending.length();i++){JSONObject item=pending.getJSONObject(i);current.send(new JSONObject().put("type","changes").put("id",item.getString("id")).put("scopes",new JSONArray(item.getString("scopes"))).toString());}engine.collectFiles();}catch(Exception ignored){}finally{Thread.interrupted();}}});
        }catch(Exception error){error(error);disconnect(socket,epoch);}
    }
    private void connect(final JSONObject identity){
        DirectWebSocket connection=new DirectWebSocket();String captured="";
        try{
            JSONObject challenge=FleetHttp.sendJson(identity.getString("realm")+"/api/primary/challenge","POST",new JSONObject().put("generation",identity.getString("generation")),SyncService.serverHeaders());
            captured=lease.connecting(identity.getString("generation"));
            connection.connectPrimary(identity.getString("realm"),ServerConfig.SERVER_KEY,PrimaryCipher.connectionProof(identity,challenge).toString());
            synchronized(this){if(!started){connection.close();lease.close(captured);return;}socket=connection;epoch=captured;generation=identity.getString("generation");connectedIdentity=identity;}
            while(started){JSONObject message=new JSONObject(connection.read());String type=message.optString("type");
                if(type.equals("ready")||type.equals("lease")){
                    boolean valid=type.equals("ready")?lease.ready(captured,message.optString("generation"),message.optLong("leaseMs")):lease.acknowledge(captured,message.optString("generation"),message.optString("nonce"),message.optLong("leaseMs"));
                    if(!valid)throw new IOException("Έληξε η επιβεβαίωση κύριου Server.");prefs().edit().putString("native_primary_last_seen",iso()).putLong("last_connection_success_ms",System.currentTimeMillis()).putBoolean("server_online",true).putString("native_primary_error","").apply();
                }else if(type.equals("request"))enqueue(connection,captured,identity,message);
                else if(type.equals("changes-ack")){final String id=message.optString("id"),ackEpoch=captured;try{business.execute(new Runnable(){public void run(){businessThread=Thread.currentThread();try{if(lease.valid(ackEpoch,generation)&&engine!=null)engine.acknowledgeSignal(id);}catch(Exception ignored){}}});}catch(RejectedExecutionException ignored){}}
            }
        }catch(Exception error){if(started)error(error);}finally{disconnect(connection,captured);synchronized(this){connecting=false;}}
    }
    private void enqueue(final DirectWebSocket connection,final String captured,final JSONObject identity,final JSONObject message)throws Exception{
        if(!message.optString("generation").equals(identity.getString("generation")))throw new IOException("Η γενιά Server άλλαξε.");final long received=SystemClock.elapsedRealtime();
        try{business.execute(new Runnable(){public void run(){businessThread=Thread.currentThread();try{
            if(SystemClock.elapsedRealtime()-received>23000||socket!=connection||!lease.valid(captured,identity.getString("generation")))return;
            JSONObject packet=message.getJSONObject("request"),clear=PrimaryCipher.open(identity,packet,System.currentTimeMillis());
            JSONObject request=sanitize(clear,identity.getString("realm"));JSONObject headers=request.getJSONObject("headers");String peer=message.optString("peerHash");if(!peer.matches("[a-f0-9]{64}"))throw new IOException("Invalid gateway peer");headers.put("CF-Connecting-IP","primary:"+peer);
            JSONObject response=call(request,identity,captured,false);if(socket==connection&&lease.valid(captured,identity.getString("generation")))connection.send(new JSONObject().put("type","response").put("id",message.getString("id")).put("response",PrimaryCipher.seal(identity,packet,response)).toString());
        }catch(Exception error){error(error);}finally{Thread.interrupted();}}});}catch(RejectedExecutionException busy){/* Relay timeout preserves an unknown operation; caller retries its same operation ID. */}
    }
    private static JSONObject sanitize(JSONObject clear,String realm)throws Exception{
        String method=clear.getString("method").toUpperCase(Locale.US);if(!Arrays.asList("GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS").contains(method))throw new IOException("Invalid method");
        URL url=new URL(clear.getString("url"));if(!origin(url).equals(realm)||!url.getPath().startsWith("/api/"))throw new IOException("Invalid primary request realm");
        JSONObject headers=new JSONObject(),supplied=clear.optJSONObject("headers");if(supplied!=null){Iterator<String> names=supplied.keys();while(names.hasNext()){String name=names.next();if(Arrays.asList("authorization","cookie","content-type","x-fleet-operation","x-fleet-pin-session","x-admin-pin","x-fleet-pin","x-fleet-client-key","x-fleet-local-ocr").contains(name.toLowerCase(Locale.US)))headers.put(name,supplied.getString(name));}}
        JSONObject request=new JSONObject().put("url",clear.getString("url")).put("method",method).put("headers",headers);
        for(String field:new String[]{"body","bodyFile","form"})if(clear.has(field))request.put(field,clear.get(field));return request;
    }
    private static JSONObject checked(JSONObject response)throws Exception{int status=response.getInt("status");String text=response.optString("body");JSONObject result;try{result=text.isEmpty()?new JSONObject():new JSONObject(text);}catch(Exception invalid){throw new IOException("Μη έγκυρη απάντηση τοπικής υπηρεσίας.");}if(status<200||status>=300)throw new FleetHttp.HttpStatusException(status,result.optString("error","Η τοπική ενέργεια δεν ολοκληρώθηκε."));return result;}
    @Override public JSONObject request(final String url,final String method,final JSONObject body,final Map<String,String> headers,InputStream input,long length,String type,final JSONObject form,final String field)throws Exception{
        if(!local(url))return null;final JSONObject identity=NativeIdentity.read(context);final String captured=epoch;final File uploaded;
        if(input!=null){uploaded=File.createTempFile("native-upload-",".bin",context.getCacheDir());try{try(InputStream source=input;FileOutputStream output=new FileOutputStream(uploaded)){byte[] buffer=new byte[65536];long total=0;int n;while((n=source.read(buffer))!=-1){total+=n;if(total>BusinessObjects.MAX_FILE||length>=0&&total>length)throw new IOException("Το αρχείο είναι πολύ μεγάλο ή άλλαξε.");output.write(buffer,0,n);}if(length>=0&&total!=length)throw new IOException("Η μεταφορά αρχείου διακόπηκε.");output.getFD().sync();}}catch(Exception error){uploaded.delete();throw error;}}else uploaded=null;
        final String contentType=type;
        try{return execute(new Callable<JSONObject>(){public JSONObject call()throws Exception{
            JSONObject request=new JSONObject().put("url",url).put("method",method).put("headers",headers==null?new JSONObject():new JSONObject(headers));if(body!=null)request.put("body",body.toString());if(form!=null)request.put("form",form);
            engine(identity);guard.begin(captured,false);JSONObject response=uploaded==null?engine.request(request,true,30000):engine.requestWithFile(request,uploaded,field,"invoice.pdf",contentType);return checked(response);
        }});}finally{if(uploaded!=null)uploaded.delete();}
    }
    @Override public boolean download(final String url,final File target,final Map<String,String> headers)throws Exception{
        if(!local(url))return false;final JSONObject identity=NativeIdentity.read(context);final String captured=epoch;
        execute(new Callable<Void>(){public Void call()throws Exception{
            JSONObject request=new JSONObject().put("url",url).put("method","GET").put("headers",headers==null?new JSONObject():new JSONObject(headers));JSONObject response=NativePrimaryService.this.call(request,identity,captured,true);if(response.getInt("status")!=200||!response.has("file"))throw new IOException("Δεν διαβάστηκε το τοπικό αρχείο.");guard.beforeRequest(request,true);engine.copyInternalFile(response.getJSONObject("file").getString("ref"),target);return null;
        }});return true;
    }
    private synchronized void disconnect(DirectWebSocket connection,String captured){lease.close(captured);if(connection!=null)connection.close();if(socket==connection){socket=null;connectedIdentity=null;}}
    private void error(Exception error){prefs().edit().putString("native_primary_error","Η ασφαλής τοπική υπηρεσία χρειάζεται επανάληψη σύνδεσης.").apply();}
    private static String iso(){return new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX",Locale.US).format(new Date());}
}
