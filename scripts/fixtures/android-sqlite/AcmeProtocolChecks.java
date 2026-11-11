package gr.argyrismitsos.fleetserver;

import org.json.*;
import java.io.*;
import java.net.*;
import java.security.*;
import java.util.*;

/** Synthetic CA/DNS ports: shared JVM and actual Android regression, no live service. */
public final class AcmeProtocolChecks {
    private static final String BASE="https://acme-v02.api.letsencrypt.org/",HOST="fixture.duckdns.org",TOKEN="synthetic-token-1234567890-abc",SECRET="PRIVATE_TEST_MARKER";
    private static void check(boolean ok,String message){if(!ok)throw new AssertionError(message);}
    private static final class Clock implements IndependentAcme.Waiter {
        long time=1800000000000L;public long now(){return time;}public void pause(long ms){check(ms>0&&ms<=10000,"bounded polling wait");time+=ms;}
    }
    private static final class Ca implements IndependentAcme.Http,IndependentAcme.Txt,IndependentAcme.Progress {
        final Clock clock=new Clock();final KeyPair account;final String chain;final List<String> phases=new ArrayList<String>();
        String mode,txt="";int writes,clears,observed,challenge,finalize,authReads,orderReads;long txtAt;boolean ready,finalized;
        Ca(KeyPair account,String chain,String mode){this.account=account;this.chain=chain;this.mode=mode;}
        public void stage(String phase){phases.add(phase);}
        private IndependentAcme.Result result(int status,JSONObject body,String location){return new IndependentAcme.Result(status,body.toString(),"synthetic-nonce-"+clock.time,location);}
        private JSONObject order(String status)throws Exception{return new JSONObject().put("status",status).put("authorizations",new JSONArray().put(BASE+"auth/fixture")).put("finalize",BASE+"finalize/fixture").put("certificate",BASE+"cert/fixture");}
        private JSONObject problem(String reason)throws Exception{return new JSONObject().put("type","urn:ietf:params:acme:error:"+reason).put("detail",SECRET+" https://www.duckdns.org/update?token="+TOKEN);}
        public boolean visible(String host,String expected)throws Exception {
            check(host.equals(HOST)&&expected.equals(txt),"exact scoped TXT lookup");
            if(mode.equals("servfail"))throw new IndependentCertificate.Failure("txt_wait","DNS_SERVFAIL",0,0);
            if(mode.equals("dns-offline"))throw new UnknownHostException(SECRET);
            if(mode.equals("stale")||clock.time-txtAt<70000)return false;
            observed++;return true;
        }
        public IndependentAcme.Result request(String url,String method,String body)throws Exception {
            if(url.startsWith("https://www.duckdns.org/update?")){
                check(method.equals("GET")&&url.contains("domains=fixture&token="+TOKEN),"scoped DuckDNS HTTPS update");
                if(url.contains("&clear=true")){clears++;check(url.contains("&txt=&clear=true"),"cleanup TXT only, not A record");return new IndependentAcme.Result(200,"OK",null,null);}
                writes++;txt=URLDecoder.decode(url.substring(url.indexOf("&txt=")+5),"UTF-8");txtAt=clock.time;
                return new IndependentAcme.Result(200,mode.equals("dns-rejected")?"KO":"OK",null,null);
            }
            check(IndependentAcme.caUrl(url).equals(url),"only pinned HTTPS CA paths");
            if(url.equals(IndependentAcme.DIRECTORY)){check(method.equals("GET"),"directory GET");return result(200,new JSONObject().put("newNonce",BASE+"new-nonce").put("newAccount",BASE+"new-account").put("newOrder",BASE+"new-order"),"");}
            if(method.equals("HEAD")){check(url.equals(BASE+"new-nonce"),"nonce endpoint");return new IndependentAcme.Result(204,"","synthetic-initial-nonce","");}
            check(method.equals("POST"),"all ACME resources use signed POST");
            JSONObject jws=new JSONObject(body);String protectedValue=jws.getString("protected"),encoded=jws.getString("payload");
            JSONObject header=new JSONObject(new String(java.util.Base64.getUrlDecoder().decode(protectedValue),"UTF-8"));
            check(header.getString("url").equals(url)&&header.getString("alg").equals("RS256")&&!header.getString("nonce").isEmpty(),"signed protected URL/alg/nonce");
            boolean registration=url.equals(BASE+"new-account");check(registration?header.has("jwk")&&!header.has("kid"):header.getString("kid").equals(BASE+"account/fixture")&&!header.has("jwk"),"account JWK vs subsequent kid");
            Signature verifier=Signature.getInstance("SHA256withRSA");verifier.initVerify(account.getPublic());verifier.update((protectedValue+"."+encoded).getBytes("US-ASCII"));check(verifier.verify(java.util.Base64.getUrlDecoder().decode(jws.getString("signature"))),"real RSA JWS on every request");
            String payload=new String(java.util.Base64.getUrlDecoder().decode(encoded),"UTF-8");
            if(registration){check(new JSONObject(payload).getBoolean("termsOfServiceAgreed"),"explicit agreed terms");return result(201,new JSONObject(),BASE+"account/fixture");}
            if(url.equals(BASE+"new-order")){
                check(new JSONObject(payload).getJSONArray("identifiers").getJSONObject(0).getString("value").equals(HOST),"exact single DNS identifier");
                if(mode.equals("caa"))return result(400,problem("caa"),"");
                if(mode.equals("subproblem"))return result(400,problem("rejectedIdentifier").put("subproblems",new JSONArray().put(problem("dns"))),"");
                if(mode.equals("rate"))return new IndependentAcme.Result(429,problem("rateLimited").toString(),"synthetic-rate-nonce","",clock.time+86400000L);
                return result(201,order("pending"),BASE+"order/fixture");
            }
            if(url.equals(BASE+"auth/fixture")){
                check(payload.isEmpty(),"authorization uses POST-as-GET empty payload");authReads++;
                JSONObject auth=new JSONObject().put("status",mode.equals("already-valid")||challenge>0&&authReads>=3?"valid":"pending");
                JSONObject challengeValue=new JSONObject().put("type","dns-01").put("token","synthetic-dns-challenge").put("url",BASE+"challenge/fixture");
                if(mode.equals("auth-caa")&&challenge>0)auth.put("status","invalid").put("error",problem("caa"));
                if(mode.equals("auth-dns")&&challenge>0)challengeValue.put("error",problem("dns"));
                if(mode.equals("auth-dns")&&challenge>0)auth.put("status","invalid");
                if(mode.equals("initial-invalid"))auth.put("status","invalid").put("error",problem("unauthorized"));
                return result(200,auth.put("challenges",new JSONArray().put(challengeValue)),"");
            }
            if(url.equals(BASE+"challenge/fixture")){check(payload.equals("{}")&&observed>=2&&clock.time-txtAt>=80000,"CA not notified until two separated public TXT observations");challenge++;return result(200,new JSONObject().put("status","pending"),"");}
            if(url.equals(BASE+"order/fixture")){
                check(payload.isEmpty(),"order uses POST-as-GET");orderReads++;
                if(!finalized){ready=!mode.equals("order-pending")&&orderReads>=3;return result(200,order(ready?"ready":"pending"),"");}
                return result(200,order(orderReads>=5?"valid":"processing"),"");
            }
            if(url.equals(BASE+"finalize/fixture")){check(ready,"never finalize before ready order");check(java.util.Base64.getUrlDecoder().decode(new JSONObject(payload).getString("csr")).length>500,"real signed PKCS#10 request");finalize++;finalized=true;return result(200,order("processing"),"");}
            if(url.equals(BASE+"cert/fixture")){check(payload.isEmpty()&&finalized,"certificate POST-as-GET after finalize");return new IndependentAcme.Result(200,chain,"synthetic-final-nonce","");}
            throw new AssertionError("Unexpected synthetic CA path");
        }
        JSONObject run(KeyPair certificate)throws Exception{return IndependentAcme.obtain(this,account,certificate,HOST,TOKEN,clock,this,this);}
    }
    private static void safe(Exception failure){String visible=IndependentCertificate.classify("directory",failure).getMessage()+IndependentCertificate.describe(failure,1800000600000L);check(!visible.contains(SECRET)&&!visible.contains(TOKEN)&&!visible.contains("https://")&&!visible.contains("synthetic-dns-challenge"),"no raw provider details, URLs, token or key in diagnostics");}
    private static void failure(KeyPair account,KeyPair certificate,String chain,String mode,String phase,String reason)throws Exception {
        Ca ca=new Ca(account,chain,mode);try{ca.run(certificate);throw new AssertionError("Expected "+mode+" failure");}catch(IndependentCertificate.Failure error){check(error.phase.equals(phase)&&error.reason.equals(reason),"correct safe stage/reason for "+mode);safe(error);if(mode.equals("rate"))check(IndependentCertificate.nextRetry(ca.clock.now(),1,error)>=error.retryAt&&error.retryAt==ca.clock.now()+86400000L,"honor CA retry beyond local cap");}
        check(ca.finalize==0,"failed validation never submits CSR");
        if(ca.writes>0&&!mode.equals("dns-rejected"))check(ca.clears==1,"attempt scoped TXT cleanup on success/failure");
        if(mode.equals("stale")||mode.equals("servfail")||mode.equals("dns-offline")||mode.equals("dns-rejected"))check(ca.challenge==0,"no premature challenge after unconfirmed DNS");
    }
    public static void run(KeyPair certificate,String chain,boolean trust)throws Exception {
        KeyPair account=IndependentAcme.generate();Ca success=new Ca(account,chain,"success");JSONObject identity=success.run(certificate);
        check(identity.getString("key").equals(IndependentAcme.encoded(certificate.getPrivate()))&&identity.getString("chain").equals(chain),"complete protocol retains exact returned identity");
        check(success.writes==1&&success.clears==1&&success.challenge==1&&success.finalize==1&&success.phases.contains("txt_wait")&&success.phases.contains("ready")&&success.phases.contains("download"),"full DNS/order/certificate lifecycle");
        if(trust)IndependentTls.chain(identity,HOST,true);
        Ca reused=new Ca(account,chain,"already-valid");reused.run(certificate);check(reused.writes==0&&reused.clears==0&&reused.challenge==0&&reused.finalize==1,"valid CA authorization avoids DNS writes");
        failure(account,certificate,chain,"caa","order","CAA");failure(account,certificate,chain,"subproblem","order","CA_DNS");failure(account,certificate,chain,"rate","order","CA_RATE_LIMIT");
        failure(account,certificate,chain,"stale","txt_wait","DNS_PENDING");failure(account,certificate,chain,"servfail","txt_wait","DNS_SERVFAIL");failure(account,certificate,chain,"dns-offline","txt_wait","DNS_UNAVAILABLE");failure(account,certificate,chain,"dns-rejected","txt_set","DNS_REJECTED");
        failure(account,certificate,chain,"auth-caa","authorization","CAA");failure(account,certificate,chain,"auth-dns","authorization","CA_DNS");failure(account,certificate,chain,"initial-invalid","authorization","CA_UNAUTHORIZED");failure(account,certificate,chain,"order-pending","ready","CA_PENDING");
        String txt="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";JSONObject answer=new JSONObject().put("Status",0).put("Answer",new JSONArray().put(new JSONObject().put("name","_acme-challenge."+HOST+".").put("type",16).put("data","\""+txt+"\"")));
        check(IndependentDns.visibleAnswer(answer.toString(),HOST,txt),"exact public TXT answer");check(!IndependentDns.visibleAnswer(answer.toString(),HOST,"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),"stale TXT rejected");
        answer.getJSONArray("Answer").getJSONObject(0).put("name","_acme-challenge.other.duckdns.org.");check(!IndependentDns.visibleAnswer(answer.toString(),HOST,txt),"unrelated TXT cannot validate hostname");answer.getJSONArray("Answer").getJSONObject(0).put("name","_acme-challenge."+HOST+".").put("type",1);check(!IndependentDns.visibleAnswer(answer.toString(),HOST,txt),"non-TXT record cannot validate");
        try{IndependentDns.visibleAnswer("{\"Status\":2}",HOST,txt);throw new AssertionError("SERVFAIL accepted");}catch(IndependentCertificate.Failure expected){check(expected.reason.equals("DNS_SERVFAIL"),"public DNS SERVFAIL preserved");}
        try{IndependentDns.visibleAnswer("{\"Status\":0,\"TC\":true}",HOST,txt);throw new AssertionError("Truncated answer accepted");}catch(IndependentCertificate.Failure expected){check(expected.reason.equals("DNS_UNAVAILABLE"),"truncated DNS rejected");}
        long now=1800000000000L;check(IndependentCertificate.retryAfter("120",now)==now+120000&&IndependentCertificate.retryAfter("not-a-date",now)==0,"Retry-After integer and malformed");
        java.text.SimpleDateFormat dates=new java.text.SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz",Locale.US);dates.setTimeZone(TimeZone.getTimeZone("GMT"));check(IndependentCertificate.retryAfter(dates.format(new Date(now+86400000L)),now)==now+86400000L,"Retry-After HTTP-date");
        check(IndependentCertificate.nextRetry(now,1,new IOException())==now+600000&&IndependentCertificate.nextRetry(now,7,new IOException())==now+21600000L,"bounded exponential retry");
        safe(new IOException(SECRET+TOKEN));check(IndependentCertificate.classify("directory",new javax.net.ssl.SSLHandshakeException(SECRET)).reason.equals("TLS"),"TLS failures categorized safely");
        check(IndependentCertificate.classify("chain",new java.security.cert.CertificateNotYetValidException(SECRET)).reason.equals("CLOCK"),"clock failures separated from untrusted chain");
        System.out.println("PASS synthetic full signed ACME/DNS-01 lifecycle, TXT propagation, ready-before-finalize, CAA/DNS/rate/timeout failures, scoped cleanup, privacy and Retry-After; no live CA/DNS changes.");
    }
}
