package gr.argyrismitsos.fleetserver;
import android.content.Context;import org.json.*;import java.io.*;import java.net.*;import java.math.BigInteger;import java.security.*;import java.security.interfaces.*;import java.security.spec.*;import java.util.*;import javax.net.ssl.HttpsURLConnection;

/** ACME v2 DNS-01, RFC8555. Only DuckDNS DNS updates and Let's Encrypt HTTPS. No port80. */
public final class IndependentAcme {
    static final String NAME="independent.acme",ALIAS="fleet.independent.acme.v1",DIRECTORY="https://acme-v02.api.letsencrypt.org/directory";
    interface Http { Result request(String url,String method,String body)throws Exception; }
    static final class Result {final int status;final String body,nonce,location;Result(int status,String body,String nonce,String location){this.status=status;this.body=body;this.nonce=nonce;this.location=location;}}
    private final Http http;private final KeyPair account;private JSONObject directory;private String kid="",nonce="";
    IndependentAcme(Http http,KeyPair account){this.http=http;this.account=account;}
    private static String b64(byte[] bytes){return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);}
    static KeyPair generate()throws Exception{KeyPairGenerator generator=KeyPairGenerator.getInstance("RSA");generator.initialize(2048);return generator.generateKeyPair();}
    static String encoded(PrivateKey key){return java.util.Base64.getEncoder().encodeToString(key.getEncoded());}
    static KeyPair decode(String privateKey)throws Exception{RSAPrivateCrtKey key=(RSAPrivateCrtKey)KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(java.util.Base64.getDecoder().decode(privateKey)));return new KeyPair(KeyFactory.getInstance("RSA").generatePublic(new RSAPublicKeySpec(key.getModulus(),key.getPublicExponent())),key);}
    static byte[] unsigned(BigInteger value){byte[] b=value.toByteArray();return b.length>1&&b[0]==0?Arrays.copyOfRange(b,1,b.length):b;}
    JSONObject jwk()throws Exception{RSAPublicKey key=(RSAPublicKey)account.getPublic();return new JSONObject().put("e",b64(unsigned(key.getPublicExponent()))).put("kty","RSA").put("n",b64(unsigned(key.getModulus())));}
    String thumbprint()throws Exception{JSONObject key=jwk();String canonical="{\"e\":\""+key.getString("e")+"\",\"kty\":\"RSA\",\"n\":\""+key.getString("n")+"\"}";return b64(MessageDigest.getInstance("SHA-256").digest(canonical.getBytes("UTF-8")));}
    static String caUrl(String url)throws Exception{URI uri=new URI(url);if(!"https".equals(uri.getScheme())||!"acme-v02.api.letsencrypt.org".equals(uri.getHost())||uri.getPort()!=-1||uri.getUserInfo()!=null||uri.getFragment()!=null)throw new IOException("Μη επιτρεπτή διεύθυνση ACME.");return url;}
    Result signed(String url,String payload,boolean newAccount)throws Exception{
        for(int retry=0;retry<2;retry++){
            caUrl(url);if(nonce.isEmpty()){Result fresh=http.request(caUrl(directory.getString("newNonce")),"HEAD",null);nonce=fresh.nonce;}if(nonce==null||nonce.isEmpty())throw new IOException("Λείπει nonce ACME.");
            JSONObject header=new JSONObject().put("alg","RS256").put("nonce",nonce).put("url",url);if(newAccount)header.put("jwk",jwk());else header.put("kid",kid);
            String protectedValue=b64(header.toString().getBytes("UTF-8")),data=b64(payload.getBytes("UTF-8"));Signature signature=Signature.getInstance("SHA256withRSA");signature.initSign(account.getPrivate());signature.update((protectedValue+"."+data).getBytes("US-ASCII"));
            Result result=http.request(url,"POST",new JSONObject().put("protected",protectedValue).put("payload",data).put("signature",b64(signature.sign())).toString());nonce=result.nonce==null?"":result.nonce;
            if(result.status>=200&&result.status<300)return result;
            if(result.status==400&&result.body.contains("urn:ietf:params:acme:error:badNonce")&&retry==0)continue;
            throw new IOException(result.status==429?"Ο πάροχος πιστοποιητικών περιόρισε τις προσπάθειες. Θα επαναληφθεί με αναμονή.":"Η έκδοση πιστοποιητικού δεν επιβεβαιώθηκε (ACME HTTP "+result.status+").");
        }throw new IOException("Απέτυχε ασφαλής ανανέωση nonce ACME.");
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
        HttpsURLConnection connection=(HttpsURLConnection)new URL(address).openConnection();connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(10000);connection.setReadTimeout(15000);connection.setRequestMethod(method);connection.setRequestProperty("User-Agent","Fleet-Independent-Android/1");
        try{if(body!=null){byte[] bytes=body.getBytes("UTF-8");connection.setDoOutput(true);connection.setRequestProperty("Content-Type","application/jose+json");connection.setFixedLengthStreamingMode(bytes.length);try(OutputStream out=connection.getOutputStream()){out.write(bytes);}}
            int status=connection.getResponseCode();ByteArrayOutputStream out=new ByteArrayOutputStream();InputStream raw=status>=400?connection.getErrorStream():connection.getInputStream();if(raw!=null)try(InputStream input=raw){byte[] bytes=new byte[8192];int n;while((n=input.read(bytes))!=-1){if(out.size()+n>1024*1024)throw new IOException("Oversized certificate response");out.write(bytes,0,n);}}
            return new Result(status,new String(out.toByteArray(),"UTF-8"),connection.getHeaderField("Replay-Nonce"),connection.getHeaderField("Location"));
        }finally{connection.disconnect();}
    }};}
    static String duckUrl(String host,String token,String txt,boolean clear)throws Exception{
        String domain=IndependentPolicy.hostname(host).replace(".duckdns.org","");if(!token.matches("[A-Za-z0-9-]{20,128}"))throw new IOException("Χρειάζεται έγκυρο προστατευμένο token DuckDNS.");
        return "https://www.duckdns.org/update?domains="+domain+"&token="+URLEncoder.encode(token,"UTF-8")+(txt==null?"&ip=&verbose=true":"&txt="+URLEncoder.encode(txt,"UTF-8")+(clear?"&clear=true":""));
    }
    static String updateDns(Context c)throws Exception{JSONObject config=IndependentConfig.read(c);Result result=network().request(duckUrl(config.getString("hostname"),config.getString("ddnsToken"),null,false),"GET",null);if(result.status!=200||!result.body.startsWith("OK\n")&&!result.body.trim().equals("OK"))throw new IOException("Η ενημέρωση DuckDNS δεν επιβεβαιώθηκε.");String[] lines=result.body.split("\\r?\\n");String ipv4=lines.length>1?lines[1].trim():"";if(!ipv4.matches("[0-9.]{7,15}")||!IndependentPolicy.publicPeer(InetAddress.getByName(ipv4)))throw new IOException("Το DuckDNS δεν επιβεβαίωσε δημόσια IPv4. Δεν ανοίγει εξωτερική πρόσβαση.");return ipv4;}
    static void issue(final Context c)throws Exception{
        JSONObject config=IndependentConfig.read(c);if(!config.optBoolean("acmeTermsAccepted"))throw new IOException("Χρειάζεται αποδοχή των όρων του παρόχου πιστοποιητικών από τον ιδιοκτήτη.");
        String host=IndependentPolicy.hostname(config.getString("hostname")),token=config.getString("ddnsToken");JSONObject saved=SealedLocalState.read(c,NAME,ALIAS);KeyPair account=saved.has("accountKey")?decode(saved.getString("accountKey")):generate();
        if(!saved.has("accountKey")){saved.put("accountKey",encoded(account.getPrivate()));SealedLocalState.write(c,NAME,ALIAS,saved);}
        IndependentAcme client=new IndependentAcme(network(),account);Result directoryResponse=client.http.request(DIRECTORY,"GET",null);if(directoryResponse.status!=200)throw new IOException("Δεν είναι διαθέσιμη η υπηρεσία πιστοποιητικών.");client.directory=new JSONObject(directoryResponse.body);
        Result accountResult=client.signed(client.directory.getString("newAccount"),new JSONObject().put("termsOfServiceAgreed",true).toString(),true);client.kid=caUrl(accountResult.location);
        Result ordered=client.signed(client.directory.getString("newOrder"),new JSONObject().put("identifiers",new JSONArray().put(new JSONObject().put("type","dns").put("value",host))).toString(),false);String orderUrl=caUrl(ordered.location);JSONObject order=new JSONObject(ordered.body);JSONArray authorizations=order.getJSONArray("authorizations");
        if(authorizations.length()!=1)throw new IOException("Unexpected certificate authorization");String authUrl=caUrl(authorizations.getString(0));JSONObject auth=new JSONObject(client.signed(authUrl,"",false).body);
        JSONObject challenge=null;JSONArray challenges=auth.getJSONArray("challenges");for(int i=0;i<challenges.length();i++)if(challenges.getJSONObject(i).optString("type").equals("dns-01"))challenge=challenges.getJSONObject(i);if(challenge==null)throw new IOException("Ο πάροχος δεν πρόσφερε DNS-01.");
        boolean txtSet=false;try{
            if(!auth.optString("status").equals("valid")){
                String validation=b64(MessageDigest.getInstance("SHA-256").digest((challenge.getString("token")+"."+client.thumbprint()).getBytes("US-ASCII")));
                Result dns=client.http.request(duckUrl(host,token,validation,false),"GET",null);if(dns.status!=200||!dns.body.trim().equals("OK"))throw new IOException("Δεν επιβεβαιώθηκε η εγγραφή DNS-01.");txtSet=true;
                // Bounded propagation wait. CA validation remains authoritative; a pending check never becomes PASS.
                Thread.sleep(15000);client.signed(caUrl(challenge.getString("url")),"{}",false);
                for(int attempt=0;attempt<20;attempt++){auth=new JSONObject(client.signed(authUrl,"",false).body);if(auth.optString("status").equals("valid"))break;if(!Arrays.asList("pending","processing").contains(auth.optString("status")))throw new IOException("Η επαλήθευση DNS-01 απέτυχε.");Thread.sleep(3000);}
                if(!auth.optString("status").equals("valid"))throw new IOException("Το DNS-01 παραμένει σε αναμονή. Θα επαναληφθεί με αναμονή.");
            }
            KeyPair certificate=generate();client.signed(caUrl(order.getString("finalize")),new JSONObject().put("csr",b64(csr(certificate,host))).toString(),false);
            for(int attempt=0;attempt<20;attempt++){order=new JSONObject(client.signed(orderUrl,"",false).body);if(order.optString("status").equals("valid"))break;if(!Arrays.asList("pending","ready","processing").contains(order.optString("status")))throw new IOException("Η έκδοση πιστοποιητικού απέτυχε.");Thread.sleep(3000);}
            if(!order.optString("status").equals("valid"))throw new IOException("Το πιστοποιητικό παραμένει σε αναμονή.");String chain=client.signed(caUrl(order.getString("certificate")),"",false).body;
            IndependentTls.save(c,new JSONObject().put("key",encoded(certificate.getPrivate())).put("chain",chain).put("issuedAt",System.currentTimeMillis()),host);
        }finally{if(txtSet)try{client.http.request(duckUrl(host,token,"",true),"GET",null);}catch(Exception ignored){/* Next attempt rewrites this single scoped TXT. */}}
    }
}
