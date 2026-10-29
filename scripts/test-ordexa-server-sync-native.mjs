import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-native-pay-sync-')),root=process.cwd(),pkg='package gr.argyrismitsos.fleetserver;',android=path.join(root,'.android-toolchain/usr/share/java/com.android.android-23.jar'),jar=path.join(root,'vendor/json-java/json-20240303.jar');
const files={
 'android/content/Context.java':`package android.content;public class Context{public static final int MODE_PRIVATE=0;public SharedPreferences prefs;public SharedPreferences getSharedPreferences(String key,int mode){return prefs;}}`,
 'BackupManager.java':pkg+'public class BackupManager{public static final String PREFS="fixture";}',
 'ServerConfig.java':pkg+'public class ServerConfig{public static final String DEFAULT_WORKER_URL="https://fixture.invalid";}',
 'ServerWorkTracker.java':pkg+'public class ServerWorkTracker{public static boolean begin(android.content.Context c,String a,String b,String d){return true;}public static void stage(String a,String b,String d){}public static void finish(String a){}}',
 'OtaManager.java':pkg+'public class OtaManager{public static boolean yield=false;public static boolean shouldYieldForUpdate(android.content.Context c){return yield;}}',
 'SyncService.java':pkg+'public class SyncService{public static java.util.Map<String,String> serverHeaders(){return new java.util.HashMap<String,String>();}}',
 'FleetDataStore.java':pkg+'public class FleetDataStore{org.json.JSONObject state=new org.json.JSONObject();public org.json.JSONObject getOrdexaPayrollState(){return state;}public void setOrdexaPayrollState(org.json.JSONObject value){state=value;}}',
 'OrdexaSync.java':pkg+`import org.json.*;public class OrdexaSync{public static boolean enabled=true;public static int reads=0;public static JSONObject status(android.content.Context c)throws Exception{return new JSONObject().put("enabled",enabled).put("busy",false);}public static String checkedAt(android.content.Context c,String a,String b){return FleetHttp.now;}public static JSONObject sync(android.content.Context c,JSONObject input){reads++;return new JSONObject();}}`,
 'FleetHttp.java':pkg+String.raw`import org.json.*;import java.util.*;public class FleetHttp{
 static String current=OrdexaPayrollSync.monday(System.currentTimeMillis()),historic="2026-10-12",now=OrdexaPayrollEngine.iso(System.currentTimeMillis()),revision="1",epoch="one";static boolean mismatch=false,scopeChange=false,ota=false;static int controls=0,pages=0,heads=0,publishes=0,heartbeats=0,releases=0;static List<String> jobs=new ArrayList<String>();static android.content.SharedPreferences prefs;
 static JSONObject sendJson(String url,String method,JSONObject body,Map<String,String> headers)throws Exception{
  if(url.endsWith("/control")){controls++;JSONArray a=new JSONArray();for(String week:jobs)a.put(new JSONObject().put("weekStart",week).put("lease","lease-"+week));return new JSONObject().put("jobs",a);}
  if(url.endsWith("/release")){releases++;return new JSONObject().put("released",true);}
  if(url.endsWith("/publish")){publishes++;if(body.has("payloadHash")){heartbeats++;if(headers.containsKey("X-Fleet-Projection"))throw new AssertionError("Small heartbeat must not duplicate full payload metadata");}else{if(!headers.containsKey("X-Fleet-Projection"))throw new AssertionError("Serialized native result needs its small envelope");JSONObject meta=new JSONObject(headers.get("X-Fleet-Projection"));if(!meta.getString("sourceSyncedAt").equals(now))throw new AssertionError("Scoped provider freshness required");if(!body.has("payroll"))throw new AssertionError("Native result missing");}return new JSONObject().put("saved",true).put("payloadHash","hash").put("computedAt",now);}
  throw new AssertionError("Unknown transport URL "+url);
 }
 static JSONObject getJson(String url,Map<String,String> headers)throws Exception{
  if(!url.contains("&table=")){heads++;if(scopeChange)prefs.edit().putString("worker_url","https://other.invalid").commit();return new JSONObject().put("revision",revision).put("epoch",epoch).put("serverTime",now).put("timeZone","Europe/Athens").put("tables",new JSONArray().put("settings"));}
  pages++;if(ota)OtaManager.yield=true;boolean first=url.endsWith("cursor=0");return new JSONObject().put("revision",mismatch&&url.contains(historic)?"changed":revision).put("epoch",epoch).put("rows",first?new JSONArray().put(new JSONObject().put("key","ordexa_policy").put("value","{\"gapMinutes\":15}")):new JSONArray()).put("hasMore",first).put("nextCursor",first?1:1);
 }
}`,
 'PayrollSyncTest.java':pkg+String.raw`import org.json.*;import android.content.*;import java.lang.reflect.*;import java.util.*;
public class PayrollSyncTest{
 static void check(boolean ok,String why){if(!ok)throw new AssertionError(why);}
 static SharedPreferences prefs(){final Map<String,Object> values=new HashMap<String,Object>();final Object[] refs=new Object[2];refs[1]=Proxy.newProxyInstance(PayrollSyncTest.class.getClassLoader(),new Class[]{SharedPreferences.Editor.class},(proxy,m,args)->{String n=m.getName();if(n.equals("commit"))return true;if(n.equals("apply"))return null;if(n.startsWith("put")){values.put((String)args[0],args[1]);return refs[1];}if(n.equals("remove")){values.remove(args[0]);return refs[1];}if(n.equals("clear")){values.clear();return refs[1];}return null;});refs[0]=Proxy.newProxyInstance(PayrollSyncTest.class.getClassLoader(),new Class[]{SharedPreferences.class},(proxy,m,args)->{String n=m.getName();if(n.equals("edit"))return refs[1];if(n.equals("contains"))return values.containsKey(args[0]);if(n.startsWith("get")&&args!=null&&args.length==2)return values.containsKey(args[0])?values.get(args[0]):args[1];if(n.equals("getAll"))return values;return null;});return (SharedPreferences)refs[0];}
 static void tick(Context c,FleetDataStore store)throws Exception{Field f=OrdexaPayrollSync.class.getDeclaredField("attempted");f.setAccessible(true);f.setLong(null,0);OrdexaPayrollSync.tick(c,store);}
 public static void main(String[] args)throws Exception{
  Context c=new Context();c.prefs=prefs();FleetHttp.prefs=c.prefs;FleetDataStore store=new FleetDataStore();FleetHttp.jobs.add(FleetHttp.current);tick(c,store);check(FleetHttp.publishes==1&&FleetHttp.pages==2,"Paged native computation and confirmed serialized publish");
  int pages=FleetHttp.pages;tick(c,store);check(FleetHttp.pages==pages&&FleetHttp.heartbeats==1,"Same revision/epoch reuses inputs and sends small unchanged heartbeat");
  FleetHttp.epoch="two";tick(c,store);check(FleetHttp.pages==pages+2,"Restore epoch invalidates local source cache");
  FleetHttp.jobs.clear();FleetHttp.jobs.add(FleetHttp.historic);FleetHttp.jobs.add(FleetHttp.current);FleetHttp.mismatch=true;int sent=FleetHttp.publishes;tick(c,store);check(FleetHttp.publishes==sent+1&&FleetHttp.releases==1,"A historical revision race releases its lease and current week still progresses");check(OrdexaSync.reads==1,"Historical requested range refresh runs on Server only");
  FleetHttp.mismatch=false;FleetHttp.jobs.clear();FleetHttp.jobs.add(FleetHttp.current);FleetHttp.scopeChange=true;FleetHttp.epoch="three";sent=FleetHttp.publishes;tick(c,store);check(FleetHttp.publishes==sent,"Scope change prevents publication to the old Worker");
  c.prefs.edit().putString("worker_url",ServerConfig.DEFAULT_WORKER_URL).commit();FleetHttp.scopeChange=false;FleetHttp.epoch="four";FleetHttp.ota=true;tick(c,store);check(FleetHttp.publishes==sent&&FleetHttp.releases>=2,"OTA during input pages yields before publication and releases lease");
  OtaManager.yield=false;FleetHttp.ota=false;tick(c,store);check(FleetHttp.publishes==sent+1,"A failed or cancelled pass cannot leave the native busy gate stuck");
  System.out.println("PASS actual OrdexaPayrollSync Java: bounded pages, revision/epoch caches, serialized publish + unchanged heartbeat, historical provider refresh, independent failed jobs, lease release, Worker-scope fence, OTA cancellation and recovery. Synthetic transport/storage only.");
 }
}`
};
try{
 for(const [name,source]of Object.entries(files)){const file=path.join(dir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source);}
 const classpath=[dir,jar,android].join(path.delimiter),compiler=path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar');
 execFileSync('java',['-jar',compiler,'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-cp',classpath,'-d',dir,'server-android/src/gr/argyrismitsos/fleetserver/OrdexaPayrollSync.java','server-android/src/gr/argyrismitsos/fleetserver/OrdexaPayrollEngine.java',...Object.keys(files).map(f=>path.join(dir,f))],{stdio:'inherit'});
 execFileSync('java',['-cp',classpath,'gr.argyrismitsos.fleetserver.PayrollSyncTest'],{stdio:'inherit',timeout:30000});
}finally{fs.rmSync(dir,{recursive:true,force:true});}
