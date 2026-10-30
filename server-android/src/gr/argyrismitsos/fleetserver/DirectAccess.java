package gr.argyrismitsos.fleetserver;

import org.json.*;
import java.security.*;
import java.nio.charset.Charset;
import java.util.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Offline authentication and permission-scoped views. No provider/cloud I/O. */
public final class DirectAccess {
    public interface Storage {
        JSONObject state() throws Exception;
        void save(JSONObject state) throws Exception;
        JSONObject snapshot(JSONObject request) throws Exception;
        JSONObject fleet() throws Exception;
        String snapshotAt() throws Exception;
    }
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final long SESSION_MS = 4 * 3600000L, WINDOW_MS = 15 * 60000L;
    public static final long MAX_AUTH_AGE_MS = 24 * 3600000L;
    private final Storage storage;
    private final JSONObject rules;
    private final SecureRandom random = new SecureRandom();
    public DirectAccess(Storage storage, JSONObject rules) { this.storage=storage; this.rules=rules; }
    private static JSONObject error(int status, String message) throws Exception { return result(status,new JSONObject().put("error",message)); }
    private static JSONObject result(int status, JSONObject data) throws Exception { return new JSONObject().put("status",status).put("body",data.toString()).put("writable",false); }
    public static String digest(String value) throws Exception { byte[] bytes=MessageDigest.getInstance("SHA-256").digest(value.getBytes(UTF8));StringBuilder out=new StringBuilder();for(byte b:bytes)out.append(String.format(Locale.US,"%02x",b&255));return out.toString(); }
    private String token() { byte[] bytes=new byte[32];random.nextBytes(bytes);return android.util.Base64.encodeToString(bytes,android.util.Base64.URL_SAFE|android.util.Base64.NO_WRAP|android.util.Base64.NO_PADDING); }
    private static String hashPassword(String password,String salt,int iterations)throws Exception {
        // HMAC over UTF-8 bytes matches WebCrypto PBKDF2, including non-ASCII.
        Mac mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(password.getBytes(UTF8),"HmacSHA256"));
        byte[] raw=salt.getBytes(UTF8),seed=Arrays.copyOf(raw,raw.length+4);seed[seed.length-1]=1;
        byte[] u=mac.doFinal(seed),out=u.clone();for(int i=1;i<iterations;i++){u=mac.doFinal(u);for(int j=0;j<out.length;j++)out[j]^=u[j];}
        StringBuilder hex=new StringBuilder();for(byte b:out)hex.append(String.format(Locale.US,"%02x",b&255));return hex.toString();
    }
    private static JSONArray array(JSONObject value,String name) { JSONArray a=value==null?null:value.optJSONArray(name);return a==null?new JSONArray():a; }
    private static JSONObject object(JSONObject value,String name) throws Exception { JSONObject o=value.optJSONObject(name);if(o==null){o=new JSONObject();value.put(name,o);}return o; }
    private static String id(JSONObject user) { return user.optString("id"); }
    private Set<String> permissions(JSONObject user) throws Exception {
        String role=user.optString("role","employee");JSONObject defaults=rules.getJSONObject("roles");if(!defaults.has(role))role="employee";
        Set<String> out=new LinkedHashSet<String>();JSONArray base=defaults.getJSONArray(role);for(int i=0;i<base.length();i++)out.add(base.getString(i));
        if("owner".equals(role))return out;
        Set<String> allowed=new HashSet<String>();JSONArray list=rules.getJSONArray("employee".equals(role)?"employee":"all");for(int i=0;i<list.length();i++)allowed.add(list.getString(i));
        JSONArray overrides;try{overrides=new JSONArray(user.optString("permissions","[]"));}catch(Exception e){overrides=new JSONArray();}
        for(int i=0;i<overrides.length();i++){String p=overrides.optString(i),name=p.startsWith("!")?p.substring(1):p;if(!allowed.contains(name))continue;if(p.startsWith("!"))out.remove(name);else out.add(name);}
        return out;
    }
    private static boolean can(Set<String> p,String permission) { return p.contains("*")||p.contains(permission); }
    private static boolean enabled(JSONObject user) { return user!=null&&user.optInt("active")==1&&user.optInt("login_enabled",1)==1&&user.isNull("deleted_at"); }
    private static JSONObject find(JSONArray users,String key,String value) {for(int i=0;i<users.length();i++){JSONObject u=users.optJSONObject(i);if(u!=null&&value.equals(u.optString(key)))return u;}return null;}
    private static JSONObject publicUser(JSONObject user)throws Exception{return new JSONObject().put("id",id(user)).put("name",user.optString("full_name")).put("role",user.optString("role"));}
    private static void audit(JSONObject state,String action,String user,long now)throws Exception{JSONArray previous=state.optJSONArray("audit"),events=new JSONArray();if(previous!=null)for(int i=Math.max(0,previous.length()-499);i<previous.length();i++)events.put(previous.getJSONObject(i));events.put(new JSONObject().put("action",action).put("userId",user).put("at",now));state.put("audit",events);}
    private static long timestamp(String value){for(String format:new String[]{"yyyy-MM-dd'T'HH:mm:ss.SSSXXX","yyyy-MM-dd'T'HH:mm:ssXXX"})try{java.text.SimpleDateFormat parser=new java.text.SimpleDateFormat(format,Locale.US);parser.setLenient(false);return parser.parse(value).getTime();}catch(Exception ignored){}return 0;}
    public synchronized boolean claimRequest(String nonce,long now)throws Exception{
        if(!nonce.matches("[a-f0-9]{32}"))return false;JSONObject state=storage.state(),previous=state.optJSONObject("recentRequests"),recent=new JSONObject();if(previous!=null){Iterator<String> keys=previous.keys();while(keys.hasNext()){String key=keys.next();if(previous.optLong(key)>now-120000L)recent.put(key,previous.getLong(key));}}
        if(recent.has(nonce)||recent.length()>=1024)return false;recent.put(nonce,now);state.put("recentRequests",recent);storage.save(state);return true;
    }
    private static JSONArray stores(JSONObject workforce,String scope)throws Exception{
        if(scope.length()==0)return new JSONArray();
        JSONArray all=array(workforce,"store_billing_records"),visible=new JSONArray();Map<String,JSONObject> shops=new HashMap<String,JSONObject>(),publications=new HashMap<String,JSONObject>();
        for(int i=0;i<all.length();i++){JSONObject row=all.getJSONObject(i);if(!scope.equals(row.optString("scope")))continue;if(row.optString("kind").equals("store"))shops.put(row.getString("id"),row);else if(row.optString("kind").equals("publication"))publications.put(row.optString("scope")+"/"+row.optString("day"),new JSONObject(row.getString("data")));}
        for(int i=0;i<all.length();i++){JSONObject row=all.getJSONObject(i);if(!scope.equals(row.optString("scope")))continue;String kind=row.optString("kind");if(!kind.equals("store")&&!kind.equals("day"))continue;JSONObject value=new JSONObject(row.getString("data")),clean=new JSONObject().put("id",row.optString("id")).put("updated_at",row.optString("updated_at"));
            if(kind.equals("store")){clean.put("name",value.optString("name")).put("blocked",value.optBoolean("blocked")).put("retainOrders",value.optBoolean("retainOrders"));}
            else{JSONObject publication=publications.get(row.optString("scope")+"/"+row.optString("day")),shop=shops.get(row.optString("store_id"));if(publication==null||shop==null||!publication.optBoolean("complete")||!(publication.optInt("protocol",1)==2?value.optInt("protocol")==2:publication.optString("activeRun").equals(value.optString("runId")))||shop.optInt("revision")!=value.optInt("storeRevision"))continue;
                clean.put("name",new JSONObject(shop.getString("data")).optString("name")).put("day",row.optString("day")).put("sourceAt",publication.optString("sourceLastSuccessAt"));for(String field:new String[]{"orderCount","orderChargeCents","minimumTopUpCents","totalChargeCents","reviewCount","retainedOrders"})if(value.has(field))clean.put(field,value.get(field));}
            visible.put(clean);
        }return visible;
    }
    public synchronized JSONObject handle(JSONObject request,long now)throws Exception {
        String path=request.optString("path"),method=request.optString("method","GET");
        JSONObject state=storage.state();
        if(!state.optBoolean("enabled"))return error(503,"Η απευθείας πρόσβαση είναι απενεργοποιημένη στον Server.");
        // Reject blocked or unknown sessions before loading any mirror data.
        if(path.equals("/api/direct-local/login")&&method.equals("POST")){
            JSONObject supplied=request.optJSONObject("body");String username=supplied==null?"":supplied.optString("username").trim().toLowerCase(Locale.US);JSONObject failures=state.optJSONObject("attempts");
            if(failures!=null){JSONObject personal=failures.optJSONObject(digest(username)),global=failures.optJSONObject("global");if(personal!=null&&personal.optLong("blocked")>now||global!=null&&global.optLong("blocked")>now)return error(429,"Πολλές αποτυχημένες προσπάθειες. Δοκίμασε ξανά σε 15 λεπτά.");}
        }else{
            JSONObject h=request.optJSONObject("headers");String auth=h==null?"":h.optString("Authorization",h.optString("authorization"));String supplied=auth.startsWith("Bearer ")?auth.substring(7):"";JSONObject saved=state.optJSONObject("sessions"),session=saved==null||supplied.length()!=43?null:saved.optJSONObject(digest(supplied));if(session==null||session.optLong("expires")<=now)return error(401,"Η σύνδεση έληξε. Συνδέσου ξανά.");
        }
        JSONObject snapshot=storage.snapshot(request),workforce=snapshot.optJSONObject("workforce");
        String at=storage.snapshotAt();long sourceAt=timestamp(at);
        JSONArray users=array(workforce,"app_users");
        if(users.length()==0)return error(503,"Δεν υπάρχει ολοκληρωμένο τοπικό αντίγραφο χρηστών. Ενημέρωσε πρώτα το αντίγραφο στον Server.");
        if(sourceAt<=0||now-sourceAt>MAX_AUTH_AGE_MS||sourceAt>now+300000L)return error(503,"Το αντίγραφο δικαιωμάτων χρειάζεται ενημέρωση στον Server. Τελευταίο αντίγραφο: "+at);
        JSONObject sessions=object(state,"sessions"),attempts=object(state,"attempts");List<String> expired=new ArrayList<String>();Iterator<String> keys=sessions.keys();while(keys.hasNext()){String key=keys.next();if(sessions.getJSONObject(key).optLong("expires")<=now)expired.add(key);}for(String key:expired)sessions.remove(key);
        JSONObject body=request.optJSONObject("body");if(body==null)body=new JSONObject();
        if(path.equals("/api/direct-local/login")&&method.equals("POST")) {
            String username=body.optString("username").trim().toLowerCase(Locale.US),password=body.optString("password");
            if(username.length()<3||username.length()>120||password.length()>512)return error(400,"Συμπλήρωσε έγκυρο username και κωδικό.");
            String fingerprint=digest(username);JSONObject attempt=attempts.optJSONObject(fingerprint),global=attempts.optJSONObject("global");
            if(attempt!=null&&attempt.optLong("blocked")>now||global!=null&&global.optLong("blocked")>now)return error(429,"Πολλές αποτυχημένες προσπάθειες. Δοκίμασε ξανά σε 15 λεπτά.");
            JSONObject user=find(users,"username",username);if(user==null)user=find(users,"email",username);
            int iterations=user==null?100000:user.optInt("password_iterations",100000);if(iterations<1||iterations>1000000)return error(503,"Τα αποθηκευμένα στοιχεία σύνδεσης χρειάζονται έλεγχο.");
            String supplied=hashPassword(password.length()>0?password:" ",user==null?"direct-dummy-salt":user.optString("password_salt"),iterations);
            boolean valid=enabled(user)&&MessageDigest.isEqual(supplied.getBytes(UTF8),user.optString("password_hash").getBytes(UTF8));
            if(!valid){
                for(String key:new String[]{fingerprint,"global"}){JSONObject old=attempts.optJSONObject(key);long start=old==null?now:old.optLong("start");int count=old!=null&&now-start<=WINDOW_MS?old.optInt("count")+1:1;if(now-start>WINDOW_MS)start=now;attempts.put(key,new JSONObject().put("start",start).put("count",count).put("blocked",count>=(key.equals("global")?40:8)?now+WINDOW_MS:0));}
                // Bound state even when an attacker rotates usernames.
                if(attempts.length()>512){JSONObject kept=new JSONObject();Iterator<String> names=attempts.keys();while(names.hasNext()){String name=names.next();JSONObject value=attempts.getJSONObject(name);if(value.optLong("start")>now-WINDOW_MS)kept.put(name,value);}if(kept.length()>512)kept=new JSONObject().put("global",attempts.getJSONObject("global"));state.put("attempts",kept);}
                audit(state,"login_failed",user==null?"":id(user),now);storage.save(state);return error(401,"Το username ή ο κωδικός δεν είναι σωστός.");
            }
            if(sessions.length()>=256)return error(429,"Πολλές ενεργές συνδέσεις. Αποσύνδεσε μια παλιά συσκευή.");
            attempts.remove(fingerprint);String token=token();sessions.put(digest(token),new JSONObject().put("userId",id(user)).put("created",now).put("expires",Math.min(now+SESSION_MS,sourceAt+MAX_AUTH_AGE_MS)).put("credential",digest(user.optString("password_hash"))));audit(state,"login",id(user),now);storage.save(state);
            return result(200,new JSONObject().put("token",token).put("user",publicUser(user)).put("snapshotAt",at).put("readOnly",true));
        }
        JSONObject headers=request.optJSONObject("headers");String authorization=headers==null?"":headers.optString("Authorization",headers.optString("authorization"));
        String token=authorization.startsWith("Bearer ")?authorization.substring(7):"";JSONObject session=token.length()==43?sessions.optJSONObject(digest(token)):null;
        JSONObject user=session==null?null:find(users,"id",session.optString("userId"));
        if(!enabled(user)||session.optLong("expires")<=now||session.optLong("created")/1000L<user.optLong("force_logout_after")||!digest(user.optString("password_hash")).equals(session.optString("credential")))return error(401,"Η σύνδεση έληξε. Συνδέσου ξανά.");
        if(path.equals("/api/direct-local/logout")&&method.equals("POST")){sessions.remove(digest(token));audit(state,"logout",id(user),now);storage.save(state);return result(200,new JSONObject().put("loggedOut",true));}
        if(!method.equals("GET"))return error(409,"Η εφεδρική πρόσβαση προσφέρει προβολή του τοπικού αντιγράφου. Η αποθήκευση αυτής της λειτουργίας χρειάζεται την κανονική σύνδεση.");
        Set<String> permissions=permissions(user);JSONObject data=new JSONObject().put("user",publicUser(user)).put("snapshotAt",at).put("readOnly",true);
        JSONArray available=new JSONArray();for(String[] view:new String[][]{{"fleet","fleet.view"},{"employees","employees.view"},{"schedules","schedules.view"},{"shifts","shifts.view"},{"stores","stores.view"}})if(can(permissions,view[1]))available.put(view[0]);
        data.put("views",available);
        if(path.equals("/api/direct-local/me"))return result(200,data);
        String view=path.startsWith("/api/direct-local/view/")?path.substring(23):"";
        String permission=view.equals("fleet")?"fleet.view":view.equals("employees")?"employees.view":view.equals("schedules")?"schedules.view":view.equals("shifts")?"shifts.view":view.equals("stores")?"stores.view":"";
        if(permission.length()==0)return error(404,"Η προβολή δεν βρέθηκε.");
        if(!can(permissions,permission)){audit(state,"permission_denied",id(user),now);storage.save(state);return error(403,"Δεν έχεις δικαίωμα για αυτή την προβολή.");}
        JSONArray rows=new JSONArray(),source;String[] fields;
        if(view.equals("fleet")){source=array(storage.fleet(),"bikes");fields=new String[]{"id","name","currentKm","nextServiceKm","lastServiceKm","lastCheckedAt"};}
        else if(view.equals("employees")){source=users;fields=new String[]{"id","full_name","role","active","assigned_vehicle_id"};}
        else if(view.equals("schedules")){source=array(workforce,"schedules");fields=new String[]{"id","employee_id","vehicle_id","start_at","end_at","status"};}
        else if(view.equals("shifts")){if(snapshot.optString("directCityId").length()==0)return error(503,"Επίλεξε πρώτα την ενεργή πόλη Ordexa στον Server.");source=array(workforce,"ordexa_sessions");fields=new String[]{"id","rider_id","provider_day","in_at","out_at","review","ignored","last_seen"};}
        else{if(snapshot.optString("directStoreScope").length()==0)return error(503,"Η ενεργή σύνδεση καταστημάτων δεν έχει ρυθμιστεί στον Server.");source=stores(workforce,snapshot.optString("directStoreScope"));fields=new String[]{"id","name","blocked","retainOrders","day","updated_at","sourceAt","orderCount","orderChargeCents","minimumTopUpCents","totalChargeCents","reviewCount","retainedOrders"};}
        int offset=Math.max(0,Math.min(100000,body.optInt("offset"))),limit=50,count=0;JSONObject page=snapshot.optJSONObject("directPage");int skip=page==null?offset:0;
        for(int i=source.length()-1;i>=0;i--){JSONObject row=source.optJSONObject(i);if(row==null)continue;
            if(view.equals("employees")&&!row.isNull("deleted_at"))continue;
            if(view.equals("shifts")&&!snapshot.optString("directCityId").equals(row.optString("city_id")))continue;
            if(count++<skip)continue;if(rows.length()>=limit)continue;
            JSONObject clean=new JSONObject();for(String field:fields)if(row.has(field))clean.put(field,row.get(field));
            if(row.has("employee_id")){JSONObject employee=find(users,"id",row.optString("employee_id"));clean.put("employee_name",employee==null?"":employee.optString("full_name"));}
            if(view.equals("shifts")){JSONArray riders=array(workforce,"ordexa_riders");for(int j=0;j<riders.length();j++){JSONObject rider=riders.getJSONObject(j);if(row.optString("city_id").equals(rider.optString("city_id"))&&row.optString("rider_id").equals(rider.optString("rider_id"))){JSONObject employee=find(users,"id",rider.optString("employee_id"));clean.put("employee_name",employee==null?rider.optString("name"):employee.optString("full_name"));break;}}}
            rows.put(clean);
        }
        int total=page==null?count:page.optInt("total");data.put("rows",rows).put("total",total).put("offset",offset).put("hasMore",offset<100000&&offset+rows.length()<total);return result(200,data);
    }
}
