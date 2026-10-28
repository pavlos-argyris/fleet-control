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
  int before=calls.size();for(String city:new String[]{"../settings","7/expenses","7?write=1","https://evil.invalid","7%2fwrite"}){try{client.report(city,"2026-10-25");throw new AssertionError(city);}catch(IllegalArgumentException good){}}check(calls.size()==before,"invalid inputs rejected before transport");
  for(String d:new String[]{"2026-02-30","2026-13-01","2026-1-2","2026-01-01&delete=1"})try{OrdexaClient.day(d);throw new AssertionError(d);}catch(Exception good){}
  denied("http://api.ordexa.gr/api/cities","GET");denied("https://api.ordexa.gr.evil.invalid/api/cities","GET");denied("https://api.ordexa.gr:443/api/cities","GET");denied("https://user@api.ordexa.gr/api/cities","GET");denied("https://api.ordexa.gr/api/cities#fragment","GET");denied("https://api.ordexa.gr/api/cities?write=1","GET");denied("https://api.ordexa.gr/api/cities","DELETE");denied("https://api.ordexa.gr/api/cities/7/report?from=2026-10-25&to=2026-10-25","POST");denied("https://api.ordexa.gr/api/settings","POST");
  System.out.println("PASS actual Java Ordexa client: fixed origin, only auth POST/read GET, blocked methods/paths/inputs before network, numeric IDs, schema, full timezone/raw events and no tokens/financial aggregate upload. Synthetic transport only.");
 }
}`);
 execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-cp',jar,'-d',dir,'server-android/src/gr/argyrismitsos/fleetserver/OrdexaClient.java',path.join(dir,'OrdexaTest.java')],{stdio:'inherit'});
 execFileSync('java',['-cp',dir+path.delimiter+jar,'gr.argyrismitsos.fleetserver.OrdexaTest'],{stdio:'inherit',timeout:20000});
}finally{fs.rmSync(dir,{recursive:true,force:true});}
