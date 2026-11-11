package gr.argyrismitsos.fleetserver;
import android.database.sqlite.SQLiteDatabase;import org.json.*;
/** One daily evidence row carries unchanged financial values and freshness.
 * The original local snapshots and provider job state remain on the phone. */
public final class CloudStoreProof {
 private CloudStoreProof(){}
 public static JSONObject value(JSONObject row)throws Exception{JSONObject v=new JSONObject(row.toString());for(String key:new String[]{"sourceLastSuccessAt","computedAt","runId"})v.remove(key);return v;}
 public static String compared(String a){String data=a+".data";return "CASE WHEN "+a+".kind='local_day' THEN json_remove("+data+",'$.sourceLastSuccessAt','$.computedAt','$.runId') WHEN "+a+".id='meta:cash-sync' THEN json_remove("+data+",'$.lastTick','$.nextDue','$.financialState') WHEN "+a+".id='meta:store-billing' THEN json_object('activeScope',COALESCE(json_extract("+data+",'$.activeScope'),json_extract("+data+",'$.control.scope'),''),'activeGeneration',COALESCE(json_extract("+data+",'$.activeGeneration'),json_extract("+data+",'$.control.generation'),''),'lastSuccess',COALESCE(json_extract("+data+",'$.lastSuccess'),''),'error',COALESCE(json_extract("+data+",'$.error'),''),'nextDue',COALESCE(json_extract("+data+",'$.nextDue'),0)) ELSE json_remove("+data+",'$.lastSeenRun','$.pendingDeleteRun') END";}
 public static JSONObject publish(SQLiteDatabase db,JSONObject row)throws Exception{
  JSONObject data=new JSONObject(row.getString("data"));String kind=row.getString("kind");
  if(row.getString("id").equals("meta:cash-sync")){data.remove("lastTick");data.remove("nextDue");data.remove("financialState");return data;}
  if(row.getString("id").equals("meta:store-billing")){JSONObject control=data.optJSONObject("control");return new JSONObject().put("activeScope",data.optString("activeScope",control==null?"":control.optString("scope"))).put("activeGeneration",data.optString("activeGeneration",control==null?"":control.optString("generation"))).put("lastSuccess",data.optString("lastSuccess")).put("error",data.optString("error")).put("nextDue",data.optLong("nextDue"));}
  if(kind.equals("coverage")){
   JSONArray rows=new BusinessSqlite(db).call("sql.query",new JSONObject().put("sql","SELECT store_id,data FROM store_billing_local WHERE scope=? AND day=? AND kind='local_day' ORDER BY store_id").put("params",new JSONArray().put(row.getString("scope")).put(row.getString("day")))).getJSONArray("results");JSONObject snapshots=new JSONObject();for(int i=0;i<rows.length();i++){JSONObject r=rows.getJSONObject(i);snapshots.put(r.getString("store_id"),value(new JSONObject(r.getString("data"))));}data.put("cloudSnapshots",snapshots);
  }return data;
 }
}
