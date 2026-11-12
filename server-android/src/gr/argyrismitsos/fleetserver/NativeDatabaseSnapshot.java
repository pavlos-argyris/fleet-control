package gr.argyrismitsos.fleetserver;

import android.database.sqlite.SQLiteDatabase;
import org.json.*;
import java.io.*;
import java.security.*;
import java.util.*;

/** Consistent compact SQLite snapshots; no whole-database JSON materialization. */
public final class NativeDatabaseSnapshot {
    public static final int APPLICATION_ID=0x464c5450;
    public static final Object OBJECT_LIFECYCLE_LOCK=new Object();
    public static final String STATE_SCHEMA=NativePrimarySchema.STATE;
    private static final String PINS="CREATE TABLE IF NOT EXISTS native_backup_pins(capture_id TEXT NOT NULL,local_name TEXT NOT NULL,PRIMARY KEY(capture_id,local_name));";
    private static final Set<String> EPHEMERAL=new HashSet<String>(Arrays.asList("auth_sessions","fleet_sessions","auth_login_attempts","fleet_pin_attempts","native_file_transfers","native_object_gc","native_backup_pins","native_event_outbox","independent_readiness"));
    public interface CaptureTask{Capture capture()throws Exception;}
    public interface Coordinator{Capture capture(CaptureTask task)throws Exception;}
    private static volatile Coordinator coordinator;
    public static void setCoordinator(Coordinator value){coordinator=value;}
    public static final class Capture {
        public final String id;public final File file;public final JSONObject manifest;public final JSONArray objects;
        Capture(String id,File file,JSONObject manifest,JSONArray objects){this.id=id;this.file=file;this.manifest=manifest;this.objects=objects;}
    }
    private NativeDatabaseSnapshot(){}
    private static JSONObject query(BusinessSqlite sql,String text,Object...parameters)throws Exception{return sql.call("sql.query",new JSONObject().put("sql",text).put("params",new JSONArray(Arrays.asList(parameters))));}
    private static JSONObject first(BusinessSqlite sql,String text,Object...parameters)throws Exception{JSONArray rows=query(sql,text,parameters).getJSONArray("results");return rows.length()>0?rows.getJSONObject(0):null;}
    private static boolean table(BusinessSqlite sql,String name)throws Exception{return first(sql,"SELECT name FROM sqlite_master WHERE type='table' AND name=?",name)!=null;}
    private static String identifier(String name)throws Exception{if(!name.matches("[A-Za-z_][A-Za-z0-9_]{0,120}"))throw new IOException("Μη συμβατό όνομα πίνακα backup.");return '"'+name+'"';}
    public static String digest(File file)throws Exception{MessageDigest hash=MessageDigest.getInstance("SHA-256");try(InputStream input=new BufferedInputStream(new FileInputStream(file))){byte[] buffer=new byte[65536];int n;while((n=input.read(buffer))!=-1){if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Ο έλεγχος βάσης διακόπηκε με ασφάλεια.");hash.update(buffer,0,n);}}return hex(hash.digest());}
    private static String hex(byte[] hash){StringBuilder out=new StringBuilder();for(byte b:hash){out.append(Character.forDigit((b>>>4)&15,16));out.append(Character.forDigit(b&15,16));}return out.toString();}
    public static void requireCapabilities(SQLiteDatabase database)throws Exception{
        BusinessSqlite sql=new BusinessSqlite(database);String version=first(sql,"SELECT sqlite_version() version").getString("version");String[] parts=version.split("\\.");int major=Integer.parseInt(parts[0]),minor=Integer.parseInt(parts[1]);
        if(major<3||major==3&&minor<27)throw new IOException("Η μεταφορά απαιτεί SQLite 3.27 ή νεότερη. Ενημέρωσε το Android του Server πριν συνεχίσεις.");
        if(first(sql,"SELECT json_extract('{\"probe\":1}','$.probe') probe").getInt("probe")!=1)throw new IOException("Δεν είναι διαθέσιμη η απαιτούμενη υποστήριξη JSON της SQLite.");
    }
    private static void integrity(BusinessSqlite sql)throws Exception{
        JSONArray quick=query(sql,"PRAGMA quick_check").getJSONArray("results");if(quick.length()!=1||!quick.getJSONObject(0).optString("quick_check").equals("ok"))throw new IOException("Απέτυχε ο έλεγχος ακεραιότητας της βάσης backup.");
        if(query(sql,"PRAGMA foreign_key_check").getJSONArray("results").length()!=0)throw new IOException("Ασυνεπείς σχέσεις στη βάση backup.");
    }
    private static void sanitize(SQLiteDatabase database,BusinessSqlite sql)throws Exception{
        database.beginTransaction();try{
            for(String name:EPHEMERAL)if(table(sql,name))database.execSQL("DELETE FROM "+identifier(name));
            for(String name:new String[]{"server_authority_stage_rows","server_authority_stage_ids","server_authority_stage_state","native_migration_rows","native_migration_inventory"})if(table(sql,name))database.execSQL("DROP TABLE "+identifier(name));
            JSONArray candidates=query(sql,"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'server_primary_frozen_v3_%'").getJSONArray("results");
            for(int i=0;i<candidates.length();i++){String name=candidates.getJSONObject(i).getString("name");if(name.startsWith("server_primary_frozen_v3_"))database.execSQL("DROP TABLE "+identifier(name));}
            // The old mirrored export is derivable from the canonical typed DB.
            // Work queues and local order ledgers remain intact.
            if(table(sql,"system_state"))database.execSQL("DELETE FROM system_state WHERE key='full_export'");
            if(table(sql,"settings"))database.execSQL("DELETE FROM settings WHERE key='direct_auth_v1'");
            database.execSQL(STATE_SCHEMA);
            database.execSQL("UPDATE native_primary_state SET phase='needs_recovery',generation='',proof_sha='' WHERE id=1");
            database.execSQL("PRAGMA application_id="+APPLICATION_ID);database.setTransactionSuccessful();
        }finally{database.endTransaction();}
    }
    public static Capture create(final SQLiteDatabase live,final File directory)throws Exception{
        Coordinator value=coordinator;return value==null?createDirect(live,directory):value.capture(new CaptureTask(){public Capture capture()throws Exception{return createDirect(live,directory);}});
    }
    private static Capture createDirect(SQLiteDatabase live,File directory)throws Exception{
        requireCapabilities(live);if(live.inTransaction())throw new IOException("Περίμενε την ολοκλήρωση της τρέχουσας συναλλαγής πριν από backup.");
        if(!directory.exists()&&!directory.mkdirs())throw new IOException("Δεν δημιουργήθηκε ο ιδιωτικός χώρος backup βάσης.");
        final String id=UUID.randomUUID().toString();File snapshot=new File(directory,id+".sqlite");boolean complete=false;SQLiteDatabase copy=null;
        synchronized(OBJECT_LIFECYCLE_LOCK){
            try{
                live.execSQL(PINS);
                // SQLite takes its own consistent snapshot, including committed
                // WAL contents. VACUUM removes unused/deleted database pages.
                live.execSQL("VACUUM main INTO ?",new Object[]{snapshot.getAbsolutePath()});
                copy=SQLiteDatabase.openDatabase(snapshot.getAbsolutePath(),null,SQLiteDatabase.OPEN_READWRITE);BusinessSqlite sql=new BusinessSqlite(copy);
                for(String required:new String[]{"app_users","fleet_snapshot","payroll_snapshots","store_billing_local","native_cash_events","native_payroll_reviews","native_health_incidents","native_objects","native_operation_receipts"})if(!table(sql,required))throw new IOException("Λείπει απαραίτητο αρχείο της κύριας βάσης: "+required);
                sanitize(copy,sql);integrity(sql);
                JSONArray objects=query(sql,"SELECT key,local_name,name,content_type,size,sha256 FROM native_objects WHERE deleted_at IS NULL ORDER BY key").getJSONArray("results");
                live.beginTransaction();try{for(int i=0;i<objects.length();i++){String name=objects.getJSONObject(i).getString("local_name");if(!BusinessObjects.validLocalName(name))throw new IOException("Μη έγκυρο ιδιωτικό όνομα τιμολογίου στο backup.");live.execSQL("INSERT INTO native_backup_pins(capture_id,local_name) VALUES(?,?)",new Object[]{id,name});}live.setTransactionSuccessful();}finally{live.endTransaction();}
                JSONObject manifest=inventory(sql).put("schemaVersion",1).put("applicationId",APPLICATION_ID).put("capturedAt",new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX",Locale.US).format(new Date())).put("objects",objects).put("sessionsExcluded",true).put("deviceIdentityExcluded",true);
                copy.close();copy=null;
                if(snapshot.length()>PortableBackupCipher.MAX_DATABASE_BYTES)throw new IOException("Η βάση backup υπερβαίνει το όριο 1 GB.");manifest.put("size",snapshot.length()).put("sha256",digest(snapshot));complete=true;return new Capture(id,snapshot,manifest,objects);
            }finally{if(copy!=null)copy.close();if(!complete){snapshot.delete();try{release(live,id);}catch(Exception ignored){}}}
        }
    }
    private static JSONObject inventory(BusinessSqlite sql)throws Exception{
        JSONArray schema=query(sql,"SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").getJSONArray("results"),tables=new JSONArray();MessageDigest hash=MessageDigest.getInstance("SHA-256");
        for(int i=0;i<schema.length();i++){
            JSONObject item=schema.getJSONObject(i);String name=item.getString("name");long count=first(sql,"SELECT COUNT(*) n FROM "+identifier(name)).getLong("n");
            tables.put(new JSONObject().put("name",name).put("rows",count));hash.update((name+"\0"+item.getString("sql")+"\0"+count+"\n").getBytes("UTF-8"));
        }
        return new JSONObject().put("tables",tables).put("schemaInventorySha256",hex(hash.digest()));
    }
    public static void release(SQLiteDatabase live,String id){synchronized(OBJECT_LIFECYCLE_LOCK){live.execSQL("DELETE FROM native_backup_pins WHERE capture_id=?",new Object[]{id});}}
    public static JSONObject verifyReadOnly(File source,JSONObject manifest)throws Exception{
        if(manifest.getInt("schemaVersion")!=1||manifest.getInt("applicationId")!=APPLICATION_ID||!manifest.optBoolean("sessionsExcluded")||!manifest.optBoolean("deviceIdentityExcluded"))throw new IOException("Μη συμβατό πλήρες backup κύριας βάσης.");
        if(source.length()!=manifest.getLong("size")||!digest(source).equals(manifest.getString("sha256")))throw new IOException("Δεν συμφωνεί το αποτύπωμα της βάσης backup.");
        SQLiteDatabase db=SQLiteDatabase.openDatabase(source.getAbsolutePath(),null,SQLiteDatabase.OPEN_READONLY);
        try{verifyOpened(new BusinessSqlite(db),manifest);return new JSONObject().put("integrityVerified",true).put("restoreVerified",false).put("databaseSha256",manifest.getString("sha256")).put("tables",manifest.getJSONArray("tables").length());}finally{db.close();}
    }
    private static void verifyOpened(BusinessSqlite sql,JSONObject manifest)throws Exception{
        verifyOpened(sql,manifest,"","");
    }
    private static void verifyOpened(BusinessSqlite sql,JSONObject manifest,String realm,String generation)throws Exception{
        integrity(sql);
        if(first(sql,"PRAGMA application_id").getInt("application_id")!=APPLICATION_ID||!inventory(sql).getString("schemaInventorySha256").equals(manifest.getString("schemaInventorySha256")))throw new IOException("Δεν συμφωνούν οι πίνακες/εγγραφές της βάσης backup.");
        for(String name:EPHEMERAL)if(table(sql,name)&&first(sql,"SELECT COUNT(*) n FROM "+identifier(name)).getLong("n")!=0)throw new IOException("Το backup περιλαμβάνει ενεργές προσωρινές συνεδρίες.");
        JSONObject state=first(sql,"SELECT phase,generation,realm,data_hash FROM native_primary_state WHERE id=1");boolean valid=state!=null&&(generation.isEmpty()?state.optString("phase").equals("needs_recovery")&&state.optString("generation").isEmpty():state.optString("phase").equals("recovering")&&generation.equals(state.optString("generation"))&&realm.equals(state.optString("realm"))&&manifest.getString("sha256").equals(state.optString("data_hash")));if(!valid)throw new IOException("Το backup δεν έχει ασφαλή κατάσταση ανάκτησης.");
        JSONArray actual=query(sql,"SELECT key,local_name,name,content_type,size,sha256 FROM native_objects WHERE deleted_at IS NULL ORDER BY key").getJSONArray("results"),expected=manifest.getJSONArray("objects");
        if(actual.length()!=expected.length())throw new IOException("Η κάλυψη ιδιωτικών αρχείων δεν συμφωνεί με τη βάση backup.");
        Set<String> keys=new HashSet<String>(),names=new HashSet<String>();
        for(int i=0;i<actual.length();i++){
            JSONObject row=actual.getJSONObject(i),object=expected.getJSONObject(i);
            for(String key:new String[]{"key","local_name","name","content_type","size","sha256"})if(!row.get(key).toString().equals(object.get(key).toString()))throw new IOException("Διαφορετικά στοιχεία ιδιωτικού αρχείου στη βάση backup.");
            if(!BusinessObjects.validLocalName(object.getString("local_name"))||!object.getString("sha256").matches("[a-f0-9]{64}")||object.getLong("size")<=0||!keys.add(object.getString("key"))||!names.add(object.getString("local_name")))throw new IOException("Μη έγκυρος κατάλογος ιδιωτικών αρχείων backup.");
        }
    }
    /** After the one journalled state transition, only counts/schema/session/object evidence may differ in bytes. */
    public static void verifyRecovering(File file,JSONObject manifest,String realm,String generation)throws Exception{
        SQLiteDatabase database=SQLiteDatabase.openDatabase(file.getPath(),null,SQLiteDatabase.OPEN_READONLY);try{verifyOpened(new BusinessSqlite(database),manifest,realm,generation);}finally{database.close();}
    }
    public static JSONObject verifyIsolated(File source,JSONObject manifest,File directory)throws Exception{
        verifyReadOnly(source,manifest);
        if(!directory.exists()&&!directory.mkdirs())throw new IOException("Δεν δημιουργήθηκε απομονωμένος χώρος δοκιμής.");File file=new File(directory,"restore-probe-"+UUID.randomUUID()+".sqlite");SQLiteDatabase db=null;
        try{
            try(InputStream in=new BufferedInputStream(new FileInputStream(source));FileOutputStream out=new FileOutputStream(file)){byte[] bytes=new byte[65536];int n;while((n=in.read(bytes))!=-1)out.write(bytes,0,n);out.getFD().sync();}
            if(!digest(file).equals(manifest.getString("sha256")))throw new IOException("Δεν αντιγράφηκε ακέραια η βάση δοκιμής.");
            db=SQLiteDatabase.openDatabase(file.getAbsolutePath(),null,SQLiteDatabase.OPEN_READWRITE);BusinessSqlite sql=new BusinessSqlite(db);verifyOpened(sql,manifest);
            db.beginTransaction();try{db.execSQL("CREATE TABLE native_restore_probe(id TEXT PRIMARY KEY,value TEXT)");db.execSQL("INSERT INTO native_restore_probe VALUES('probe','Ελληνικά 🛵')");if(!first(sql,"SELECT value FROM native_restore_probe WHERE id='probe'").getString("value").equals("Ελληνικά 🛵"))throw new IOException("Απέτυχε πραγματική ανάγνωση/εγγραφή της βάσης ανάκτησης.");}finally{db.endTransaction();}
            if(table(sql,"native_restore_probe"))throw new IOException("Απέτυχε η πραγματική αναίρεση της δοκιμαστικής εγγραφής.");
            return new JSONObject().put("isolated",true).put("restoreVerified",true).put("sqliteIntegrity",true).put("contentMatches",true).put("sourceRevalidationRequired",true).put("tables",manifest.getJSONArray("tables").length()).put("databaseSha256",manifest.getString("sha256")).put("sessionsExcluded",true).put("requiresRecoveryHandover",true);
        }finally{if(db!=null)db.close();for(String suffix:new String[]{"","-journal","-wal","-shm"}){File part=new File(file.getPath()+suffix);if(part.exists()&&!part.delete())throw new IOException("Δεν καθαρίστηκε ο προσωρινός χώρος δοκιμής βάσης.");}}
    }
}
