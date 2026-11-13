package gr.argyrismitsos.fleetserver;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONObject;

/**
 * Owner-operated, offline certificate migration between Android installations.
 * Never uploads TLS private keys, ACME account credentials or owner credentials.
 * Keystore-wrapped on each device; only the exported file uses this passphrase.
 */
public final class IndependentCertificateTransfer {
    private static final String KIND="fleet-control-https-transfer";
    private static final int VERSION=1, ITERATIONS=320000, MAX_BYTES=65536;
    private static final int SALT_BYTES=16, IV_BYTES=12, KEY_BITS=256;
    private IndependentCertificateTransfer(){}

    private static void password(String value)throws IOException {
        if(value==null||value.length()<12||value.length()>512)
            throw new IOException("Ο κωδικός μεταφοράς πρέπει να έχει τουλάχιστον 12 χαρακτήρες.");
    }
    private static byte[] random(int size){
        byte[] bytes=new byte[size];new SecureRandom().nextBytes(bytes);return bytes;
    }
    private static byte[] derive(String password,byte[] salt)throws Exception {
        char[] chars=password.toCharArray();
        PBEKeySpec spec=new PBEKeySpec(chars,salt,ITERATIONS,KEY_BITS);
        try{return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();}
        finally{spec.clearPassword();Arrays.fill(chars,'\0');}
    }
    private static byte[] aad(String host){
        return (KIND+"\n"+VERSION+"\n"+host).getBytes(StandardCharsets.UTF_8);
    }
    /**
     * Caller must verify the source's trusted certificate and live owner session.
     * The payload includes ONLY server TLS key, chain and exact hostname.
     */
    static byte[] encrypt(JSONObject identity,String host,String passphrase)throws Exception {
        password(passphrase);
        String selected=IndependentPolicy.hostname(host);
        JSONObject payload=new JSONObject()
            .put("hostname",selected)
            .put("key",identity.getString("key"))
            .put("chain",identity.getString("chain"));
        byte[] plaintext=payload.toString().getBytes(StandardCharsets.UTF_8);
        if(plaintext.length>MAX_BYTES/2)throw new IOException("Το πιστοποιητικό υπερβαίνει το επιτρεπόμενο μέγεθος.");
        byte[] salt=random(SALT_BYTES),iv=random(IV_BYTES),secret=derive(passphrase,salt);
        try {
            Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(secret,"AES"),new GCMParameterSpec(128,iv));
            cipher.updateAAD(aad(selected));
            byte[] ciphertext=cipher.doFinal(plaintext);
            JSONObject envelope=new JSONObject()
                .put("type",KIND).put("schemaVersion",VERSION).put("hostname",selected)
                .put("kdf","PBKDF2-HMAC-SHA256").put("iterations",ITERATIONS)
                .put("cipher","AES-256-GCM")
                .put("salt",Base64.getEncoder().encodeToString(salt))
                .put("iv",Base64.getEncoder().encodeToString(iv))
                .put("ciphertext",Base64.getEncoder().encodeToString(ciphertext));
            byte[] output=envelope.toString().getBytes(StandardCharsets.UTF_8);
            if(output.length>MAX_BYTES)throw new IOException("Το αρχείο μεταφοράς είναι υπερβολικά μεγάλο.");
            return output;
        } finally {
            Arrays.fill(secret,(byte)0);
            Arrays.fill(plaintext,(byte)0);
        }
    }
    /**
     * Authenticated decryption is bound to the owner-configured DuckDNS name.
     * Certificate trust, SAN, expiry and private-key match must be checked by
     * IndependentTls.chain(..., true) before any Keystore write.
     */
    static JSONObject decrypt(byte[] file,String host,String passphrase)throws Exception {
        password(passphrase);
        String selected=IndependentPolicy.hostname(host);
        if(file==null||file.length==0||file.length>MAX_BYTES)
            throw new IOException("Το αρχείο πιστοποιητικού δεν είναι έγκυρο.");
        JSONObject envelope=new JSONObject(new String(file,StandardCharsets.UTF_8));
        if(!KIND.equals(envelope.optString("type"))||envelope.getInt("schemaVersion")!=VERSION||
            !selected.equals(envelope.optString("hostname"))||
            !"PBKDF2-HMAC-SHA256".equals(envelope.optString("kdf"))||
            envelope.getInt("iterations")!=ITERATIONS||
            !"AES-256-GCM".equals(envelope.optString("cipher")))
            throw new IOException("Το αρχείο δεν ανήκει στο επιλεγμένο όνομα HTTPS ή δεν υποστηρίζεται.");
        byte[] salt=Base64.getDecoder().decode(envelope.getString("salt"));
        byte[] iv=Base64.getDecoder().decode(envelope.getString("iv"));
        byte[] ciphertext=Base64.getDecoder().decode(envelope.getString("ciphertext"));
        if(salt.length!=SALT_BYTES||iv.length!=IV_BYTES||ciphertext.length<17||ciphertext.length>MAX_BYTES)
            throw new IOException("Τα κρυπτογραφικά δεδομένα του αρχείου είναι μη έγκυρα.");
        byte[] key=derive(passphrase,salt);
        try {
            Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,iv));
            cipher.updateAAD(aad(selected));
            byte[] clear=cipher.doFinal(ciphertext);
            try {
                JSONObject identity=new JSONObject(new String(clear,StandardCharsets.UTF_8));
                if(!selected.equals(identity.getString("hostname"))||
                    identity.getString("key").isEmpty()||identity.getString("chain").isEmpty())
                    throw new IOException("Το πιστοποιητικό δεν αντιστοιχεί στο επιλεγμένο όνομα.");
                return new JSONObject().put("key",identity.getString("key")).put("chain",identity.getString("chain"));
            } finally {Arrays.fill(clear,(byte)0);}
        } finally {Arrays.fill(key,(byte)0);}
    }
}
