package gr.argyrismitsos.fleetdirect;
import android.content.*;import org.json.*;import java.io.*;
import gr.argyrismitsos.fleetserver.BackendMode;

/** Cold swaps are restricted to Direct's database/documents directories. */
public final class NativeColdRuntime{
    static final String PENDING="direct.recovery.pending",ALIAS="fleet.direct.recovery.pending.v1";
    private NativeColdRuntime(){}
    static String pendingHash(JSONObject value)throws Exception{return BusinessRuntime.sha256(NativeMigrationCoordinator.canonical(value).getBytes("UTF-8"));}
    static JSONObject pending(Context c)throws Exception{return SealedLocalState.read(c,PENDING,ALIAS);}
    static JSONObject pending(Context c,JSONObject marker)throws Exception{JSONObject v=pending(c);if(!v.optString("id").equals(marker.getString("id"))||!pendingHash(v).equals(marker.getString("pendingHash")))throw new IOException("Δεν συμφωνεί η προστατευμένη ανάκτηση Direct.");return v;}
    static File databaseDirectory(Context c){return c.getDatabasePath(NativeColdRestore.DATABASE_NAME).getParentFile();}
    public static NativeColdRestore core(final Context c){return new NativeColdRestore(c.getFilesDir(),databaseDirectory(c),new File(c.getFilesDir(),"service-documents"),new NativeColdRestore.Ports(){
        public void verifyPending(JSONObject marker)throws Exception{pending(c,marker);}
        public void verifySource(File database,JSONObject manifest)throws Exception{NativeDatabaseSnapshot.verifyReadOnly(database,manifest);}
        public void installSecrets(JSONObject marker)throws Exception{
            JSONObject p=pending(c,marker),config=p.getJSONObject("configuration");
            File database=new File(databaseDirectory(c),NativeColdRestore.DATABASE_NAME);
            JSONObject identity=new JSONObject().put("realm",BackendMode.DIRECT).put("generation",config.getString("generation")).put("ownerId",config.getString("ownerId"));
            NativeRecoveryInstall.prepare(database,new File(c.getFilesDir(),"service-documents"),p.getJSONObject("manifest"),identity);
            IndependentConfig.save(c,config);BackupProtection.restore(c,p.getJSONObject("newProtection"));settings(c,p.getJSONObject("settings"));
            if(!c.getSharedPreferences(BackupManager.PREFS,0).edit().putBoolean("native_recovery_pending",true).putString("native_recovery_status",new JSONObject().put("stage","Η βάση Direct ανακτήθηκε. Ολοκλήρωσε τον έλεγχο του νέου backup.").toString()).commit())throw new IOException("Δεν αποθηκεύτηκε η συνέχεια ανάκτησης Direct.");
        }
        public void rollbackSecrets(JSONObject marker)throws Exception{
            JSONObject p=pending(c,marker);IndependentConfig.save(c,p.getJSONObject("oldConfiguration"));BackupProtection.restore(c,p.getJSONObject("oldProtection"));settings(c,p.getJSONObject("oldSettings"));
            c.getSharedPreferences(BackupManager.PREFS,0).edit().putBoolean("native_recovery_pending",p.optBoolean("oldRecoveryPending")).commit();
        }
        public void syncDirectory(File dir)throws Exception{sync(dir);}
    });}
    static void settings(Context c,JSONObject settings)throws Exception{
        String frequency=settings.optString("backupFrequency","daily");if(!java.util.Arrays.asList("daily","weekdays","weekly").contains(frequency))throw new IOException("Μη συμβατές ρυθμίσεις backup.");
        if(!c.getSharedPreferences(BackupManager.PREFS,0).edit().putString("worker_url",BackendMode.DIRECT).putInt("sync_seconds",Math.max(10,Math.min(60,settings.optInt("syncSeconds",30)))).putInt(BackupManager.KEY_HOUR,Math.max(0,Math.min(23,settings.optInt("backupHour",3)))).putInt(BackupManager.KEY_RETENTION,Math.max(1,Math.min(90,settings.optInt("backupRetention",30)))).putString(BackupManager.KEY_FREQUENCY,frequency).putBoolean("automatic_backup",settings.optBoolean("automaticBackup",true)).putBoolean("automatic_start",settings.optBoolean("automaticStart",true)).commit())throw new IOException("Δεν αποθηκεύτηκαν οι ρυθμίσεις Direct.");
    }
    static void sync(File directory)throws Exception{IndependentRestore.sync(directory);}
    public static boolean blocked(Context c){return c.getSharedPreferences(BackupManager.PREFS,0).getBoolean("native_recovery_blocked",false);}
    public static void prepareStartup(Context c){try{String phase=core(c).state().optString("phase");boolean pending=java.util.Arrays.asList("ready","swapping","database_installed","documents_installed","installing_secrets").contains(phase);c.getSharedPreferences(BackupManager.PREFS,0).edit().putBoolean("native_recovery_blocked",pending).putBoolean("native_recovery_startup_pending",pending).commit();}catch(Exception e){c.getSharedPreferences(BackupManager.PREFS,0).edit().putBoolean("native_recovery_blocked",true).commit();}}
    public static void applyIfPending(Context c){try{core(c).apply();c.getSharedPreferences(BackupManager.PREFS,0).edit().putBoolean("native_recovery_blocked",false).putBoolean("native_recovery_startup_pending",false).commit();}catch(Exception e){c.getSharedPreferences(BackupManager.PREFS,0).edit().putBoolean("native_recovery_blocked",true).commit();}}
}
