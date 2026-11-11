package gr.argyrismitsos.fleetserver;
import java.net.*;import java.io.IOException;import java.util.*;

/** No proxy headers, arbitrary origins, plaintext, production endpoints or Cloudflare fallback. */
public final class IndependentPolicy {
    private IndependentPolicy(){}
    public static String hostname(String value)throws IOException{
        String host=value.trim().toLowerCase(Locale.US);
        if(!host.matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.duckdns\\.org"))throw new IOException("Χρειάζεται το δικό σου καταχωρισμένο όνομα .duckdns.org, χωρίς https ή θύρα.");
        return host;
    }
    public static String origin(String value)throws Exception{
        URI uri=new URI(value);if(!"https".equals(uri.getScheme())||uri.getHost()==null||uri.getUserInfo()!=null||uri.getPort()!=-1&&uri.getPort()!=443||uri.getRawQuery()!=null||uri.getRawFragment()!=null||!Arrays.asList("","/").contains(uri.getRawPath()))throw new IOException("Χρειάζεται μία σταθερή διεύθυνση HTTPS χωρίς πρόσθετη διαδρομή.");
        return "https://"+hostname(uri.getHost());
    }
    public static boolean publicPeer(InetAddress address){
        if(address.isAnyLocalAddress()||address.isLoopbackAddress()||address.isLinkLocalAddress()||address.isSiteLocalAddress()||address.isMulticastAddress())return false;
        byte[] b=address.getAddress();int a=b[0]&255,c=b[1]&255,d=b.length>2?b[2]&255:0;
        if(b.length==4)return a>0&&a<224&&!(a==100&&c>=64&&c<=127)&&!(a==169&&c==254)&&!(a==192&&c==0&&(d==0||d==2))&&!(a==198&&(c==18||c==19||c==51&&d==100))&&!(a==203&&c==0&&d==113);
        return b.length==16&&(a&254)!=252&&(a&224)==32&&!(a==32&&c==1&&d==13&&(b[3]&255)==184);
    }
    public static boolean api(String path){
        return path.startsWith("/api/")&&!path.matches("/api/(server|deploy|pin|unlock|direct|primary)(/.*)?")&&!path.matches("/api/(server-update|client-update)(/.*)?")&&!path.matches("/api/auth/(login|bootstrap)")&&!path.equals("/api/sync");
    }
    public static void headers(String method,Map<String,String> headers,String realm)throws IOException{
        String origin=headers.get("origin"),site=headers.get("sec-fetch-site");
        if(origin!=null&&!origin.equals(realm)||"cross-site".equals(site))throw new IOException("Η πρόσβαση επιτρέπεται μόνο από την ίδια διεύθυνση Server.");
        if(!Arrays.asList("GET","HEAD").contains(method)&&headers.containsKey("cookie")&&!headers.containsKey("authorization")&&!realm.equals(origin))throw new IOException("Η αποθήκευση απαιτεί την ίδια ασφαλή προέλευση.");
    }
    public static Map<String,String> safeHeaders(Map<String,String> supplied){
        Map<String,String> result=new HashMap<String,String>();
        for(String name:Arrays.asList("authorization","cookie","content-type","origin","x-fleet-operation","x-fleet-pin-session","x-admin-pin","x-fleet-pin","x-idempotency-key","x-fleet-projection","x-fleet-local-ocr"))if(supplied.containsKey(name))result.put(name,supplied.get(name));
        return result;
    }
}
