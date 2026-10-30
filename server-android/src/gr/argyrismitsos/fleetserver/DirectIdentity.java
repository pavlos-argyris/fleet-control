package gr.argyrismitsos.fleetserver;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.security.KeyStore;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Device identity is sealed by AndroidKeyStore and excluded from data backups. */
public final class DirectIdentity {
    private static final String PREFS="fleet_direct_identity",ALIAS="fleet.direct.identity.v1";
    private static SharedPreferences preferences(Context context){return context.getSharedPreferences(PREFS,Context.MODE_PRIVATE);}
    private static SecretKey key()throws Exception{
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);if(!store.containsAlias(ALIAS)){KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");generator.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());generator.generateKey();}return (SecretKey)store.getKey(ALIAS,null);
    }
    public static JSONObject read(Context context)throws Exception{
        String raw=preferences(context).getString("identity","");if(raw.length()==0)return new JSONObject();JSONObject saved=new JSONObject(raw);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(saved.getString("iv"),Base64.NO_WRAP)));return new JSONObject(new String(cipher.doFinal(Base64.decode(saved.getString("value"),Base64.NO_WRAP)),"UTF-8"));
    }
    public static void rotate(Context context)throws Exception{
        JSONObject identity=DirectCipher.identity();Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());JSONObject saved=new JSONObject().put("iv",Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)).put("value",Base64.encodeToString(cipher.doFinal(identity.toString().getBytes("UTF-8")),Base64.NO_WRAP));
        if(!preferences(context).edit().putString("identity",saved.toString()).putString("generation",java.util.UUID.randomUUID().toString()).commit())throw new java.io.IOException("Δεν αποθηκεύτηκε η προστατευμένη ταυτότητα Server.");
    }
    public static String generation(Context context){return preferences(context).getString("generation","");}
    public static String pairingCode(Context context)throws Exception{JSONObject identity=read(context);return identity.has("secret")&&identity.has("publicKey")?identity.getString("secret")+"."+identity.getString("publicKey"):"";}
    private DirectIdentity(){}
}
