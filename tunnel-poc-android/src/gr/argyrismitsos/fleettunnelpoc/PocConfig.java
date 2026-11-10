package gr.argyrismitsos.fleettunnelpoc;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.io.*;
import java.net.IDN;
import java.security.KeyStore;
import java.util.Locale;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;

/** Dedicated test-tunnel credentials, unrelated to Fleet users/signing/Ordexa. */
final class PocConfig {
    private static final String ALIAS="fleet.tunnel.poc.credentials.v1",PREF="poc";
    static JSONObject validate(String host,String supplied)throws Exception {
        if(supplied.length()>16384)throw new IOException("Invalid configuration");
        String name=IDN.toASCII(host.trim().toLowerCase(Locale.US));
        if(name.length()>253||!name.matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+")||name.matches("[0-9.]+")||name.endsWith(".workers.dev")||name.endsWith(".trycloudflare.com"))throw new IOException("A dedicated named hostname is required");
        JSONObject raw=new JSONObject(supplied);String account=raw.getString("AccountTag"),id=raw.getString("TunnelID"),secret=raw.getString("TunnelSecret");
        if(!account.matches("[a-f0-9]{32}")||!id.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")||!secret.matches("[A-Za-z0-9+/]{43}=")||Base64.decode(secret,Base64.NO_WRAP).length!=32)throw new IOException("Invalid dedicated named tunnel credentials");
        return new JSONObject().put("hostname",name).put("credentials",new JSONObject().put("AccountTag",account).put("TunnelID",id).put("TunnelSecret",secret));
    }
    private static SecretKey key()throws Exception {
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        if(!store.containsAlias(ALIAS)){KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");generator.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());generator.generateKey();}
        return (SecretKey)store.getKey(ALIAS,null);
    }
    static void save(Context context,String hostname,String supplied)throws Exception {
        JSONObject clean=validate(hostname,supplied);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());cipher.updateAAD(ALIAS.getBytes("UTF-8"));
        String sealed=new JSONObject().put("iv",Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)).put("ciphertext",Base64.encodeToString(cipher.doFinal(clean.toString().getBytes("UTF-8")),Base64.NO_WRAP)).toString();
        if(!context.getSharedPreferences(PREF,0).edit().putString("sealed",sealed).putString("hostname",clean.getString("hostname")).commit())throw new IOException("Configuration not saved");
    }
    static JSONObject read(Context context)throws Exception {
        String value=context.getSharedPreferences(PREF,0).getString("sealed","");if(value.isEmpty())throw new IOException("No test configuration");JSONObject saved=new JSONObject(value);
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(saved.getString("iv"),Base64.NO_WRAP)));cipher.updateAAD(ALIAS.getBytes("UTF-8"));
        JSONObject clear=new JSONObject(new String(cipher.doFinal(Base64.decode(saved.getString("ciphertext"),Base64.NO_WRAP)),"UTF-8"));return validate(clear.getString("hostname"),clear.getJSONObject("credentials").toString());
    }
    static File write(Context context,String name,String value)throws Exception {
        try(FileOutputStream output=context.openFileOutput(name,Context.MODE_PRIVATE)){output.write(value.getBytes("UTF-8"));output.getFD().sync();}return new File(context.getFilesDir(),name);
    }
    static File runtime(Context context,JSONObject value)throws Exception {
        File credentials=write(context,"tunnel-test-credentials.json",value.getJSONObject("credentials").toString());
        String config="tunnel: "+value.getJSONObject("credentials").getString("TunnelID")+"\ncredentials-file: "+credentials.getAbsolutePath()+"\nprotocol: http2\nmetrics: 127.0.0.1:18788\nloglevel: info\ntransport-loglevel: error\ningress:\n  - hostname: "+value.getString("hostname")+"\n    service: http://127.0.0.1:"+PocOrigin.PORT+"\n  - service: http_status:404\n";
        return write(context,"tunnel-test-config.yml",config);
    }
    static void cleanRuntime(Context context){for(String name:new String[]{"tunnel-test-credentials.json","tunnel-test-config.yml"})new File(context.getFilesDir(),name).delete();}
}
