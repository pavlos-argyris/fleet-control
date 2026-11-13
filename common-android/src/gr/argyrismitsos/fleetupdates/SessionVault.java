package gr.argyrismitsos.fleetupdates;
import android.content.*;import android.security.keystore.*;import android.util.Base64;
import java.net.URI;import java.security.*;import javax.crypto.*;import javax.crypto.spec.GCMParameterSpec;import org.json.*;

/** Device-held sessions: separate keys/AAD per realm, with atomic legacy migration. */
public final class SessionVault{
    public static final String CLOUD="https://fleet-control.pavlosargyris.workers.dev",DIRECT="https://fleet-control.duckdns.org";
    private SessionVault(){}
    public static String pageRealm(String url){
        if(url==null)return "";if(url.startsWith("file:///android_asset/www/")&&!url.contains(".."))return CLOUD;
        try{URI uri=new URI(url);if(!"https".equals(uri.getScheme())||uri.getRawUserInfo()!=null||uri.getPort()!=-1&&uri.getPort()!=443)return "";String origin="https://"+uri.getHost();return origin.equals(CLOUD)||origin.equals(DIRECT)?origin:"";}catch(Exception invalid){return "";}
    }
    private static void require(String realm)throws Exception{if(!realm.equals(CLOUD)&&!realm.equals(DIRECT))throw new GeneralSecurityException("Invalid session realm");}
    private static SecretKey key(Context c,String realm)throws Exception{
        require(realm);String alias="fleet.session.v1."+(realm.equals(DIRECT)?"direct":"cloud");KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        synchronized(SessionVault.class){if(store.containsAlias(alias))return (SecretKey)store.getKey(alias,null);
            KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");generator.init(new KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());return generator.generateKey();}
    }
    private static byte[] aad(Context c,String name,String realm)throws Exception{return (c.getPackageName()+"\n"+name+"\n"+realm).getBytes("UTF-8");}
    public static void save(Context c,SharedPreferences prefs,String name,String realm,String token)throws Exception{
        require(realm);if(token==null||token.isEmpty()){clear(prefs,name);return;}if(token.getBytes("UTF-8").length>16384)throw new GeneralSecurityException("Invalid session length");
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key(c,realm));cipher.updateAAD(aad(c,name,realm));
        String encoded=new JSONObject().put("schema",1).put("iv",Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)).put("body",Base64.encodeToString(cipher.doFinal(token.getBytes("UTF-8")),Base64.NO_WRAP)).toString();
        if(!prefs.edit().putString(name+".sealed",encoded).remove(name).commit())throw new GeneralSecurityException("Session was not saved");
    }
    public static String read(Context c,SharedPreferences prefs,String name,String realm){try{
        require(realm);String encoded=prefs.getString(name+".sealed","");
        if(encoded.isEmpty()){String legacy=prefs.getString(name,"");if(!legacy.isEmpty())save(c,prefs,name,realm,legacy);return legacy;}
        JSONObject value=new JSONObject(encoded);if(value.getInt("schema")!=1||encoded.length()>32768)throw new GeneralSecurityException("Invalid session record");
        byte[] iv=Base64.decode(value.getString("iv"),Base64.NO_WRAP);if(iv.length!=12)throw new GeneralSecurityException("Invalid session nonce");
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(c,realm),new GCMParameterSpec(128,iv));cipher.updateAAD(aad(c,name,realm));return new String(cipher.doFinal(Base64.decode(value.getString("body"),Base64.NO_WRAP)),"UTF-8");
    }catch(Exception lockedOrInvalid){return "";}}
    public static void clear(SharedPreferences prefs,String name){if(!prefs.edit().remove(name).remove(name+".sealed").commit())throw new IllegalStateException("Session was not cleared");}
}
