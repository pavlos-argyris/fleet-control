package gr.argyrismitsos.fleetserver;

import android.database.sqlite.SQLiteDatabase;
import org.json.*;
import java.io.*;
import java.util.*;

/** The production Host. Every API, job, receipt, audit and event shares one transaction. */
public final class NativeBusinessEngine implements Closeable, BusinessRuntime.Host {
    public interface Authority {
        void beforeRequest(JSONObject request,boolean internal)throws Exception;
        void beforeCommit(JSONObject response,boolean internal)throws Exception;
    }
    /** Explicit Android integrations; unknown capabilities are never passed to Java reflection. */
    public interface Ports { JSONObject call(String command,JSONObject value,BusinessObjects objects)throws Exception; }
    private static final String OUTBOX="CREATE TABLE IF NOT EXISTS native_event_outbox(id TEXT PRIMARY KEY,generation TEXT NOT NULL,scopes TEXT NOT NULL,created_at TEXT NOT NULL);";
    private static final Set<String> SCOPES=new HashSet<String>(Arrays.asList("fleet","workforce","schedule","payroll","stores","cash","status","invoices"));
    private final BusinessRuntime runtime;
    private final BusinessSqlite sql;
    private final BusinessObjects objects;
    private final Authority authority;
    private final Ports ports;
    private final String generation,pepper;
    private final SQLiteDatabase db;
    public NativeBusinessEngine(SQLiteDatabase db,File documents,File temporary,JSONObject config,String bundledCode,String bundledHash,Authority authority,Ports ports)throws Exception{
        this.db=db;this.sql=new BusinessSqlite(db);this.authority=authority;this.ports=ports;
        this.generation=config.getString("generation");this.pepper=config.getString("authPepper");
        this.objects=new BusinessObjects(db,documents,temporary);db.execSQL(OUTBOX);
        runtime=new BusinessRuntime(this,bundledCode,bundledHash,config);
    }
    public synchronized JSONObject request(JSONObject request,boolean internal,long budget)throws Exception{return runtime.request(request,internal,budget);}
    public synchronized JSONObject sandboxStatus()throws Exception{return runtime.sandboxStatus();}
    public synchronized JSONObject requestWithFile(JSONObject request,File input,String field,String name,String type)throws Exception{
        authority.beforeRequest(request,true);
        objects.context("server",generation,request.getString("url"));objects.security(BusinessRuntime.sha256("native-internal".getBytes("UTF-8")));
        JSONObject file;
        try{file=objects.importFile(input,name,type);}finally{objects.context("","","");}
        JSONObject value=new JSONObject(request.toString());
        if(field==null)value.put("bodyFile",file.getString("ref"));
        else{JSONObject form=value.optJSONObject("form");if(form==null)form=new JSONObject();value.put("form",form.put(field,file));}
        return runtime.request(value,true,30000);
    }
    @Override public void beforeRequest(JSONObject request,boolean internal)throws Exception{
        authority.beforeRequest(request,internal);
        objects.context(BusinessActor.resolve(sql,request,pepper,internal),generation,request.optString("url"));
    }
    @Override public void beforeCommit(JSONObject response,boolean internal)throws Exception{authority.beforeCommit(response,internal);}
    @Override public void afterRequest(){objects.context("","","");}
    @Override public String call(String command,String raw)throws Exception{
        JSONObject data=new JSONObject(raw),value;
        if(command.startsWith("sql."))value=sql.call(command,data);
        else{
            value=BusinessPrimitives.call(command,data);if(value==null)value=objects.call(command,data);
            if(value==null&&command.equals("events.queue")){
                JSONObject event=new JSONObject(data.getString("body"));JSONArray supplied=event.optJSONArray("scopes"),accepted=new JSONArray();
                if(supplied==null||supplied.length()>16)throw new IOException("Invalid change signal");
                Set<String> unique=new HashSet<String>();for(int i=0;i<supplied.length();i++){String scope=supplied.getString(i);if(SCOPES.contains(scope)&&unique.add(scope))accepted.put(scope);}
                if(accepted.length()>0)db.execSQL("INSERT INTO native_event_outbox(id,generation,scopes,created_at) VALUES(?,?,?,?)",new Object[]{UUID.randomUUID().toString(),generation,accepted.toString(),new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX",Locale.US).format(new Date())});
                value=new JSONObject();
            }
            if(value==null&&Arrays.asList("store.context","health.snapshot","reports.export","http.read","independent.status","independent.probe","independent.activate").contains(command))value=ports.call(command,data,objects);
        }
        if(value==null)throw new IOException("Unsupported native capability");return value.toString();
    }
    public synchronized JSONArray pendingSignals()throws Exception{return sql.call("sql.query",new JSONObject().put("sql","SELECT id,scopes FROM native_event_outbox WHERE generation=? ORDER BY created_at,id LIMIT 8").put("params",new JSONArray().put(generation))).getJSONArray("results");}
    public synchronized void acknowledgeSignal(String id)throws Exception{if(!id.matches("[a-f0-9-]{36}"))return;db.execSQL("DELETE FROM native_event_outbox WHERE id=? AND generation=?",new Object[]{id,generation});}
    public synchronized void collectFiles()throws Exception{objects.collectDeletedObjects();objects.collectExpiredTransfers();}
    public synchronized void copyInternalFile(String reference,File target)throws Exception{
        objects.context("server",generation,"");objects.security(BusinessRuntime.sha256("native-internal".getBytes("UTF-8")));
        File parent=target.getParentFile();if(parent!=null&&!parent.exists()&&!parent.mkdirs())throw new IOException("Δεν δημιουργήθηκε ο φάκελος αρχείου.");File part=new File(target.getPath()+".part");
        try{JSONObject info=objects.call("file.stat",new JSONObject().put("ref",reference));long size=info.getLong("size");if(size>BusinessObjects.MAX_FILE)throw new IOException("Το τιμολόγιο είναι πολύ μεγάλο.");java.security.MessageDigest digest=java.security.MessageDigest.getInstance("SHA-256");
            try(FileOutputStream output=new FileOutputStream(part)){for(long at=0;at<size;at+=262144){byte[] bytes=BusinessPrimitives.unhex(objects.call("file.read",new JSONObject().put("ref",reference).put("start",at).put("length",Math.min(262144,size-at))).getString("hex"));output.write(bytes);digest.update(bytes);}output.getFD().sync();}
            if(!BusinessPrimitives.hex(digest.digest()).equals(info.getString("sha256")))throw new IOException("Το αρχείο δεν συμφωνεί με το αποθηκευμένο αποτύπωμα.");if(!part.renameTo(target))throw new IOException("Δεν ολοκληρώθηκε η αποθήκευση αρχείου.");
        }finally{part.delete();objects.context("","","");}
    }
    @Override public synchronized void close(){runtime.close();}
}
