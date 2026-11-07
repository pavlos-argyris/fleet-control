package gr.argyrismitsos.fleetserver;

import org.json.*;
import java.net.URI;
import java.nio.charset.Charset;
import java.security.*;
import java.text.SimpleDateFormat;
import java.util.*;
import javax.crypto.*;
import javax.crypto.spec.*;

/** Pure primitives shared by production and actual JVM/SQLite integration tests. */
public final class BusinessPrimitives {
    private BusinessPrimitives(){}
    static byte[] unhex(String value)throws Exception{
        if(value.length()%2!=0||!value.matches("[A-Fa-f0-9]*"))throw new IllegalArgumentException("Invalid bytes");byte[] out=new byte[value.length()/2];for(int i=0;i<out.length;i++)out[i]=(byte)Integer.parseInt(value.substring(i*2,i*2+2),16);return out;
    }
    static String hex(byte[] data){StringBuilder s=new StringBuilder(data.length*2);for(byte b:data){s.append(Character.forDigit((b>>>4)&15,16));s.append(Character.forDigit(b&15,16));}return s.toString();}
    public static JSONObject call(String command,JSONObject data)throws Exception {
        if(command.equals("clock"))return new JSONObject().put("millis",System.nanoTime()/1000000.0);
        if(command.equals("diagnostic"))return new JSONObject();
        if(command.equals("utf8.decode"))return new JSONObject().put("text",new String(unhex(data.getString("hex")),"UTF-8"));
        if(command.equals("base64.encode")){
            String text=data.getString("text");for(int i=0;i<text.length();i++)if(text.charAt(i)>255)throw new IllegalArgumentException("Invalid binary string");
            return new JSONObject().put("text",Base64.getEncoder().encodeToString(text.getBytes("ISO-8859-1")));
        }
        if(command.equals("base64.decode"))return new JSONObject().put("text",new String(Base64.getDecoder().decode(data.getString("text")),"ISO-8859-1"));
        if(command.equals("url.parse")){
            URI uri=new URI(data.getString("value"));if(!uri.isAbsolute()&&!data.isNull("base"))uri=new URI(data.getString("base")).resolve(uri);uri=URI.create(uri.toASCIIString());String host=uri.getHost();if(host==null)throw new IllegalArgumentException("Invalid URL");String origin=uri.getScheme()+"://"+host+(uri.getPort()<0?"":":"+uri.getPort());
            return new JSONObject().put("protocol",uri.getScheme()+":").put("hostname",host).put("host",host+(uri.getPort()<0?"":":"+uri.getPort())).put("port",uri.getPort()<0?"":String.valueOf(uri.getPort())).put("origin",origin).put("pathname",uri.getRawPath()==null||uri.getRawPath().isEmpty()?"/":uri.getRawPath()).put("search",uri.getRawQuery()==null?"":"?"+uri.getRawQuery()).put("hash",uri.getRawFragment()==null?"":"#"+uri.getRawFragment()).put("username",uri.getRawUserInfo()==null?"":uri.getRawUserInfo().split(":",2)[0]).put("password",uri.getRawUserInfo()!=null&&uri.getRawUserInfo().contains(":")?uri.getRawUserInfo().split(":",2)[1]:"");
        }
        if(command.equals("date.parts")){
            String zone=data.getString("zone");if(!Arrays.asList(TimeZone.getAvailableIDs()).contains(zone))throw new IllegalArgumentException("Invalid zone");TimeZone tz=TimeZone.getTimeZone(zone);Date date=new Date(data.getLong("at"));JSONArray parts=new JSONArray();String[] names={"year","month","day","hour","minute","second","weekday"},formats={"yyyy","MM","dd","HH","mm","ss","EEE"};
            for(int i=0;i<names.length;i++){SimpleDateFormat f=new SimpleDateFormat(formats[i],Locale.US);f.setTimeZone(tz);parts.put(new JSONObject().put("type",names[i]).put("value",f.format(date)));}return new JSONObject().put("parts",parts);
        }
        if(command.equals("crypto.random")){int n=data.getInt("length");if(n<0||n>65536)throw new IllegalArgumentException("Random byte limit");byte[] bytes=new byte[n];new SecureRandom().nextBytes(bytes);return new JSONObject().put("hex",hex(bytes));}
        if(command.equals("crypto.digest")){if(!"SHA-256".equals(data.getString("algorithm")))throw new IllegalArgumentException("Unsupported digest");return new JSONObject().put("hex",BusinessRuntime.sha256(unhex(data.getString("hex"))));}
        if(command.equals("crypto.derive")){
            if(!"PBKDF2".equals(data.getString("algorithm"))||!"SHA-256".equals(data.getString("hash")))throw new IllegalArgumentException("Unsupported derivation");int iterations=data.getInt("iterations"),bits=data.getInt("length");if(iterations<1||iterations>1000000||bits<8||bits>512||bits%8!=0)throw new IllegalArgumentException("Derivation limit");
            char[] pass=new String(unhex(data.getString("key")),"UTF-8").toCharArray();PBEKeySpec spec=new PBEKeySpec(pass,unhex(data.getString("salt")),iterations,bits);try{return new JSONObject().put("hex",hex(SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded()));}finally{spec.clearPassword();Arrays.fill(pass,'\0');}
        }
        if(command.equals("crypto.sign")||command.equals("crypto.verify")){
            if(!"HMAC".equals(data.getString("algorithm")))throw new IllegalArgumentException("Unsupported signature");Mac mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(unhex(data.getString("key")),"HmacSHA256"));byte[] result=mac.doFinal(unhex(data.getString("hex")));
            return command.equals("crypto.sign")?new JSONObject().put("hex",hex(result)):new JSONObject().put("valid",MessageDigest.isEqual(result,unhex(data.getString("signature"))));
        }
        return null;
    }
}
