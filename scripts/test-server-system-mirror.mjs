import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const root=process.cwd(),temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-system-mirror-'));
try{
for(const file of ['JSONObject.java','JSONArray.java'])fs.copyFileSync(path.join(root,'scripts/fixtures/java-json',file),path.join(temp,file));
fs.writeFileSync(path.join(temp,'FleetHttp.java'),`package gr.argyrismitsos.fleetserver;import java.util.*;import org.json.*;public class FleetHttp{
 public static List<JSONObject> replies=new ArrayList<JSONObject>();public static List<String> urls=new ArrayList<String>();
 public static JSONObject getJson(String url,Map<String,String> headers)throws Exception{if(!"key".equals(headers.get("X-Fleet-Server-Key")))throw new Exception("auth");urls.add(url);if(replies.isEmpty())throw new Exception("503");return replies.remove(0);}
}`);
fs.writeFileSync(path.join(temp,'MirrorTest.java'),`import gr.argyrismitsos.fleetserver.*;import org.json.*;import java.util.*;public class MirrorTest{
 static void check(boolean ok){if(!ok)throw new AssertionError();}
 static JSONObject page(long cursor,boolean more,String id){return new JSONObject().put("table","app_users").put("nextCursor",cursor).put("hasMore",more).put("rows",new JSONArray().put(new JSONObject().put("id",id)));}
 static void init(JSONObject... pages){FleetHttp.urls.clear();FleetHttp.replies.clear();FleetHttp.replies.add(new JSONObject().put("tables",new JSONArray().put("app_users")));for(JSONObject p:pages)FleetHttp.replies.add(p);}
 public static void main(String[] args)throws Exception{
 Map<String,String> headers=new HashMap<String,String>();headers.put("X-Fleet-Server-Key","key");JSONObject fleet=new JSONObject().put("bikes",new JSONArray());
 SystemMirror.Progress progress=new SystemMirror.Progress(){public void stage(String m){check(m.length()>0);}};
 init(page(8,true,"one"),page(9,false,"two"));JSONObject result=SystemMirror.download("https://fixture",headers,fleet,progress);
 check(result.getJSONObject("workforce").getJSONArray("app_users").length()==2);check(FleetHttp.urls.get(2).contains("cursor=8"));
 init(page(0,true,"one"));boolean invalid=false;try{SystemMirror.download("https://fixture",headers,fleet,progress);}catch(Exception e){invalid=true;}check(invalid);
 init(page(8,true,"one"));boolean interrupted=false;try{SystemMirror.download("https://fixture",headers,fleet,progress);}catch(Exception e){interrupted=true;}check(interrupted);
 String epoch="0123456789abcdef0123456789abcdef";
 JSONObject mirror=new JSONObject().put("epoch",epoch).put("cursor",4).put("rowIds",new JSONObject().put("app_users",new JSONArray().put(1).put(2)));
 JSONObject prior=new JSONObject().put("mirror",mirror).put("workforce",new JSONObject().put("app_users",new JSONArray().put(new JSONObject().put("id","one")).put(new JSONObject().put("id","two"))));
 String before=prior.toString();FleetHttp.replies.clear();FleetHttp.urls.clear();
 JSONArray changes=new JSONArray().put(new JSONObject().put("table","app_users").put("rowId",1).put("row",new JSONObject().put("id","changed"))).put(new JSONObject().put("table","app_users").put("rowId",2).put("row",JSONObject.NULL)).put(new JSONObject().put("table","app_users").put("rowId",3).put("row",new JSONObject().put("id","new")));
 JSONObject delta=new JSONObject().put("epoch",epoch).put("until",7).put("nextCursor",7).put("hasMore",false).put("changes",changes);
 FleetHttp.replies.add(delta);JSONObject updated=SystemMirror.update("https://fixture",headers,fleet,prior,progress);
 check(updated.getJSONObject("mirror").getLong("cursor")==7);check(updated.getJSONObject("workforce").getJSONArray("app_users").length()==2);check(updated.getJSONObject("workforce").getJSONArray("app_users").getJSONObject(0).getString("id").equals("changed"));check(prior.toString().equals(before));check(FleetHttp.urls.size()==1);
 FleetHttp.replies.add(new JSONObject(delta.toString()).put("hasMore",true).put("until",8));boolean failed=false;try{SystemMirror.update("https://fixture",headers,fleet,prior,progress);}catch(Exception e){failed=true;}check(failed);check(prior.toString().equals(before));
 System.out.println("OK actual Java paged mirror: authenticated complete assembly, advancing cursor, updates/deletions/additions, one-call unchanged mirror, partial/network failures never modify the previous mirror.");
 }} `);
execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-d',temp,path.join(temp,'JSONObject.java'),path.join(temp,'JSONArray.java'),path.join(temp,'FleetHttp.java'),path.join(root,'server-android/src/gr/argyrismitsos/fleetserver/SystemMirror.java'),path.join(temp,'MirrorTest.java')],{stdio:'inherit'});
execFileSync('java',['-cp',temp,'MirrorTest'],{stdio:'inherit'});
}finally{fs.rmSync(temp,{recursive:true,force:true});}
