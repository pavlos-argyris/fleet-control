package gr.argyrismitsos.fleetdirect;

import android.content.Context;
import org.json.*;
import java.io.*;
import java.util.concurrent.atomic.AtomicBoolean;
import gr.argyrismitsos.fleetserver.BackendMode;

/** Adapts the existing native Server controls to the independent authority. */
public final class DirectHost {
    private static final AtomicBoolean resumed=new AtomicBoolean();
    private static boolean started;
    private DirectHost(){}
    static void initialize(Context c){
        try{
            startup(c);
            if(!NativeColdRuntime.blocked(c)&&IndependentConfig.read(c).has("backupSha256"))IndependentRuntime.get(c);
        }catch(Exception error){c.getSharedPreferences(BackupManager.PREFS,0).edit().putBoolean("native_recovery_blocked",true).commit();c.getSharedPreferences("independent_ui",0).edit().putString("blocked","Η προετοιμασία Direct χρειάζεται έλεγχο πριν ανοίξει η βάση.").commit();}
    }
    static synchronized void startup(Context c)throws Exception{
        if(started){if(NativeColdRuntime.blocked(c))throw new IOException("Επανεκκίνησε για την έτοιμη ανάκτηση Direct.");return;}
        IndependentSqlite.initialize(c);JSONObject state=NativeColdRuntime.core(c).state();
        boolean direct=!state.optString("id").isEmpty()&&state.optString("id").equals(NativeColdRuntime.pending(c).optString("id"));
        if(direct){NativeColdRuntime.prepareStartup(c);if(c.getSharedPreferences(BackupManager.PREFS,0).getBoolean("native_recovery_startup_pending",false))NativeColdRuntime.applyIfPending(c);}
        else IndependentRestore.startup(c);
        if(NativeColdRuntime.blocked(c))throw new IOException("Η ανάκτηση Direct χρειάζεται συνέχεια πριν ανοίξει η βάση.");
        c.getSharedPreferences("independent_ui",0).edit().remove("blocked").commit();
        started=true;
    }
    static boolean paused(Context c){return NativeRecoveryController.replacing()||NativeColdRuntime.blocked(c)||c.getSharedPreferences(BackupManager.PREFS,0).getBoolean("native_recovery_pending",false)||c.getSharedPreferences(BackupManager.PREFS,0).getBoolean("ota_quiescing",false);}
    static JSONObject primary(Context c)throws Exception{
        JSONObject config=IndependentConfig.read(c);
        return new JSONObject().put("phase",c.getSharedPreferences(BackupManager.PREFS,0).getBoolean("native_recovery_pending",false)?"recovering":"active").put("realm",BackendMode.DIRECT).put("ready",config.has("backupSha256")).put("available",IndependentService.listenerOnline()).put("direct",true);
    }
    static JSONObject access(Context c)throws Exception{return new JSONObject().put("enabled",true).put("paired",true).put("direct",true).put("realm",BackendMode.DIRECT).put("online",IndependentService.listenerOnline()).put("message","Σύνδεση στο fleet-control.duckdns.org με όνομα χρήστη και κωδικό.");}
    static void cloudOnly()throws IOException{throw new IOException("Η μεταφορά Cloudflare είναι διαθέσιμη στη λειτουργία Cloudflare. Ο διακόπτης διατηρεί ανεξάρτητα τα δεδομένα των δύο λειτουργιών.");}
    static JSONObject prepareBackup(Context c,FleetDataStore store,File directory,String id,BackupEnvelope envelope,NativeBackupBuilder.Progress progress)throws Exception{
        JSONObject config=IndependentConfig.read(c);
        JSONObject recovery=new JSONObject().put("schemaVersion",1).put("realm",IndependentConfig.realm(config)).put("authPepper",config.getString("authPepper")).put("recoveryToken",config.getString("recoveryToken")).put("ownerId",config.getString("ownerId")).put("sourceGeneration",config.getString("generation")).put("sourceFingerprint",BusinessRuntime.sha256(config.getString("instanceId").getBytes("UTF-8")));
        JSONObject settings=BackupManager.settingsPayload(c).put("workerUrl",IndependentConfig.realm(config)).put("sourceScopeRealm",config.getString("sourceScopeRealm"));
        JSONObject job=NativeBackupBuilder.prepare(c,store.getReadableDatabase(),directory,id,settings,recovery,envelope,true,progress);
        JSONObject proof=job.getJSONObject("nativeProof");if(!proof.optBoolean("restoreVerified")||!proof.optBoolean("documentsVerified"))throw new IOException("Δεν επαληθεύτηκε το πλήρες αντίγραφο Direct.");
        proof.put("checkedAt",new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX",java.util.Locale.US).format(new java.util.Date())).put("fileName","Τοπικό πλήρες αντίγραφο Direct").put("protectionKeyId",envelope.keyId());
        if(!c.getSharedPreferences(BackupManager.PREFS,0).edit().putString(BackupManager.KEY_RESTORE_TEST,proof.toString()).commit())throw new IOException("Δεν καταγράφηκε η επαλήθευση του αντιγράφου.");
        return job;
    }
    static void maintenance(Context c,IndependentRuntime runtime)throws Exception{
        if(NativeColdRuntime.blocked(c)||NativeRecoveryController.replacing()||c.getSharedPreferences(BackupManager.PREFS,0).getBoolean("native_recovery_pending",false))return;
        if(resumed.compareAndSet(false,true))OtaManager.resumeAfterRestart(c);
        OtaManager.check(c,false);
        try(FleetDataStore store=new FleetDataStore(c)){
            if(!paused(c))BackupManager.maybeAutomatic(c,store);
            OtaManager.maybeApply(c,store);
        }
    }
}
