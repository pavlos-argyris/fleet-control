package gr.argyrismitsos.fleetserver;
import android.content.Context;import android.util.Base64;import org.json.*;

/** Stores only a Keystore-wrapped derived key. The user's recovery code is not saved. */
public final class BackupProtection {
    private static final String NAME="backup.protection",ALIAS="fleet.backup.protection.v1";
    private BackupProtection(){}
    public static PortableBackupCipher.Material material(Context context)throws Exception{
        JSONObject saved=SealedLocalState.read(context,NAME,ALIAS);if(saved.length()==0)return null;
        byte[] key=Base64.decode(saved.getString("derivedKey"),Base64.NO_WRAP);try{return new PortableBackupCipher.Material(saved.getJSONObject("parameters"),key);}finally{java.util.Arrays.fill(key,(byte)0);}
    }
    public static JSONObject state(Context context)throws Exception{
        JSONObject saved=SealedLocalState.read(context,NAME,ALIAS);return new JSONObject().put("enabled",saved.length()>0).put("keyId",saved.length()==0?"":saved.getJSONObject("parameters").getString("keyId")).put("configuredAt",saved.optString("configuredAt"));
    }
    public static JSONObject configure(Context context,String password)throws Exception{
        try(PortableBackupCipher.Material material=PortableBackupCipher.create(password)){
            byte[] key=material.key();try{SealedLocalState.write(context,NAME,ALIAS,new JSONObject().put("parameters",material.parameters).put("derivedKey",Base64.encodeToString(key,Base64.NO_WRAP)).put("configuredAt",new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX",java.util.Locale.US).format(new java.util.Date())));}finally{java.util.Arrays.fill(key,(byte)0);}
        }
        return state(context);
    }
    public static void disable(Context context,FleetDataStore store)throws Exception{
        if(NativePrimaryState.hasImportedData(store.getReadableDatabase()))throw new java.io.IOException("Η κύρια βάση Server χρειάζεται φορητό κωδικό ανάκτησης. Μπορείς να αλλάξεις τον κωδικό και να δημιουργήσεις νέο backup.");
        SealedLocalState.remove(context,NAME);
    }
}
