package gr.argyrismitsos.fleetserver;

import org.json.JSONArray;
import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;
import java.net.URL;
import java.io.*;
import java.nio.charset.Charset;
import java.text.SimpleDateFormat;
import java.security.MessageDigest;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.*;

/** Fixed, read-only provider protocol. No arbitrary path, method or redirects. */
public final class OrdexaClient {
    static final String ORIGIN="https://api.ordexa.gr";
    static final Charset UTF8=Charset.forName("UTF-8");
    public enum Action { LOGIN, ME, CITIES, REPORT }
    interface Transport { JSONObject send(String url,String method,JSONObject body,String token)throws Exception; }
    private final Transport transport;
    private String token="";
    public OrdexaClient(){this(new HttpsTransport());}
    OrdexaClient(Transport transport){this.transport=transport;}
    static String path(Action action,String city,String from,String to)throws Exception{
        if(action==null)throw new IllegalArgumentException("Άγνωστη ενέργεια Ordexa.");
        switch(action){
            case LOGIN:return "/api/login";
            case ME:return "/api/me";
            case CITIES:return "/api/cities";
            case REPORT:
                if(city==null||!city.matches("[A-Za-z0-9_-]{1,100}"))throw new IllegalArgumentException("Μη έγκυρη πόλη Ordexa.");
                day(from);day(to);if(from.compareTo(to)>0)throw new IllegalArgumentException("Μη έγκυρη περίοδος Ordexa.");
                return "/api/cities/"+city+"/report?from="+from+"&to="+to;
            default:throw new IllegalArgumentException("Μη επιτρεπόμενη ενέργεια Ordexa.");
        }
    }
    static void day(String day)throws Exception{
        if(day==null||!day.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}"))throw new IllegalArgumentException("Μη έγκυρη ημερομηνία.");
        SimpleDateFormat f=new SimpleDateFormat("yyyy-MM-dd",Locale.US);f.setTimeZone(TimeZone.getTimeZone("UTC"));f.setLenient(false);if(!f.format(f.parse(day)).equals(day))throw new IllegalArgumentException("Μη έγκυρη ημερομηνία.");
    }
    static String identifier(Object value)throws Exception{
        if(value instanceof Number){double n=((Number)value).doubleValue();if(Double.isNaN(n)||Double.isInfinite(n)||n<0||n>9007199254740991d||n!=Math.floor(n))throw new IOException("Μη έγκυρο αναγνωριστικό Ordexa.");return new java.math.BigDecimal(value.toString()).stripTrailingZeros().toPlainString();}
        if(!(value instanceof String)||((String)value).trim().length()==0||((String)value).length()>100)throw new IOException("Μη έγκυρο αναγνωριστικό Ordexa.");return (String)value;
    }
    static long instant(String value)throws Exception{
        Matcher match=Pattern.compile("^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2})(?:\\.(\\d{1,3}))?(Z|[+-]\\d{2}:\\d{2})$").matcher(value);
        if(!match.matches()||Integer.parseInt(value.substring(11,13))>23)throw new IOException("Η ώρα Ordexa πρέπει να έχει πλήρη ημερομηνία και ζώνη ώρας.");
        String fraction=match.group(2)==null?"":match.group(2);while(fraction.length()<3)fraction+="0";
        String zone="Z".equals(match.group(3))?"+0000":match.group(3).replace(":","");SimpleDateFormat format=new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ",Locale.US);format.setLenient(false);return format.parse(match.group(1)+"."+fraction+zone).getTime();
    }
    // Array ordering and JSONObject iteration order are not provider revisions.
    // Only normalized, credential-free report data is fingerprinted locally.
    private static String canonical(Object value)throws Exception{
        if(value instanceof JSONObject){JSONObject object=(JSONObject)value;List<String> keys=new ArrayList<String>();Iterator<String> iterator=object.keys();while(iterator.hasNext()){String k=iterator.next();if(!"capturedAt".equals(k))keys.add(k);}Collections.sort(keys);StringBuilder result=new StringBuilder("{");for(String k:keys){if(result.length()>1)result.append(',');result.append(JSONObject.quote(k)).append(':').append(canonical(object.get(k)));}return result.append('}').toString();}
        if(value instanceof JSONArray){JSONArray array=(JSONArray)value;List<String> rows=new ArrayList<String>();for(int i=0;i<array.length();i++)rows.add(canonical(array.get(i)));Collections.sort(rows);StringBuilder result=new StringBuilder("[");for(String row:rows){if(result.length()>1)result.append(',');result.append(row);}return result.append(']').toString();}
        // Android does not expose JSONObject.valueToString publicly. A
        // one-element array applies JSON escaping using public SDK methods.
        String wrapped=new JSONArray().put(value).toString();return wrapped.substring(1,wrapped.length()-1);
    }
    static String digest(JSONObject report)throws Exception{
        byte[] bytes=MessageDigest.getInstance("SHA-256").digest(canonical(report).getBytes(UTF8));StringBuilder result=new StringBuilder();for(byte b:bytes)result.append(String.format(Locale.US,"%02x",b&255));return result.toString();
    }
    private JSONObject call(Action action,JSONObject body,String city,String from,String to)throws Exception{
        String path=path(action,city,from,to);
        if(action!=Action.LOGIN&&token.length()==0)throw new IOException("Συνδέσου πρώτα στο Ordexa από τις ρυθμίσεις Server.");
        return transport.send(ORIGIN+path,action==Action.LOGIN?"POST":"GET",action==Action.LOGIN?body:null,action==Action.LOGIN?"":token);
    }
    public void token(String value){token=value==null?"":value;}
    public String login(String username,String password)throws Exception{
        if(username==null||username.trim().length()==0||username.length()>200||password==null||password.length()==0||password.length()>1000)throw new IllegalArgumentException("Συμπλήρωσε όνομα χρήστη και κωδικό.");
        JSONObject result=call(Action.LOGIN,new JSONObject().put("username",username).put("password",password),null,null,null);
        Object rawToken=result.opt("token");if(!(rawToken instanceof String))throw new IOException("Το Ordexa δεν επέστρεψε έγκυρη συνεδρία.");String value=(String)rawToken;if(value.length()<8||value.length()>16384||value.contains("\n")||value.contains("\r"))throw new IOException("Το Ordexa δεν επέστρεψε έγκυρη συνεδρία.");
        token=value;return value;
    }
    public JSONArray cities()throws Exception{
        JSONArray source=call(Action.CITIES,null,null,null,null).optJSONArray("cities");if(source==null||source.length()>200)throw new IOException("Άγνωστο σχήμα πόλεων Ordexa.");
        JSONArray result=new JSONArray();Set<String> seen=new HashSet<String>();for(int i=0;i<source.length();i++){JSONObject row=source.getJSONObject(i);String id=identifier(row.get("id"));if(!seen.add(id))throw new IOException("Διπλή πόλη Ordexa.");path(Action.REPORT,id,"2026-01-01","2026-01-01");result.put(new JSONObject().put("id",id).put("name",row.optString("name",id)));}return result;
    }
    static String isoNow(){SimpleDateFormat f=new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",Locale.US);f.setTimeZone(TimeZone.getTimeZone("UTC"));return f.format(new Date());}
    public JSONObject report(String city,String day)throws Exception{
        String capturedAt=isoNow();JSONObject result=call(Action.REPORT,null,city,day,day);
        JSONObject report=result.optJSONObject("report");JSONArray riders=report==null?null:report.optJSONArray("riders");
        if(riders==null||riders.length()>200||result.optBoolean("hasMore")||report.optBoolean("hasMore")||result.has("next")&&!result.isNull("next")||report.has("next")&&!report.isNull("next"))throw new IOException("Άγνωστη ή μη πλήρης αναφορά Ordexa.");
        JSONArray clean=new JSONArray();Set<String> riderIds=new HashSet<String>();int count=0;
        for(int i=0;i<riders.length();i++){
            JSONObject rider=riders.getJSONObject(i);JSONArray sessions=rider.optJSONArray("sessions");
            if(sessions==null)throw new IOException("Η αναφορά δεν έχει αναλυτικά clock in/out.");
            String riderId=identifier(rider.get("riderId")),name=rider.getString("name");if(!riderIds.add(riderId)||name.trim().length()==0||name.length()>200)throw new IOException("Μη έγκυρα στοιχεία διανομέα Ordexa.");
            JSONArray rows=new JSONArray();Set<String> sessionIds=new HashSet<String>();for(int j=0;j<sessions.length();j++){
                if(++count>2000)throw new IOException("Υπέρβαση ημερήσιου ορίου παρουσιών. Δεν αποκόπηκε η αναφορά.");
                JSONObject source=sessions.getJSONObject(j),row=new JSONObject();
                if(!day.equals(source.getString("day")))throw new IOException("Η αναφορά Ordexa περιέχει άλλη ημέρα.");
                long start=instant(source.getString("inAt"));boolean closed=source.has("outAt")&&!source.isNull("outAt")&&!"".equals(source.get("outAt"));
                if(closed&&instant(source.getString("outAt"))<start)throw new IOException("Η έξοδος Ordexa προηγείται της εισόδου.");
                for(String flag:new String[]{"unclosed","forgotten","long"})if(source.has(flag)&&!source.isNull(flag)&&!(source.get(flag) instanceof Boolean))throw new IOException("Άγνωστο σχήμα ενδείξεων παρουσίας Ordexa.");
                String identity=source.has("id")&&!source.isNull("id")?"id:"+identifier(source.get("id")):"in:"+start;if(!sessionIds.add(identity))throw new IOException("Διπλή παρουσία στην αναφορά Ordexa.");
                for(String key:new String[]{"id","day","inAt","outAt","unclosed","forgotten","long","choice","shift"})if(source.has(key))row.put(key,source.get(key));
                rows.put(row);
            }
            clean.put(new JSONObject().put("riderId",rider.get("riderId")).put("name",rider.getString("name")).put("sessions",rows));
        }
        return new JSONObject().put("cityId",city).put("day",day).put("capturedAt",capturedAt).put("report",new JSONObject().put("riders",clean));
    }
    private JSONObject storeRead(String city,String suffix)throws Exception{
        path(Action.REPORT,city,"2026-01-01","2026-01-01");
        if(token.length()==0)throw new IOException("Συνδέσου πρώτα στο Ordexa από τις ρυθμίσεις Server.");
        return transport.send(ORIGIN+"/api/cities/"+city+suffix,"GET",null,token);
    }
    public JSONObject storesSetup(String city)throws Exception{return storeRead(city,"/setup");}
    public JSONObject storesOrders(String city,String from,String to,int page,String shop)throws Exception{
        day(from);day(to);if(from.compareTo(to)>0||page<1||page>10000)throw new IllegalArgumentException("Μη έγκυρη σελίδα παραγγελιών Ordexa.");
        if(shop!=null&&!shop.matches("[A-Za-z0-9_-]{1,100}"))throw new IllegalArgumentException("Μη έγκυρο κατάστημα Ordexa.");
        return storeRead(city,"/orders?from="+from+"&to="+to+"&page="+page+"&sort=at&dir=asc"+(shop==null?"":"&shopId="+shop));
    }
    static final class HttpsTransport implements Transport {
        public JSONObject send(String url,String method,JSONObject body,String token)throws Exception{
            // Plans are generated above; keep an independent final transport fence.
            URL target=new URL(url);String path=target.getPath();
            boolean login="POST".equals(method)&&"/api/login".equals(path)&&target.getQuery()==null;
            boolean read="GET".equals(method)&&body==null&&(("/api/me".equals(path)||"/api/cities".equals(path))&&target.getQuery()==null||path.matches("/api/cities/[A-Za-z0-9_-]{1,100}/report")&&target.getQuery()!=null&&target.getQuery().matches("from=[0-9]{4}-[0-9]{2}-[0-9]{2}&to=[0-9]{4}-[0-9]{2}-[0-9]{2}"));
            read=read||("GET".equals(method)&&body==null&&(
                path.matches("/api/cities/[A-Za-z0-9_-]{1,100}/setup")&&target.getQuery()==null||
                path.matches("/api/cities/[A-Za-z0-9_-]{1,100}/orders")&&target.getQuery()!=null&&target.getQuery().matches("from=[0-9]{4}-[0-9]{2}-[0-9]{2}&to=[0-9]{4}-[0-9]{2}-[0-9]{2}&page=[1-9][0-9]{0,4}&sort=at&dir=asc(?:&shopId=[A-Za-z0-9_-]{1,100})?")));
            if(!"https".equals(target.getProtocol())||!"api.ordexa.gr".equals(target.getHost())||target.getPort()!=-1||target.getUserInfo()!=null||target.getRef()!=null||(!login&&!read))throw new IOException("Η ενέργεια Ordexa αποκλείστηκε πριν αποσταλεί.");
            HttpsURLConnection connection=(HttpsURLConnection)target.openConnection();connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(20000);connection.setReadTimeout(30000);connection.setRequestMethod(method);connection.setRequestProperty("Accept","application/json");
            if(token.length()>0)connection.setRequestProperty("Authorization","Bearer "+token);
            try{
                if(login){byte[] bytes=body.toString().getBytes(UTF8);connection.setDoOutput(true);connection.setRequestProperty("Content-Type","application/json");connection.setFixedLengthStreamingMode(bytes.length);try(OutputStream out=connection.getOutputStream()){out.write(bytes);}}
                int status=connection.getResponseCode();if(status<200||status>=300)throw new IOException(status==401?"Η συνεδρία Ordexa έληξε ή η σύνδεση απορρίφθηκε. Συνδέσου ξανά.":"Η ανάγνωση Ordexa απέτυχε (HTTP "+status+").");
                ByteArrayOutputStream out=new ByteArrayOutputStream();try(InputStream input=connection.getInputStream()){byte[] buf=new byte[16384];int n;while((n=input.read(buf))!=-1){if(out.size()+n>8*1024*1024)throw new IOException("Η αναφορά Ordexa ξεπερνά το ασφαλές όριο.");out.write(buf,0,n);}}
                return new JSONObject(new String(out.toByteArray(),UTF8));
            }finally{connection.disconnect();}
        }
    }
}
