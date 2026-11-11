package gr.argyrismitsos.fleetserver;
import android.content.Context;import org.json.*;import java.io.*;import java.security.*;import java.security.cert.*;import java.security.spec.*;import java.util.*;import javax.net.ssl.*;

/** Validates the full CA chain and exact DNS SAN before opening any listener. */
public final class IndependentTls {
    static final String NAME="independent.tls",ALIAS="fleet.independent.tls.v1";
    private IndependentTls(){}
    static PrivateKey key(JSONObject value)throws Exception{return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(java.util.Base64.getDecoder().decode(value.getString("key"))));}
    static X509Certificate[] chain(JSONObject value,String host,boolean trusted)throws Exception{
        IndependentPolicy.hostname(host);Collection<? extends java.security.cert.Certificate> parsed=CertificateFactory.getInstance("X.509").generateCertificates(new ByteArrayInputStream(value.getString("chain").getBytes("US-ASCII")));
        if(parsed.size()<2||parsed.size()>8)throw new IOException("Χρειάζεται πλήρης αλυσίδα πιστοποιητικού HTTPS.");X509Certificate[] chain=parsed.toArray(new X509Certificate[0]);boolean named=false;
        for(X509Certificate certificate:chain)certificate.checkValidity();Collection<List<?>> names=chain[0].getSubjectAlternativeNames();if(names!=null)for(List<?> name:names)if(Integer.valueOf(2).equals(name.get(0))&&host.equalsIgnoreCase(String.valueOf(name.get(1))))named=true;
        if(!named)throw new IOException("Το πιστοποιητικό δεν ανήκει στο επιλεγμένο όνομα Server.");
        if(chain[0].getBasicConstraints()>=0)throw new IOException("Χρειάζεται πιστοποιητικό HTTPS τελικού Server.");
        if(trusted){TrustManagerFactory factory=TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());factory.init((KeyStore)null);boolean accepted=false;for(TrustManager manager:factory.getTrustManagers())if(manager instanceof X509TrustManager){((X509TrustManager)manager).checkServerTrusted(chain,"RSA");accepted=true;}if(!accepted)throw new IOException("Δεν επαληθεύτηκε έμπιστη αλυσίδα TLS.");}
        Signature signer=Signature.getInstance("SHA256withRSA");byte[] probe="Fleet independent TLS proof".getBytes("UTF-8");signer.initSign(key(value));signer.update(probe);byte[] signature=signer.sign();signer.initVerify(chain[0].getPublicKey());signer.update(probe);if(!signer.verify(signature))throw new IOException("Το ιδιωτικό κλειδί δεν αντιστοιχεί στο πιστοποιητικό.");return chain;
    }
    static void save(Context c,JSONObject value,String host)throws Exception{chain(value,host,true);SealedLocalState.write(c,NAME,ALIAS,value.put("hostname",host));}
    static JSONObject read(Context c)throws Exception{return SealedLocalState.read(c,NAME,ALIAS);}
    static boolean valid(Context c,String host){try{chain(read(c),host,true);return true;}catch(Exception error){return false;}}
    static long expires(Context c)throws Exception{JSONObject value=read(c);return chain(value,value.getString("hostname"),true)[0].getNotAfter().getTime();}
    static SSLContext context(Context c,String host)throws Exception{return context(read(c),host,true);}
    static SSLContext context(JSONObject value,String host,boolean trusted)throws Exception{
        X509Certificate[] chain=chain(value,host,trusted);KeyStore keys=KeyStore.getInstance("PKCS12");keys.load(null,null);char[] password=IndependentConfig.random().toCharArray();keys.setKeyEntry("https",key(value),password,chain);KeyManagerFactory factory=KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());factory.init(keys,password);SSLContext tls=SSLContext.getInstance("TLS");tls.init(factory.getKeyManagers(),null,new SecureRandom());Arrays.fill(password,'\0');return tls;
    }
}
