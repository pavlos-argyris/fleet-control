import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root=process.cwd(),temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-snapshot-policy-'));
try {
 fs.writeFileSync(path.join(temp,'JSONException.java'),'package org.json; public class JSONException extends Exception {}');
 fs.writeFileSync(path.join(temp,'JSONObject.java'),`package org.json; import java.util.*;
public class JSONObject { final Map<String,Object> data=new LinkedHashMap<String,Object>();
 public JSONObject put(String k,Object v){data.put(k,v);return this;}
 public String optString(String k,String fallback){Object v=data.get(k);return v==null?fallback:v.toString();}
 public long optLong(String k,long fallback){Object v=data.get(k);return v instanceof Number?((Number)v).longValue():fallback;}
 public JSONArray optJSONArray(String k){Object v=data.get(k);return v instanceof JSONArray?(JSONArray)v:null;}
}`);
 fs.writeFileSync(path.join(temp,'JSONArray.java'),`package org.json; import java.util.*;
public class JSONArray { final List<Object> values=new ArrayList<Object>(); public JSONArray put(Object v){values.add(v);return this;}
 public int length(){return values.size();} public JSONObject optJSONObject(int i){Object v=values.get(i);return v instanceof JSONObject?(JSONObject)v:null;}
 public String optString(int i,String fallback){Object v=values.get(i);return v==null?fallback:v.toString();}
}`);
 fs.writeFileSync(path.join(temp,'SnapshotSyncTest.java'),`
import org.json.*; import gr.argyrismitsos.fleetserver.FleetSnapshotSync;
public class SnapshotSyncTest {
 static void check(boolean ok,String message){if(!ok)throw new AssertionError(message);}
 static JSONObject entry(String id,String time){return new JSONObject().put("id",id).put("updatedAt",time);}
 static JSONObject bike(String time,long km,JSONArray history){return new JSONObject().put("id","bike").put("updatedAt",time).put("currentKm",km).put("history",history);}
 static JSONObject fleet(JSONObject bike){return new JSONObject().put("bikes",new JSONArray().put(bike));}
 static JSONObject note(String id,String status,String time){return new JSONObject().put("id",id).put("text","Έλεγχος ιμάντα").put("status",status).put("createdAt","2026-10-01T00:00:00.000Z").put("updatedAt",time).put("sourceEntryId","source").put("completedEntryId","completed".equals(status)?"service":"");}
 public static void main(String[] args)throws Exception{
  String a="2026-10-09T12:00:00Z",b="2026-10-10T12:00:00Z";
  JSONObject remote=bike(a,100,new JSONArray().put(entry("one",a)).put(entry("two",a)));
  JSONObject local=bike(a,100,new JSONArray().put(entry("two",a)).put(entry("one",a)));
  check(FleetSnapshotSync.bikesToPublish(fleet(local),fleet(remote)).length()==0,"history order must not trigger upload");
  local.put("updatedAt",b);check(FleetSnapshotSync.bikesToPublish(fleet(local),fleet(remote)).length()==1,"newer local change lost");
  local.put("updatedAt",a).put("currentKm",120);check(FleetSnapshotSync.bikesToPublish(fleet(local),fleet(remote)).length()==1,"higher local km lost");
  local.put("currentKm",100).put("history",new JSONArray().put(entry("one",a)).put(entry("old-backup",a)));
  check(FleetSnapshotSync.bikesToPublish(fleet(local),fleet(remote)).length()==1,"older missing backup entry must be recovered");
  remote.put("historyDeletedIds",new JSONArray().put("old-backup"));
  check(FleetSnapshotSync.bikesToPublish(fleet(local),fleet(remote)).length()==0,"deleted history resurrected");
  local.put("historyCorrectedAt",b);check(FleetSnapshotSync.bikesToPublish(fleet(local),fleet(remote)).length()==1,"manual downward correction lost");
  JSONObject archived=fleet(remote).put("archivedBikeIds",new JSONArray().put("bike"));
  check(FleetSnapshotSync.bikesToPublish(fleet(local),archived).length()==0,"archived bike resurrected");
  check(FleetSnapshotSync.bikesToPublish(fleet(local),new JSONObject().put("bikes",new JSONArray())).length()==1,"local backup bike omitted");
  String t1="2026-10-01T00:00:00.000Z",t2="2026-10-02T00:00:00.000Z",t3="2026-10-03T00:00:00.000Z";
  JSONObject open=note("reminder","pending",t1),done=note("reminder","completed",t2),extra=note("independent","pending",t3);
  org.json.JSONArray notes=gr.argyrismitsos.fleetserver.NextServiceNotes.merge(new JSONArray().put(done),new JSONArray().put(open).put(extra));
  check(notes.length()==2,"independent next-service notes lost");
  for(int i=0;i<notes.length();i++)if("reminder".equals(notes.optJSONObject(i).optString("id","")))check("completed".equals(notes.optJSONObject(i).optString("status","")),"old mirror resurrected a completed task");
  local=bike(t1,100,new JSONArray()).put("nextServiceNotes",new JSONArray().put(done));remote=bike(t3,100,new JSONArray()).put("nextServiceNotes",new JSONArray().put(open));
  check(FleetSnapshotSync.bikesToPublish(fleet(local),fleet(remote)).length()==1,"per-note recovery change hidden by newer bike clock");
  remote.put("nextServiceNotes",new JSONArray().put(done));check(FleetSnapshotSync.bikesToPublish(fleet(local),fleet(remote)).length()==0,"unchanged next-service notes trigger uploads");
  local.put("nextServiceNotes",new JSONArray().put(open));check(FleetSnapshotSync.bikesToPublish(fleet(local),fleet(remote)).length()==0,"stale pending task uploaded again");
  System.out.println("OK actual Java snapshot policy: unchanged mirrors skip uploads, per-bike local/recovery changes, newer corrections, no archived/deleted resurrection.");
 }
}`);
 execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-d',temp,
  path.join(root,'server-android/src/gr/argyrismitsos/fleetserver/FleetSnapshotSync.java'),path.join(root,'server-android/src/gr/argyrismitsos/fleetserver/NextServiceNotes.java'),...['JSONException.java','JSONObject.java','JSONArray.java','SnapshotSyncTest.java'].map(f=>path.join(temp,f))],{stdio:'inherit'});
 execFileSync('java',['-cp',temp,'SnapshotSyncTest'],{stdio:'inherit'});
} finally {fs.rmSync(temp,{recursive:true,force:true});}
