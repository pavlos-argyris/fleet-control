import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-ordexa-native-')),root=process.cwd(),jar=path.join(root,'vendor/json-java/json-20240303.jar');
try{
 fs.writeFileSync(path.join(dir,'OrdexaTest.java'),String.raw`package gr.argyrismitsos.fleetserver;
import org.json.*;import java.util.*;
public class OrdexaTest {
 static void check(boolean x,String m){if(!x)throw new AssertionError(m);}
 static void denied(String url,String method)throws Exception{boolean blocked=false;try{new OrdexaClient.HttpsTransport().send(url,method,null,"");}catch(java.io.IOException e){blocked=e.getMessage().contains("αποκλείστηκε");}check(blocked,"must block before any network: "+url);}
 public static void main(String[] args)throws Exception{
  final List<String> calls=new ArrayList<String>();
  OrdexaClient client=new OrdexaClient(new OrdexaClient.Transport(){public JSONObject send(String url,String method,JSONObject body,String token)throws Exception{
   calls.add(method+" "+url);
   if(url.endsWith("/login")){check(method.equals("POST"),"auth only POST");check(body.length()==2,"only credentials for login");return new JSONObject().put("token","synthetic-token").put("user",new JSONObject().put("id",1));}
   check(method.equals("GET")&&body==null&&token.equals("synthetic-token"),"reads only with bound token");
   if(url.endsWith("/cities"))return new JSONObject().put("cities",new JSONArray().put(new JSONObject().put("id",7).put("name","Συνθετική πόλη")));
   JSONObject event=new JSONObject().put("id","raw-1").put("day","2026-10-25").put("inAt","2026-10-25T03:30:00+03:00").put("outAt","2026-10-25T03:30:00+02:00").put("pay",99999).put("token","do-not-upload");
   return new JSONObject().put("report",new JSONObject().put("riders",new JSONArray().put(new JSONObject().put("riderId",17).put("name","Άλλο όνομα").put("sessions",new JSONArray().put(event)).put("cost",12345))));
  }});
  boolean noSession=false;try{client.cities();}catch(Exception e){noSession=true;}check(noSession&&calls.isEmpty(),"no unauthenticated read");
  client.login("fixture","not-a-real-password");check(client.cities().getJSONObject(0).getString("id").equals("7"),"numeric city ID");
  JSONObject report=client.report("7","2026-10-25");String raw=report.toString();check(!raw.contains("do-not-upload")&&!raw.contains("cost")&&!raw.contains("pay"),"do not upload tokens or financial aggregates");check(raw.contains("03:30:00+03:00")&&raw.contains("03:30:00+02:00"),"retain original timezone evidence");
  JSONObject ordered=new JSONObject().put("capturedAt","2026-10-25T01:00:00Z").put("report",new JSONObject().put("riders",new JSONArray().put(new JSONObject().put("riderId",1).put("sessions",new JSONArray().put(new JSONObject().put("id","a").put("inAt","first")).put(new JSONObject().put("id","b").put("inAt","second")))).put(new JSONObject().put("riderId",2).put("sessions",new JSONArray()))));
  JSONObject reordered=new JSONObject().put("report",new JSONObject().put("riders",new JSONArray().put(new JSONObject().put("sessions",new JSONArray()).put("riderId",2)).put(new JSONObject().put("sessions",new JSONArray().put(new JSONObject().put("inAt","second").put("id","b")).put(new JSONObject().put("inAt","first").put("id","a"))).put("riderId",1)))).put("capturedAt","2026-10-25T02:00:00Z");
  check(OrdexaClient.digest(ordered).equals(OrdexaClient.digest(reordered)),"ordering and capture time must not resend unchanged reports");reordered.getJSONObject("report").getJSONArray("riders").getJSONObject(1).getJSONArray("sessions").getJSONObject(0).put("inAt","corrected");check(!OrdexaClient.digest(ordered).equals(OrdexaClient.digest(reordered)),"actual corrections must change the digest");
  final JSONObject provider=new JSONObject().put("report",new JSONObject().put("riders",new JSONArray().put(new JSONObject().put("riderId",1).put("name","Fixture").put("sessions",new JSONArray().put(new JSONObject().put("id","one").put("day","2026-10-25").put("inAt","2026-10-25T08:00:00+02:00").put("outAt","2026-10-25T09:00:00+02:00"))))));
  OrdexaClient strict=new OrdexaClient(new OrdexaClient.Transport(){public JSONObject send(String url,String method,JSONObject body,String token){return provider;}});strict.token("synthetic-token");strict.report("7","2026-10-25");
  provider.getJSONObject("report").put("next","page-two");boolean incomplete=false;try{strict.report("7","2026-10-25");}catch(Exception good){incomplete=true;}check(incomplete,"nested incomplete pagination must fail before preview/import");provider.getJSONObject("report").remove("next");
  JSONObject event=provider.getJSONObject("report").getJSONArray("riders").getJSONObject(0).getJSONArray("sessions").getJSONObject(0);
  event.put("unclosed","false");boolean shape=false;try{strict.report("7","2026-10-25");}catch(Exception good){shape=true;}check(shape,"unknown flag types must fail preview");event.remove("unclosed");
  event.put("day","2026-10-24");boolean wrongDay=false;try{strict.report("7","2026-10-25");}catch(Exception good){wrongDay=true;}check(wrongDay,"wrong provider day must fail preview");event.put("day","2026-10-25");
  int before=calls.size();for(String city:new String[]{"../settings","7/expenses","7?write=1","https://evil.invalid","7%2fwrite"}){try{client.report(city,"2026-10-25");throw new AssertionError(city);}catch(IllegalArgumentException good){}}check(calls.size()==before,"invalid inputs rejected before transport");
  for(String d:new String[]{"2026-02-30","2026-13-01","2026-1-2","2026-01-01&delete=1"})try{OrdexaClient.day(d);throw new AssertionError(d);}catch(Exception good){}
  denied("http://api.ordexa.gr/api/cities","GET");denied("https://api.ordexa.gr.evil.invalid/api/cities","GET");denied("https://api.ordexa.gr:443/api/cities","GET");denied("https://user@api.ordexa.gr/api/cities","GET");denied("https://api.ordexa.gr/api/cities#fragment","GET");denied("https://api.ordexa.gr/api/cities?write=1","GET");denied("https://api.ordexa.gr/api/cities","DELETE");denied("https://api.ordexa.gr/api/cities/7/report?from=2026-10-25&to=2026-10-25","POST");denied("https://api.ordexa.gr/api/settings","POST");
  System.out.println("PASS actual Java Ordexa client: fixed origin, only auth POST/read GET, blocked methods/paths/inputs before network, numeric IDs, schema, full timezone/raw events and no tokens/financial aggregate upload. Synthetic transport only.");
 }
}`);
 execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-cp',jar,'-d',dir,'server-android/src/gr/argyrismitsos/fleetserver/OrdexaClient.java',path.join(dir,'OrdexaTest.java')],{stdio:'inherit'});
 execFileSync('java',['-cp',dir+path.delimiter+jar,'gr.argyrismitsos.fleetserver.OrdexaTest'],{stdio:'inherit',timeout:20000});
 const packageName='package gr.argyrismitsos.fleetserver;';
 const stubs={
  BackupManager:packageName+'public class BackupManager{public static final String PREFS="fixture";}',
  ServerConfig:packageName+'public class ServerConfig{public static final String DEFAULT_WORKER_URL="https://fixture.invalid";}',
  ServerWorkTracker:packageName+'public class ServerWorkTracker{public static boolean begin(android.content.Context c,String a,String b,String d){return true;}public static void stage(String a,String b,String d){}public static void finish(String a){}}',
  OtaManager:packageName+'public class OtaManager{public static boolean shouldYieldForUpdate(android.content.Context c){return false;}}',
  SyncService:packageName+'public class SyncService{public static java.util.Map<String,String> serverHeaders(){return java.util.Collections.emptyMap();}}',
  FleetHttp:packageName+'public class FleetHttp{public static org.json.JSONObject sendJson(String a,String b,org.json.JSONObject c,java.util.Map<String,String> d){throw new AssertionError("No network allowed in gate test");}}'
 };
 for(const [name,source] of Object.entries(stubs))fs.writeFileSync(path.join(dir,name+'.java'),source);
 fs.writeFileSync(path.join(dir,'OrdexaGateTest.java'),String.raw`package gr.argyrismitsos.fleetserver;import org.json.*;import java.util.concurrent.atomic.AtomicBoolean;
 public class OrdexaGateTest{public static void main(String[] args)throws Exception{java.lang.reflect.Field field=OrdexaSync.class.getDeclaredField("running");field.setAccessible(true);AtomicBoolean gate=(AtomicBoolean)field.get(null);gate.set(true);
 for(String name:new String[]{"login","configure","preview","sync"}){boolean blocked=false;try{OrdexaSync.class.getMethod(name,android.content.Context.class,JSONObject.class).invoke(null,null,new JSONObject());}catch(java.lang.reflect.InvocationTargetException e){blocked=e.getCause().getMessage().contains("Ordexa");}if(!blocked||!gate.get())throw new AssertionError("Concurrent operation must not steal/release another operation's gate: "+name);}
 gate.set(false);for(String name:new String[]{"login","configure","preview","sync"}){try{OrdexaSync.class.getMethod(name,android.content.Context.class,JSONObject.class).invoke(null,null,new JSONObject());}catch(java.lang.reflect.InvocationTargetException expected){}if(gate.get())throw new AssertionError("Failed operation left a permanent busy state: "+name);}
 System.out.println("PASS actual native OrdexaSync: login/configure/preview/sync are mutually exclusive before storage/network and every failed operation releases its own gate.");}}
 `);
 const android=path.join(root,'.android-toolchain/usr/share/java/com.android.android-23.jar'),classpath=[dir,jar,android].join(path.delimiter);
 // Compile against Android's own org.json API as well as the host test jar.
 execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-cp',android,'-d',path.join(dir,'android-api'),'server-android/src/gr/argyrismitsos/fleetserver/OrdexaClient.java'],{stdio:'inherit'});
 execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-cp',classpath,'-d',dir,'server-android/src/gr/argyrismitsos/fleetserver/OrdexaSync.java',...Object.keys(stubs).map(name=>path.join(dir,name+'.java')),path.join(dir,'OrdexaGateTest.java')],{stdio:'inherit'});
 execFileSync('java',['-cp',classpath,'gr.argyrismitsos.fleetserver.OrdexaGateTest'],{stdio:'inherit',timeout:20000});
}finally{fs.rmSync(dir,{recursive:true,force:true});}
