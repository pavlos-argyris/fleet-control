package gr.argyrismitsos.fleetserver;
import android.content.Context;import org.json.*;import java.io.*;import java.net.*;import java.math.BigInteger;import java.security.*;import java.security.interfaces.*;import java.security.spec.*;import java.util.*;import javax.net.ssl.HttpsURLConnection;

/** ACME v2 DNS-01, RFC8555. Only DuckDNS DNS updates and Let's Encrypt HTTPS. No port80. */
public final class IndependentAcme {
    static final String NAME="independent.acme",ALIAS="fleet.independent.acme.v1",DIRECTORY="https://acme-v02.api.letsencrypt.org/directory";
    interface Http { Result request(String url,String method,String body)throws Exception; }
    static final class Result {final int status;final String body,nonce,location;final long retryAt;Result(int status,String body,String nonce,String location){this(status,body,nonce,location,0);}Result(int status,String body,String nonce,String location,long retryAt){this.status=status;this.body=body;this.nonce=nonce;this.location=location;this.retryAt=retryAt;}}
    interface Waiter {long now();void pause(long milliseconds)throws Exception;}
    interface Txt {boolean visible(String host,String expected)throws Exception;}
    interface Progress {void stage(String phase)throws Exception;}
    private final Http http;private final KeyPair account;private JSONObject directory;private String kid="",nonce="",phase="directory";
    IndependentAcme(Http http,KeyPair account){this.http=http;this.account=account;}
    private static String b64(byte[] bytes){return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);}
    static KeyPair generate()throws Exception{KeyPairGenerator generator=KeyPairGenerator.getInstance("RSA");generator.initialize(2048);return generator.generateKeyPair();}
    static String encoded(PrivateKey key){return java.util.Base64.getEncoder().encodeToString(key.getEncoded());}
    static KeyPair decode(String privateKey)throws Exception{return decode(privateKey,"");}
    /** Android providers may return RSAPrivateKey without exposing the CRT
     * interface. Trust neither an inferred exponent nor an optional stored
     * public key until a fresh RSA sign/verify challenge succeeds. */
    static KeyPair decode(String privateKey,String publicKey)throws Exception{
        KeyFactory factory=KeyFactory.getInstance("RSA");
        PrivateKey privateValue=factory.generatePrivate(new PKCS8EncodedKeySpec(java.util.Base64.getDecoder().decode(privateKey)));
        if(!(privateValue instanceof RSAPrivateKey))throw new InvalidKeyException("RSA private key required");
        RSAPrivateKey rsa=(RSAPrivateKey)privateValue;
        PublicKey publicValue;
        if(publicKey!=null&&!publicKey.isEmpty())
            publicValue=factory.generatePublic(new X509EncodedKeySpec(java.util.Base64.getDecoder().decode(publicKey)));
        else {
            // Legacy v1 keys were generated with standard RSA 2048/65537.
            // Use the CRT exponent when available; verify cryptographically
            // below before accepting the legacy-derived public key.
            BigInteger exponent=privateValue instanceof RSAPrivateCrtKey?
                ((RSAPrivateCrtKey)privateValue).getPublicExponent():BigInteger.valueOf(65537);
            publicValue=factory.generatePublic(new RSAPublicKeySpec(rsa.getModulus(),exponent));
        }
        if(!(publicValue instanceof RSAPublicKey)||
           !rsa.getModulus().equals(((RSAPublicKey)publicValue).getModulus()))
            throw new InvalidKeyException("RSA modulus mismatch");
        byte[] challenge=new byte[32];new SecureRandom().nextBytes(challenge);
        Signature signer=Signature.getInstance("SHA256withRSA");
        signer.initSign(privateValue);signer.update(challenge);byte[] signed=signer.sign();
        Signature verifier=Signature.getInstance("SHA256withRSA");
        verifier.initVerify(publicValue);verifier.update(challenge);
        if(!verifier.verify(signed))throw new InvalidKeyException("RSA keypair verification failed");
        return new KeyPair(publicValue,privateValue);
    }
    static byte[] unsigned(BigInteger value){byte[] b=value.toByteArray();return b.length>1&&b[0]==0?Arrays.copyOfRange(b,1,b.length):b;}
    JSONObject jwk()throws Exception{RSAPublicKey key=(RSAPublicKey)account.getPublic();return new JSONObject().put("e",b64(unsigned(key.getPublicExponent()))).put("kty","RSA").put("n",b64(unsigned(key.getModulus())));}
    String thumbprint()throws Exception{JSONObject key=jwk();String canonical="{\"e\":\""+key.getString("e")+"\",\"kty\":\"RSA\",\"n\":\""+key.getString("n")+"\"}";return b64(MessageDigest.getInstance("SHA-256").digest(canonical.getBytes("UTF-8")));}
    static String caUrl(String url)throws Exception{URI uri=new URI(url);if(!"https".equals(uri.getScheme())||!"acme-v02.api.letsencrypt.org".equals(uri.getHost())||uri.getPort()!=-1||uri.getUserInfo()!=null||uri.getFragment()!=null)throw new IOException("Μη επιτρεπτή διεύθυνση ACME.");return url;}
    Result signed(String url,String payload,boolean newAccount)throws Exception{
        for(int retry=0;retry<2;retry++){
            caUrl(url);if(nonce.isEmpty()){Result fresh=http.request(caUrl(directory.getString("newNonce")),"HEAD",null);if(fresh.status<200||fresh.status>=300)throw IndependentCertificate.problem(phase,fresh.body,fresh.status,fresh.retryAt);nonce=fresh.nonce;}if(nonce==null||nonce.isEmpty())throw new IndependentCertificate.Failure(phase,"CA_NONCE",0,0);
            JSONObject header=new JSONObject().put("alg","RS256").put("nonce",nonce).put("url",url);if(newAccount)header.put("jwk",jwk());else header.put("kid",kid);
            String protectedValue=b64(header.toString().getBytes("UTF-8")),data=b64(payload.getBytes("UTF-8"));Signature signature=Signature.getInstance("SHA256withRSA");signature.initSign(account.getPrivate());signature.update((protectedValue+"."+data).getBytes("US-ASCII"));
            Result result=http.request(url,"POST",new JSONObject().put("protected",protectedValue).put("payload",data).put("signature",b64(signature.sign())).toString());nonce=result.nonce==null?"":result.nonce;
            if(result.status>=200&&result.status<300)return result;
            if(result.status==400&&result.body.contains("urn:ietf:params:acme:error:badNonce")&&retry==0)continue;
            throw IndependentCertificate.problem(phase,result.body,result.status,result.retryAt);
        }throw new IndependentCertificate.Failure(phase,"CA_NONCE",0,0);
    }
    private static byte[] concat(byte[]...parts)throws IOException{ByteArrayOutputStream out=new ByteArrayOutputStream();for(byte[] part:parts)out.write(part);return out.toByteArray();}
    static byte[] der(int tag,byte[] content)throws IOException{ByteArrayOutputStream out=new ByteArrayOutputStream();out.write(tag);if(content.length<128)out.write(content.length);else{int n=content.length,count=0;while(n>0){count++;n>>>=8;}out.write(128|count);for(int i=count-1;i>=0;i--)out.write((content.length>>>(i*8))&255);}out.write(content);return out.toByteArray();}
    static byte[] csr(KeyPair certificate,String host)throws Exception{
        IndependentPolicy.hostname(host);
        byte[] commonName=der(0x30,concat(new byte[]{6,3,85,4,3},der(12,host.getBytes("UTF-8"))));
        byte[] subject=der(0x30,der(0x31,commonName));
        byte[] san=der(0x30,der(0x82,host.getBytes("US-ASCII")));
        byte[] extension=der(0x30,concat(new byte[]{6,3,85,29,17},der(4,san)));
        byte[] extensions=der(0x30,extension),attribute=der(0x30,concat(new byte[]{6,9,42,(byte)134,72,(byte)134,(byte)247,13,1,9,14},der(0x31,extensions)));
        byte[] information=der(0x30,concat(new byte[]{2,1,0},subject,certificate.getPublic().getEncoded(),der(0xa0,attribute)));
        Signature signer=Signature.getInstance("SHA256withRSA");signer.initSign(certificate.getPrivate());signer.update(information);
        return der(0x30,concat(information,new byte[]{0x30,13,6,9,42,(byte)134,72,(byte)134,(byte)247,13,1,1,11,5,0},der(3,concat(new byte[]{0},signer.sign()))));
    }
    static Http network(){return new Http(){public Result request(String address,String method,String body)throws Exception{
        URI uri=new URI(address);boolean dns="www.duckdns.org".equals(uri.getHost());if(!dns)caUrl(address);else if(!"https".equals(uri.getScheme())||!"/update".equals(uri.getPath())||uri.getUserInfo()!=null||uri.getPort()!=-1||uri.getFragment()!=null||!method.equals("GET"))throw new IOException("Μη επιτρεπτή ενημέρωση DNS.");
        if(dns)return new Result(200,IndependentDns.get(address),null,null);
        HttpsURLConnection connection=(HttpsURLConnection)new URL(address).openConnection();connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(10000);connection.setReadTimeout(15000);connection.setRequestMethod(method);connection.setRequestProperty("User-Agent","Fleet-Independent-Android/1");
        try{if(body!=null){byte[] bytes=body.getBytes("UTF-8");connection.setDoOutput(true);connection.setRequestProperty("Content-Type","application/jose+json");connection.setFixedLengthStreamingMode(bytes.length);try(OutputStream out=connection.getOutputStream()){out.write(bytes);}}
            int status=connection.getResponseCode();ByteArrayOutputStream out=new ByteArrayOutputStream();InputStream raw=status>=400?connection.getErrorStream():connection.getInputStream();if(raw!=null)try(InputStream input=raw){byte[] bytes=new byte[8192];int n;while((n=input.read(bytes))!=-1){if(out.size()+n>1024*1024)throw new IOException("Oversized certificate response");out.write(bytes,0,n);}}
            return new Result(status,new String(out.toByteArray(),"UTF-8"),connection.getHeaderField("Replay-Nonce"),connection.getHeaderField("Location"),IndependentCertificate.retryAfter(connection.getHeaderField("Retry-After"),System.currentTimeMillis()));
        }finally{connection.disconnect();}
    }};}
    static String duckUrl(String host,String token,String txt,boolean clear)throws Exception{
        String domain=IndependentPolicy.hostname(host).replace(".duckdns.org","");if(!token.matches("[A-Za-z0-9-]{20,128}"))throw new IOException("Χρειάζεται έγκυρο προστατευμένο token DuckDNS.");
        return "https://www.duckdns.org/update?domains="+domain+"&token="+URLEncoder.encode(token,"UTF-8")+(txt==null?"&ip=&verbose=true":"&txt="+URLEncoder.encode(txt,"UTF-8")+(clear?"&clear=true":""));
    }
    static String updateDns(Context c)throws Exception{JSONObject config=IndependentConfig.read(c);Result result=network().request(duckUrl(config.getString("hostname"),config.getString("ddnsToken"),null,false),"GET",null);if(result.status!=200||!result.body.startsWith("OK\n")&&!result.body.trim().equals("OK"))throw new IOException("Η ενημέρωση DuckDNS δεν επιβεβαιώθηκε.");String[] lines=result.body.split("\\r?\\n");String ipv4=lines.length>1?lines[1].trim():"";if(!ipv4.matches("[0-9.]{7,15}")||!IndependentPolicy.publicPeer(InetAddress.getByName(ipv4)))throw new IOException("Το DuckDNS δεν επιβεβαίωσε δημόσια IPv4. Δεν ανοίγει εξωτερική πρόσβαση.");return ipv4;}
    private void stage(String name,Progress progress)throws Exception{phase=name;progress.stage(name);}
    private JSONObject object(Result result)throws Exception{return new JSONObject(result.body);}
    private JSONObject poll(String url,String wanted,Set<String> waiting,Waiter waiter,Progress progress)throws Exception{
        for(int attempt=0;attempt<30;attempt++){
            JSONObject value=object(signed(caUrl(url),"",false));String status=value.optString("status");
            if(status.equals(wanted))return value;
            if(!waiting.contains(status))throw IndependentCertificate.resource(phase,value);
            waiter.pause(3000);
        }
        throw new IndependentCertificate.Failure(phase,"CA_PENDING",0,0);
    }
    /** Pure protocol port: only production Http/Txt ports may perform network I/O. */
    static JSONObject obtain(Http http,KeyPair account,KeyPair certificate,String host,String token,Waiter waiter,Txt lookup,Progress progress)throws Exception{
        IndependentAcme client=new IndependentAcme(http,account);boolean txtSet=false,authorizationConfirmed=false;
        try{
            IndependentPolicy.hostname(host);client.stage("directory",progress);
            Result directoryResponse=http.request(DIRECTORY,"GET",null);if(directoryResponse.status!=200)throw IndependentCertificate.problem(client.phase,directoryResponse.body,directoryResponse.status,directoryResponse.retryAt);client.directory=client.object(directoryResponse);
            client.stage("account",progress);Result registered=client.signed(client.directory.getString("newAccount"),new JSONObject().put("termsOfServiceAgreed",true).toString(),true);client.kid=caUrl(registered.location);
            client.stage("order",progress);Result ordered=client.signed(client.directory.getString("newOrder"),new JSONObject().put("identifiers",new JSONArray().put(new JSONObject().put("type","dns").put("value",host))).toString(),false);String orderUrl=caUrl(ordered.location);JSONObject order=client.object(ordered);JSONArray authorizations=order.getJSONArray("authorizations");
            if(authorizations.length()!=1)throw new IndependentCertificate.Failure(client.phase,"CA_RESPONSE",0,0);
            String authUrl=caUrl(authorizations.getString(0));client.stage("authorization",progress);JSONObject auth=client.object(client.signed(authUrl,"",false));
            if(!auth.optString("status").equals("valid")){
                if(!auth.optString("status").equals("pending"))throw IndependentCertificate.resource(client.phase,auth);
                JSONObject challenge=null;JSONArray challenges=auth.getJSONArray("challenges");for(int i=0;i<challenges.length();i++)if(challenges.getJSONObject(i).optString("type").equals("dns-01"))challenge=challenges.getJSONObject(i);
                if(challenge==null)throw new IndependentCertificate.Failure(client.phase,"CA_RESPONSE",0,0);
                String validation=b64(MessageDigest.getInstance("SHA-256").digest((challenge.getString("token")+"."+client.thumbprint()).getBytes("US-ASCII")));
                client.stage("txt_set",progress);Result dns=http.request(duckUrl(host,token,validation,false),"GET",null);if(dns.status!=200||!dns.body.trim().equals("OK"))throw new IndependentCertificate.Failure(client.phase,"DNS_REJECTED",dns.status,0);txtSet=true;
                client.stage("txt_wait",progress);long start=waiter.now(),deadline=start+180000;int stable=0;IndependentCertificate.Failure last=null;
                // A provider's OK is not propagation. Require two observed values,
                // separated in time, before notifying the CA. No guessed PASS.
                while(waiter.now()<deadline){
                    if(waiter.now()-start>=30000){
                        try{if(lookup.visible(host,validation)){if(++stable>=2)break;}else stable=0;last=null;}
                        catch(Exception error){stable=0;last=IndependentCertificate.classify(client.phase,error);}
                    }
                    waiter.pause(10000);
                }
                if(stable<2)throw last!=null?last:new IndependentCertificate.Failure(client.phase,"DNS_PENDING",0,0);
                client.stage("authorization",progress);client.signed(caUrl(challenge.getString("url")),"{}",false);
                auth=client.poll(authUrl,"valid",new HashSet<String>(Arrays.asList("pending","processing")),waiter,progress);authorizationConfirmed=true;
            }
            // Authorization and order transitions are separate ACME resources.
            // The server must report ready before a CSR may be finalized.
            client.stage("ready",progress);order=client.poll(orderUrl,"ready",new HashSet<String>(Arrays.asList("pending")),waiter,progress);
            client.stage("finalize",progress);client.signed(caUrl(order.getString("finalize")),new JSONObject().put("csr",b64(csr(certificate,host))).toString(),false);
            order=client.poll(orderUrl,"valid",new HashSet<String>(Arrays.asList("pending","ready","processing")),waiter,progress);
            client.stage("download",progress);String chain=client.signed(caUrl(order.getString("certificate")),"",false).body;
            return new JSONObject().put("key",encoded(certificate.getPrivate())).put("chain",chain).put("issuedAt",waiter.now());
        }catch(Exception error){throw IndependentCertificate.classify(client.phase,error);}
        finally{if(txtSet&&authorizationConfirmed)try{http.request(duckUrl(host,token,"",true),"GET",null);}catch(Exception ignored){/* A later owner-controlled attempt can clean up the scoped TXT. */}}
    }
    // Recovery creates a separate identity; old sealed state and key remain intact.
    static final String NAME_V2=NAME+".v2",ALIAS_V2=ALIAS+".v2";
    private static String stateName(JSONObject config){return config.optInt("acmeAccountVersion",1)==2?NAME_V2:NAME;}
    private static String stateAlias(JSONObject config){return config.optInt("acmeAccountVersion",1)==2?ALIAS_V2:ALIAS;}
    static KeyPair accountKey(Context c,JSONObject config)throws Exception{
        String name=stateName(config),alias=stateAlias(config);
        try{
            // Do not silently create a new AES key for existing ciphertext.
            String encrypted=c.getSharedPreferences("fleet_sealed_runtime_v1",Context.MODE_PRIVATE).getString(name,"");
            if(!encrypted.isEmpty()){
                KeyStore keys=KeyStore.getInstance("AndroidKeyStore");keys.load(null);
                if(!keys.containsAlias(alias))throw new IndependentCertificate.Failure("storage","ACCOUNT_ALIAS_MISSING",0,0);
            }
        }catch(Exception error){throw IndependentCertificate.storage("ACCOUNT_KEYSTORE",error);}
        JSONObject saved;
        try{saved=SealedLocalState.read(c,name,alias);}catch(Exception error){throw IndependentCertificate.storage("ACCOUNT_READ",error);}
        if(saved.has("accountKey")){
            try{return decode(saved.getString("accountKey"),saved.optString("accountPublicKey",""));}catch(Exception error){throw IndependentCertificate.storage("ACCOUNT_DECODE",error);}
        }
        KeyPair created;
        try{created=generate();}catch(Exception error){throw IndependentCertificate.storage("RSA_GENERATE",error);}
        try{
            saved.put("accountKey",encoded(created.getPrivate()));
            saved.put("accountPublicKey",java.util.Base64.getEncoder().encodeToString(created.getPublic().getEncoded()));
            SealedLocalState.write(c,name,alias,saved);
        }
        catch(Exception error){throw IndependentCertificate.storage("ACCOUNT_WRITE",error);}
        // Split real-device failures: a verified sealed write must survive a
        // fresh read/decrypt, RSA reconstruction and exact public-key match.
        JSONObject persisted;
        try{persisted=SealedLocalState.read(c,name,alias);}
        catch(Exception error){throw IndependentCertificate.storage("ACCOUNT_VERIFY_READ",error);}
        KeyPair verified;
        try{verified=decode(persisted.getString("accountKey"),persisted.optString("accountPublicKey",""));}
        catch(Exception error){throw IndependentCertificate.storage("ACCOUNT_VERIFY_DECODE",error);}
        if(!java.util.Arrays.equals(created.getPublic().getEncoded(),verified.getPublic().getEncoded()))
            throw new IndependentCertificate.Failure("storage","ACCOUNT_VERIFY_MISMATCH",0,0);
        return verified;
    }
    /** Owner UI and explicit confirmation only: prepare v2 before selecting it. */
    static synchronized void prepareFreshAccount(Context c)throws Exception{
        JSONObject config;
        try{config=IndependentConfig.read(c);}catch(Exception error){throw IndependentCertificate.storage("CONFIG_READ",error);}
        if(!config.has("backupSha256")||!config.optBoolean("acmeTermsAccepted"))
            throw new IOException("Χρειάζεται εισαγμένο backup και αποδεκτοί όροι πιστοποιητικού.");
        if(config.optInt("acmeAccountVersion",1)!=1)
            throw new IOException("Έγινε ήδη η ασφαλής αλλαγή λογαριασμού. Δεν επιτρέπεται επαναλαμβανόμενη αντικατάσταση.");
        android.content.SharedPreferences ui=c.getSharedPreferences("independent_ui",Context.MODE_PRIVATE);
        String failure=ui.getString("certificateFailureCode","");
        if(failure.isEmpty())failure=ui.getString("certificate","");
        if(!failure.contains("CERT_STORAGE_ACCOUNT")&&!failure.contains("CERT_STORAGE_RSA")&&!failure.contains("CERT_STORAGE_STORAGE"))
            throw new IOException("Δεν υπάρχει καταγεγραμμένο σφάλμα κλειδιού ACME. Δεν πραγματοποιήθηκε αλλαγή.");
        JSONObject proposed=new JSONObject(config.toString()).put("acmeAccountVersion",2);
        accountKey(c,proposed); // seal + verify without touching v1
        try{IndependentConfig.save(c,proposed);}catch(Exception error){throw IndependentCertificate.storage("CONFIG_WRITE",error);}
        if(!ui.edit().putBoolean("certificateRetryRequested",true)
              .putString("certificate","Νέος απομονωμένος λογαριασμός πιστοποιητικού προετοιμάστηκε. Θα ακολουθήσει ασφαλής επανάληψη.")
              .remove("certificateFailureCode").commit())
            throw new IOException("Η ρύθμιση αποθηκεύτηκε, αλλά η επανάληψη χρειάζεται επανεκκίνηση της υπηρεσίας.");
    }
    static void issue(final Context c)throws Exception{issue(c,phase->{});}
    static synchronized void issue(final Context c,Progress progress)throws Exception{
        String phase="storage";
        try{
            progress.stage(phase);
            JSONObject config;
            try{config=IndependentConfig.read(c);}catch(Exception error){throw IndependentCertificate.storage("CONFIG_READ",error);}
            if(!config.optBoolean("acmeTermsAccepted"))throw new IndependentCertificate.Failure(phase,"CA_UNAUTHORIZED",0,0);
            String host,token;
            try{host=IndependentPolicy.hostname(config.getString("hostname"));token=config.getString("ddnsToken");}
            catch(Exception error){throw IndependentCertificate.storage("CONFIG_INVALID",error);}
            KeyPair account=accountKey(c,config);
            KeyPair certificate;
            try{certificate=generate();}catch(Exception error){throw IndependentCertificate.storage("RSA_GENERATE",error);}
            JSONObject identity=obtain(network(),account,certificate,host,token,new Waiter(){public long now(){return System.currentTimeMillis();}public void pause(long ms)throws Exception{Thread.sleep(ms);}},(name,value)->IndependentDns.visible(name,value),progress);
            phase="chain";progress.stage(phase);IndependentTls.save(c,identity,host);
        }catch(Exception error){throw IndependentCertificate.classify(phase,error);}
    }
}
