package gr.argyrismitsos.fleetserver;
import android.content.Context;import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;import android.security.keystore.KeyProperties;
import android.util.Base64;import org.json.*;import java.security.KeyStore;import javax.crypto.*;import javax.crypto.spec.GCMParameterSpec;

/** Device-only wrapping. Signing credentials and provider credentials are unrelated. */
public final class SealedLocalState {
    private SealedLocalState(){}
    private static SecretKey key(String alias)throws Exception{
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        if(!store.containsAlias(alias)){KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");generator.init(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());generator.generateKey();}
        return (SecretKey)store.getKey(alias,null);
    }
    private static SharedPreferences prefs(Context context){return context.getSharedPreferences("fleet_sealed_runtime_v1",Context.MODE_PRIVATE);}
    public static JSONObject read(Context context,String name,String alias)throws Exception{
        String raw=prefs(context).getString(name,"");if(raw.isEmpty())return new JSONObject();JSONObject saved=new JSONObject(raw);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(alias),new GCMParameterSpec(128,Base64.decode(saved.getString("iv"),Base64.NO_WRAP)));cipher.updateAAD(name.getBytes("UTF-8"));return new JSONObject(new String(cipher.doFinal(Base64.decode(saved.getString("ciphertext"),Base64.NO_WRAP)),"UTF-8"));
    }
    public static void write(Context context,String name,String alias,JSONObject value)throws Exception{
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key(alias));cipher.updateAAD(name.getBytes("UTF-8"));JSONObject saved=new JSONObject().put("iv",Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)).put("ciphertext",Base64.encodeToString(cipher.doFinal(value.toString().getBytes("UTF-8")),Base64.NO_WRAP));
        if(!prefs(context).edit().putString(name,saved.toString()).commit())throw new java.io.IOException("Δεν αποθηκεύτηκε η προστατευμένη ρύθμιση Server.");
    }
    public static void remove(Context context,String name)throws Exception{if(!prefs(context).edit().remove(name).commit())throw new java.io.IOException("Δεν αφαιρέθηκε η προστατευμένη ρύθμιση.");}
}
