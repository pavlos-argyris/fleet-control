package gr.argyrismitsos.fleetserver;
import android.content.*;import android.system.Os;import android.system.OsConstants;
import org.json.*;import java.io.*;

/** Android private vault/settings adapter, invoked before every database helper on process startup. */
public final class NativeColdRuntime {
    private NativeColdRuntime(){}
    static String pendingHash(JSONObject value)throws Exception{return BusinessRuntime.sha256(NativeMigrationCoordinator.canonical(value).getBytes("UTF-8"));}
    static JSONObject pending(Context context,JSONObject marker)throws Exception{
        JSONObject value=NativeIdentity.pendingRecovery(context);if(!value.optString("id").equals(marker.getString("id"))||!pendingHash(value).equals(marker.getString("pendingHash"))||!value.getJSONObject("manifest").getString("sha256").equals(marker.getJSONObject("manifest").getString("sha256")))throw new IOException("Δεν συμφωνεί η προστατευμένη προετοιμασία ανάκτησης.");return value;
    }
    static File databaseDirectory(Context c){return new File(c.getApplicationInfo().dataDir,"databases");}
    public static NativeColdRestore core(final Context context){
        return new NativeColdRestore(context.getFilesDir(),databaseDirectory(context),new File(context.getFilesDir(),"service-documents"),new NativeColdRestore.Ports(){
            public void verifyPending(JSONObject marker)throws Exception{pending(context,marker);}
            public void verifySource(File database,JSONObject manifest)throws Exception{NativeDatabaseSnapshot.verifyReadOnly(database,manifest);}
            public void installSecrets(JSONObject marker)throws Exception{
                JSONObject value=pending(context,marker),identity=value.getJSONObject("identity");
                NativeRecoveryInstall.prepare(new File(databaseDirectory(context),NativeColdRestore.DATABASE_NAME),new File(context.getFilesDir(),"service-documents"),value.getJSONObject("manifest"),identity);
                NativeIdentity.save(context,identity);BackupProtection.restore(context,value.getJSONObject("newProtection"));settings(context,value.getJSONObject("settings"));
                if(!context.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE).edit().putBoolean("native_recovery_pending",true).putString("native_recovery_transaction",value.getString("id")).putString("native_recovery_status",new JSONObject().put("stage","Η βάση ανακτήθηκε· χρειάζεται νέο επαληθευμένο backup και ολοκλήρωση της αλλαγής Server").put("updatedAt",System.currentTimeMillis()).toString()).commit())throw new IOException("Δεν καταγράφηκε η συνέχεια ανάκτησης.");
            }
            public void rollbackSecrets(JSONObject marker)throws Exception{
                JSONObject value=pending(context,marker),identity=value.getJSONObject("oldIdentity");if(identity.length()==0)NativeIdentity.clearCandidate(context);else NativeIdentity.save(context,identity);BackupProtection.restore(context,value.getJSONObject("oldProtection"));settings(context,value.getJSONObject("oldSettings"),false);
                if(!context.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE).edit().putBoolean("native_recovery_pending",value.optBoolean("oldRecoveryPending")).putString("native_recovery_transaction",value.optString("oldRecoveryTransaction")).commit())throw new IOException("Δεν αποκαταστάθηκαν οι προηγούμενες ρυθμίσεις ανάκτησης.");
            }
            public void syncDirectory(File directory)throws Exception{NativeColdRuntime.sync(directory);}
            public void checkpoint(String phase)throws Exception{
                String label=phase.equals("swapping")?"Ασφαλής αλλαγή αρχείων βάσης":phase.equals("database_installed")?"Η βάση τοποθετήθηκε· έλεγχος ιδιωτικών αρχείων":phase.equals("documents_installed")?"Τα ιδιωτικά αρχεία τοποθετήθηκαν":phase.equals("installing_secrets")?"Έλεγχος λογαριασμών και προστατευμένης ταυτότητας":phase.equals("installed")?"Η τοπική ανάκτηση ολοκληρώθηκε":"Συνεπής μεταφορά και διατήρηση προηγούμενων αρχείων";
                context.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE).edit().putString("native_recovery_step",label).apply();
            }
        });
    }
    static void sync(File directory)throws Exception{FileDescriptor fd=Os.open(directory.getAbsolutePath(),OsConstants.O_RDONLY,0);try{Os.fsync(fd);}finally{Os.close(fd);}}
    static void settings(Context context,JSONObject settings)throws Exception{settings(context,settings,true);}
    private static void settings(Context context,JSONObject settings,boolean strict)throws Exception{
        String realm=settings.getString("workerUrl");java.net.URI uri=new java.net.URI(realm);if(strict&&(!"https".equals(uri.getScheme())||uri.getHost()==null||uri.getRawUserInfo()!=null||uri.getRawQuery()!=null||uri.getRawFragment()!=null||!uri.getPath().isEmpty()))throw new IOException("Μη έγκυρη σύνδεση ανάκτησης Fleet.");
        String frequency=settings.optString("backupFrequency","daily");if(!java.util.Arrays.asList("daily","weekdays","weekly").contains(frequency))throw new IOException("Μη συμβατή συχνότητα backup.");
        if(!context.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE).edit().putString("worker_url",realm).putInt("sync_seconds",Math.max(10,Math.min(60,settings.optInt("syncSeconds",30)))).putInt(BackupManager.KEY_HOUR,Math.max(0,Math.min(23,settings.optInt("backupHour",3)))).putInt(BackupManager.KEY_RETENTION,Math.max(1,Math.min(90,settings.optInt("backupRetention",30)))).putString(BackupManager.KEY_FREQUENCY,frequency).putBoolean("automatic_backup",settings.optBoolean("automaticBackup",true)).putBoolean("automatic_start",settings.optBoolean("automaticStart",true)).commit())throw new IOException("Δεν αποθηκεύτηκαν οι ρυθμίσεις ανάκτησης.");
    }
    public static boolean blocked(Context context){return context.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE).getBoolean("native_recovery_blocked",false);}
    public static void prepareStartup(Context context){
        SharedPreferences prefs=context.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);try{String phase=core(context).state().optString("phase");boolean pending=java.util.Arrays.asList("ready","swapping","database_installed","documents_installed","installing_secrets").contains(phase),known=pending||java.util.Arrays.asList("","installed","failed").contains(phase);prefs.edit().putBoolean("native_recovery_blocked",pending||!known).putBoolean("native_recovery_startup_pending",pending).commit();}catch(Exception error){prefs.edit().putBoolean("native_recovery_blocked",true).putBoolean("native_recovery_startup_pending",false).commit();}
    }
    public static void applyIfPending(Context context){
        SharedPreferences prefs=context.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);
        try{core(context).apply();prefs.edit().putBoolean("native_recovery_blocked",false).putBoolean("native_recovery_startup_pending",false).putString("native_recovery_error","").commit();}
        catch(Exception error){boolean unsafe=true;try{unsafe=!core(context).state().optString("phase").equals("failed");}catch(Exception ignored){}prefs.edit().putBoolean("native_recovery_blocked",unsafe).putBoolean("native_recovery_startup_pending",false).putString("native_recovery_error",error.getMessage()==null?"Η ανάκτηση χρειάζεται επανάληψη πριν ανοίξει η βάση.":error.getMessage()).commit();}
    }
}
