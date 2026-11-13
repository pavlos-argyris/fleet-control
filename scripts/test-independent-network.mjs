import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
const dir=path.resolve('.build/independent-network');fs.mkdirSync(dir,{recursive:true});
const run=(bin,args)=>execFileSync(bin,args,{stdio:'pipe'}),file=name=>path.join(dir,name),password='fixture-independent-only';
for(const name of ['ca.p12','server.p12','trust.p12'])try{fs.unlinkSync(file(name));}catch{}
run('keytool',['-genkeypair','-alias','ca','-keyalg','RSA','-keysize','2048','-validity','30','-dname','CN=Fleet disposable fixture CA','-ext','BC=ca:true','-keystore',file('ca.p12'),'-storepass',password,'-keypass',password,'-noprompt']);
run('keytool',['-exportcert','-rfc','-alias','ca','-keystore',file('ca.p12'),'-storepass',password,'-file',file('ca.pem')]);
run('keytool',['-genkeypair','-alias','server','-keyalg','RSA','-keysize','2048','-validity','30','-dname','CN=fixture.duckdns.org','-keystore',file('server.p12'),'-storepass',password,'-keypass',password,'-noprompt']);
run('keytool',['-certreq','-alias','server','-keystore',file('server.p12'),'-storepass',password,'-file',file('request.pem')]);
run('keytool',['-gencert','-rfc','-alias','ca','-keystore',file('ca.p12'),'-storepass',password,'-infile',file('request.pem'),'-outfile',file('leaf.pem'),'-validity','20','-ext','SAN=dns:fixture.duckdns.org','-ext','EKU=serverAuth','-ext','KU=digitalSignature,keyEncipherment']);
for(const key of ['server.p12','trust.p12'])run('keytool',['-importcert','-alias','ca','-keystore',file(key),'-storepass',password,'-file',file('ca.pem'),'-noprompt']);
run('keytool',['-importcert','-alias','server','-keystore',file('server.p12'),'-storepass',password,'-file',file('leaf.pem'),'-noprompt']);
fs.writeFileSync(file('Context.java'),'package android.content;public class Context{public static final int MODE_PRIVATE=0;public SharedPreferences getSharedPreferences(String name,int mode){throw new UnsupportedOperationException("Network fixture only");}}');
fs.writeFileSync(file('SharedPreferences.java'),'package android.content;public interface SharedPreferences{String getString(String k,String def);Editor edit();interface Editor{Editor putBoolean(String name,boolean value);Editor putString(String name,String value);Editor remove(String name);boolean commit();}}');
fs.writeFileSync(file('IndependentConfig.java'),'package gr.argyrismitsos.fleetserver;import org.json.*;import android.content.Context;public class IndependentConfig{static String random(){byte[] b=new byte[32];new java.security.SecureRandom().nextBytes(b);return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(b);}static JSONObject read(Context c){return new JSONObject();}static void save(Context c,JSONObject value){}}');
fs.writeFileSync(file('SealedLocalState.java'),'package gr.argyrismitsos.fleetserver;import org.json.*;import android.content.Context;public class SealedLocalState{static JSONObject value=new JSONObject();static JSONObject read(Context c,String n,String a){return value;}static void write(Context c,String n,String a,JSONObject v){value=v;}}');
fs.writeFileSync(file('IndependentNetworkTest.java'),String.raw`package gr.argyrismitsos.fleetserver;
import org.json.*;import java.net.*;import java.io.*;import java.nio.file.*;import java.security.*;import java.security.cert.*;import java.util.*;import java.util.concurrent.*;import javax.net.ssl.*;
public class IndependentNetworkTest {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 static SSLContext tls;static int port;static final String host="fixture.duckdns.org";
 static String request(String request)throws Exception{try(Socket tcp=new Socket("127.0.0.1",port);SSLSocket socket=(SSLSocket)tls.getSocketFactory().createSocket(tcp,host,port,true)){socket.setSoTimeout(20000);SSLParameters parameters=socket.getSSLParameters();parameters.setEndpointIdentificationAlgorithm("HTTPS");socket.setSSLParameters(parameters);socket.startHandshake();OutputStream out=socket.getOutputStream();out.write(request.getBytes("UTF-8"));out.flush();ByteArrayOutputStream bytes=new ByteArrayOutputStream();byte[] buffer=new byte[4096];int n;while((n=socket.getInputStream().read(buffer))!=-1)bytes.write(buffer,0,n);return new String(bytes.toByteArray(),"UTF-8");}}
 public static void main(String[] args)throws Exception{
  final String realm="https://"+host;check(IndependentPolicy.origin(realm+"/").equals(realm),"canonical HTTPS origin");
  for(String bad:new String[]{"http://fixture.duckdns.org","https://fixture.duckdns.org.evil.invalid","https://user@fixture.duckdns.org","https://fixture.duckdns.org:8443","https://fixture.duckdns.org/#fragment","https://fixture.duckdns.org?next=bad","https://fleet-control.pavlosargyris.workers.dev"}){boolean failed=false;try{IndependentPolicy.origin(bad);}catch(Exception expected){failed=true;}check(failed,"reject unsafe endpoint");}
  for(String address:new String[]{"127.0.0.1","192.168.1.2","10.1.2.3","100.64.1.2","169.254.2.2","192.0.2.3","198.51.100.1","203.0.113.1","::1","fd00::1","2001:db8::1"})check(!IndependentPolicy.publicPeer(InetAddress.getByName(address)),"private/test address is not external evidence: "+address);
  check(IndependentPolicy.publicPeer(InetAddress.getByName("8.8.8.8")),"numeric public fixture address");
  check(!IndependentPolicy.api("/api/server/pulse")&&!IndependentPolicy.api("/api/primary/request")&&!IndependentPolicy.api("/api/auth/bootstrap"),"private native/production routes denied");
  Map<String,String> attack=new HashMap<String,String>();attack.put("x-fleet-server-key","spoof");attack.put("cf-connecting-ip","8.8.8.8");attack.put("x-forwarded-for","8.8.8.8");check(IndependentPolicy.safeHeaders(attack).isEmpty(),"cannot spoof internal capability or peer");
  attack.put("origin","https://evil.invalid");boolean csrf=false;try{IndependentPolicy.headers("POST",attack,realm);}catch(IOException expected){csrf=true;}check(csrf,"cross-origin mutation blocked");attack.clear();attack.put("cookie","fc_auth=fixture");csrf=false;try{IndependentPolicy.headers("POST",attack,realm);}catch(IOException expected){csrf=true;}check(csrf,"cookie-only mutation needs same-origin proof");
  KeyStore store=KeyStore.getInstance("PKCS12");try(InputStream in=new FileInputStream(args[0]+"/server.p12")){store.load(in,"fixture-independent-only".toCharArray());}PrivateKey privateKey=(PrivateKey)store.getKey("server","fixture-independent-only".toCharArray());String chain=new String(Files.readAllBytes(Paths.get(args[0],"leaf.pem")),"US-ASCII")+new String(Files.readAllBytes(Paths.get(args[0],"ca.pem")),"US-ASCII");
  JSONObject identity=new JSONObject().put("key",java.util.Base64.getEncoder().encodeToString(privateKey.getEncoded())).put("chain",chain);tls=IndependentTls.context(identity,host,true);AcmeProtocolChecks.run(IndependentAcme.decode(identity.getString("key")),chain,true);
  boolean mismatch=false;try{IndependentTls.chain(identity,"other.duckdns.org",true);}catch(Exception expected){mismatch=true;}check(mismatch,"hostname/SAN mismatch denied");
  JSONObject wrong=new JSONObject(identity.toString()).put("key",IndependentAcme.encoded(IndependentAcme.generate().getPrivate()));mismatch=false;try{IndependentTls.chain(wrong,host,true);}catch(Exception expected){mismatch=true;}check(mismatch,"mismatched TLS key denied");
  // New no-password device-to-device format: cleartext private key, strict
  // hostname + real trusted certificate/private-key proof before installation.
  byte[] plain=IndependentCertificateTransfer.exportPlain(identity,host);
  check(plain.length<65536&&new String(plain,"UTF-8").contains(identity.getString("key"))&&
        new String(plain,"UTF-8").contains("BEGIN CERTIFICATE"),
        "Plain owner-controlled export contains the exact private key and chain");
  JSONObject plainImported=IndependentCertificateTransfer.importPlain(plain,host);
  check(plainImported.getString("key").equals(identity.getString("key"))&&
        plainImported.getString("chain").equals(identity.getString("chain")),
        "Plain import is exact, without password");
  IndependentTls.chain(plainImported,host,true);
  boolean plainRejected=false;
  try{IndependentCertificateTransfer.importPlain(plain,"other.duckdns.org");}
  catch(IOException expected){plainRejected=true;}
  check(plainRejected,"Plain file cannot import for a different DuckDNS name");
  JSONObject wrongPlain=new JSONObject(new String(plain,"UTF-8"))
        .put("key",IndependentAcme.encoded(IndependentAcme.generate().getPrivate()));
  plainRejected=false;
  try{IndependentTls.chain(IndependentCertificateTransfer.importPlain(wrongPlain.toString().getBytes("UTF-8"),host),host,true);}
  catch(Exception expected){plainRejected=true;}
  check(plainRejected,"Even valid-formatted plaintext transfer with wrong TLS key is rejected");
  plainRejected=false;
  try{IndependentCertificateTransfer.importPlain("not a Fleet TLS file".getBytes("UTF-8"),host);}
  catch(IOException expected){plainRejected=true;}
  check(plainRejected,"Malformed plaintext transfer is rejected");
  // Transfer must wrap the real TLS identity offline and fail closed on every mutation.
  String portableCode="fixture-only-very-long-private-passphrase";
  byte[] portable=IndependentCertificateTransfer.encrypt(identity,host,portableCode);
  check(portable.length<65536&&!new String(portable,"UTF-8").contains(identity.getString("key"))&&!new String(portable,"UTF-8").contains("BEGIN CERTIFICATE"),
        "portable HTTPS transfer contains no plaintext private key or certificate");
  JSONObject recovered=IndependentCertificateTransfer.decrypt(portable,host,portableCode);
  check(recovered.getString("key").equals(identity.getString("key"))&&recovered.getString("chain").equals(identity.getString("chain")),
        "certificate and private key decrypt exactly");
  IndependentTls.chain(recovered,host,true);
  for(String passphraseCandidate:new String[]{"wrongpassword00000","another-long-secret-passphrase"}){
      boolean rejected=false;try{IndependentCertificateTransfer.decrypt(portable,host,passphraseCandidate);}
      catch(Exception expected){rejected=true;}check(rejected,"wrong passphrase cannot decrypt");
  }
  boolean rejected=false;
  try{IndependentCertificateTransfer.decrypt(portable,"other.duckdns.org",portableCode);}
  catch(Exception expected){rejected=true;}
  check(rejected,"file cannot be imported for a different DuckDNS hostname");
  JSONObject tampered=new JSONObject(new String(portable,"UTF-8")).put("iterations",1);
  rejected=false;try{IndependentCertificateTransfer.decrypt(tampered.toString().getBytes("UTF-8"),host,portableCode);}
  catch(Exception expected){rejected=true;}check(rejected,"KDF work factor cannot be weakened");
  tampered=new JSONObject(new String(portable,"UTF-8"));
  String ciphertext=tampered.getString("ciphertext");
  byte[] changed=java.util.Base64.getDecoder().decode(ciphertext);changed[changed.length-1]^=1;
  tampered.put("ciphertext",java.util.Base64.getEncoder().encodeToString(changed));
  rejected=false;try{IndependentCertificateTransfer.decrypt(tampered.toString().getBytes("UTF-8"),host,portableCode);}
  catch(Exception expected){rejected=true;}check(rejected,"GCM rejects tampered transfer");
  rejected=false;try{IndependentCertificateTransfer.decrypt(new byte[65537],host,portableCode);}
  catch(Exception expected){rejected=true;}check(rejected,"oversized transfer rejected before PBKDF");
  final java.util.concurrent.atomic.AtomicInteger requests=new java.util.concurrent.atomic.AtomicInteger();
  IndependentHttps server=new IndependentHttps(tls,InetAddress.getByName("127.0.0.1"),0,realm,new IndependentHttps.Handler(){public JSONObject routing()throws Exception{return new JSONObject().put("schema",1).put("revision",7).put("activeMode","cloudflare");}public JSONObject api(JSONObject request)throws Exception{requests.incrementAndGet();check(!request.getJSONObject("headers").has("x-fleet-server-key"),"listener strips spoofed native key");check(!request.optBoolean("independentExternal"),"real localhost connection cannot become external");check(request.optString("independentPeer").equals("127.0.0.1"),"actual TCP peer overrides spoofed forwarding headers");return new JSONObject().put("status",200).put("headers",new JSONObject().put("Content-Type","application/json").put("Access-Control-Allow-Origin","*")).put("body","{\"local\":true}");}public InputStream asset(String name)throws Exception{if(name.equals("portal.html"))return new ByteArrayInputStream("<h1>Android-owned Web</h1>".getBytes("UTF-8"));if(name.equals("index.html"))return new ByteArrayInputStream("Fleet module".getBytes("UTF-8"));if(name.equals("download/client.apk")||name.equals("vendor/pdfjs/pdf.mjs")||name.equals("vendor/pdfjs/standard_fonts/FoxitSans.pfb"))return new ByteArrayInputStream("fixture private-free asset".getBytes("UTF-8"));throw new FileNotFoundException();}public long revision(){return 0;}public long await(long revision)throws Exception{Thread.sleep(10);return 0;}});port=server.port();server.start();String discovery=request("GET /fleet-mode.json HTTP/1.1\r\nHost: "+host+"\r\nOrigin: https://fleet-control.pavlosargyris.workers.dev\r\n\r\n");check(discovery.startsWith("HTTP/1.1 200")&&discovery.toLowerCase(Locale.US).contains("access-control-allow-origin: *")&&discovery.contains("\"revision\":7"),"only public mode discovery has credential-free CORS");
  long started=System.nanoTime();try{
   String ok=request("GET /api/status HTTP/1.1\r\nHost: "+host+"\r\nX-Fleet-Server-Key: spoof\r\nX-Forwarded-For: 8.8.8.8\r\nConnection: close\r\n\r\n");check(ok.startsWith("HTTP/1.1 200")&&ok.contains("{\"local\":true}")&&!ok.toLowerCase().contains("access-control-allow-origin"),"actual trusted TLS API and no wildcard CORS");
   check(request("GET / HTTP/1.1\r\nHost: "+host+"\r\n\r\n").contains("Android-owned Web"),"Web assets served by same Android origin");
   check(request("GET /fleet.html?embedded=1 HTTP/1.1\r\nHost: "+host+"\r\n\r\n").contains("Fleet module"),"fleet route serves index module, never the Portal");
   for(String asset:new String[]{"/vendor/pdfjs/pdf.mjs","/vendor/pdfjs/standard_fonts/FoxitSans.pfb","/download/client.apk"})check(request("GET "+asset+" HTTP/1.1\r\nHost: "+host+"\r\n\r\n").contains("fixture private-free asset"),"local PDF modules/fonts and explicit APK download are served");
   check(request("GET /private.apk HTTP/1.1\r\nHost: "+host+"\r\n\r\n").startsWith("HTTP/1.1 404"),"only the explicit packaged Client APK path is public");
   check(request("GET /api/server/pulse HTTP/1.1\r\nHost: "+host+"\r\n\r\n").startsWith("HTTP/1.1 403"),"private server route cannot reach handler");
   for(String malformed:new String[]{"GET /api/status HTTP/1.1\r\nHost: evil.invalid\r\n\r\n","POST /api/status HTTP/1.1\r\nHost: "+host+"\r\nOrigin: https://evil.invalid\r\nContent-Length: 0\r\n\r\n","POST /api/status HTTP/1.1\r\nHost: "+host+"\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n","GET /api/status HTTP/1.1\r\nHost: "+host+"\r\nHost: "+host+"\r\n\r\n","GET /%2e%2e/private HTTP/1.1\r\nHost: "+host+"\r\n\r\n"})check(request(malformed).isEmpty(),"malformed/CSRF/smuggling/traversal fail closed");
   try(Socket raw=new Socket("127.0.0.1",port)){raw.setSoTimeout(15000);raw.getOutputStream().write(("GET /health HTTP/1.1\r\nHost: "+host+"\r\n\r\n").getBytes("UTF-8"));int first=raw.getInputStream().read();check(first<0||first!=72,"plaintext HTTP cannot produce a successful HTTP response");}
   ExecutorService clients=Executors.newFixedThreadPool(30);try{List<Future<String>> responses=new ArrayList<Future<String>>();for(int i=0;i<30;i++)responses.add(clients.submit(()->request("GET /api/status HTTP/1.1\r\nHost: "+host+"\r\n\r\n")));for(Future<String> response:responses)check(response.get().contains("{\"local\":true}"),"30 concurrent actual TLS connections");}finally{clients.shutdownNow();}
   check(requests.get()==31,"rejected requests never reach business code");
  }finally{server.close();}
  KeyPair account=IndependentAcme.generate();final int[] posts={0};IndependentAcme acme=new IndependentAcme((url,method,body)->{if(method.equals("HEAD"))return new IndependentAcme.Result(200,"","fixture-nonce-1","");JSONObject jws=new JSONObject(body);String protectedValue=jws.getString("protected"),payload=jws.getString("payload");JSONObject header=new JSONObject(new String(java.util.Base64.getUrlDecoder().decode(protectedValue),"UTF-8"));check(header.getString("url").equals(url)&&header.getString("alg").equals("RS256")&&header.has("jwk")&&!header.has("kid"),"RFC8555 protected URL/alg/JWK");Signature verifier=Signature.getInstance("SHA256withRSA");verifier.initVerify(account.getPublic());verifier.update((protectedValue+"."+payload).getBytes("US-ASCII"));check(verifier.verify(java.util.Base64.getUrlDecoder().decode(jws.getString("signature"))),"real RSA JWS signature");posts[0]++;return posts[0]==1?new IndependentAcme.Result(400,"urn:ietf:params:acme:error:badNonce","fixture-nonce-2",""):new IndependentAcme.Result(201,"{}","fixture-nonce-3","https://acme-v02.api.letsencrypt.org/acme/acct/fixture");},account);
  java.lang.reflect.Field directory=IndependentAcme.class.getDeclaredField("directory");directory.setAccessible(true);directory.set(acme,new JSONObject().put("newNonce","https://acme-v02.api.letsencrypt.org/acme/new-nonce"));check(acme.signed("https://acme-v02.api.letsencrypt.org/acme/new-acct","{}",true).status==201&&posts[0]==2,"bounded badNonce retry uses new signed nonce");
  byte[] csr=IndependentAcme.csr(IndependentAcme.generate(),host);Files.write(Paths.get(args[0],"generated.csr"),csr);String duck=IndependentAcme.duckUrl(host,"fixture-token-1234567890-abc","validation",false);check(duck.startsWith("https://www.duckdns.org/update?")&&duck.contains("domains=fixture")&&duck.contains("&txt=validation"),"DuckDNS uses scoped HTTPS DNS-01 API");
  String expectedTxt="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";String txtName="_acme-challenge."+host+".";String quotedTxt=new JSONObject().put("Status",0).put("Answer",new JSONArray().put(new JSONObject().put("name",txtName).put("type",16).put("data","\""+expectedTxt+"\""))).toString();String normalizedTxt=new JSONObject().put("Status",0).put("Answer",new JSONArray().put(new JSONObject().put("name",txtName).put("type",16).put("data",expectedTxt))).toString();check(IndependentDns.visibleAnswer(quotedTxt,host,expectedTxt),"quoted TXT record accepted");check(IndependentDns.visibleAnswer(normalizedTxt,host,expectedTxt),"normalized TXT record accepted");check(!IndependentDns.visibleAnswer(new JSONObject().put("Status",0).put("Answer",new JSONArray().put(new JSONObject().put("name",txtName).put("type",16).put("data",""))).toString(),host,expectedTxt),"empty TXT must never validate");
  check(!IndependentDns.visibleAnswer(new JSONObject().put("Status",0).put("Answer",new JSONArray().put(new JSONObject().put("name","_acme-challenge.other.duckdns.org.").put("type",16).put("data",expectedTxt))).toString(),host,expectedTxt),"wrong DNS owner must never validate");
  check(!IndependentDns.visibleAnswer(new JSONObject().put("Status",0).put("Answer",new JSONArray().put(new JSONObject().put("name",txtName).put("type",1).put("data",expectedTxt))).toString(),host,expectedTxt),"non-TXT DNS answer must never validate");
  boolean servfail=false;try{IndependentDns.visibleAnswer(new JSONObject().put("Status",2).toString(),host,expectedTxt);}catch(IndependentCertificate.Failure failure){servfail=failure.reason.equals("DNS_SERVFAIL");}check(servfail,"SERVFAIL must surface distinct safe diagnostic");
  boolean denied=false;try{IndependentAcme.caUrl("https://evil.invalid/redirect");}catch(Exception expected){denied=true;}check(denied,"ACME endpoint SSRF/redirect guard");
  JSONObject result=new JSONObject().put("passed",true).put("realTlsConnections",32).put("parallelClients",30).put("elapsedMs",(System.nanoTime()-started)/1000000).put("physicalAndroidTest",false).put("externalNovaTest",false).put("liveCertificateIssuance",false);Files.write(Paths.get(args[0],"results.json"),result.toString(2).getBytes("UTF-8"));System.out.println("PASS actual trusted TLS/SAN/key validation, TLS-only listener, same-origin/CSRF/Host/smuggling/traversal rejection, true TCP-peer provenance, 30 concurrent TLS clients, RSA DNS CSR and signed ACME badNonce retry. Encrypted offline TLS export/import, wrong password, wrong host, KDF downgrade and tamper rejection verified; live DDNS/CA issuance and physical Nova/Android tests remain pending.");
 }
}`);
const jar=path.resolve('vendor/json-java/json-20240303.jar');
const sources=['Context','SharedPreferences','IndependentConfig','SealedLocalState','IndependentNetworkTest'].map(n=>file(n+'.java')).concat([path.resolve('scripts/fixtures/android-sqlite/AcmeProtocolChecks.java')]).concat(['IndependentPolicy','IndependentHttps','IndependentAcme','IndependentTls','IndependentDns','IndependentCertificate','IndependentCertificateTransfer'].map(n=>path.resolve('independent-android/src/gr/argyrismitsos/fleetserver',n+'.java')));
execFileSync('java',['-jar',path.resolve('.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-cp',jar,'-d',dir,...sources],{stdio:'inherit'});
execFileSync('java',['-Djavax.net.ssl.trustStore='+file('trust.p12'),'-Djavax.net.ssl.trustStorePassword='+password,'-cp',dir+path.delimiter+jar,'gr.argyrismitsos.fleetserver.IndependentNetworkTest',dir],{stdio:'inherit',timeout:90000});
const inspected=run('openssl',['req','-inform','DER','-in',file('generated.csr'),'-noout','-verify','-text']).toString();if(!inspected.includes('DNS:fixture.duckdns.org'))throw Error('CSR lacks exact SAN');console.log('PASS OpenSSL independently verifies generated PKCS#10 signature and DNS subjectAltName.');
