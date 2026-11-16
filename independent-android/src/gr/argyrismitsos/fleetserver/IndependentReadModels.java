package gr.argyrismitsos.fleetserver;
import android.database.Cursor;import android.database.sqlite.SQLiteDatabase;import org.json.*;
import java.net.*;import java.nio.charset.StandardCharsets;import java.security.MessageDigest;import java.util.*;import java.util.concurrent.*;import java.util.function.LongSupplier;

/** Private RAM snapshots of authorized JSON reads. SQLite remains the authority. */
final class IndependentReadModels implements AutoCloseable {
 interface Loader {void schedule(Runnable task);JSONObject compute(JSONObject request)throws Exception;default void updated(String scope){}}
 private static final String AUTH_SQL="SELECT u.* FROM auth_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.active=1 AND COALESCE(u.login_enabled,1)=1 AND u.deleted_at IS NULL AND s.created_at>=COALESCE(u.force_logout_after,0)";
 private static final long MAX_BYTES=8L*1024*1024,MAX_AGE=300000,REFRESH=15000;
 private final BusinessSqlite reader;private final String realm,pepper;private final Loader loader;private final LongSupplier clock;
 private final LinkedHashMap<String,Entry> entries=new LinkedHashMap<String,Entry>(16,.75f,true);private final Set<String> pending=new HashSet<String>();private long bytes,hits,misses,refreshes;private volatile boolean closed;
 private static final class Entry {String key,path,scope,identity,versions,body,revision;JSONObject request,headers;long at,weight,lastUsed;volatile boolean stalePresented;}
 static final class Ticket {String key,path,scope,identity,versions,actor;}
 IndependentReadModels(SQLiteDatabase db,String realm,String pepper,Loader loader){this(db,realm,pepper,loader,System::currentTimeMillis);}
 IndependentReadModels(SQLiteDatabase db,String realm,String pepper,Loader loader,LongSupplier clock){reader=new BusinessSqlite(db);this.realm=realm;this.pepper=pepper;this.loader=loader;this.clock=clock;}
 private static long memoryBudget(){Runtime r=Runtime.getRuntime();long available=r.maxMemory()-r.totalMemory()+r.freeMemory();return available<32L*1024*1024?2L*1024*1024:MAX_BYTES;}
 private static String digest(String value)throws Exception{byte[] raw=MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));StringBuilder out=new StringBuilder();for(byte b:raw)out.append(String.format(Locale.US,"%02x",b&255));return out.toString();}
 static void install(SQLiteDatabase db)throws Exception{
  boolean own=!db.inTransaction();if(own)db.beginTransaction();try{
  db.execSQL("CREATE TABLE IF NOT EXISTS independent_projection_revisions(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL)");
  Map<String,String> watches=new LinkedHashMap<String,String>();
  for(String table:new String[]{"fleet_snapshot","vehicles","vehicle_history"})watches.put(table,"fleet");
  for(String table:new String[]{"app_users","fleet_settings","app_settings"})watches.put(table,"all");
  for(String table:new String[]{"shifts","shift_corrections","ordexa_server_weeks","ordexa_server_rows","ordexa_server_views","ordexa_clock_records","ordexa_rider_links"})watches.put(table,"workforce");
  for(String table:new String[]{"schedules","schedule_weeks","schedule_templates"})watches.put(table,"schedule");
  for(String table:new String[]{"payroll_periods","payroll_adjustments","payroll_payments","pay_rules","ordexa_pay_adjustments","ordexa_pay_decisions"})watches.put(table,"payroll");
  for(String table:new String[]{"native_cash_events","native_cash_rules","native_cash_rider_links","native_cash_auto_days","native_cash_auto_exclusions"})watches.put(table,"cash");
  for(String table:new String[]{"store_billing_records","store_billing_local","native_store_aliases"})watches.put(table,"stores");
  for(String table:new String[]{"admin_alerts","system_alerts","audit_log","recycle_bin","server_state","server_instances","native_health_incidents"})watches.put(table,"status");
  Set<String> tables=new HashSet<String>();Cursor catalog=db.rawQuery("SELECT name FROM sqlite_master WHERE type='table'",null);try{while(catalog.moveToNext())tables.add(catalog.getString(0));}finally{catalog.close();}
  // Future business tables fail conservatively to the shared revision, while
  // session/file-transfer bookkeeping never changes a financial projection.
  for(String table:tables)if(table.matches("[A-Za-z_][A-Za-z0-9_]*")&&!table.matches("(?:sqlite_.*|independent_.*|auth_sessions|auth_login_attempts|registered_devices|native_event_outbox|native_operation_receipts|native_file_.*|native_object_.*|native_objects|native_transfers)")&&!watches.containsKey(table))watches.put(table,"all");
  for(Map.Entry<String,String> watch:watches.entrySet())if(tables.contains(watch.getKey()))for(String action:new String[]{"INSERT","UPDATE","DELETE"}){
   String table=watch.getKey(),scope=watch.getValue(),name="independent_projection_"+table+"_"+action.toLowerCase(Locale.US),condition="",event=action;
   if(table.equals("app_users")&&action.equals("UPDATE")){List<String> columns=new ArrayList<String>();Cursor info=db.rawQuery("PRAGMA table_info(app_users)",null);try{while(info.moveToNext()){String column=info.getString(1);if(!column.equals("last_seen_at")&&column.matches("[A-Za-z_][A-Za-z0-9_]*"))columns.add("\""+column+"\"");}}finally{info.close();}if(!columns.isEmpty())event="UPDATE OF "+String.join(",",columns);}
   if(table.equals("ordexa_server_views")&&action.equals("UPDATE"))event="UPDATE OF payload,payload_hash,input_revision,input_epoch,engine_version,computed_at,source_synced_at,sequence";
   if(table.equals("store_billing_local")){String row=action.equals("DELETE")?"OLD":"NEW";condition=" WHEN "+row+".kind IN ('store','local_day','coverage','connection','outbox','cash_source_coverage')";}
   // Changes become visible to the separate WAL reader only after commit.
   db.execSQL("DROP TRIGGER IF EXISTS "+name);
   db.execSQL("CREATE TRIGGER "+name+" AFTER "+event+" ON "+table+condition+" BEGIN INSERT INTO independent_projection_revisions(scope,revision) VALUES('"+scope+"',1) ON CONFLICT(scope) DO UPDATE SET revision=revision+1; END");
  }
  if(own)db.setTransactionSuccessful();}finally{if(own)db.endTransaction();}
 }
 private static String scope(String path){
  if(path.matches("/api/(sync|snapshot|workforce/vehicles|admin/service-documents|admin/service-document-followups)"))return "fleet";
  if(Arrays.asList("/api/native/cash","/api/native/cash/rules","/api/native/cash/automatic").contains(path))return "cash";
  if(path.equals("/api/native/store-financials")||path.equals("/api/admin/store-billing"))return "stores";
  if(path.matches("/api/admin/(payroll|pay-rules|ordexa-server/(payroll|estimate))")||path.equals("/api/native/payroll-review"))return "payroll";
  if(path.matches("/api/admin/(schedule-week|schedules|schedule-templates|staffing-coverage)"))return "schedule";
  if(path.matches("/api/(workforce/(dashboard|employees)|admin/(employees|shifts|ordexa-server/(dashboard|shifts))|employee/home)"))return "workforce";
  if(path.matches("/api/(status|admin/(alerts|audit|recycle|server-health|settings)|native/health)"))return "status";
  return "";
 }
 private String canonical(JSONObject request)throws Exception{
  if(closed||!request.optString("method").equals("GET")||request.has("body")||request.has("form")||request.optBoolean("internal"))return "";
  URI uri=new URI(request.getString("url"));if(!realm.equals(uri.getScheme()+"://"+uri.getRawAuthority())||uri.getRawFragment()!=null||request.getString("url").length()>4096||scope(uri.getPath()).isEmpty())return "";
  // Sorting names preserves the order of duplicate values (URLSearchParams.get).
  List<String[]> pairs=new ArrayList<String[]>();if(uri.getRawQuery()!=null)for(String pair:uri.getRawQuery().split("&",-1)){String[] p=pair.split("=",2);pairs.add(new String[]{URLDecoder.decode(p[0],"UTF-8"),URLDecoder.decode(p.length==2?p[1]:"","UTF-8")});}if(pairs.size()>40)return "";Collections.sort(pairs,(a,b)->a[0].compareTo(b[0]));StringBuilder key=new StringBuilder(uri.getPath());for(String[] p:pairs)key.append(key.indexOf("?")<0?'?':'&').append(URLEncoder.encode(p[0],"UTF-8")).append('=').append(URLEncoder.encode(p[1],"UTF-8"));return key.toString();
 }
 private JSONObject identity(JSONObject request)throws Exception{
  JSONObject headers=request.optJSONObject("headers");String auth="",cookie="";int authCount=0,cookieCount=0;if(headers!=null)for(String key:headers.keySet()){if(key.equalsIgnoreCase("authorization")){auth=headers.optString(key);authCount++;}if(key.equalsIgnoreCase("cookie")){cookie=headers.optString(key);cookieCount++;}}if(authCount>1||cookieCount>1||!auth.isEmpty()&&!auth.matches("Bearer [\\x21-\\x7E]{1,1024}"))return null;String token=auth.startsWith("Bearer ")?auth.substring(7):"";if(token.isEmpty())for(String part:cookie.split(";")){String[] p=part.trim().split("=",2);if(p.length==2&&p[0].equals("fc_auth"))token=p[1];}if(token.isEmpty()||token.length()>1024)return null;
  String hash=digest(pepper+":auth:"+token);JSONArray rows=reader.call("sql.query",new JSONObject().put("sql",AUTH_SQL).put("params",new JSONArray().put(hash).put(clock.getAsLong()/1000)).put("first",true)).getJSONArray("results");if(rows.length()==0)return null;JSONObject account=rows.getJSONObject(0);account.remove("last_seen_at");return new JSONObject().put("actor",account.getString("id")).put("proof",digest(hash+":"+account.toString()));
 }
 private String versions(String scope)throws Exception{
  JSONArray rows=reader.call("sql.query",new JSONObject().put("sql","SELECT scope,revision FROM independent_projection_revisions ORDER BY scope")).getJSONArray("results");JSONArray relevant=new JSONArray();
  for(int i=0;i<rows.length();i++){JSONObject r=rows.getJSONObject(i);String s=r.getString("scope");if(s.equals("all")||s.equals(scope)||scope.equals("status")||scope.equals("workforce")||scope.equals("payroll")&&(s.equals("workforce")||s.equals("schedule"))||scope.equals("cash")&&s.equals("stores")||scope.equals("schedule")&&s.equals("workforce"))relevant.put(r);}return relevant.toString();
 }
 Ticket ticket(JSONObject request)throws Exception{String path=canonical(request);if(path.isEmpty())return null;JSONObject who=identity(request);if(who==null)return null;String identity=who.getString("proof");Ticket t=new Ticket();t.actor=who.getString("actor");t.path=path;t.scope=scope(new URI(request.getString("url")).getPath());t.identity=identity;t.versions=versions(t.scope);String backend="";JSONObject headers=request.optJSONObject("headers");if(headers!=null)for(String name:headers.keySet())if(name.equalsIgnoreCase("x-fleet-backend-revision"))backend=headers.optString(name);t.key=digest(new JSONArray().put(identity).put(backend).put(path).toString());return t;}
 JSONObject get(JSONObject request)throws Exception{
  Ticket t=ticket(request);if(t==null)return null;Entry e;synchronized(this){e=entries.get(t.key);if(e==null||clock.getAsLong()-e.at>MAX_AGE){misses++;return null;}hits++;e.lastUsed=clock.getAsLong();}
  boolean stale=!e.versions.equals(t.versions)||clock.getAsLong()-e.at>=REFRESH;if(stale){e.stalePresented=true;refresh(e);}return response(e,stale);
 }
 JSONObject remember(JSONObject request,JSONObject result,Ticket before)throws Exception{
  if(before==null||closed||result.optInt("status")!=200||!result.has("body")||result.has("file")||result.has("bodyFile"))return result;
  if(result.optJSONObject("headers")==null||!before.actor.equals(result.getJSONObject("headers").optString("x-fleet-actor")))return result;
  String body=result.getString("body");if(body.getBytes(StandardCharsets.UTF_8).length>Math.min(1024*1024,memoryBudget()/4))return result;JSONObject data;try{data=new JSONObject(body);}catch(Exception notObject){return result;}
  if(data.has("token")||data.has("serverKey")||data.has("authPepper")||data.has("snapshot"))return result;
  Ticket after=ticket(request);if(after==null||!before.key.equals(after.key)||!before.versions.equals(after.versions))return result;
  Entry e=new Entry();e.key=after.key;e.path=after.path;e.scope=after.scope;e.identity=after.identity;e.versions=after.versions;e.body=body;JSONObject stable=new JSONObject(body);stripTimes(stable);e.revision=data.optString("revision",digest(stable.toString()));e.at=clock.getAsLong();e.request=new JSONObject(request.toString());e.headers=new JSONObject(result.optJSONObject("headers")==null?"{}":result.getJSONObject("headers").toString());e.weight=body.getBytes(StandardCharsets.UTF_8).length+e.request.toString().length()*2L;
  boolean changed=false;synchronized(this){Entry old=entries.remove(e.key);if(old!=null){bytes-=old.weight;changed=old.stalePresented||!old.revision.equals(e.revision);e.lastUsed=old.lastUsed;}while((bytes+e.weight>memoryBudget()||entries.size()>=256)&&!entries.isEmpty()){Iterator<Entry> it=entries.values().iterator();bytes-=it.next().weight;it.remove();}entries.put(e.key,e);bytes+=e.weight;}if(changed)loader.updated(e.scope);return response(e,false);
 }
 private static void stripTimes(Object value){if(value instanceof JSONObject){JSONObject o=(JSONObject)value;for(String name:new String[]{"observedAt","computedAt","serverTime"})o.remove(name);for(String name:o.keySet())stripTimes(o.opt(name));}else if(value instanceof JSONArray){JSONArray a=(JSONArray)value;for(int i=0;i<a.length();i++)stripTimes(a.opt(i));}}
 private JSONObject response(Entry e,boolean stale)throws Exception{
  JSONObject body=new JSONObject(e.body);Object source=body.has("sourceSyncedAt")?body.opt("sourceSyncedAt"):body.optJSONObject("projection")!=null?body.getJSONObject("projection").opt("sourceSyncedAt"):body.optJSONObject("sync")!=null?body.getJSONObject("sync").opt("lastCompleteAt"):JSONObject.NULL;
  JSONObject snapshot=new JSONObject().put("revision",body.optString("revision",e.revision)).put("computedAt",new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX",Locale.US).format(new Date(e.at))).put("sourceSyncedAt",source==null?JSONObject.NULL:source).put("coverageVerified",body.optBoolean("coverageVerified")).put("stale",stale).put("refreshing",stale);body.put("snapshot",snapshot);
  if(stale){body.put("coverageVerified",false);JSONObject projection=body.optJSONObject("projection");if(projection!=null)projection.put("stale",true).put("pending",true).put("fresh",false).put("sourceFresh",false).put("readOnly",true).put("waiting",true);JSONObject sync=body.optJSONObject("sync");if(sync!=null)sync.put("state","stale").put("coverageVerified",false).put("completedSnapshotAvailable",false);if(body.has("automaticOrderMappingVerified"))body.put("automaticOrderMappingVerified",false);JSONObject totals=body.optJSONObject("totals");if(totals!=null&&totals.has("complete"))totals.put("complete",false);}
  return new JSONObject().put("status",200).put("headers",new JSONObject(e.headers.toString()).put("Cache-Control","private, no-store")).put("body",body.toString());
 }
 private void refresh(final Entry e){
  synchronized(this){if(closed||!pending.add(e.key))return;refreshes++;}
  try{loader.schedule(()->{
   try{Ticket t=ticket(e.request);if(t!=null){JSONObject result=loader.compute(new JSONObject(e.request.toString()));remember(e.request,result,t);}
    else synchronized(this){Entry old=entries.remove(e.key);if(old!=null)bytes-=old.weight;}
   }catch(Exception ignored){/* Keep the last known snapshot explicitly stale. */}
   finally{synchronized(this){pending.remove(e.key);}}
  });}catch(RuntimeException busy){synchronized(this){pending.remove(e.key);}}
 }
 void warm(JSONObject headers,String path){try{JSONObject request=new JSONObject().put("url",realm+path).put("method","GET").put("headers",new JSONObject(headers.toString()));Ticket t=ticket(request);if(t==null)return;Entry e=new Entry();e.key=t.key;e.request=request;refresh(e);}catch(Exception ignored){}}
 void refreshDirty(){List<Entry> saved;synchronized(this){saved=new ArrayList<Entry>(entries.values());}Map<String,String> current=new HashMap<String,String>();for(Entry e:saved)try{if(!current.containsKey(e.scope))current.put(e.scope,versions(e.scope));if(!e.versions.equals(current.get(e.scope))||e.lastUsed>0&&clock.getAsLong()-e.lastUsed<60000&&clock.getAsLong()-e.at>=REFRESH)refresh(e);}catch(Exception ignored){}}
 JSONObject metrics()throws Exception{synchronized(this){return new JSONObject().put("models",entries.size()).put("bytes",bytes).put("pending",pending.size()).put("hits",hits).put("misses",misses).put("refreshes",refreshes);}}
 void clear(){synchronized(this){entries.clear();bytes=0;}}
 @Override public void close(){synchronized(this){closed=true;clear();pending.clear();}}
}
