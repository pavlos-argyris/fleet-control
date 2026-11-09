package gr.argyrismitsos.fleetserver;

import android.util.Base64;
import org.json.*;
import java.io.*;
import java.security.*;
import java.security.spec.*;
import javax.crypto.*;
import javax.crypto.spec.*;

/** Primary packets are bound to realm/generation and separate from old pairing. */
public final class PrimaryCipher {
    private static final int FLAGS=Base64.URL_SAFE|Base64.NO_WRAP|Base64.NO_PADDING;
    public static final int MAX_CLEAR_BYTES=1400000;
    private PrimaryCipher(){}
    private static String encode(byte[] bytes){return Base64.encodeToString(bytes,FLAGS);}
    private static byte[] decode(String value){return Base64.decode(value,FLAGS);}
    private static boolean encoded(String value,int min,int max){return value!=null&&value.length()>=min&&value.length()<=max&&value.matches("[A-Za-z0-9_-]+");}
    private static String context(JSONObject identity)throws Exception{
        String realm=identity.getString("realm"),generation=identity.getString("generation"),salt=identity.getString("publicSalt");
        if(!realm.startsWith("https://")||realm.length()>500||!generation.matches("[a-f0-9-]{36}")||!encoded(salt,43,43))throw new GeneralSecurityException("Invalid primary identity");
        return "fleet-primary-v1:"+realm+":"+generation+":";
    }
    private static byte[] aad(JSONObject identity,JSONObject packet,String direction)throws Exception{
        if(packet.optInt("v")!=1||!packet.optString("nonce").matches("[a-f0-9]{32}")||!encoded(packet.optString("epk"),122,122))throw new GeneralSecurityException("Invalid primary packet");
        return (context(identity)+direction+":"+packet.getString("nonce")+":"+packet.getString("epk")).getBytes("UTF-8");
    }
    private static PrivateKey own(JSONObject identity)throws Exception{return KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(decode(identity.getString("privateKey"))));}
    private static byte[] key(JSONObject identity,JSONObject packet)throws Exception{
        aad(identity,packet,"request");PublicKey other=KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(decode(packet.getString("epk"))));
        KeyAgreement agreement=KeyAgreement.getInstance("ECDH");agreement.init(own(identity));agreement.doPhase(other,true);
        byte[] secret=agreement.generateSecret();try{MessageDigest hash=MessageDigest.getInstance("SHA-256");hash.update((context(identity)+identity.getString("publicSalt")+":").getBytes("UTF-8"));return hash.digest(secret);}finally{java.util.Arrays.fill(secret,(byte)0);}
    }
    public static JSONObject open(JSONObject identity,JSONObject packet,long now)throws Exception{
        if(!encoded(packet.optString("iv"),16,16)||!encoded(packet.optString("ciphertext"),22,2097152))throw new GeneralSecurityException("Invalid primary ciphertext");
        byte[] key=key(identity,packet),plain=null;
        try{
            Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,decode(packet.getString("iv"))));cipher.updateAAD(aad(identity,packet,"request"));plain=cipher.doFinal(decode(packet.getString("ciphertext")));
            if(plain.length>MAX_CLEAR_BYTES)throw new GeneralSecurityException("Oversized primary request");JSONObject request=new JSONObject(new String(plain,"UTF-8"));long sent=request.getLong("sentAt");if(sent<now-120000||sent>now+120000)throw new GeneralSecurityException("Expired primary request");return request;
        }finally{java.util.Arrays.fill(key,(byte)0);if(plain!=null)java.util.Arrays.fill(plain,(byte)0);}
    }
    public static JSONObject seal(JSONObject identity,JSONObject packet,JSONObject response)throws Exception{
        byte[] plain=response.toString().getBytes("UTF-8");if(plain.length>MAX_CLEAR_BYTES)throw new GeneralSecurityException("Oversized primary response");byte[] key=key(identity,packet),iv=new byte[12];new SecureRandom().nextBytes(iv);
        try{Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,iv));cipher.updateAAD(aad(identity,packet,"response"));return new JSONObject().put("v",1).put("nonce",packet.getString("nonce")).put("epk",packet.getString("epk")).put("iv",encode(iv)).put("ciphertext",encode(cipher.doFinal(plain)));}
        finally{java.util.Arrays.fill(key,(byte)0);java.util.Arrays.fill(plain,(byte)0);}
    }
    private static byte[] rawSignature(byte[] der)throws Exception{
        if(der.length<8||der.length>72||der[0]!=0x30||(der[1]&255)!=der.length-2)throw new GeneralSecurityException("Invalid ECDSA signature");
        byte[] raw=new byte[64];int at=2;
        for(int part=0;part<2;part++){
            if(at+2>der.length||der[at++]!=2)throw new GeneralSecurityException("Invalid ECDSA integer");int length=der[at++]&255;if(length<1||length>33||at+length>der.length||(der[at]&128)!=0)throw new GeneralSecurityException("Invalid ECDSA length");
            if(length>1&&der[at]==0){if((der[at+1]&128)==0)throw new GeneralSecurityException("Noncanonical ECDSA integer");at++;length--;}
            if(length>32)throw new GeneralSecurityException("Oversized ECDSA integer");System.arraycopy(der,at,raw,part*32+32-length,length);at+=length;
        }
        if(at!=der.length)throw new GeneralSecurityException("Trailing ECDSA data");return raw;
    }
    public static JSONObject connectionProof(JSONObject identity,JSONObject challenge)throws Exception{
        String nonce=challenge.getString("nonce");if(!nonce.matches("[a-f0-9-]{36}"))throw new GeneralSecurityException("Invalid primary challenge");
        String message="fleet-primary-connect-v1|"+identity.getString("realm")+"|"+identity.getString("generation")+"|"+nonce;if(!message.equals(challenge.getString("message")))throw new GeneralSecurityException("Primary challenge context changed");
        Signature signer=Signature.getInstance("SHA256withECDSA");signer.initSign(own(identity));signer.update(message.getBytes("UTF-8"));return new JSONObject().put("nonce",nonce).put("generation",identity.getString("generation")).put("signature",encode(rawSignature(signer.sign())));
    }
    public static JSONObject cloudReturnCertificate(JSONObject identity,String targetId,String inventoryHash)throws Exception{
        if(!targetId.matches("[a-f0-9-]{36}")||!inventoryHash.matches("[a-f0-9]{64}"))throw new GeneralSecurityException("Invalid cloud return identity");
        String message="fleet-cloud-return-v1|"+identity.getString("realm")+"|"+identity.getString("generation")+"|"+targetId+"|"+inventoryHash;
        Signature signer=Signature.getInstance("SHA256withECDSA");signer.initSign(own(identity));signer.update(message.getBytes("UTF-8"));
        return new JSONObject().put("realm",identity.getString("realm")).put("sourceGeneration",identity.getString("generation")).put("targetId",targetId).put("inventoryHash",inventoryHash).put("signature",encode(rawSignature(signer.sign())));
    }

}
