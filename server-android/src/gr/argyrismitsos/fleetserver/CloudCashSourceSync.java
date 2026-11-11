package gr.argyrismitsos.fleetserver;
import android.database.sqlite.SQLiteDatabase;import org.json.*;import java.util.*;
/** Per-day manifest/delta publisher. Staging never changes the active cloud view. */
public final class CloudCashSourceSync {
 private CloudCashSourceSync(){}
 private static JSONArray query(SQLiteDatabase db,String text,Object...args)throws Exception{return new BusinessSqlite(db).call("sql.query",new JSONObject().put("sql",text).put("params",new JSONArray(Arrays.asList(args)))).getJSONArray("results");}
 private static JSONObject message(JSONObject context,JSONObject job,String action)throws Exception{JSONObject body=new JSONObject().put("scope",context.getString("scope")).put("generation",context.getString("generation")).put("day",job.getString("day")).put("jobId",job.getString("jobId")).put("action",action);return body;}
 private static JSONObject send(String realm,JSONObject body)throws Exception{return FleetHttp.sendJson(realm+"/api/server/cloud-source/cash","POST",body,SyncService.serverHeaders());}
 public static boolean tick(SQLiteDatabase db,String realm,JSONObject context)throws Exception{
  if(!context.optBoolean("configured"))return false;
  db.execSQL("CREATE TABLE IF NOT EXISTS cloud_source_cash_job(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)");
  JSONArray pending=query(db,"SELECT d.id,d.revision,s.scope,s.day,s.data FROM cloud_source_dirty d JOIN store_billing_local s ON s.id=d.id WHERE d.kind='cash_source_coverage' AND d.deleted=0 AND s.scope=? ORDER BY s.day DESC LIMIT 1",context.getString("scope"));
  if(pending.length()==0)return false;JSONObject selected=pending.getJSONObject(0),coverage=new JSONObject(selected.getString("data"));String scope=selected.getString("scope"),day=selected.getString("day"),run=coverage.optString("runId"),revision=selected.getString("revision");
  String jobId=BusinessRuntime.sha256((scope+"\0"+context.getString("generation")+"\0"+day+"\0"+run+"\0"+revision).getBytes("UTF-8"));
  JSONArray saved=query(db,"SELECT data FROM cloud_source_cash_job WHERE id=1");JSONObject job=saved.length()==0?null:new JSONObject(saved.getJSONObject(0).getString("data"));
  if(job==null||!jobId.equals(job.optString("jobId")))job=new JSONObject().put("jobId",jobId).put("day",day).put("coverageId",selected.getString("id")).put("revision",revision).put("runId",run);
  boolean complete=coverage.optBoolean("identityVerified")&&coverage.optBoolean("ordersCoverageComplete")&&!coverage.optBoolean("needsSourceRefresh")&&coverage.optString("sourceDigest").matches("[a-f0-9]{64}");
  if(!complete){send(realm,message(context,job,"partial").put("coverage",coverage));ack(db,job);return true;}
  if(!job.has("missing")){
   // The source digest is computed by the shared local reader. An unchanged
   // day needs one small proof, not an upload/read of every order identity.
   try{JSONObject fresh=send(realm,message(context,job,"freshness").put("coverage",coverage));if(fresh.optBoolean("done")){ack(db,job);return true;}}
   catch(FleetHttp.HttpStatusException oldWorker){if(oldWorker.statusCode!=400)throw oldWorker;}
   JSONArray rows=query(db,"SELECT json_extract(data,'$.sourceOrderId') id,json_extract(data,'$.fingerprint') fingerprint FROM store_billing_local WHERE scope=? AND day=? AND kind='cash_snapshot_order' AND json_extract(data,'$.runId')=? ORDER BY json_extract(data,'$.sourceOrderId')",scope,day,run);
   JSONObject response=send(realm,message(context,job,"prepare").put("coverage",coverage).put("orders",rows));if(response.optBoolean("done")){ack(db,job);return true;}job.put("missing",response.getJSONArray("missing")).put("cursor",0);
  }else{
   JSONArray missing=job.getJSONArray("missing");int cursor=job.optInt("cursor");
   if(cursor<missing.length()){
    JSONArray ids=new JSONArray();for(int n=cursor;n<Math.min(cursor+64,missing.length());n++)ids.put(missing.getString(n));
    JSONArray rows=query(db,"SELECT store_id,data FROM store_billing_local WHERE scope=? AND day=? AND kind='cash_snapshot_order' AND json_extract(data,'$.runId')=? AND json_extract(data,'$.sourceOrderId') IN(SELECT value FROM json_each(?)) ORDER BY json_extract(data,'$.sourceOrderId')",scope,day,run,ids.toString());if(rows.length()!=ids.length())throw new java.io.IOException("Άλλαξε το πλήρες στιγμιότυπο της ημέρας.");
    if(!send(realm,message(context,job,"stage").put("rows",rows)).optBoolean("saved"))throw new java.io.IOException("Δεν επιβεβαιώθηκε η παρτίδα πηγής.");job.put("cursor",cursor+rows.length());
   }else{if(!send(realm,message(context,job,"finish")).optBoolean("done"))throw new java.io.IOException("Δεν επιβεβαιώθηκε η πλήρης κάλυψη Cloudflare.");ack(db,job);return true;}
  }
  db.execSQL("INSERT INTO cloud_source_cash_job VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",new Object[]{job.toString()});return true;
 }
 private static void ack(SQLiteDatabase db,JSONObject job)throws Exception{db.beginTransaction();try{db.execSQL("DELETE FROM cloud_source_dirty WHERE id=? AND revision=?",new Object[]{job.getString("coverageId"),job.getString("revision")});db.execSQL("DELETE FROM cloud_source_cash_job WHERE id=1 AND json_extract(data,'$.jobId')=?",new Object[]{job.getString("jobId")});db.setTransactionSuccessful();}finally{db.endTransaction();}}
}
