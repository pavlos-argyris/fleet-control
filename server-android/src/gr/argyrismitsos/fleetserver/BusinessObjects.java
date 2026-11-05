package gr.argyrismitsos.fleetserver;

import android.database.sqlite.SQLiteDatabase;
import org.json.*;
import java.io.*;
import java.security.*;
import java.util.*;

/** Private immutable object versions and bounded, actor-bound transfer handles. */
public final class BusinessObjects {
    public static final long MAX_FILE=15L*1024*1024;
    public static final String SCHEMA=
        "CREATE TABLE IF NOT EXISTS native_objects(key TEXT PRIMARY KEY,local_name TEXT NOT NULL,name TEXT NOT NULL,content_type TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,http_metadata TEXT NOT NULL,custom_metadata TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);\n"+
        "CREATE TABLE IF NOT EXISTS native_file_transfers(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,generation TEXT NOT NULL,kind TEXT NOT NULL,local_name TEXT NOT NULL,document_root INTEGER NOT NULL DEFAULT 0,name TEXT NOT NULL,content_type TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,received INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL,source_url TEXT NOT NULL DEFAULT '',permission TEXT NOT NULL DEFAULT '');\n"+
        "CREATE TABLE IF NOT EXISTS native_object_gc(local_name TEXT PRIMARY KEY,requested_at TEXT NOT NULL);\n"+
        "CREATE TABLE IF NOT EXISTS native_backup_pins(capture_id TEXT NOT NULL,local_name TEXT NOT NULL,PRIMARY KEY(capture_id,local_name));";
    private final SQLiteDatabase db;
    private final BusinessSqlite sql;
    private final File documents,temporary;
    private String actor="",generation="",sourceUrl="";
    public BusinessObjects(SQLiteDatabase db,File documents,File temporary)throws Exception{
        this.db=db;this.sql=new BusinessSqlite(db);this.documents=documents;this.temporary=temporary;
        if(!documents.exists()&&!documents.mkdirs()||!temporary.exists()&&!temporary.mkdirs())throw new IOException("Δεν δημιουργήθηκε ο ιδιωτικός χώρος αρχείων.");
        sql.call("sql.exec",new JSONObject().put("sql",SCHEMA));
    }
    public void context(String actor,String generation,String sourceUrl){this.actor=actor;this.generation=generation;this.sourceUrl=sourceUrl;}
    private JSONObject row(String statement,Object...args)throws Exception{JSONArray rows=sql.call("sql.query",new JSONObject().put("sql",statement).put("params",new JSONArray(Arrays.asList(args))).put("first",true)).getJSONArray("results");return rows.length()==0?null:rows.getJSONObject(0);}
    private static String clean(String text,int max){return text.replaceAll("[\\x00-\\x1f\\x7f]","").substring(0,Math.min(max,text.replaceAll("[\\x00-\\x1f\\x7f]","").length()));}
    private static String extension(String type){return "application/pdf".equals(type)?".pdf":"image/png".equals(type)?".png":"image/webp".equals(type)?".webp":"image/jpeg".equals(type)?".jpg":".bin";}
    public static boolean validLocalName(String name){return name!=null&&name.matches("[a-f0-9]{64}-[a-f0-9]{64}\\.(pdf|png|jpg|webp|bin)");}
    private File privateFile(boolean documentRoot,String name)throws Exception{
        if(!(documentRoot?validLocalName(name):name.matches("[a-f0-9-]{36}\\.(part|pdf|xlsx|bin)")))throw new IOException("Μη έγκυρη ιδιωτική αναφορά αρχείου.");
        File root=documentRoot?documents:temporary,file=new File(root,name);if(!file.getCanonicalFile().getParentFile().equals(root.getCanonicalFile()))throw new IOException("Μη έγκυρη θέση αρχείου.");return file;
    }
    private static String digest(File file)throws Exception{MessageDigest hash=MessageDigest.getInstance("SHA-256");try(InputStream input=new BufferedInputStream(new FileInputStream(file))){byte[] buffer=new byte[65536];int n;while((n=input.read(buffer))!=-1)hash.update(buffer,0,n);}return BusinessPrimitives.hex(hash.digest());}
    private JSONObject transfer(String reference)throws Exception{
        if(actor.isEmpty()||!reference.matches("[a-f0-9-]{36}(?::[0-9]+:[0-9]+)?"))throw new IOException("Χρειάζεται έγκυρη ιδιωτική αναφορά αρχείου.");
        String[] parts=reference.split(":");JSONObject value=row("SELECT * FROM native_file_transfers WHERE id=? AND actor_id=? AND generation=? AND expires_at>?",parts[0],actor,generation,System.currentTimeMillis());
        if(value==null)throw new IOException("Η ιδιωτική αναφορά αρχείου έληξε. Άνοιξε ξανά το αρχείο.");
        long start=0,length=value.getLong("size");if(parts.length==3){start=Long.parseLong(parts[1]);length=Long.parseLong(parts[2]);if(start<0||length<0||start>value.getLong("size")||length>value.getLong("size")-start)throw new IOException("Μη έγκυρο τμήμα αρχείου.");}
        return value.put("slice_start",start).put("slice_size",length).put("ref",reference);
    }
    private static JSONObject info(JSONObject value)throws Exception{return new JSONObject().put("ref",value.getString("ref")).put("size",value.getLong("slice_size")).put("name",value.getString("name")).put("type",value.getString("content_type")).put("sha256",value.getString("sha256")).put("complete",value.getInt("complete")==1).put("received",value.getLong("received")).put("sourceUrl",value.getString("source_url")).put("permission",value.getString("permission"));}
    private JSONObject register(File file,boolean documentRoot,String name,String type,String sha,String kind,String permission)throws Exception{
        String id=UUID.randomUUID().toString();if(actor.isEmpty())throw new IOException("Δεν επιβεβαιώθηκε ο χρήστης αρχείου.");
        db.execSQL("INSERT INTO native_file_transfers(id,actor_id,generation,kind,local_name,document_root,name,content_type,size,sha256,received,complete,expires_at,source_url,permission) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",new Object[]{id,actor,generation,kind,file.getName(),documentRoot?1:0,clean(name,240),type,file.length(),sha,file.length(),1,System.currentTimeMillis()+900000,sourceUrl,permission});
        return info(transfer(id));
    }
    public JSONObject importFile(File source,String name,String type)throws Exception{
        String id=UUID.randomUUID().toString();File target=privateFile(false,id+".bin");copy(source,target);return register(target,false,name,type,digest(target),"internal","");
    }
    public JSONObject registerExport(File file,String name,String type)throws Exception{
        String permission=sourceUrl.contains("/cash/")?"cash.view":sourceUrl.contains("/store-financials/")?"stores.view":"reports.view";
        return register(file,false,name,type,digest(file),"export",permission);
    }
    public File exportTarget(String format)throws Exception{return privateFile(false,UUID.randomUUID().toString()+"."+format);}
    public JSONObject storeObject(String key,File input,JSONObject metadata)throws Exception{
        if(key.length()==0||key.length()>500||input.length()==0||input.length()>MAX_FILE)throw new IOException("Μη έγκυρο μέγεθος ή ταυτότητα τιμολογίου.");
        if(metadata==null)metadata=new JSONObject();
        JSONObject http=metadata.optJSONObject("httpMetadata"),custom=metadata.optJSONObject("customMetadata");if(http==null)http=new JSONObject();if(custom==null)custom=new JSONObject();if(http.toString().length()+custom.toString().length()>16384)throw new IOException("Μεγάλα μεταδεδομένα αρχείου.");
        String type=http.optString("contentType","application/octet-stream"),sha=digest(input),local=BusinessRuntime.sha256(key.getBytes("UTF-8"))+"-"+sha+extension(type),name=custom.optString("displayName",key.substring(key.lastIndexOf('/')+1));
        File target=privateFile(true,local);
        if(!target.exists()){
            File part=File.createTempFile("object-",".part",documents);
            try{copy(input,part);if(!digest(part).equals(sha))throw new IOException("Το αρχείο άλλαξε κατά την αποθήκευση.");if(!part.renameTo(target)&&!target.exists())throw new IOException("Δεν ολοκληρώθηκε η αποθήκευση του αρχείου.");}finally{part.delete();}
        }
        if(target.length()!=input.length()||!digest(target).equals(sha))throw new IOException("Δεν επαληθεύτηκε το τοπικό αρχείο τιμολογίου.");
        String now=new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX",Locale.US).format(new Date());
        db.execSQL("INSERT INTO native_objects(key,local_name,name,content_type,size,sha256,http_metadata,custom_metadata,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(key) DO UPDATE SET local_name=excluded.local_name,name=excluded.name,content_type=excluded.content_type,size=excluded.size,sha256=excluded.sha256,http_metadata=excluded.http_metadata,custom_metadata=excluded.custom_metadata,updated_at=excluded.updated_at,deleted_at=NULL",new Object[]{key,local,clean(name,240),type,input.length(),sha,http.toString(),custom.toString(),now});
        return new JSONObject().put("key",key).put("size",input.length()).put("etag",sha);
    }
    private static void copy(File source,File target)throws Exception{
        try(InputStream in=new BufferedInputStream(new FileInputStream(source));FileOutputStream out=new FileOutputStream(target)){byte[] buffer=new byte[65536];int n;while((n=in.read(buffer))!=-1)out.write(buffer,0,n);out.getFD().sync();}
    }
    public JSONObject call(String command,JSONObject value)throws Exception{
        if(command.equals("files.start")){
            String id=value.getString("id"),sha=value.getString("sha256"),name=clean(value.getString("name"),240),type=clean(value.getString("type"),100);long size=value.getLong("size");
            if(!id.matches("[a-f0-9-]{36}")||!sha.matches("[a-f0-9]{64}")||size<1||size>MAX_FILE||actor.isEmpty())throw new IOException("Μη έγκυρη μεταφορά αρχείου.");
            JSONObject prior=row("SELECT actor_id,generation,size,sha256 FROM native_file_transfers WHERE id=?",id);if(prior!=null){if(!actor.equals(prior.getString("actor_id"))||!generation.equals(prior.getString("generation"))||size!=prior.getLong("size")||!sha.equals(prior.getString("sha256")))throw new IOException("Η ταυτότητα μεταφοράς έχει διαφορετικό αρχείο.");return info(transfer(id));}
            JSONObject quota=row("SELECT COALESCE(SUM(size),0) bytes FROM native_file_transfers WHERE kind='upload' AND expires_at>?",System.currentTimeMillis());if(quota.getLong("bytes")+size>256L*1024*1024)throw new IOException("Υπάρχουν πολλές εκκρεμείς μεταφορές. Περίμενε και δοκίμασε ξανά.");
            File file=privateFile(false,id+".part");try(FileOutputStream output=new FileOutputStream(file)){output.getFD().sync();}
            db.execSQL("INSERT INTO native_file_transfers(id,actor_id,generation,kind,local_name,name,content_type,size,sha256,expires_at) VALUES(?,?,?,'upload',?,?,?,?,?,?)",new Object[]{id,actor,generation,file.getName(),name,type,size,sha,System.currentTimeMillis()+3600000});return info(transfer(id));
        }
        if(command.equals("files.append")){
            JSONObject record=transfer(value.getString("ref"));if(!record.getString("kind").equals("upload"))throw new IOException("Η αναφορά δεν είναι μεταφόρτωση.");long offset=value.getLong("offset"),received=record.getLong("received");byte[] bytes=Base64.getDecoder().decode(value.getString("data"));if(bytes.length<1||bytes.length>262144||offset<0||offset>received||bytes.length>record.getLong("size")-offset)throw new IOException("Μη έγκυρο τμήμα μεταφοράς.");File file=privateFile(false,record.getString("local_name"));
            try(RandomAccessFile output=new RandomAccessFile(file,"rw")){
                if(offset<received){if(bytes.length>received-offset)throw new IOException("Το τμήμα επικαλύπτει ανεπιβεβαίωτα δεδομένα.");byte[] prior=new byte[bytes.length];output.seek(offset);output.readFully(prior);if(!MessageDigest.isEqual(bytes,prior))throw new IOException("Η επανάληψη περιέχει διαφορετικά δεδομένα.");return info(record);}
                if(record.getInt("complete")==1)throw new IOException("Η μεταφορά έχει ήδη ολοκληρωθεί.");output.setLength(received);output.seek(received);output.write(bytes);output.getFD().sync();
            }
            db.execSQL("UPDATE native_file_transfers SET received=? WHERE id=?",new Object[]{received+bytes.length,record.getString("id")});return info(transfer(record.getString("id")));
        }
        if(command.equals("files.finish")){
            JSONObject record=transfer(value.getString("ref"));File file=privateFile(record.getInt("document_root")==1,record.getString("local_name"));if(record.getLong("received")!=record.getLong("size")||file.length()!=record.getLong("size")||!digest(file).equals(record.getString("sha256")))throw new IOException("Δεν συμφωνούν τα δεδομένα ή το αποτύπωμα αρχείου. Επανάλαβε τη μεταφορά.");db.execSQL("UPDATE native_file_transfers SET complete=1 WHERE id=?",new Object[]{record.getString("id")});return info(transfer(record.getString("id")));
        }
        if(command.equals("file.stat"))return info(transfer(value.getString("ref")));
        if(command.equals("file.slice")){
            JSONObject record=transfer(value.getString("ref"));long start=value.getLong("start"),end=value.getLong("end"),size=record.getLong("slice_size");if(start<0||end<start||end>size)throw new IOException("Μη έγκυρο τμήμα αρχείου.");return new JSONObject().put("ref",record.getString("id")+":"+(record.getLong("slice_start")+start)+":"+(end-start));
        }
        if(command.equals("file.read")||command.equals("files.chunk")){
            JSONObject record=transfer(value.getString("ref"));if(record.getInt("complete")!=1)throw new IOException("Το αρχείο δεν έχει επαληθευτεί.");long start=value.optLong("start",value.optLong("offset",0)),length=value.optLong("length",262144);if(command.equals("files.chunk"))length=Math.min(262144,record.getLong("slice_size")-start);if(start<0||length<0||start>record.getLong("slice_size")||length>record.getLong("slice_size")-start||length>MAX_FILE)throw new IOException("Μη έγκυρο τμήμα ανάγνωσης.");byte[] bytes=new byte[(int)length];try(RandomAccessFile input=new RandomAccessFile(privateFile(record.getInt("document_root")==1,record.getString("local_name")),"r")){input.seek(record.getLong("slice_start")+start);input.readFully(bytes);}return command.equals("file.read")?new JSONObject().put("hex",BusinessPrimitives.hex(bytes)):new JSONObject().put("data",Base64.getEncoder().encodeToString(bytes)).put("offset",start).put("length",length).put("size",record.getLong("slice_size")).put("sha256",record.getString("sha256"));
        }
        if(command.equals("objects.put")){
            if(!value.isNull("ref")){JSONObject record=transfer(value.getString("ref"));if(record.getInt("complete")!=1||record.getLong("slice_start")!=0||record.getLong("slice_size")!=record.getLong("size"))throw new IOException("Χρειάζεται πλήρες επαληθευμένο αρχείο.");return storeObject(value.getString("key"),privateFile(record.getInt("document_root")==1,record.getString("local_name")),value.optJSONObject("metadata"));}
            File file=exportTarget("bin");try{byte[] bytes=BusinessPrimitives.unhex(value.getString("hex"));try(FileOutputStream output=new FileOutputStream(file)){output.write(bytes);output.getFD().sync();}return storeObject(value.getString("key"),file,value.optJSONObject("metadata"));}finally{file.delete();}
        }
        if(command.equals("objects.get")){
            JSONObject object=row("SELECT * FROM native_objects WHERE key=? AND deleted_at IS NULL",value.getString("key"));if(object==null)return new JSONObject().put("exists",false);File file=privateFile(true,object.getString("local_name"));if(!file.exists()||file.length()!=object.getLong("size"))throw new IOException("Λείπει το τοπικό αρχείο τιμολογίου. Χρειάζεται ανάκτηση του αντιγράφου.");JSONObject result=register(file,true,object.getString("name"),object.getString("content_type"),object.getString("sha256"),"download","fleet.view");return result.put("exists",true).put("key",value.getString("key")).put("httpMetadata",new JSONObject(object.getString("http_metadata"))).put("customMetadata",new JSONObject(object.getString("custom_metadata"))).put("httpEtag","\""+object.getString("sha256")+"\"");
        }
        if(command.equals("objects.delete")){
            JSONObject object=row("SELECT local_name FROM native_objects WHERE key=? AND deleted_at IS NULL",value.getString("key"));if(object!=null){db.execSQL("UPDATE native_objects SET deleted_at=datetime('now') WHERE key=?",new Object[]{value.getString("key")});db.execSQL("INSERT OR IGNORE INTO native_object_gc(local_name,requested_at) VALUES(?,datetime('now'))",new Object[]{object.getString("local_name")});}return new JSONObject();
        }
        return null;
    }
    /** Run only after the API transaction committed. Old active versions survive rollback. */
    public void collectDeletedObjects()throws Exception{
        synchronized(NativeDatabaseSnapshot.OBJECT_LIFECYCLE_LOCK){
        JSONArray pending=sql.call("sql.query",new JSONObject().put("sql","SELECT g.local_name FROM native_object_gc g WHERE NOT EXISTS(SELECT 1 FROM native_objects o WHERE o.local_name=g.local_name AND o.deleted_at IS NULL) AND NOT EXISTS(SELECT 1 FROM native_backup_pins p WHERE p.local_name=g.local_name) AND NOT EXISTS(SELECT 1 FROM native_file_transfers f WHERE f.document_root=1 AND f.local_name=g.local_name AND f.expires_at>?) LIMIT 25").put("params",new JSONArray().put(System.currentTimeMillis()))).getJSONArray("results");
        for(int i=0;i<pending.length();i++){String name=pending.getJSONObject(i).getString("local_name");File file=privateFile(true,name);if(!file.exists()||file.delete())db.execSQL("DELETE FROM native_object_gc WHERE local_name=?",new Object[]{name});}
        }
    }
}
