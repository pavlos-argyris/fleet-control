package gr.argyrismitsos.fleetserver;
import android.content.*;import android.database.sqlite.SQLiteDatabase;import org.json.*;import java.io.*;import java.net.*;import java.util.*;import java.util.concurrent.*;

/** One serialized local writer. No lease/coordinator/transport from the production service. */
public final class IndependentRuntime implements FleetHttp.LocalTransport,AutoCloseable {
    private static IndependentRuntime instance;
    static synchronized IndependentRuntime get(Context c)throws Exception{IndependentConfig.require(c);IndependentSqlite.requireReady();if(instance==null)instance=new IndependentRuntime(c.getApplicationContext());return instance;}
    private final Context context;private FleetDataStore store;private SQLiteDatabase db;private NativeBusinessEngine engine;private final JSONObject config;
    private final ThreadPoolExecutor executor=new ThreadPoolExecutor(1,1,0,TimeUnit.MILLISECONDS,new ArrayBlockingQueue<Runnable>(32));
    private final RandomAccessFile lockFile;private java.nio.channels.FileLock processLock;
    private long housekeepingAt;private volatile Thread writer;private volatile boolean closed;private long revision=0;private final Object changes=new Object();
    static String asset(Context c,String name)throws Exception{try(InputStream input=c.getAssets().open(name);ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] bytes=new byte[65536];int n;while((n=input.read(bytes))!=-1){if(out.size()+n>8*1024*1024)throw new IOException("Oversized bundled asset");out.write(bytes,0,n);}return new String(out.toByteArray(),"UTF-8");}}
    private IndependentRuntime(final Context c)throws Exception{
        context=c;config=IndependentConfig.read(c);if(!config.has("backupSha256")||!config.getJSONObject("restoreProof").optBoolean("restoreVerified"))throw new IOException("Εισήγαγε πρώτα πλήρες επαληθευμένο backup.");
        lockFile=new RandomAccessFile(new File(c.getFilesDir(),"independent-writer.lock"),"rw");try{processLock=lockFile.getChannel().tryLock();if(processLock==null)throw new IOException("Η ανεξάρτητη βάση έχει ήδη ενεργό Server.");
        store=new FleetDataStore(c);db=store.getWritableDatabase();NativeDatabaseSnapshot.requireCapabilities(db);
        IndependentDatabase.configure(db);
        JSONObject state=NativePrimaryState.read(db);if(state.optString("phase").equals("needs_recovery")){NativePrimaryState.phase(db,"active",IndependentConfig.realm(config),config.getString("generation"),config.getString("ownerId"),config.getString("backupSha256"));db.execSQL("DELETE FROM independent_readiness");db.execSQL("INSERT OR REPLACE INTO independent_instance(id,instance_id,mode) VALUES(1,?,'test')",new Object[]{config.getString("instanceId")});}
        state=NativePrimaryState.read(db);if(!IndependentConfig.realm(config).equals(state.optString("realm"))){db.beginTransaction();try{db.execSQL("UPDATE native_primary_state SET realm=? WHERE id=1 AND generation=?",new Object[]{IndependentConfig.realm(config),config.getString("generation")});db.execSQL("UPDATE auth_sessions SET revoked_at=? WHERE revoked_at IS NULL",new Object[]{System.currentTimeMillis()/1000});db.execSQL("DELETE FROM independent_readiness");db.setTransactionSuccessful();}finally{db.endTransaction();}}
        final JSONObject runtimeConfig=new JSONObject(config.toString()).put("realm",IndependentConfig.realm(config)).put("standalone",true);
        engine=new NativeBusinessEngine(db,new File(c.getFilesDir(),"service-documents"),new File(c.getCacheDir(),"independent-transfers"),runtimeConfig,asset(c,"business-runtime/runtime.js"),new JSONObject(asset(c,"business-runtime/manifest.json")).getString("bundleSha256"),new NativeBusinessEngine.Authority(){
            private void check()throws Exception{JSONObject saved=IndependentConfig.read(c),state=NativePrimaryState.read(db);if(closed||!saved.optString("instanceId").equals(config.getString("instanceId"))||!saved.optString("hostname").equals(config.optString("hostname"))||!state.optString("generation").equals(config.getString("generation"))||!state.optString("realm").equals(IndependentConfig.realm(config))||!Arrays.asList("test","primary").contains(saved.optString("mode")))throw new IOException("Η ανεξάρτητη βάση ή η διεύθυνση άλλαξε. Η αποθήκευση δεν επιβεβαιώθηκε.");}
            public void beforeRequest(JSONObject request,boolean internal)throws Exception{check();if(!new URI(request.getString("url")).getRawAuthority().equals(new URI(IndependentConfig.realm(config)).getRawAuthority()))throw new IOException("Η παλιά cloud βάση δεν χρησιμοποιείται.");}
            public void beforeCommit(JSONObject response,boolean internal)throws Exception{check();}
        },new NativeBusinessEngine.Ports(){public JSONObject call(String command,JSONObject value,BusinessObjects objects)throws Exception{return port(command,value,objects);}});
        // Initialize the same schema/business handlers against the imported local database.
        internal("/api/status","GET",null);context.getSharedPreferences("independent_ui",Context.MODE_PRIVATE).edit().putString("mode",query("SELECT mode FROM independent_instance WHERE id=1").getJSONObject(0).getString("mode")).apply();FleetHttp.installLocalTransport(this);
        CashSync.installAuthority(new CashSync.Authority(){public boolean ready(){return !closed;}public JSONObject apply()throws Exception{return internal("/api/server/cash/apply","POST",new JSONObject());}});
        NativeDatabaseSnapshot.setCoordinator(new NativeDatabaseSnapshot.Coordinator(){public NativeDatabaseSnapshot.Capture capture(final NativeDatabaseSnapshot.CaptureTask task)throws Exception{return serialized(new Callable<NativeDatabaseSnapshot.Capture>(){public NativeDatabaseSnapshot.Capture call()throws Exception{return task.capture();}});}});
        c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE).edit().putString("worker_url",IndependentConfig.realm(config)).putString("independent_source_realm",config.optString("sourceScopeRealm",IndependentConfig.realm(config))).commit();
        }catch(Exception failure){closed=true;executor.shutdownNow();try{if(engine!=null)engine.close();}finally{try{if(store!=null)store.close();}finally{try{if(processLock!=null&&processLock.isValid())processLock.release();}finally{lockFile.close();}}}throw failure;}
    }
    <T>T serialized(final Callable<T> call)throws Exception{
        if(Thread.currentThread()==writer)return call.call();Future<T> future;
        try{future=executor.submit(new Callable<T>(){public T call()throws Exception{writer=Thread.currentThread();try{return call.call();}finally{Thread.interrupted();}}});}catch(RejectedExecutionException busy){throw new IOException("Ο Server εξυπηρετεί άλλες εργασίες. Δοκίμασε ξανά.");}
        try{return future.get(60,TimeUnit.SECONDS);}catch(ExecutionException error){Throwable cause=error.getCause();if(cause instanceof Exception)throw(Exception)cause;throw new IOException("Η τοπική εργασία απέτυχε.");}catch(TimeoutException error){future.cancel(true);throw new IOException("Δεν επιβεβαιώθηκε η εργασία. Έλεγξε πριν επαναλάβεις.");}
    }
    private JSONObject port(String command,JSONObject value,BusinessObjects objects)throws Exception{
        if(command.equals("store.context")){
            JSONObject source=OrdexaSync.storesContext(context);new StoreBillingStore(store);
            if(source.optBoolean("configured"))return source.put("cashOrdersProtocol",new StoreBillingStore(store).orderProtocolEvidence(source.getString("scope")));
            JSONArray rows=query("SELECT DISTINCT scope FROM store_billing_local WHERE kind='store' AND scope<>'' LIMIT 2");return rows.length()==1?new JSONObject().put("configured",true).put("scope",rows.getJSONObject(0).getString("scope")).put("historicalOnly",true):new JSONObject().put("configured",false);
        }
        if(command.equals("health.snapshot"))return new JSONObject().put("at",iso()).put("serverLastSeenAt",iso()).put("ordexaLastSuccessAt",OrdexaSync.status(context).optString("lastSuccess")).put("storesLastSuccessAt",StoreBillingSync.status(store).optString("lastSuccess")).put("freeBytes",context.getFilesDir().getUsableSpace()).put("outboxPending",0).put("versions",new JSONObject().put("server","independent-1")).put("backupLastVerifiedRestoreAt",iso(config.getLong("restoredAt")));
        if(command.equals("reports.export")){
            String format=value.getString("format");if(!Arrays.asList("pdf","xlsx").contains(format))throw new IOException("Invalid export format");File file=objects.exportTarget(format);boolean saved=false;
            try{if(format.equals("xlsx"))FinancialExport.writeXlsx(file,value.getJSONObject("spec"));else try(InputStream font=context.getAssets().open("com/tom_roush/pdfbox/resources/ttf/LiberationSans-Regular.ttf")){FinancialExport.writePdf(file,value.getJSONObject("spec"),font);}JSONObject result=objects.registerExport(file,"Fleet-report."+format,format.equals("pdf")?"application/pdf":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");saved=true;return result;}finally{if(!saved)file.delete();}
        }
        if(command.equals("http.read")){String host=new URI(value.getString("url")).getHost();if(host!=null&&(host.endsWith(".workers.dev")||host.endsWith(".cloudflare.com")))throw new IOException("Δεν χρησιμοποιούνται Cloudflare endpoints στην ανεξάρτητη εγκατάσταση.");return NativePublicRead.fetch(value,objects);}
        if(command.equals("independent.status"))return status();
        if(command.equals("independent.probe"))return merge(status(),IndependentReadiness.probe(db,value,System.currentTimeMillis()));
        if(command.equals("independent.activate"))return merge(status(),IndependentReadiness.activate(db,value,config.getString("instanceId"),IndependentTls.valid(context,config.optString("hostname")),System.currentTimeMillis()));
        throw new IOException("Unsupported independent native capability");
    }
    private static JSONObject merge(JSONObject base,JSONObject extra)throws Exception{Iterator<String> keys=extra.keys();while(keys.hasNext()){String key=keys.next();base.put(key,extra.get(key));}return base;}
    private JSONArray query(String sql)throws Exception{return new BusinessSqlite(db).call("sql.query",new JSONObject().put("sql",sql)).getJSONArray("results");}
    JSONObject status()throws Exception{JSONObject saved=IndependentConfig.read(context);return new JSONObject().put("instanceId",config.getString("instanceId")).put("mode",query("SELECT mode FROM independent_instance WHERE id=1").getJSONObject(0).getString("mode")).put("endpoint",IndependentConfig.realm(config)).put("serverOnline",!closed).put("backupVerified",true).put("restoredAt",config.getLong("restoredAt")).put("lastBackupAt",saved.optLong("lastBackupAt")).put("ordexaLastSuccessAt",OrdexaSync.status(context).optString("lastSuccess")).put("testOrdexa",saved.optBoolean("testOrdexa")).put("sourceIntervalMs",300000).put("externalTestRequired",true);}
    private JSONObject dispatch(JSONObject request,boolean internal)throws Exception{
        JSONObject result=engine.request(request,internal,30000);
        if(result.optInt("status")==200&&new URI(request.getString("url")).getPath().equals("/api/independent/activate"))context.getSharedPreferences("independent_ui",Context.MODE_PRIVATE).edit().putString("mode",new JSONObject(result.getString("body")).optString("mode","test")).apply();
        // Signals leave the writer only after the native request transaction committed.
        JSONArray pending=engine.pendingSignals();if(pending.length()>0){for(int i=0;i<pending.length();i++)engine.acknowledgeSignal(pending.getJSONObject(i).getString("id"));synchronized(changes){revision++;changes.notifyAll();}}
        return result;
    }
    JSONObject external(final JSONObject request)throws Exception{return serialized(new Callable<JSONObject>(){public JSONObject call()throws Exception{return materialize(request,dispatch(request,false));}});}
    JSONObject localLogin(String username,String password)throws Exception{return external(new JSONObject().put("url",IndependentConfig.realm(config)+"/api/auth/user-login").put("method","POST").put("headers",new JSONObject().put("Content-Type","application/json")).put("body",new JSONObject().put("username",username).put("password",password).put("deviceName","Independent owner console").toString()));}
    JSONObject localProbe(String token)throws Exception{return external(new JSONObject().put("url",IndependentConfig.realm(config)+"/api/independent/probe").put("method","POST").put("headers",new JSONObject().put("Authorization","Bearer "+token).put("X-Fleet-Operation",UUID.randomUUID().toString())).put("body","{}"));}
    private JSONObject materialize(JSONObject request,JSONObject response)throws Exception{
        JSONObject file=response.optJSONObject("file");if(file==null)file=response.optJSONObject("bodyFile");if(file==null)return response;
        File target=File.createTempFile("independent-response-",".bin",context.getCacheDir());boolean ok=false;
        try(FileOutputStream output=new FileOutputStream(target)){
            long size=file.getLong("size");if(size>BusinessObjects.MAX_FILE)throw new IOException("Oversized response");java.security.MessageDigest hash=java.security.MessageDigest.getInstance("SHA-256");
            for(long offset=0;offset<size;){JSONObject chunkRequest=new JSONObject().put("url",IndependentConfig.realm(config)+"/api/native/files/"+file.getString("ref")+"?offset="+offset).put("method","GET").put("headers",request.getJSONObject("headers"));JSONObject chunkResponse=dispatch(chunkRequest,false);if(chunkResponse.getInt("status")!=200)throw new IOException("Η πρόσβαση στο ιδιωτικό αρχείο άλλαξε.");JSONObject chunk=new JSONObject(chunkResponse.getString("body"));byte[] bytes=java.util.Base64.getDecoder().decode(chunk.getString("data"));if(bytes.length==0||offset+bytes.length>size)throw new IOException("Invalid private chunk");output.write(bytes);hash.update(bytes);offset+=bytes.length;}
            if(!BusinessPrimitives.hex(hash.digest()).equals(file.getString("sha256")))throw new IOException("Private response digest mismatch");output.getFD().sync();response.put("localFile",target.getPath());ok=true;return response;
        }finally{if(!ok)target.delete();}
    }
    JSONObject internal(final String path,final String method,final JSONObject body)throws Exception{return serialized(new Callable<JSONObject>(){public JSONObject call()throws Exception{JSONObject request=new JSONObject().put("url",IndependentConfig.realm(config)+path).put("method",method).put("headers",new JSONObject().put("X-Fleet-Server-Key",config.getString("serverKey")));if(body!=null)request.put("body",body.toString());return checked(dispatch(request,true));}});}
    private static JSONObject checked(JSONObject response)throws Exception{int status=response.getInt("status");JSONObject value;try{value=new JSONObject(response.optString("body","{}"));}catch(Exception e){throw new IOException("Η τοπική απάντηση δεν είναι έγκυρη.");}if(status<200||status>=300)throw new FleetHttp.HttpStatusException(status,value.optString("error","Η τοπική ενέργεια απέτυχε."));return value;}
    @Override public JSONObject request(final String address,final String method,final JSONObject body,final Map<String,String> headers,InputStream input,long length,String type,JSONObject form,String field)throws Exception{
        URI uri=new URI(address);if(!address.startsWith(IndependentConfig.realm(config)+"/api/")||!uri.getScheme().equals("https"))throw new IOException("Αποκλείστηκε εξωτερική/Cloudflare κλήση από τον ανεξάρτητο Server.");
        final File uploaded;
        if(input!=null){uploaded=File.createTempFile("independent-internal-upload-",".bin",context.getCacheDir());try(InputStream source=input;FileOutputStream output=new FileOutputStream(uploaded)){byte[] buffer=new byte[65536];long count=0;int n;while((n=source.read(buffer))!=-1){count+=n;if(count>BusinessObjects.MAX_FILE||length>=0&&count>length)throw new IOException("Oversized local file");output.write(buffer,0,n);}if(length>=0&&count!=length)throw new IOException("Incomplete local file");output.getFD().sync();}catch(Exception error){uploaded.delete();throw error;}}else uploaded=null;
        final JSONObject formValue=form;final String fileField=field,contentType=type;
        try{return serialized(new Callable<JSONObject>(){public JSONObject call()throws Exception{JSONObject request=new JSONObject().put("url",address).put("method",method).put("headers",headers==null?new JSONObject():new JSONObject(headers));request.getJSONObject("headers").put("X-Fleet-Server-Key",config.getString("serverKey"));if(body!=null)request.put("body",body.toString());if(formValue!=null)request.put("form",formValue);return checked(uploaded==null?dispatch(request,true):engine.requestWithFile(request,uploaded,fileField,"invoice.pdf",contentType));}});}finally{if(uploaded!=null)uploaded.delete();}
    }
    @Override public boolean download(final String address,final File target,final Map<String,String> headers)throws Exception{
        if(!address.startsWith(IndependentConfig.realm(config)+"/api/"))throw new IOException("Αποκλείστηκε cloud download στην ανεξάρτητη εγκατάσταση.");
        serialized(new Callable<Void>(){public Void call()throws Exception{JSONObject request=new JSONObject().put("url",address).put("method","GET").put("headers",new JSONObject().put("X-Fleet-Server-Key",config.getString("serverKey")));JSONObject response=dispatch(request,true);if(response.getInt("status")!=200||!response.has("file"))throw new IOException("Δεν βρέθηκε το τοπικό αρχείο.");engine.copyInternalFile(response.getJSONObject("file").getString("ref"),target);return null;}});return true;
    }
    long revision(){synchronized(changes){return revision;}}
    long await(long after)throws InterruptedException{synchronized(changes){if(revision==after)changes.wait(15000);return revision;}}
    String realm(){return IndependentConfig.realm(config);}
    void jobs()throws Exception{long now=System.currentTimeMillis();if(now-housekeepingAt>=60000){internal("/api/server/heartbeat","POST",new JSONObject().put("serverVersion",ServerConfig.SERVER_VERSION).put("health",DeviceHealth.collect(context)));internal("/api/independent/maintenance","POST",new JSONObject());housekeepingAt=now;}if(!IndependentConfig.read(context).optBoolean("testOrdexa"))return;OrdexaSync.tick(context);StoreBillingSync.tick(context,store);OrdexaPayrollSync.tick(context,store);CashSync.tick(context,store);}
    static String iso(){return iso(System.currentTimeMillis());}static String iso(long time){java.text.SimpleDateFormat f=new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX",Locale.US);return f.format(new Date(time));}
    @Override public synchronized void close()throws Exception{closed=true;executor.shutdownNow();engine.close();store.close();processLock.release();lockFile.close();synchronized(IndependentRuntime.class){if(instance==this)instance=null;}}
}
