package gr.argyrismitsos.fleetserver;

import android.util.Base64;
import org.json.JSONObject;
import java.security.*;
import java.security.spec.*;
import java.io.ByteArrayOutputStream;
import javax.crypto.*;
import javax.crypto.spec.*;

/** Pinned P-256 identity plus authenticated, direction-bound request encryption. */
public final class DirectCipher {
    private static final int FLAGS=Base64.URL_SAFE|Base64.NO_WRAP|Base64.NO_PADDING;
    private static String encode(byte[] bytes){return Base64.encodeToString(bytes,FLAGS);}
    private static byte[] decode(String value){return Base64.decode(value,FLAGS);}
    public static JSONObject identity()throws Exception{
        KeyPairGenerator generator=KeyPairGenerator.getInstance("EC");generator.initialize(new ECGenParameterSpec("secp256r1"));KeyPair keys=generator.generateKeyPair();byte[] secret=new byte[32];new SecureRandom().nextBytes(secret);
        return new JSONObject().put("secret",encode(secret)).put("publicKey",encode(keys.getPublic().getEncoded())).put("privateKey",encode(keys.getPrivate().getEncoded()));
    }
    private static byte[] key(JSONObject identity,JSONObject packet)throws Exception{
        String epk=packet.getString("epk");if(!epk.matches("[A-Za-z0-9_-]{122}"))throw new GeneralSecurityException("Invalid public key");
        KeyFactory factory=KeyFactory.getInstance("EC");PrivateKey own=factory.generatePrivate(new PKCS8EncodedKeySpec(decode(identity.getString("privateKey"))));PublicKey other=factory.generatePublic(new X509EncodedKeySpec(decode(epk)));
        KeyAgreement agreement=KeyAgreement.getInstance("ECDH");agreement.init(own);agreement.doPhase(other,true);
        ByteArrayOutputStream input=new ByteArrayOutputStream();input.write(("fleet-direct-v1:"+identity.getString("secret")+":").getBytes("UTF-8"));input.write(agreement.generateSecret());return MessageDigest.getInstance("SHA-256").digest(input.toByteArray());
    }
    private static byte[] aad(JSONObject packet,String direction)throws Exception{
        if(packet.optInt("v")!=1||!packet.optString("nonce").matches("[a-f0-9]{32}")||!packet.optString("epk").matches("[A-Za-z0-9_-]{122}"))throw new GeneralSecurityException("Invalid packet");
        return ("fleet-direct-v1:"+direction+":"+packet.getString("nonce")+":"+packet.getString("epk")).getBytes("UTF-8");
    }
    public static JSONObject open(JSONObject identity,JSONObject packet)throws Exception{
        if(!packet.optString("iv").matches("[A-Za-z0-9_-]{16}")||!packet.optString("ciphertext").matches("[A-Za-z0-9_-]{22,2097152}"))throw new GeneralSecurityException("Invalid encrypted request");
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,new SecretKeySpec(key(identity,packet),"AES"),new GCMParameterSpec(128,decode(packet.getString("iv"))));cipher.updateAAD(aad(packet,"request"));
        JSONObject value=new JSONObject(new String(cipher.doFinal(decode(packet.getString("ciphertext"))),"UTF-8"));long difference=System.currentTimeMillis()-value.optLong("sentAt");if(difference>120000L||difference< -120000L)throw new GeneralSecurityException("Expired encrypted request");return value;
    }
    public static JSONObject seal(JSONObject identity,JSONObject request,JSONObject response)throws Exception{
        byte[] iv=new byte[12];new SecureRandom().nextBytes(iv);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(key(identity,request),"AES"),new GCMParameterSpec(128,iv));cipher.updateAAD(aad(request,"response"));
        return new JSONObject().put("v",1).put("nonce",request.getString("nonce")).put("epk",request.getString("epk")).put("iv",encode(iv)).put("ciphertext",encode(cipher.doFinal(response.toString().getBytes("UTF-8"))));
    }
    private DirectCipher(){}
}
