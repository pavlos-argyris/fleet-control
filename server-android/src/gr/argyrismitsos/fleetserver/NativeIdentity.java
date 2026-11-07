package gr.argyrismitsos.fleetserver;
import android.content.Context;import android.util.Base64;import org.json.*;import java.security.SecureRandom;

/** Primary authority identity is separate from the old read-only pairing identity. */
public final class NativeIdentity {
    private static final String NAME="primary.identity",ALIAS="fleet.primary.identity.v1";
    private NativeIdentity(){}
    private static String random(){byte[] bytes=new byte[32];new SecureRandom().nextBytes(bytes);return Base64.encodeToString(bytes,Base64.URL_SAFE|Base64.NO_WRAP|Base64.NO_PADDING);}
    public static JSONObject read(Context context)throws Exception{
        JSONObject value=SealedLocalState.read(context,NAME,ALIAS);
        if(value.length()>0&&!value.has("publicSalt")&&value.has("secret")){value.put("publicSalt",value.getString("secret")).remove("secret");save(context,value);}return value;
    }
    public static void save(Context context,JSONObject identity)throws Exception{SealedLocalState.write(context,NAME,ALIAS,identity);}
    static void clearCandidate(Context context)throws Exception{SealedLocalState.remove(context,NAME);}
    public static JSONObject create(Context context,String realm)throws Exception{
        JSONObject prior=read(context);if(prior.length()>0){if(!prior.getString("realm").equals(realm))throw new java.io.IOException("Η προστατευμένη ταυτότητα ανήκει σε άλλη σύνδεση Fleet. Χρειάζεται ελεγχόμενη μεταφορά.");return prior;}
        JSONObject value=DirectCipher.identity().put("schemaVersion",1).put("realm",realm).put("generation",java.util.UUID.randomUUID().toString()).put("authPepper",random()).put("recoveryToken",random()).put("migrationTicket",random());value.put("publicSalt",value.getString("secret")).remove("secret");save(context,value);return value;
    }
    public static JSONObject backupRoot(Context context)throws Exception{
        JSONObject identity=read(context);if(identity.length()==0)throw new java.io.IOException("Λείπει το προστατευμένο στοιχείο ανάκτησης κύριας βάσης.");
        return new JSONObject().put("schemaVersion",1).put("realm",identity.getString("realm")).put("authPepper",identity.getString("authPepper")).put("recoveryToken",identity.getString("recoveryToken")).put("ownerId",identity.optString("ownerId")).put("sourceGeneration",identity.getString("generation")).put("sourceFingerprint",BusinessRuntime.sha256(identity.getString("publicKey").getBytes("UTF-8")));
    }
    public static JSONObject recoveryCandidate(JSONObject root,String ownerId)throws Exception{
        if(root.getInt("schemaVersion")!=1||!root.getString("recoveryToken").matches("[A-Za-z0-9_-]{43}")||root.getString("authPepper").length()>512)throw new java.io.IOException("Μη συμβατό στοιχείο ανάκτησης.");
        JSONObject value=DirectCipher.identity().put("schemaVersion",1).put("realm",root.getString("realm")).put("generation",java.util.UUID.randomUUID().toString()).put("authPepper",root.getString("authPepper")).put("recoveryToken",random()).put("recoveryProof",root.getString("recoveryToken")).put("ownerId",ownerId).put("sourceGeneration",root.getString("sourceGeneration"));value.put("publicSalt",value.getString("secret")).remove("secret");return value;
    }
    static JSONObject pendingRecovery(Context context)throws Exception{return SealedLocalState.read(context,"primary.recovery.pending","fleet.primary.recovery.pending.v1");}
    static void pendingRecovery(Context context,JSONObject value)throws Exception{SealedLocalState.write(context,"primary.recovery.pending","fleet.primary.recovery.pending.v1",value);}
}
