package gr.argyrismitsos.fleetserver;
import android.content.Context;import org.json.*;import java.io.*;import java.security.*;import java.security.cert.*;import java.security.spec.*;import java.util.*;import javax.net.ssl.*;

/** Validates the full CA chain and exact DNS SAN before opening any listener. */
public final class IndependentTls {
    static final String NAME="independent.tls",ALIAS="fleet.independent.tls.v1";
    private IndependentTls(){}
    private static IndependentCertificate.Failure chainFailure(String reason){return new IndependentCertificate.Failure("chain",reason,0,0);}
    static PrivateKey key(JSONObject value)throws Exception{return KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(java.util.Base64.getDecoder().decode(value.getString("key"))));}
    static X509Certificate[] chain(JSONObject value,String host,boolean trusted)throws Exception{
        IndependentPolicy.hostname(host);Collection<java.security.cert.Certificate> parsed=new ArrayList<java.security.cert.Certificate>();String pem=value.getString("chain");java.util.regex.Matcher blocks=java.util.regex.Pattern.compile("-----BEGIN CERTIFICATE-----\\s*([A-Za-z0-9+/=\\s]+?)\\s*-----END CERTIFICATE-----").matcher(pem);int end=0;CertificateFactory parser=CertificateFactory.getInstance("X.509");while(blocks.find()){if(!pem.substring(end,blocks.start()).trim().isEmpty())throw chainFailure("CHAIN_INCOMPLETE");byte[] der;try{der=java.util.Base64.getMimeDecoder().decode(blocks.group(1));}catch(IllegalArgumentException error){throw chainFailure("CHAIN_INCOMPLETE");}parsed.add(parser.generateCertificate(new ByteArrayInputStream(der)));end=blocks.end();}if(!pem.substring(end).trim().isEmpty())throw chainFailure("CHAIN_INCOMPLETE");
        if(parsed.isEmpty()||parsed.size()>8)throw chainFailure("CHAIN_INCOMPLETE");X509Certificate[] chain=parsed.toArray(new X509Certificate[0]);boolean named=false;
        for(X509Certificate certificate:chain)try{certificate.checkValidity();}catch(CertificateExpiredException error){throw chainFailure("CLOCK");}catch(CertificateNotYetValidException error){throw chainFailure("CLOCK");}Collection<List<?>> names=chain[0].getSubjectAlternativeNames();if(names!=null)for(List<?> name:names)if(Integer.valueOf(2).equals(name.get(0))&&host.equalsIgnoreCase(String.valueOf(name.get(1))))named=true;
        if(!named)throw chainFailure("CHAIN_HOSTNAME");
        if(chain.length<2)throw chainFailure("CHAIN_INCOMPLETE");
        if(chain[0].getBasicConstraints()>=0)throw chainFailure("CHAIN_LEAF");
        if(trusted){TrustManagerFactory factory=TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());factory.init((KeyStore)null);boolean accepted=false;for(TrustManager manager:factory.getTrustManagers())if(manager instanceof X509TrustManager){try{((X509TrustManager)manager).checkServerTrusted(chain,chain[0].getPublicKey().getAlgorithm());}catch(CertificateException error){throw chainFailure("CHAIN_UNTRUSTED");}accepted=true;}if(!accepted)throw chainFailure("CHAIN_UNTRUSTED");}
        Signature signer=Signature.getInstance("SHA256withRSA");byte[] probe="Fleet independent TLS proof".getBytes("UTF-8");signer.initSign(key(value));signer.update(probe);byte[] signature=signer.sign();signer.initVerify(chain[0].getPublicKey());signer.update(probe);if(!signer.verify(signature))throw chainFailure("CHAIN_KEY_MISMATCH");return chain;
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
