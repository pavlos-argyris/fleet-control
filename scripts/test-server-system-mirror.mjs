import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const root=process.cwd(),temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-system-mirror-'));
try{
fs.writeFileSync(path.join(temp,'JSONObject.java'),`package org.json;import java.util.*;public class JSONObject{
 final Map<String,Object> values=new HashMap<String,Object>(); public JSONObject put(String k,Object v){values.put(k,v);return this;}
 public JSONArray getJSONArray(String k){return (JSONArray)values.get(k);}public JSONObject getJSONObject(String k){return (JSONObject)values.get(k);}
 public String optString(String k){Object v=values.get(k);return v==null?"":v.toString();}public boolean optBoolean(String k,boolean f){Object v=values.get(k);return v==null?f:(Boolean)v;}
 public long getLong(String k){return ((Number)values.get(k)).longValue();}
}`);
fs.writeFileSync(path.join(temp,'JSONArray.java'),`package org.json;import java.util.*;public class JSONArray{final List<Object> v=new ArrayList<Object>();public JSONArray put(Object o){v.add(o);return this;}public int length(){return v.size();}public JSONObject getJSONObject(int i){return (JSONObject)v.get(i);}public String getString(int i){return (String)v.get(i);}}`);
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
 System.out.println("OK actual Java paged mirror: authenticated complete assembly, advancing cursor, partial/network failures never return a replacement mirror.");
 }} `);
execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-d',temp,path.join(temp,'JSONObject.java'),path.join(temp,'JSONArray.java'),path.join(temp,'FleetHttp.java'),path.join(root,'server-android/src/gr/argyrismitsos/fleetserver/SystemMirror.java'),path.join(temp,'MirrorTest.java')],{stdio:'inherit'});
execFileSync('java',['-cp',temp,'MirrorTest'],{stdio:'inherit'});
}finally{fs.rmSync(temp,{recursive:true,force:true});}
