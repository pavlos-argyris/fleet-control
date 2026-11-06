package gr.argyrismitsos.fleetserver;
import android.database.sqlite.SQLiteDatabase;
import org.json.*;
import java.io.*;
import java.util.*;

/** Complete, resumable fence/import/document/backup/probe/activation ordering. No UI secrets escape. */
public final class NativeMigrationCoordinator {
    public interface Cloud {
        JSONObject json(String path,String method,JSONObject body)throws Exception;
        void document(JSONObject metadata,File target)throws Exception;
        void signedProbe(JSONObject identity)throws Exception;
    }
    public interface Steps {
        JSONObject initialBackup()throws Exception;
        JSONObject initialize(JSONObject identity)throws Exception;
        JSONObject verifiedBackup()throws Exception;
        boolean backupStillValid(JSONObject evidence)throws Exception;
        void saveIdentity(JSONObject identity)throws Exception;
        void progress(String stage)throws Exception;
    }
    private NativeMigrationCoordinator(){}
    private static void require(boolean valid,String message)throws IOException{if(!valid)throw new IOException(message);}
    static String canonical(Object value)throws Exception{
        if(value instanceof JSONObject){JSONObject json=(JSONObject)value;List<String> keys=new ArrayList<String>();Iterator<String> i=json.keys();while(i.hasNext())keys.add(i.next());Collections.sort(keys);StringBuilder result=new StringBuilder("{");for(String key:keys){if(result.length()>1)result.append(',');result.append(JSONObject.quote(key)).append(':').append(canonical(json.get(key)));}return result.append('}').toString();}
        if(value instanceof JSONArray){JSONArray array=(JSONArray)value;StringBuilder result=new StringBuilder("[");for(int i=0;i<array.length();i++){if(i>0)result.append(',');result.append(canonical(array.get(i)));}return result.append(']').toString();}
        return value instanceof String?JSONObject.quote((String)value):String.valueOf(value);
    }
    private static JSONArray objects(Cloud cloud)throws Exception{
        Map<String,JSONObject> sorted=new TreeMap<String,JSONObject>();Set<String> cursors=new HashSet<String>();String cursor="";
        do{JSONObject page=cloud.json("/objects"+(cursor.isEmpty()?"":"?cursor="+java.net.URLEncoder.encode(cursor,"UTF-8")),"GET",null);JSONArray rows=page.getJSONArray("objects");require(rows.length()<=25,"Μη έγκυρη σελίδα ιδιωτικών αρχείων.");
            for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);String key=row.getString("key");require(key.length()>0&&key.length()<=500&&row.getLong("size")>0&&row.getLong("size")<=BusinessObjects.MAX_FILE&&row.getString("etag").length()>0&&sorted.put(key,row)==null,"Διπλότυπο ή μη συμβατό ιδιωτικό αρχείο.");}
            cursor=page.isNull("cursor")?"":page.optString("cursor");require(cursor.isEmpty()||cursors.add(cursor),"Επαναλαμβανόμενη σελίδα ιδιωτικών αρχείων.");require(sorted.size()<=50000,"Μεγάλος κατάλογος ιδιωτικών αρχείων.");
        }while(!cursor.isEmpty());JSONArray result=new JSONArray();for(JSONObject row:sorted.values())result.put(row);return result;
    }
    private static JSONObject activate(SQLiteDatabase db,JSONObject identity,Cloud cloud,Steps steps,JSONObject evidence)throws Exception{
        JSONObject state=NativePrimaryState.read(db);require(state.optString("phase").equals("prepared")&&state.optString("generation").equals(identity.getString("generation"))&&state.optString("data_hash").equals(evidence.getString("contentHash"))&&steps.backupStillValid(evidence),"Η πλήρης απόδειξη και το backup χρειάζονται νέα επιβεβαίωση.");
        steps.progress("Υπογεγραμμένη δοκιμή σύνδεσης κύριου Server");cloud.signedProbe(identity);
        steps.progress("Ενεργοποίηση κύριας βάσης Server");JSONObject result=cloud.json("/activate","POST",new JSONObject().put("contentHash",evidence.getString("contentHash")).put("restoreVerified",true).put("documentsVerified",true));
        require(result.optBoolean("active")&&result.optString("generation").equals(identity.getString("generation"))&&result.optString("contentHash").equals(evidence.getString("contentHash")),"Δεν επιβεβαιώθηκε η ενεργοποίηση. Επανάλαβε την ίδια μεταφορά.");
        db.beginTransaction();try{require(NativePrimaryState.read(db).optString("phase").equals("prepared"),"Η τοπική κατάσταση άλλαξε.");db.execSQL("UPDATE native_primary_state SET phase='active',proof_sha=? WHERE id=1 AND generation=? AND data_hash=?",new Object[]{evidence.getString("databaseSha256"),identity.getString("generation"),evidence.getString("contentHash")});db.setTransactionSuccessful();}finally{db.endTransaction();}
        return new JSONObject().put("active",true).put("generation",identity.getString("generation")).put("contentCompared",true).put("documentsVerified",true).put("restoreVerified",true).put("backupJobId",evidence.getString("backupJobId"));
    }
    public static JSONObject migrate(final SQLiteDatabase db,final JSONObject identity,JSONObject credentials,File temporary,File documents,final Cloud cloud,final Steps steps)throws Exception{
        String realm=identity.getString("realm"),generation=identity.getString("generation"),phase=NativePrimaryState.read(db).optString("phase","cloud");
        require(Arrays.asList("cloud","preparing","importing","prepared").contains(phase),"Η κύρια βάση δεν επιτρέπει νέα εισαγωγή.");
        NativeDatabaseSnapshot.requireCapabilities(db);if(!temporary.exists()&&!temporary.mkdirs())throw new IOException("Δεν δημιουργήθηκε ο ιδιωτικός χώρος μεταφοράς.");
        JSONObject evidence=identity.optJSONObject("migrationEvidence");if(phase.equals("prepared")&&evidence!=null&&steps.backupStillValid(evidence))return activate(db,identity,cloud,steps,evidence);
        if(phase.equals("cloud")){steps.progress("Ασφαλές αντίγραφο πριν από τη μεταφορά");JSONObject backup=steps.initialBackup();require(backup.optBoolean("localReady")&&backup.optBoolean("workforceIncluded")&&backup.optInt("missingDocuments",-1)==0,"Χρειάζεται πλήρες αρχικό τοπικό backup προσωπικού και τιμολογίων πριν από τη μεταφορά.");NativePrimaryState.phase(db,"preparing",realm,generation,"","");}
        steps.progress("Επιβεβαίωση ιδιοκτήτη και φραγή παλιών εγγραφών");
        JSONObject prepare=new JSONObject().put("ticket",identity.getString("migrationTicket")).put("generation",generation).put("publicKey",identity.getString("publicKey")).put("publicSalt",identity.getString("publicSalt")).put("recoveryHash",BusinessRuntime.sha256(identity.getString("recoveryToken").getBytes("UTF-8"))).put("username",credentials.optString("username")).put("password",credentials.optString("password"));
        JSONObject frozen=cloud.json("/prepare","POST",prepare);require(frozen.optString("mode").equals("preparing")&&frozen.optBoolean("fenced")&&frozen.optString("generation").equals(generation)&&frozen.optString("realm").equals(realm)&&frozen.optString("publicKey").equals(identity.getString("publicKey"))&&frozen.optString("publicSalt").equals(identity.getString("publicSalt")),"Δεν επιβεβαιώθηκε η τελική φραγή της παλιάς βάσης.");
        JSONObject seed=cloud.json("/seed","GET",null);for(String key:new String[]{"realm","generation","publicKey","publicSalt"})require(seed.getString(key).equals(identity.getString(key)),"Άλλαξε το στοιχείο σύνδεσης της μεταφοράς.");
        require(seed.getInt("schemaVersion")==1&&seed.getString("authPepper").length()<=512&&!seed.getString("ownerId").isEmpty()&&seed.getString("eventSigningKey").length()>=32,"Μη συμβατή αρχική ταυτότητα σύνδεσης.");
        identity.put("authPepper",seed.getString("authPepper")).put("eventSigningKey",seed.getString("eventSigningKey")).put("ownerId",seed.getString("ownerId"));identity.remove("migrationEvidence");steps.saveIdentity(identity);
        NativePrimaryState.phase(db,"importing",realm,generation,seed.getString("ownerId"),"");JSONObject signed=steps.initialize(identity);final JSONObject inventory=cloud.json("/inventory","GET",null);
        require(inventory.getString("realm").equals(realm)&&inventory.getString("generation").equals(generation),"Άλλαξε η τελική πηγή.");
        NativeFrozenImportV3.Progress progress=new NativeFrozenImportV3.Progress(){public void update(String table,long copied,long expected)throws Exception{steps.progress("Μεταφορά και σύγκριση "+table+" · "+copied+" / "+expected);}};
        NativeFrozenImportV3.stage(db,inventory,new NativeFrozenImportV3.PageReader(){public JSONObject read(String table,long after,int limit)throws Exception{return cloud.json("/rows?table="+java.net.URLEncoder.encode(table,"UTF-8")+"&after="+after+"&limit="+limit,"GET",null);}},new NativeFrozenExportV3.CellReader(){public JSONObject read(String table,long rowid,String column,int offset,int size)throws Exception{return cloud.json("/cell?table="+java.net.URLEncoder.encode(table,"UTF-8")+"&rowid="+rowid+"&column="+java.net.URLEncoder.encode(column,"UTF-8")+"&offset="+offset+"&size="+size,"GET",null);}},progress);
        require(canonical(inventory).equals(canonical(cloud.json("/inventory","GET",null))),"Η απογραφή πηγής άλλαξε πριν από την τελική εισαγωγή.");
        JSONObject promoted=NativePrimaryPromotion.promote(db,inventory,signed.getJSONArray("requiredMigrationTables"),realm,generation,seed.getString("ownerId"),progress);
        steps.progress("Απογραφή και επαλήθευση όλων των ιδιωτικών τιμολογίων");JSONArray files=objects(cloud);BusinessObjects storage=new BusinessObjects(db,documents,new File(temporary,"files"));
        db.execSQL("UPDATE native_objects SET deleted_at=datetime('now') WHERE deleted_at IS NULL");Set<String> keys=new HashSet<String>();
        for(int i=0;i<files.length();i++){JSONObject file=files.getJSONObject(i);steps.progress("Μεταφορά τιμολογίων · "+(i+1)+" / "+files.length());File target=File.createTempFile("migration-document-",".bin",temporary);try{cloud.document(file,target);require(target.length()==file.getLong("size"),"Διαφορετικό μέγεθος ιδιωτικού τιμολογίου.");storage.storeObject(file.getString("key"),target,new JSONObject().put("httpMetadata",file.getJSONObject("httpMetadata")).put("customMetadata",file.getJSONObject("customMetadata")));keys.add(file.getString("key"));}finally{target.delete();}}
        require(canonical(files).equals(canonical(objects(cloud))),"Άλλαξαν τα ιδιωτικά αρχεία κατά τη μεταφορά. Επανάλαβε πριν ενεργοποιήσεις.");
        // Current and archived bike histories retain their original attachment IDs.
        BusinessSqlite sql=new BusinessSqlite(db);JSONArray snapshots=sql.call("sql.query",new JSONObject().put("sql","SELECT data FROM fleet_snapshot WHERE id=1")).getJSONArray("results");if(snapshots.length()>0)references(new JSONObject(snapshots.getJSONObject(0).getString("data")),keys);
        long afterArchive=0;for(;;){JSONArray archived=sql.call("sql.query",new JSONObject().put("sql","SELECT rowid archive_row,snapshot_json FROM vehicle_archives WHERE rowid>? ORDER BY rowid LIMIT 10").put("params",new JSONArray().put(afterArchive))).getJSONArray("results");if(archived.length()==0)break;for(int a=0;a<archived.length();a++){JSONObject item=archived.getJSONObject(a);references(new JSONObject(item.getString("snapshot_json")),keys);afterArchive=item.getLong("archive_row");}}
        steps.progress("Πλήρες φορητό backup και πραγματική απομονωμένη ανάκτηση");JSONObject backup=steps.verifiedBackup(),proof=backup.optJSONObject("nativeProof");
        require(backup.optBoolean("localReady")&&backup.optBoolean("portable")&&backup.optInt("missingDocuments",-1)==0&&proof!=null&&proof.optBoolean("restoreVerified")&&proof.optBoolean("documentsVerified"),"Δεν επαληθεύτηκε πραγματική ανάκτηση του πλήρους backup.");
        evidence=new JSONObject().put("contentHash",promoted.getString("contentHash")).put("backupJobId",backup.getString("id")).put("databaseSha256",proof.getString("databaseSha256")).put("manifestSha256",backup.getString("dataSha256"));identity.put("migrationEvidence",evidence);steps.saveIdentity(identity);
        return activate(db,identity,cloud,steps,evidence);
    }
    private static void references(Object value,Set<String> keys)throws Exception{
        if(value instanceof JSONObject){JSONObject object=(JSONObject)value;JSONArray attachments=object.optJSONArray("attachments");if(attachments!=null)for(int i=0;i<attachments.length();i++){JSONObject file=attachments.optJSONObject(i);if(file!=null&&!file.optString("key").isEmpty())require(keys.contains(file.getString("key")),"Λείπει ιδιωτικό αρχείο που αναφέρεται στο ιστορικό. Δεν ενεργοποιήθηκε η νέα βάση.");}Iterator<String> names=object.keys();while(names.hasNext())references(object.get(names.next()),keys);}
        else if(value instanceof JSONArray){JSONArray array=(JSONArray)value;for(int i=0;i<array.length();i++)references(array.get(i),keys);}
    }
}
