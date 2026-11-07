package gr.argyrismitsos.fleetserver;

import android.content.Context;
import android.content.ContextWrapper;
import android.database.Cursor;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** Executes a real restore into disposable SQLite and private document files.
 * It never invokes production restore, sync, settings import or provider I/O. */
public final class BackupRestoreProbe {
    private BackupRestoreProbe() {}

    public static String canonical(Object value) throws Exception {
        if (value == null || value == JSONObject.NULL) return "null";
        if (value instanceof JSONObject) {
            JSONObject object=(JSONObject)value;
            List<String> keys=new ArrayList<String>();
            Iterator<String> names=object.keys();while(names.hasNext())keys.add(names.next());
            Collections.sort(keys);StringBuilder result=new StringBuilder("{");
            for(String key:keys){if(result.length()>1)result.append(',');result.append(JSONObject.quote(key)).append(':').append(canonical(object.get(key)));}
            return result.append('}').toString();
        }
        if (value instanceof JSONArray) {
            JSONArray array=(JSONArray)value;StringBuilder result=new StringBuilder("[");
            for(int i=0;i<array.length();i++){if(i>0)result.append(',');result.append(canonical(array.get(i)));}
            return result.append(']').toString();
        }
        if(value instanceof String)return JSONObject.quote((String)value);
        if(value instanceof Boolean)return value.toString();
        if(value instanceof Number)return JSONObject.numberToString((Number)value);
        throw new IOException("Μη συμβατό περιεχόμενο αντιγράφου.");
    }

    private static JSONObject indexed(JSONArray rows, boolean storeRows) throws Exception {
        JSONObject out=new JSONObject();Set<String> ids=new HashSet<String>();
        for(int i=0;i<rows.length();i++){
            JSONObject row=new JSONObject(rows.getJSONObject(i).toString());String id=row.getString("id");
            if(id.length()==0||!ids.add(id))throw new IOException("Διπλή ή κενή ταυτότητα στο αντίγραφο.");
            if(storeRows){
                // Restore intentionally requeues publication and revalidates
                // source coverage. Those flags are not financial data.
                row.remove("dirty");JSONObject data=row.getJSONObject("data");data.remove("pendingDeleteRun");
                if("coverage".equals(row.getString("kind")))data.remove("needsSourceRefresh");
            }
            out.put(id,row);
        }
        return out;
    }

    private static JSONObject sections(JSONObject root) throws Exception {
        int schema=root.optInt("schemaVersion",0);
        if(schema<3||schema>5)throw new IOException("Το αντίγραφο χρειάζεται συμβατή έκδοση πριν από δοκιμή πλήρους ανάκτησης.");
        JSONArray bikes=root.getJSONObject("fleet").getJSONArray("bikes");
        JSONObject workforce=root.getJSONObject("workforce");
        if(workforce.length()==0)throw new IOException("Το αντίγραφο δεν περιλαμβάνει πλήρες στιγμιότυπο προσωπικού/συστήματος.");
        Iterator<String> names=workforce.keys();int records=0;
        while(names.hasNext()){
            JSONArray rows=workforce.getJSONArray(names.next());
            for(int i=0;i<rows.length();i++)rows.getJSONObject(i);
            records+=rows.length();
        }
        JSONObject billing=root.optJSONObject("storeBilling");
        if(billing==null)throw new IOException("Το αντίγραφο δεν περιλαμβάνει το αρχείο καταστημάτων. Χρειάζεται πλήρες νεότερο αντίγραφο για αυτή τη δοκιμή.");
        if(billing.getInt("schemaVersion")!=1||billing.getInt("cutoffHour")!=5)throw new IOException("Μη συμβατό αρχείο καταστημάτων.");
        StoreBillingStore.validateBackup(billing.getJSONArray("records"));
        if(root.has("settings")&&root.optJSONObject("settings")==null)throw new IOException("Μη έγκυρες ρυθμίσεις στο αντίγραφο.");
        JSONObject result=new JSONObject().put("fleet",indexed(bikes,false)).put("workforce",workforce).put("settings",root.optJSONObject("settings")==null?new JSONObject():root.getJSONObject("settings"))
            .put("storeBilling",indexed(billing.getJSONArray("records"),true));
        return new JSONObject().put("data",result).put("bikes",bikes.length()).put("workforceRecords",records)
            .put("storeRecords",billing.getJSONArray("records").length());
    }

    private static void checkSqlite(FleetDataStore store) throws Exception {
        Cursor cursor=store.getReadableDatabase().rawQuery("PRAGMA quick_check",null);
        try{if(!cursor.moveToFirst()||!"ok".equals(cursor.getString(0)))throw new IOException("Απέτυχε ο έλεγχος SQLite της δοκιμαστικής βάσης.");}finally{cursor.close();}
        cursor=store.getReadableDatabase().rawQuery("PRAGMA foreign_key_check",null);
        try{if(cursor.moveToFirst())throw new IOException("Ασυνέπεια σχέσεων στη δοκιμαστική βάση.");}finally{cursor.close();}
    }

