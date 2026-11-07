package gr.argyrismitsos.fleetserver;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** Promotes an authenticated frozen candidate, atomically, without activating writes. */
public final class NativePrimaryPromotion {
    private NativePrimaryPromotion(){}
    private static IOException invalid(String message){return new IOException("Η μεταφορά κύριας βάσης δεν ολοκληρώθηκε: "+message);}
    private static String q(String value)throws IOException{return NativeFrozenDigest.identifier(value);}
    private static String scalar(SQLiteDatabase db,String sql,String...args){Cursor c=db.rawQuery(sql,args);try{return c.moveToFirst()?c.getString(0):null;}finally{c.close();}}
    private static String inventoryHash(JSONObject inventory)throws Exception{return NativeFrozenDigest.finish(digest(inventory.toString()));}
    private static MessageDigest digest(String value)throws Exception{MessageDigest hash=MessageDigest.getInstance("SHA-256");hash.update(value.getBytes(StandardCharsets.UTF_8));return hash;}
    private static Map<String,JSONObject> columns(SQLiteDatabase db,String table)throws Exception{
        Map<String,JSONObject> result=new LinkedHashMap<String,JSONObject>();Cursor c=db.rawQuery("PRAGMA table_info("+q(table)+")",null);
        try{while(c.moveToNext())result.put(c.getString(1),new JSONObject().put("type",c.getString(2)).put("notnull",c.getInt(3)).put("default",c.isNull(4)?JSONObject.NULL:c.getString(4)).put("pk",c.getInt(5)));}finally{c.close();}return result;
    }
    private static void checkPhase(SQLiteDatabase db,String generation,String realm,String owner)throws Exception{
        if(!generation.equals(scalar(db,"SELECT generation FROM native_primary_state WHERE id=1"))||!realm.equals(scalar(db,"SELECT realm FROM native_primary_state WHERE id=1"))||!owner.equals(scalar(db,"SELECT owner_id FROM native_primary_state WHERE id=1")))throw invalid("άλλαξε η σύνδεση ή η επιβεβαίωση ιδιοκτήτη.");
        String phase=scalar(db,"SELECT phase FROM native_primary_state WHERE id=1");if(!Arrays.asList("preparing","importing","prepared").contains(phase))throw invalid("η τρέχουσα κύρια βάση δεν επιτρέπεται να αντικατασταθεί.");
    }
    private static boolean reserved(String table){return Arrays.asList("bikes","settings","system_state","applied_operations","store_billing_local").contains(table)||table.startsWith("native_")||table.startsWith("server_primary_")||table.startsWith("sqlite_");}
    /**
     * signedRequiredTables comes from the signed native bundle, never UI input.
     * The caller must hold the verified coordinator fence and quiesce local jobs.
     * This method reaches only prepared; activation requires backup proof + lease.
     */
    public static JSONObject promote(SQLiteDatabase db,JSONObject inventory,JSONArray signedRequiredTables,String realm,String generation,String owner,NativeFrozenImportV3.Progress progress)throws Exception{
        if(inventory.getInt("schemaVersion")!=3||!realm.equals(inventory.getString("realm"))||!generation.equals(inventory.getString("generation"))||owner.isEmpty())throw invalid("μη συμβατό στοιχείο τελικής πηγής.");
        JSONArray tables=inventory.getJSONArray("tables");if(tables.length()==0||signedRequiredTables.length()==0)throw invalid("λείπουν οι απαιτούμενοι πίνακες.");
        Map<String,JSONObject> names=new LinkedHashMap<String,JSONObject>();
        for(int t=0;t<tables.length();t++){
            JSONObject table=tables.getJSONObject(t);String name=table.getString("name");q(name);
            if(reserved(name)||names.put(name,table)!=null||scalar(db,"SELECT name FROM sqlite_master WHERE type='table' AND name=?",name)==null)throw invalid("άγνωστος ή προστατευμένος πίνακας "+name+". Χρειάζεται συμβατή έκδοση Server.");
            Map<String,JSONObject> target=columns(db,name);JSONArray source=table.getJSONArray("columns");Set<String> seen=new HashSet<String>();
            for(int c=0;c<source.length();c++){
                JSONObject column=source.getJSONObject(c);String field=column.getString("name");q(field);JSONObject local=target.get(field);
                if(local==null||!seen.add(field)||!column.optString("type").trim().equalsIgnoreCase(local.getString("type").trim())||column.getInt("notnull")!=local.getInt("notnull")||column.getInt("pk")!=local.getInt("pk"))throw invalid("διαφορετικό σχήμα "+name+"."+field+".");
            }
            for(Map.Entry<String,JSONObject> column:target.entrySet())if(!seen.contains(column.getKey())&&column.getValue().getInt("notnull")!=0&&column.getValue().isNull("default"))throw invalid("λείπει υποχρεωτική νέα στήλη.");
        }
        for(int i=0;i<signedRequiredTables.length();i++)if(!names.containsKey(signedRequiredTables.getString(i)))throw invalid("ελλιπής τελική απογραφή.");
        String meta=NativeFrozenImportV3.metadataTable(),inventorySha=inventoryHash(inventory);
        if(!generation.equals(scalar(db,"SELECT generation FROM "+meta+" WHERE id=1"))||!inventorySha.equals(scalar(db,"SELECT inventory_sha256 FROM "+meta+" WHERE id=1")))throw invalid("το υποψήφιο αντίγραφο ανήκει σε διαφορετική πηγή.");
        String expected=scalar(db,"SELECT content_sha256 FROM "+meta+" WHERE id=1");if(expected==null||!expected.matches("[a-f0-9]{64}"))throw invalid("χρειάζεται νέα πλήρης σύγκριση του υποψηφίου.");
        synchronized(db){db.beginTransaction();try{
            checkPhase(db,generation,realm,owner);
            if(!generation.equals(scalar(db,"SELECT generation FROM "+meta+" WHERE id=1"))||!inventorySha.equals(scalar(db,"SELECT inventory_sha256 FROM "+meta+" WHERE id=1"))||!expected.equals(scalar(db,"SELECT content_sha256 FROM "+meta+" WHERE id=1")))throw invalid("η προετοιμασία άλλαξε πριν από την εισαγωγή.");
            if(!expected.equals(NativeFrozenDigest.database(db,inventory,true,progress)))throw invalid("άλλαξε το περιεχόμενο του υποψηφίου.");
            if("prepared".equals(scalar(db,"SELECT phase FROM native_primary_state WHERE id=1"))){
                if(!expected.equals(scalar(db,"SELECT data_hash FROM native_primary_state WHERE id=1"))||!expected.equals(NativeFrozenDigest.database(db,inventory,false,progress)))throw invalid("η προηγούμενη ολοκλήρωση δεν αντιστοιχεί στην πηγή.");
                db.setTransactionSuccessful();return new JSONObject().put("prepared",true).put("replayed",true).put("contentHash",expected).put("inventoryHash",inventorySha).put("tables",tables.length()).put("businessWritesEnabled",false).put("restoreProbeRequired",true);
            }
            // Only triggers already installed by the signed native handlers are
            // suspended, in this transaction; no cloud SQL is imported/executed.
            List<String[]> triggers=new ArrayList<String[]>();Cursor c=db.rawQuery("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",null);
            try{while(c.moveToNext())if(names.containsKey(c.getString(1)))triggers.add(new String[]{c.getString(0),c.getString(2)});}finally{c.close();}
            for(String[] trigger:triggers)db.execSQL("DROP TRIGGER "+q(trigger[0]));
            db.execSQL("PRAGMA defer_foreign_keys=ON");
            for(String name:names.keySet())db.execSQL("DELETE FROM "+q(name));
            for(Map.Entry<String,JSONObject> entry:names.entrySet()){
                String name=entry.getKey();JSONArray source=entry.getValue().getJSONArray("columns");StringBuilder columns=new StringBuilder(),selected=new StringBuilder();
                for(int i=0;i<source.length();i++){String field=q(source.getJSONObject(i).getString("name"));columns.append(',').append(field);selected.append(',').append(field);}
                db.execSQL("INSERT INTO "+q(name)+"(rowid"+columns+") SELECT _fleet_source_rowid"+selected+" FROM "+q(NativeFrozenImportV3.candidateName(name))+" ORDER BY _fleet_source_rowid");
                if(Long.parseLong(scalar(db,"SELECT COUNT(*) FROM "+q(name)))!=entry.getValue().getLong("rows"))throw invalid("διαφορετικό πλήθος εγγραφών "+name+".");
            }
            if(!expected.equals(NativeFrozenDigest.database(db,inventory,false,progress)))throw invalid("δεν συμφωνούν όλα τα αρχικά δεδομένα μετά την εισαγωγή.");
            for(String[] trigger:triggers)db.execSQL(trigger[1]);
            if(!"ok".equals(scalar(db,"PRAGMA quick_check"))||scalar(db,"PRAGMA foreign_key_check")!=null)throw invalid("απέτυχε η ακεραιότητα ή οι σχέσεις της βάσης.");
            if(!"1".equals(scalar(db,"SELECT COUNT(*) FROM app_users WHERE id=? AND role='owner' AND active=1 AND login_enabled=1 AND deleted_at IS NULL",owner)))throw invalid("δεν βρέθηκε ο επιβεβαιωμένος ενεργός ιδιοκτήτης.");
            for(String ephemeral:new String[]{"auth_sessions","auth_login_attempts","fleet_sessions","fleet_pin_attempts"})if(scalar(db,"SELECT name FROM sqlite_master WHERE type='table' AND name=?",ephemeral)!=null)db.execSQL("DELETE FROM "+q(ephemeral));
            if(scalar(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='fleet_mirror_changes'")!=null)db.execSQL("DELETE FROM fleet_mirror_changes");
            if(scalar(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='fleet_mirror_state'")!=null)db.execSQL("UPDATE fleet_mirror_state SET epoch=lower(hex(randomblob(16))),floor=0 WHERE id=1");
            db.execSQL("UPDATE native_primary_state SET phase='prepared',data_hash=?,proof_sha='',imported_at=datetime('now') WHERE id=1",new Object[]{expected});
            db.setTransactionSuccessful();return new JSONObject().put("prepared",true).put("contentHash",expected).put("inventoryHash",inventorySha).put("tables",tables.length()).put("businessWritesEnabled",false).put("restoreProbeRequired",true);
        }finally{db.endTransaction();}}
    }
}
