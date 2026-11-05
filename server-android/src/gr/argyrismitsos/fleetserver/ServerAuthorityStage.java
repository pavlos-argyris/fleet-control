package gr.argyrismitsos.fleetserver;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import org.json.*;
import java.io.*;
import java.net.URI;
import java.security.MessageDigest;
import java.util.*;

/** Reproducible migration candidate. Never grants authority or accepts business writes. */
public final class ServerAuthorityStage {
    public interface Progress { void stage(String detail) throws Exception; }
    private static final String KEY="server_authority_stage_v1";
    private static final String ROWS="server_authority_stage_rows";
    private static final long SAFE_INTEGER=9007199254740991L;
    // Keep this list explicit; a changed Worker export must fail the contract test.
    static final String[] TABLES={"app_users","registered_devices","vehicle_registry","vehicle_archives","shift_templates","schedule_assignments","schedule_week_drafts","schedule_publications","schedule_acknowledgements","schedule_vehicle_waivers","schedules","shifts","vehicle_segments","correction_requests","pay_rules","pay_rule_versions","special_rates","special_rate_assignments","payroll_segments","payroll_periods","payroll_adjustments","payroll_snapshots","system_alerts","alert_rules","audit_log","system_settings","deleted_records","invoice_import_drafts","ordexa_riders","ordexa_imports","ordexa_sessions","ordexa_pay_decisions","ordexa_shift_adjustments","store_billing_records"};
    private ServerAuthorityStage() {}

    private static String text(SQLiteDatabase db,String sql,String[] args) {
        Cursor cursor=db.rawQuery(sql,args);
        try{return cursor.moveToFirst()?cursor.getString(0):"";}finally{cursor.close();}
    }
    private static long number(SQLiteDatabase db,String sql,String[] args) {
        Cursor cursor=db.rawQuery(sql,args);
        try{return cursor.moveToFirst()?cursor.getLong(0):0;}finally{cursor.close();}
    }
    private static JSONObject saved(SQLiteDatabase db)throws Exception {
        String value=text(db,"SELECT value FROM settings WHERE key=?",new String[]{KEY});
        return value==null||value.length()==0?new JSONObject():new JSONObject(value);
    }
    private static String realm(String value)throws Exception {
        String base=value==null?"":value.trim().replaceAll("/+$","");URI uri=new URI(base);
        if(base.length()>2048||!"https".equalsIgnoreCase(uri.getScheme())||uri.getHost()==null||uri.getRawUserInfo()!=null||uri.getRawQuery()!=null||uri.getRawFragment()!=null)throw new IOException("Χρειάζεται έγκυρη διεύθυνση HTTPS του Fleet.");
        return base;
    }
    private static JSONObject source(SQLiteDatabase db)throws Exception {
        String raw=text(db,"SELECT json_object('schema',json_extract(value,'$.schemaVersion'),'realm',json_extract(value,'$.sourceWorker'),'epoch',json_extract(value,'$.mirror.epoch'),'cursor',json_extract(value,'$.mirror.cursor'),'updatedAt',updated_at,'bytes',length(CAST(value AS BLOB))) FROM system_state WHERE key='full_export'",null);
        return raw==null||raw.length()==0?new JSONObject():new JSONObject(raw);
    }
    private static String hex(byte[] bytes) {
        StringBuilder out=new StringBuilder(bytes.length*2);for(byte b:bytes){out.append(Character.forDigit((b>>>4)&15,16));out.append(Character.forDigit(b&15,16));}return out.toString();
    }
    private static String digest(String value)throws Exception{return hex(MessageDigest.getInstance("SHA-256").digest(value.getBytes("UTF-8")));}
    private static void progress(Progress listener,String detail)throws Exception {
        if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Η προετοιμασία μεταφοράς διακόπηκε με ασφάλεια.");
        if(listener!=null)listener.stage(detail);
    }
    private static String sourceDigest(SQLiteDatabase db,long bytes,Progress listener)throws Exception {
        MessageDigest digest=MessageDigest.getInstance("SHA-256");
        // BLOB slices keep every CursorWindow cell small, including a >4 MiB row.
        // Hex avoids a payload-sized Java String and preserves exact UTF-8 bytes.
        for(long offset=0;offset<bytes;offset+=32768){
            progress(listener,"Έλεγχος αποτυπώματος πηγής · "+offset+" / "+bytes+" bytes");
            String chunk=text(db,"SELECT hex(substr(CAST(value AS BLOB),?,32768)) FROM system_state WHERE key='full_export'",new String[]{Long.toString(offset+1)});
            int expected=(int)Math.min(32768,bytes-offset);
            if(chunk==null||chunk.length()!=expected*2)throw new IOException("Δεν ολοκληρώθηκε η ανάγνωση του αντιγράφου πηγής.");
            byte[] decoded=new byte[expected];
            for(int i=0;i<expected;i++){int a=Character.digit(chunk.charAt(i*2),16),b=Character.digit(chunk.charAt(i*2+1),16);if(a<0||b<0)throw new IOException("Μη έγκυρα δεδομένα αντιγράφου.");decoded[i]=(byte)((a<<4)|b);}
            digest.update(decoded);
        }
        return hex(digest.digest());
    }
    private static void validate(SQLiteDatabase db,JSONObject info,String base)throws Exception {
        if(info.length()==0)throw new IOException("Χρειάζεται πρώτα πλήρες αντίγραφο προσωπικού από το Fleet.");
        long valid=number(db,"SELECT CASE WHEN json_type(value,'$.schemaVersion')='integer' AND json_extract(value,'$.schemaVersion') BETWEEN 3 AND 5 AND json_type(value,'$.workforce')='object' AND json_type(value,'$.mirror.rowIds')='object' AND json_type(value,'$.mirror.cursor')='integer' THEN 1 ELSE 0 END FROM system_state WHERE key='full_export'",null);
        if(valid!=1||!info.optString("epoch").matches("[a-f0-9]{32}")||info.optLong("cursor",-1)<0||info.optLong("cursor")>SAFE_INTEGER||info.optString("updatedAt").length()==0)throw new IOException("Το αντίγραφο δεν περιέχει πλήρη συμβατή απογραφή αλλαγών. Επανάλαβε τον συγχρονισμό προσωπικού.");
        if(!base.equals(realm(info.optString("realm"))))throw new IOException("Το αντίγραφο ανήκει σε διαφορετική σύνδεση Fleet. Χρειάζεται νέο πλήρες αντίγραφο.");
        for(String field:new String[]{"workforce","mirror.rowIds"}){
            if(number(db,"SELECT COUNT(*) FROM system_state s,json_each(s.value,?) j WHERE s.key='full_export'",new String[]{"$."+field})!=TABLES.length)throw new IOException("Η απογραφή πινάκων άλλαξε ή είναι ελλιπής. Δεν ενεργοποιήθηκε μεταφορά.");
            Set<String> found=new HashSet<String>();Cursor keys=db.rawQuery("SELECT j.key FROM system_state s,json_each(s.value,?) j WHERE s.key='full_export'",new String[]{"$."+field});
            try{while(keys.moveToNext())found.add(keys.getString(0));}finally{keys.close();}
            if(!found.equals(new HashSet<String>(Arrays.asList(TABLES))))throw new IOException("Η απογραφή πινάκων άλλαξε ή είναι ελλιπής. Δεν ενεργοποιήθηκε μεταφορά.");
        }
    }