    private static void removeTree(File file) throws IOException {
        if(!file.exists())return;
        if(file.isDirectory()){File[] children=file.listFiles();if(children==null)throw new IOException("Δεν καθαρίστηκε ο φάκελος δοκιμής ανάκτησης.");for(File child:children)removeTree(child);}
        if(!file.delete())throw new IOException("Δεν καθαρίστηκε το προσωρινό αρχείο δοκιμής ανάκτησης.");
    }

    public static JSONObject run(final Context context, JSONObject source, JSONObject documentInventory,
                                 File documentArchive, int expectedDocuments) throws Exception {
        // Validate before even creating the disposable target. Never merge
        // missing sections with live data, which would conceal an incomplete backup.
        final JSONObject root=new JSONObject(source.toString());
        final JSONObject expected=sections(root);
        if(expectedDocuments<0 || expectedDocuments>0&&documentArchive==null)throw new IOException("Λείπουν τα συνοδευτικά αρχεία για τη δοκιμή ανάκτησης.");
        String uuid=UUID.randomUUID().toString(),databaseName="fleet-recovery-probe-"+uuid+".db";
        final File directory=new File(context.getCacheDir(),"fleet-recovery-probe-"+uuid);
        if(!directory.mkdirs())throw new IOException("Δεν δημιουργήθηκε ο απομονωμένος φάκελος δοκιμής.");
        Context isolated=new ContextWrapper(context){
            @Override public File getFilesDir(){return directory;}
            @Override public File getCacheDir(){return directory;}
        };
        FleetDataStore target=null;
        try {
            target=new FleetDataStore(context,databaseName);target.getWritableDatabase();
            JSONArray bikes=root.getJSONObject("fleet").getJSONArray("bikes");
            for(int i=0;i<bikes.length();i++)target.replaceBike(bikes.getJSONObject(i));
            target.setSystemExport(root);
            StoreBillingStore billing=new StoreBillingStore(target);
            billing.restore(root.getJSONObject("storeBilling").getJSONArray("records"));
            int documents=0;
            if(documentArchive!=null){
                FileInputStream input=new FileInputStream(documentArchive);
                try{JSONObject restored=ServiceDocumentStore.restoreArchive(isolated,documentInventory,input);documents=restored.getInt("restored");}
                finally{input.close();}
            }
            if(documents!=expectedDocuments)throw new IOException("Δεν επανήλθαν όλα τα συνοδευτικά αρχεία στη δοκιμή.");
            checkSqlite(target);
            JSONObject actual=sections(target.fullBackupPayload());
            if(!canonical(expected.getJSONObject("data")).equals(canonical(actual.getJSONObject("data"))))
                throw new IOException("Τα δεδομένα της δοκιμαστικής επαναφοράς δεν συμφωνούν με το αντίγραφο.");
            JSONArray restoredRows=billing.exportRows();
            for(int i=0;i<restoredRows.length();i++){
                JSONObject row=restoredRows.getJSONObject(i);
                if("coverage".equals(row.getString("kind"))&&!row.getJSONObject("data").optBoolean("needsSourceRefresh"))
                    throw new IOException("Δεν σημάνθηκε επανέλεγχος πηγής μετά την επαναφορά.");
            }
            String digest=BackupArchiveVerifier.digest(canonical(root).getBytes("UTF-8"));
            return new JSONObject().put("schemaVersion",1).put("isolated",true).put("restoreVerified",true)
                .put("payloadSha256",digest).put("bikes",expected.getInt("bikes"))
                .put("workforceRecords",expected.getInt("workforceRecords")).put("storeRecords",expected.getInt("storeRecords"))
                .put("documents",documents).put("sqliteIntegrity",true).put("contentMatches",true)
                .put("datasetsVerified",new JSONArray().put("fleet").put("workforce").put("storeBilling").put("settings"))
                .put("sourceRevalidationRequired",true).put("providerCredentialsRestored",false)
                .put("message","Η δοκιμαστική ανάκτηση ολοκληρώθηκε σε ξεχωριστή βάση. Τα δεδομένα και τα συνοδευτικά αρχεία συμφωνούν.");
        } finally {
            try {if(target!=null)target.close();}
            finally {
                try {if(!context.deleteDatabase(databaseName)&&context.getDatabasePath(databaseName).exists())throw new IOException("Δεν καθαρίστηκε η απομονωμένη βάση δοκιμής.");}
                finally {removeTree(directory);}
            }
        }
    }
}
