package gr.argyrismitsos.fleetserver;
import android.content.*;import org.json.*;import java.io.*;import java.util.concurrent.atomic.AtomicBoolean;

/** Android control flow. UI receives only public progress, never keys, tickets or recovery roots. */
public final class NativeMigrationController {
    private static final AtomicBoolean running=new AtomicBoolean();
    private static volatile boolean cancelled;
    private static final String STATUS="native_migration_status";
    private NativeMigrationController(){}
    private static SharedPreferences prefs(Context c){return c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);}
    public static JSONObject status(Context c)throws Exception{
        JSONObject progress=new JSONObject(prefs(c).getString(STATUS,"{}"));progress.put("busy",running.get());
        if(!running.get()){try(FleetDataStore store=new FleetDataStore(c)){JSONObject state=NativePrimaryState.read(store.getReadableDatabase());progress.put("phase",state.optString("phase","cloud")).put("generation",state.optString("generation"));}JSONObject identity=NativeIdentity.read(c);if(identity.length()>0)progress.put("fingerprint",BusinessRuntime.sha256(identity.getString("publicKey").getBytes("UTF-8")));}
        return progress.put("portableBackupEnabled",BackupProtection.state(c).optBoolean("enabled"));
    }
    public static void cancel(){cancelled=true;}
    private static void progress(Context c,String realm,String label)throws Exception{
        if(cancelled||Thread.currentThread().isInterrupted()||OtaManager.shouldYieldForUpdate(c)||!realm.equals(prefs(c).getString("worker_url",ServerConfig.DEFAULT_WORKER_URL).replaceAll("/+$","")))throw new InterruptedIOException("Η μεταφορά σταμάτησε με ασφάλεια. Επανάλαβέ την ή ακύρωσε τη μεταφορά από αυτή την οθόνη.");
        JSONObject state=new JSONObject().put("stage",label).put("busy",true).put("updatedAt",System.currentTimeMillis());prefs(c).edit().putString(STATUS,state.toString()).apply();ServerWorkTracker.stage("action:primaryMigration","Μεταφορά κύριας βάσης",label);
    }
    public static JSONObject migrate(final Context c,JSONObject input)throws Exception{
        if(!input.optBoolean("backupCodeSaved")||!BackupProtection.state(c).optBoolean("enabled"))throw new IOException("Ρύθμισε φορητό κωδικό backup και επιβεβαίωσε ότι τον αποθήκευσες εκτός κινητού.");
        if(!running.compareAndSet(false,true))throw new IOException("Εκτελείται ήδη μεταφορά κύριας βάσης.");cancelled=false;boolean locked=false;String error="";
        final String realm=prefs(c).getString("worker_url",ServerConfig.DEFAULT_WORKER_URL).replaceAll("/+$","");
        try(final FleetDataStore store=new FleetDataStore(c)){
            progress(c,realm,"Αναμονή ασφαλούς ολοκλήρωσης τρεχουσών εργασιών");NativeWorkGate.exclusive(new NativeWorkGate.Check(){public void check()throws Exception{progress(c,realm,"Αναμονή ασφαλούς ολοκλήρωσης τρεχουσών εργασιών");}});locked=true;
            NativeDatabaseSnapshot.requireCapabilities(store.getReadableDatabase());if(c.getFilesDir().getUsableSpace()<256L*1024*1024)throw new IOException("Χρειάζονται τουλάχιστον256MB ελεύθερου χώρου πριν από τη μεταφορά.");
            final JSONObject identity=NativeIdentity.create(c,realm);
            JSONObject result=NativeMigrationCoordinator.migrate(store.getWritableDatabase(),identity,input,new File(c.getCacheDir(),"primary-migration"),new File(c.getFilesDir(),"service-documents"),new NativeMigrationTransport(identity,ServerConfig.SERVER_KEY),new NativeMigrationCoordinator.Steps(){
                public JSONObject initialBackup()throws Exception{return BackupJobs.createLocalAutomatic(c,store);}
                public JSONObject initialize(JSONObject identity)throws Exception{return NativePrimaryService.get(c).initializeCandidate(identity);}
                public JSONObject verifiedBackup()throws Exception{return BackupJobs.createLocalAutomatic(c,store);}
                public boolean backupStillValid(JSONObject evidence)throws Exception{try{JSONObject job=BackupJobs.load(c,evidence.getString("backupJobId")),proof=job.getJSONObject("nativeProof");return job.getString("dataSha256").equals(evidence.getString("manifestSha256"))&&proof.optBoolean("restoreVerified")&&proof.optBoolean("documentsVerified")&&proof.getString("databaseSha256").equals(evidence.getString("databaseSha256"))&&BackupJobs.localReady(c,job);}catch(Exception missing){return false;}}
                public void saveIdentity(JSONObject identity)throws Exception{NativeIdentity.save(c,identity);}
                public void progress(String label)throws Exception{NativeMigrationController.progress(c,realm,label);}
            });
            NativePrimaryService.get(c).start();prefs(c).edit().putString(STATUS,new JSONObject().put("phase","active").put("stage","Η κύρια βάση μεταφέρθηκε στον Server").put("updatedAt",System.currentTimeMillis()).toString()).commit();return result;
        }catch(Exception failure){error=failure.getMessage()==null?"Δεν ολοκληρώθηκε η μεταφορά. Επανάλαβε ή ακύρωσε από αυτή την οθόνη.":failure.getMessage();throw failure;}
        finally{if(locked)NativeWorkGate.release();running.set(false);if(!error.isEmpty())prefs(c).edit().putString(STATUS,new JSONObject().put("error",error).put("stage","Η μεταφορά χρειάζεται συνέχεια").put("updatedAt",System.currentTimeMillis()).toString()).commit();}
    }
    public static JSONObject abort(Context c)throws Exception{
        if(!running.compareAndSet(false,true))throw new IOException("Σταμάτησε πρώτα την τρέχουσα μεταφορά και περίμενε την ολοκλήρωση του βήματος.");boolean locked=false;
        try(FleetDataStore store=new FleetDataStore(c)){
            NativeWorkGate.exclusive(new NativeWorkGate.Check(){public void check(){}});locked=true;JSONObject state=NativePrimaryState.read(store.getReadableDatabase());if(!java.util.Arrays.asList("preparing","importing","prepared").contains(state.optString("phase")))throw new IOException("Η ενεργή κύρια βάση δεν ακυρώνεται από αυτή την ενέργεια.");
            JSONObject identity=NativeIdentity.read(c);NativeMigrationTransport cloud=new NativeMigrationTransport(identity,ServerConfig.SERVER_KEY);JSONObject result;
            try{result=cloud.json("/abort","POST",new JSONObject());}catch(Exception uncertain){JSONObject descriptor=cloud.json("/descriptor","GET",null);if(!descriptor.optString("mode").equals("cloud"))throw uncertain;result=new JSONObject().put("aborted",true);}
            if(!result.optBoolean("aborted"))throw new IOException("Δεν επιβεβαιώθηκε η άρση της παλιάς φραγής.");NativePrimaryState.phase(store.getWritableDatabase(),"cloud","","","","");NativeIdentity.clearCandidate(c);prefs(c).edit().putString(STATUS,new JSONObject().put("phase","cloud").put("stage","Η μεταφορά ακυρώθηκε· οι παλιές εγγραφές ενεργοποιήθηκαν ξανά").toString()).commit();return result;
        }finally{if(locked)NativeWorkGate.release();running.set(false);}
    }
}
