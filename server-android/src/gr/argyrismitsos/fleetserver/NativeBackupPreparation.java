package gr.argyrismitsos.fleetserver;
import android.content.Context;import org.json.*;import java.io.File;

/** Android-specific secret access stays outside the portable archive builder. */
public final class NativeBackupPreparation {
    private NativeBackupPreparation(){}
    public static JSONObject prepareIfImported(Context context,FleetDataStore store,File directory,String id,BackupEnvelope envelope,NativeBackupBuilder.Progress progress)throws Exception{
        if(!NativePrimaryState.hasImportedData(store.getReadableDatabase()))return null;
        String phase=NativePrimaryState.read(store.getReadableDatabase()).getString("phase");
        JSONObject job=NativeBackupBuilder.prepare(context,store.getReadableDatabase(),directory,id,BackupManager.settingsPayload(context),NativeIdentity.backupRoot(context),envelope,phase.equals("prepared")||phase.equals("recovering"),progress);
        JSONObject proof=job.getJSONObject("nativeProof");
        if(proof.optBoolean("restoreVerified")){
            proof.put("checkedAt",new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX",java.util.Locale.US).format(new java.util.Date())).put("fileName","Τοπικό πλήρες αντίγραφο").put("protectionKeyId",envelope.keyId());
            if(!context.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE).edit().putString(BackupManager.KEY_RESTORE_TEST,proof.toString()).commit())throw new java.io.IOException("Δεν αποθηκεύτηκε η απόδειξη πραγματικής ανάκτησης.");
        }
        return job;
    }
}