    public static JSONObject prepare(SQLiteDatabase db,String worker,String expectedStageId,long usableBytes,Progress listener)throws Exception {
        synchronized(db){
            long started=System.currentTimeMillis();String base=realm(worker);
            db.beginTransaction();
            try{
                JSONObject previous=saved(db);
                if(expectedStageId==null||!expectedStageId.equals(previous.optString("stageId")))throw new IOException("Η προετοιμασία άλλαξε από άλλη ενέργεια. Ανανέωσε την κατάσταση πριν επαναλάβεις.");
                JSONObject info=source(db);validate(db,info,base);long bytes=info.getLong("bytes");
                if(bytes<=0||usableBytes<33554432L||bytes>(usableBytes-33554432L)/3)throw new IOException("Δεν υπάρχει αρκετός ελεύθερος χώρος για ασφαλή προετοιμασία. Το προηγούμενο αντίγραφο διατηρείται.");
                progress(listener,"Προετοιμασία τοπικής βάσης μεταφοράς");
                db.execSQL("CREATE TABLE IF NOT EXISTS "+ROWS+"(table_name TEXT NOT NULL,row_id INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(table_name,row_id))");
                db.execSQL("DELETE FROM "+ROWS);
                String sha=sourceDigest(db,bytes,listener);JSONObject counts=new JSONObject();long total=0;
                for(int i=0;i<TABLES.length;i++){
                    String table=TABLES[i],data="$.workforce."+table,ids="$.mirror.rowIds."+table;
                    progress(listener,"Αντιγραφή και σύγκριση "+(i+1)+" / "+TABLES.length+" · "+table);
                    long shape=number(db,"SELECT CASE WHEN json_type(value,?)='array' AND json_type(value,?)='array' AND json_array_length(value,?)=json_array_length(value,?) THEN 1 ELSE 0 END FROM system_state WHERE key='full_export'",new String[]{data,ids,data,ids});
                    long invalid=number(db,"SELECT COUNT(*) FROM system_state s,json_each(s.value,?) j WHERE s.key='full_export' AND j.type<>'object'",new String[]{data})+
                        number(db,"SELECT COUNT(*) FROM system_state s,json_each(s.value,?) j WHERE s.key='full_export' AND (j.type<>'integer' OR j.value<=0 OR j.value>9007199254740991)",new String[]{ids});
                    if(shape!=1||invalid!=0)throw new IOException("Ασυμφωνία εγγραφών ή σταθερών ταυτοτήτων στον πίνακα "+table+".");
                    db.execSQL("INSERT INTO "+ROWS+"(table_name,row_id,data) SELECT ?,n.value,r.value FROM system_state s,json_each(s.value,?) r JOIN json_each(s.value,?) n ON n.key=r.key WHERE s.key='full_export'",new Object[]{table,data,ids});
                    String original="SELECT n.value row_id,r.value data FROM system_state s,json_each(s.value,?) r JOIN json_each(s.value,?) n ON n.key=r.key WHERE s.key='full_export'";
                    String candidate="SELECT row_id,data FROM "+ROWS+" WHERE table_name=?";
                    if(number(db,"SELECT COUNT(*) FROM ("+original+" EXCEPT "+candidate+")",new String[]{data,ids,table})!=0||number(db,"SELECT COUNT(*) FROM ("+candidate+" EXCEPT "+original+")",new String[]{table,data,ids})!=0)throw new IOException("Δεν επαληθεύτηκε το πλήρες περιεχόμενο του πίνακα "+table+".");
                    long rows=number(db,"SELECT COUNT(*) FROM "+ROWS+" WHERE table_name=?",new String[]{table});counts.put(table,rows);total+=rows;
                }
                if(!"ok".equals(text(db,"PRAGMA quick_check",null)))throw new IOException("Δεν επαληθεύτηκε η ακεραιότητα της τοπικής βάσης.");
                progress(listener,"Ολοκλήρωση σύγκρισης · καμία αλλαγή της ενεργής κύριας βάσης");
                JSONObject result=new JSONObject().put("schemaVersion",1).put("stageId",UUID.randomUUID().toString()).put("sourceUpdatedAt",info.getString("updatedAt")).put("realmSha256",digest(base)).put("sourceEpoch",info.getString("epoch")).put("sourceCursor",info.getLong("cursor")).put("sourcePayloadSha256",sha).put("sourceBytes",bytes).put("tableCounts",counts).put("tables",TABLES.length).put("rows",total).put("preparedAt",System.currentTimeMillis()).put("durationMs",Math.max(0,System.currentTimeMillis()-started)).put("contentCompared",true).put("businessWritesEnabled",false);
                db.execSQL("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)",new Object[]{KEY,result.toString()});
                db.setTransactionSuccessful();return publicStatus(result,info,base);
            }finally{db.endTransaction();}
        }
    }
    private static JSONObject publicStatus(JSONObject prepared,JSONObject current,String base)throws Exception {
        boolean matched=prepared.optString("sourceUpdatedAt").equals(current.optString("updatedAt"))&&prepared.optString("sourceEpoch").equals(current.optString("epoch"))&&prepared.optLong("sourceCursor",-1)==current.optLong("cursor",-2)&&prepared.optString("realmSha256").equals(digest(base))&&base.equals(current.optString("realm").replaceAll("/+$",""));
        return new JSONObject().put("state",matched?"prepared":"source_changed").put("stageId",prepared.getString("stageId")).put("preparedAt",prepared.optLong("preparedAt")).put("sourceUpdatedAt",prepared.optString("sourceUpdatedAt")).put("sourcePayloadSha256",prepared.optString("sourcePayloadSha256")).put("tables",prepared.optInt("tables")).put("rows",prepared.optLong("rows")).put("sourceBytes",prepared.optLong("sourceBytes")).put("durationMs",prepared.optLong("durationMs")).put("contentCompared",prepared.optBoolean("contentCompared")).put("businessWritesEnabled",false).put("sourceRevalidationRequired",true).put("backupIncluded",false);
    }
    public static JSONObject status(SQLiteDatabase db,String worker)throws Exception {
        synchronized(db){JSONObject value=saved(db);if(value.length()==0)return new JSONObject().put("state","not_prepared").put("stageId","").put("businessWritesEnabled",false);return publicStatus(value,source(db),realm(worker));}
    }
    /** The candidate is derivative. A restore must require a fresh preparation. */
    public static void invalidate(SQLiteDatabase db) {
        db.execSQL("DELETE FROM settings WHERE key=?",new Object[]{KEY});
        // Keep disposable rows for the next atomic replacement; no live data is touched.
    }
}
