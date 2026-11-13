package gr.argyrismitsos.fleetdirect;
import android.content.*;import android.net.Uri;import org.sqlite.database.sqlite.SQLiteDatabase;
import org.json.*;import java.io.*;import java.util.*;import java.util.concurrent.atomic.AtomicBoolean;

/** Portable recovery controller. Complete private preparation precedes an explicit cold restart. */
public final class NativeRecoveryController {
    private static final String PREVIEW="primary.recovery.preview",ALIAS="fleet.primary.recovery.preview.v1",STATUS="native_recovery_status";
    private static final AtomicBoolean running=new AtomicBoolean();
    private static volatile boolean replacing;
    static boolean replacing(){return replacing;}
    private NativeRecoveryController(){}
    private static SharedPreferences prefs(Context c){return c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);}
    private static void stage(Context c,String label)throws Exception{if(Thread.currentThread().isInterrupted()||OtaManager.shouldYieldForUpdate(c))throw new InterruptedIOException("Η ανάκτηση σταμάτησε με ασφάλεια πριν ολοκληρωθεί. Επανάλαβε από αυτή την οθόνη.");prefs(c).edit().putString(STATUS,new JSONObject().put("stage",label).put("updatedAt",System.currentTimeMillis()).toString()).apply();ServerWorkTracker.stage("action:primaryRecovery","Ανάκτηση Server",label);}
    private static void copy(File source,File destination)throws Exception{File parent=destination.getParentFile();if(!parent.exists()&&!parent.mkdirs())throw new IOException("Δεν δημιουργήθηκε ο χώρος ανάκτησης.");try(InputStream input=new BufferedInputStream(new FileInputStream(source));FileOutputStream output=new FileOutputStream(destination)){byte[] buffer=new byte[65536];int n;while((n=input.read(buffer))!=-1)output.write(buffer,0,n);output.getFD().sync();}}
    public static JSONObject preview(final Context c,Uri uri,String password)throws Exception{
        if(!running.compareAndSet(false,true))throw new IOException("Εκτελείται ήδη προετοιμασία ανάκτησης.");
        try{
            JSONObject existing=NativeColdRuntime.core(c).state();if(!Arrays.asList("","installed","failed").contains(existing.optString("phase")))throw new IOException("Υπάρχει ήδη προετοιμασμένη ανάκτηση. Επανεκκίνησε για να συνεχιστεί.");
            stage(c,"Άνοιγμα και έλεγχος πλήρους φορητού backup");JSONObject root=BackupManager.readBackupRoot(c,uri,password);if(!NativeBackupReader.isNative(root))throw new IOException("Για αυτό το παλιότερο αντίγραφο χρησιμοποίησε την επαναφορά παλιού backup.");
            String id=UUID.randomUUID().toString();final File directory=NativeColdRuntime.core(c).directory(id);
            try(NativeBackupReader.Prepared prepared=BackupManager.readNative(c,uri,root,password)){
                long needed=prepared.database.length()*3+32L*1024*1024;JSONArray objects=prepared.manifest.getJSONArray("objects");for(int i=0;i<objects.length();i++)needed+=objects.getJSONObject(i).getLong("size")*3;
                if(c.getFilesDir().getUsableSpace()<needed)throw new IOException("Δεν υπάρχει αρκετός χώρος για ασφαλή ανάκτηση και διατήρηση των προηγούμενων αρχείων.");
                stage(c,"Πραγματική απομονωμένη δοκιμή βάσης και ιδιωτικών αρχείων");JSONObject proof=NativeBackupRestoreProbe.run(c,prepared.database,prepared.manifest,prepared.documents);if(!proof.optBoolean("restoreVerified")||!proof.optBoolean("documentsVerified"))throw new IOException("Δεν επαληθεύτηκε πλήρης ανάκτηση.");
                JSONArray accounts;SQLiteDatabase database=SQLiteDatabase.openDatabase(prepared.database.getPath(),null,SQLiteDatabase.OPEN_READONLY);try{accounts=new BusinessSqlite(database).call("sql.query",new JSONObject().put("sql","SELECT id,full_name,username,role,active,login_enabled,deleted_at FROM app_users ORDER BY role,full_name,id")).getJSONArray("results");}finally{database.close();}
                boolean owner=false;for(int i=0;i<accounts.length();i++){JSONObject account=accounts.getJSONObject(i);if(account.optString("role").equals("owner")&&account.optInt("active")==1&&account.optInt("login_enabled")==1&&account.isNull("deleted_at"))owner=true;}if(!owner)throw new IOException("Το backup δεν περιέχει ενεργό λογαριασμό ιδιοκτήτη. Δεν μπορεί να ενεργοποιηθεί ως κύρια βάση.");
                stage(c,"Προετοιμασία επαληθευμένων αρχείων για την επόμενη εκκίνηση");copy(prepared.database,new File(directory,"new-databases/"+NativeColdRestore.DATABASE_NAME));File newDocs=new File(directory,"new-documents");if(!newDocs.mkdirs())throw new IOException("Δεν δημιουργήθηκε ο χώρος ιδιωτικών αρχείων ανάκτησης.");
                if(prepared.documents!=null){Context isolated=new ContextWrapper(c){@Override public File getFilesDir(){return directory;}@Override public File getCacheDir(){File file=new File(directory,"cache");file.mkdirs();return file;}};ServiceDocumentStore.restoreArchive(isolated,NativeBackupRestoreProbe.inventory(prepared.manifest),new FileInputStream(prepared.documents));File restored=new File(directory,"service-documents");if(!newDocs.delete()||!restored.renameTo(newDocs))throw new IOException("Δεν προετοιμάστηκαν όλα τα ιδιωτικά αρχεία ανάκτησης.");}
                JSONObject protection=password==null?BackupProtection.snapshot(c):BackupProtection.candidate(password);if(protection.length()==0)throw new IOException("Χρειάζεται φορητός κωδικός για το νέο backup ανάκτησης.");
                JSONObject settings=root.getJSONObject("settings");settings.put("workerUrl",root.getJSONObject("nativeRecovery").getString("realm"));
                JSONObject value=new JSONObject().put("id",id).put("createdAt",System.currentTimeMillis()).put("backupCreatedAt",root.getString("createdAt")).put("fileName",BackupManager.queryDisplayName(c,uri)).put("manifest",prepared.manifest).put("recovery",root.getJSONObject("nativeRecovery")).put("settings",settings).put("newProtection",protection).put("accounts",accounts).put("proof",proof);
                SealedLocalState.write(c,PREVIEW,ALIAS,value);return publicPreview(value);
            }
        }finally{running.set(false);}
    }
    private static JSONObject publicPreview(JSONObject value)throws Exception{return new JSONObject().put("previewId",value.getString("id")).put("fileName",value.getString("fileName")).put("backupCreatedAt",value.getString("backupCreatedAt")).put("accounts",value.getJSONArray("accounts")).put("tables",value.getJSONObject("manifest").getJSONArray("tables")).put("documents",value.getJSONObject("manifest").getJSONArray("objects").length()).put("restoreVerified",value.getJSONObject("proof").optBoolean("restoreVerified")).put("documentsVerified",value.getJSONObject("proof").optBoolean("documentsVerified"));}
    public static JSONObject status(Context c)throws Exception{
        JSONObject value=new JSONObject(prefs(c).getString(STATUS,"{}"));value.put("busy",running.get()).put("blocked",NativeColdRuntime.blocked(c)).put("coldPhase",NativeColdRuntime.core(c).state().optString("phase"));
        value.put("phase",prefs(c).getBoolean("native_recovery_pending",false)?"recovering":"active");
        JSONObject config=IndependentConfig.read(c);if(config.has("instanceId"))value.put("fingerprint",BusinessRuntime.sha256(config.getString("instanceId").getBytes("UTF-8")));return value;
    }
    public static JSONObject prepare(Context c,JSONObject input)throws Exception{
        if(!input.optBoolean("accountsReviewed")||!input.optBoolean("backupCodeSaved")||!input.optBoolean("replaceConfirmed"))throw new IOException("Έλεγξε τους λογαριασμούς και επιβεβαίωσε το backup και την αντικατάσταση.");
        if(!running.compareAndSet(false,true))throw new IOException("Εκτελείται ήδη ανάκτηση.");boolean locked=false;replacing=true;
        try(FleetDataStore store=new FleetDataStore(c)){
            JSONObject preview=SealedLocalState.read(c,PREVIEW,ALIAS);
            if(!preview.optString("id").equals(input.getString("previewId"))||System.currentTimeMillis()-preview.optLong("createdAt")>86400000)throw new IOException("Η προεπισκόπηση έληξε. Άνοιξε ξανά το backup.");
            String owner=input.getString("ownerId");boolean eligible=false;JSONArray accounts=preview.getJSONArray("accounts");
            for(int i=0;i<accounts.length();i++){JSONObject a=accounts.getJSONObject(i);if(a.optString("id").equals(owner)&&a.optString("role").equals("owner")&&a.optInt("active")==1&&a.optInt("login_enabled")==1&&a.isNull("deleted_at"))eligible=true;}
            if(!eligible)throw new IOException("Επίλεξε ενεργό ιδιοκτήτη από το backup.");
            final long deadline=System.currentTimeMillis()+45000;
            NativeWorkGate.exclusive(()->{if(System.currentTimeMillis()>deadline)throw new IOException("Ο Server είναι απασχολημένος. Τα τωρινά δεδομένα διατηρήθηκαν.");});locked=true;
            IndependentRuntime.get(c).barrier();
            stage(c,"Πλήρες τοπικό αντίγραφο πριν από την αντικατάσταση Direct");
            JSONObject before=BackupJobs.createLocalAutomatic(c,store);if(!BackupJobs.localReady(c,before)||!before.getJSONObject("nativeProof").optBoolean("restoreVerified"))throw new IOException("Δεν επαληθεύτηκε το αντίγραφο των τωρινών δεδομένων Direct.");
            JSONObject old=IndependentConfig.read(c),backup=new JSONObject().put("nativeRecovery",preview.getJSONObject("recovery")).put("nativeDatabase",preview.getJSONObject("manifest")).put("createdAt",preview.getString("backupCreatedAt")).put("settings",preview.getJSONObject("settings"));
            JSONObject config=new JSONObject(old.toString()),fresh=IndependentConfig.fresh(backup);java.util.Iterator<String> keys=fresh.keys();while(keys.hasNext()){String key=keys.next();config.put(key,fresh.get(key));}
            config.put("ownerId",owner).put("hostname","fleet-control.duckdns.org").put("restoreProof",preview.getJSONObject("proof")).put("sourceTables",preview.getJSONObject("manifest").getJSONArray("tables")).put("testOrdexa",false);
            JSONObject pending=new JSONObject().put("id",preview.getString("id")).put("configuration",config).put("manifest",preview.getJSONObject("manifest")).put("settings",preview.getJSONObject("settings")).put("oldConfiguration",old).put("oldSettings",BackupManager.settingsPayload(c)).put("oldProtection",BackupProtection.snapshot(c)).put("newProtection",preview.getJSONObject("newProtection")).put("oldRecoveryPending",prefs(c).getBoolean("native_recovery_pending",false)).put("beforeBackupId",before.getString("id"));
            SealedLocalState.write(c,NativeColdRuntime.PENDING,NativeColdRuntime.ALIAS,pending);
            NativeColdRuntime.core(c).arm(pending.getString("id"),pending.getJSONObject("manifest"),NativeColdRuntime.pendingHash(pending));
            prefs(c).edit().putBoolean("native_recovery_blocked",true).commit();
            stage(c,"Έτοιμη η ανάκτηση Direct. Επανεκκίνησε για ασφαλή εφαρμογή.");
            return new JSONObject().put("restartRequired",true).put("restoreVerified",true).put("documentsVerified",true);
        }finally{if(locked)NativeWorkGate.release();replacing=false;running.set(false);}
    }
    public static JSONObject finish(Context c)throws Exception{
        if(!running.compareAndSet(false,true))throw new IOException("Εκτελείται ήδη ανάκτηση.");replacing=true;
        try(FleetDataStore store=new FleetDataStore(c)){
            if(!prefs(c).getBoolean("native_recovery_pending",false)||!NativeColdRuntime.core(c).state().optString("phase").equals("installed"))throw new IOException("Δεν υπάρχει εγκατεστημένη ανάκτηση Direct προς ολοκλήρωση.");
            IndependentRuntime.get(c).barrier();
            JSONObject job=BackupJobs.createLocalAutomatic(c,store),proof=job.getJSONObject("nativeProof");
            if(!job.optBoolean("portable")||!proof.optBoolean("restoreVerified")||!proof.optBoolean("documentsVerified")||!BackupJobs.localReady(c,job))throw new IOException("Δεν επαληθεύτηκε το νέο πλήρες backup Direct.");
            JSONObject config=IndependentConfig.read(c);org.sqlite.database.sqlite.SQLiteDatabase db=store.getWritableDatabase();db.beginTransaction();try{
                db.execSQL("UPDATE auth_sessions SET revoked_at=? WHERE revoked_at IS NULL",new Object[]{System.currentTimeMillis()/1000});db.execSQL("DELETE FROM independent_readiness");
                db.execSQL("INSERT OR REPLACE INTO independent_instance(id,instance_id,mode) VALUES(1,?,'test')",new Object[]{config.getString("instanceId")});
                NativePrimaryState.phase(db,"active",IndependentConfig.realm(config),config.getString("generation"),config.getString("ownerId"),config.getString("backupSha256"));db.setTransactionSuccessful();
            }finally{db.endTransaction();}
            OrdexaSync.clearForRecovery(c);
            if(!prefs(c).edit().putBoolean("native_recovery_pending",false).putString(STATUS,new JSONObject().put("stage","Η ανάκτηση Direct ολοκληρώθηκε. Χρειάζεται νέα σύνδεση χρηστών και Ordexa.").put("updatedAt",System.currentTimeMillis()).toString()).commit())throw new IOException("Δεν καταγράφηκε η ολοκλήρωση ανάκτησης.");
            return new JSONObject().put("active",true).put("restoreVerified",true).put("documentsVerified",true).put("newBackupVerified",true).put("connected",IndependentService.listenerOnline());
        }finally{replacing=false;running.set(false);}
    }
}
