package gr.argyrismitsos.fleetserver;
import android.content.*;import android.net.Uri;import android.database.sqlite.SQLiteDatabase;import org.json.*;import java.io.*;import java.util.*;

/** Validates/decrypts all FCB3 parts before the existing crash-safe cold directory swap. */
public final class IndependentRestore {
    static final String PENDING="independent.restore.pending",ALIAS="fleet.independent.restore.pending.v1";
    private IndependentRestore(){}
    static void sync(File directory)throws Exception{java.io.FileDescriptor fd=android.system.Os.open(directory.getPath(),android.system.OsConstants.O_RDONLY,0);try{android.system.Os.fsync(fd);}finally{android.system.Os.close(fd);}}
    static NativeColdRestore core(final Context c){
        IndependentConfig.require(c);
        return new NativeColdRestore(c.getFilesDir(),c.getDatabasePath(NativeColdRestore.DATABASE_NAME).getParentFile(),new File(c.getFilesDir(),"service-documents"),new NativeColdRestore.Ports(){
            public void verifyPending(JSONObject marker)throws Exception{JSONObject pending=SealedLocalState.read(c,PENDING,ALIAS);if(!pending.optString("id").equals(marker.getString("id"))||!BusinessRuntime.sha256(pending.toString().getBytes("UTF-8")).equals(marker.getString("pendingHash")))throw new IOException("Δεν συμφωνεί η απομονωμένη προετοιμασία backup.");}
            public void verifySource(File database,JSONObject manifest)throws Exception{NativeDatabaseSnapshot.verifyReadOnly(database,manifest);}
            public void installSecrets(JSONObject marker)throws Exception{IndependentConfig.save(c,SealedLocalState.read(c,PENDING,ALIAS).getJSONObject("configuration"));}
            public void rollbackSecrets(JSONObject marker)throws Exception{SealedLocalState.remove(c,IndependentConfig.NAME);}
            public void syncDirectory(File directory)throws Exception{sync(directory);}
        });
    }
    static void startup(Context c)throws Exception{core(c).apply();}
    static JSONObject importBackup(final Context c,Uri uri,String password)throws Exception{
        IndependentConfig.require(c);
        if(IndependentConfig.read(c).has("backupSha256")||c.getDatabasePath(NativeColdRestore.DATABASE_NAME).exists())throw new IOException("Η δοκιμαστική εγκατάσταση έχει ήδη βάση. Διατήρησέ την και το backup της πριν από νέα εισαγωγή.");
        JSONObject root=BackupManager.readBackupRoot(c,uri,password);
        if(!NativeBackupReader.isNative(root))throw new IOException("STOP: αυτό είναι παλιό/μερικό Android backup. Λείπει η πλήρης κύρια SQLite (.fcdb), οι λογαριασμοί και/ή τα οικονομικά ιστορικά. Δεν έγινε εισαγωγή ή cloud ανάγνωση.");
        String id=UUID.randomUUID().toString();final File directory=core(c).directory(id);
        try(NativeBackupReader.Prepared prepared=BackupManager.readNative(c,uri,root,password)){
            long needed=prepared.database.length()*4+64L*1024*1024;JSONArray objects=prepared.manifest.getJSONArray("objects");for(int i=0;i<objects.length();i++)needed+=objects.getJSONObject(i).getLong("size")*4;
            if(c.getFilesDir().getUsableSpace()<needed)throw new IOException("Δεν υπάρχει αρκετός ελεύθερος χώρος. Το αρχικό backup διατηρήθηκε.");
            JSONObject proof=NativeBackupRestoreProbe.run(c,prepared.database,prepared.manifest,prepared.documents);
            SQLiteDatabase db=SQLiteDatabase.openDatabase(prepared.database.getPath(),null,SQLiteDatabase.OPEN_READONLY);
            try{
                BusinessSqlite sql=new BusinessSqlite(db);JSONArray integrity=sql.call("sql.query",new JSONObject().put("sql","PRAGMA integrity_check")).getJSONArray("results");if(integrity.length()!=1||!integrity.getJSONObject(0).optString("integrity_check").equals("ok"))throw new IOException("Απέτυχε ο πλήρης έλεγχος ακεραιότητας SQLite.");
                String schema=IndependentRuntime.asset(c,"business-runtime/manifest.json");JSONArray required=new JSONObject(schema).getJSONArray("requiredMigrationTables");
                for(int i=0;i<required.length();i++){String name=required.getString(i);JSONArray rows=sql.call("sql.query",new JSONObject().put("sql","SELECT name FROM sqlite_master WHERE type='table' AND name=?").put("params",new JSONArray().put(name))).getJSONArray("results");if(rows.length()!=1)throw new IOException("STOP: λείπει υποχρεωτικός πίνακας κύριας βάσης: "+name);}
                JSONArray owners=sql.call("sql.query",new JSONObject().put("sql","SELECT id FROM app_users WHERE role='owner' AND active=1 AND login_enabled=1 AND deleted_at IS NULL AND length(password_hash)>0 AND length(password_salt)>0")).getJSONArray("results");if(owners.length()==0)throw new IOException("STOP: το backup δεν περιλαμβάνει ενεργό λογαριασμό ιδιοκτήτη με κωδικό.");
                root.getJSONObject("nativeRecovery").put("ownerId",owners.getJSONObject(0).getString("id"));
            }finally{db.close();}
            File newDb=new File(directory,"new-databases");if(!newDb.mkdirs())throw new IOException("Δεν δημιουργήθηκε ο ιδιωτικός χώρος εισαγωγής.");copy(prepared.database,new File(newDb,NativeColdRestore.DATABASE_NAME));
            final File newFiles=new File(directory,"extracted");newFiles.mkdirs();
            Context isolated=new ContextWrapper(c){@Override public File getFilesDir(){return newFiles;}};
            if(prepared.documents!=null)ServiceDocumentStore.restoreArchive(isolated,NativeBackupRestoreProbe.inventory(prepared.manifest),new FileInputStream(prepared.documents));
            File docs=new File(newFiles,"service-documents"),staged=new File(directory,"new-documents");if(docs.exists()){if(!docs.renameTo(staged))throw new IOException("Δεν προετοιμάστηκαν τα ιδιωτικά αρχεία.");}else if(!staged.mkdirs())throw new IOException("Δεν δημιουργήθηκε ο φάκελος ιδιωτικών αρχείων.");
            // Validate every restored immutable file independently of the ZIP preview.
            for(int i=0;i<objects.length();i++){JSONObject object=objects.getJSONObject(i);File file=new File(staged,object.getString("local_name"));if(!BusinessObjects.validLocalName(file.getName())||!file.isFile()||file.length()!=object.getLong("size")||!NativeDatabaseSnapshot.digest(file).equals(object.getString("sha256")))throw new IOException("STOP: λείπει ή αλλοιώθηκε ιδιωτικό αρχείο μετά την ανάκτηση.");}
            JSONObject config=IndependentConfig.fresh(root).put("restoreProof",proof).put("sourceTables",prepared.manifest.getJSONArray("tables"));
            JSONObject pending=new JSONObject().put("id",id).put("configuration",config);SealedLocalState.write(c,PENDING,ALIAS,pending);sync(staged);sync(newDb);sync(directory);
            core(c).arm(id,prepared.manifest,BusinessRuntime.sha256(pending.toString().getBytes("UTF-8")));core(c).apply();
            c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE).edit().putString("worker_url",IndependentConfig.realm(config)).putString("independent_source_realm",config.getString("sourceScopeRealm")).commit();
            return proof.put("imported",true).put("instanceId",config.getString("instanceId")).put("mode","test");
        }
    }
    static void copy(File from,File to)throws Exception{File parent=to.getParentFile();if(!parent.exists()&&!parent.mkdirs())throw new IOException("Δεν δημιουργήθηκε ιδιωτικός φάκελος.");try(InputStream in=new FileInputStream(from);FileOutputStream out=new FileOutputStream(to)){byte[] bytes=new byte[65536];int n;while((n=in.read(bytes))!=-1)out.write(bytes,0,n);out.getFD().sync();}}
}
