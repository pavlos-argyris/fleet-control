package gr.argyrismitsos.fleetserver;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import org.json.*;
import java.util.*;

/** Prepare the rider directory on the phone. Cloudflare receives the small
 * result instead of joining every historical order on every rules/link read. */
public final class CloudCashCatalog {
 private CloudCashCatalog(){}
 public static void refresh(StoreBillingStore store,String scope,String generation)throws Exception{
  SQLiteDatabase db=store.database();String id=StoreBillingStore.key("cash-catalog",scope,"riders"),stateId=StoreBillingStore.key("cloud-catalog-state",scope,"riders");
  db.beginTransaction();try{
   JSONArray aliases=new JSONArray(),coverage=new JSONArray();
   Cursor c=db.rawQuery("SELECT data FROM store_billing_local WHERE scope=? AND kind='cash_rider_alias' ORDER BY json_extract(data,'$.observedAt') DESC,id",new String[]{scope});
   try{while(c.moveToNext())aliases.put(new JSONObject(c.getString(0)));}finally{c.close();}
   c=db.rawQuery("SELECT day,data FROM store_billing_local WHERE scope=? AND kind='cash_source_coverage' ORDER BY day",new String[]{scope});
   try{while(c.moveToNext()){JSONObject v=new JSONObject(c.getString(1));coverage.put(new JSONArray().put(c.getString(0)).put(v.optString("runId")).put(v.optString("observedAt")));}}finally{c.close();}
   String input=OrdexaClient.digest(new JSONObject().put("generation",generation).put("aliases",aliases).put("coverage",coverage));JSONObject previous=store.get(stateId);
   if(previous!=null&&input.equals(previous.optString("input"))&&store.get(id)!=null){db.setTransactionSuccessful();return;}
   Map<String,JSONObject> riders=new TreeMap<String,JSONObject>();
   for(int i=0;i<aliases.length();i++){JSONObject v=aliases.getJSONObject(i);String rider=v.getString("riderId");JSONObject item=riders.get(rider);if(item==null){item=new JSONObject().put("riderId",rider).put("nickname",v.optString("nickname")).put("aliases",new JSONArray());riders.put(rider,item);}item.getJSONArray("aliases").put(new JSONObject().put("nickname",v.optString("nickname")).put("observedAt",v.optString("observedAt")));}
   Set<String> selected=new HashSet<String>();
   c=db.rawQuery("SELECT json_extract(n.data,'$.sourceRiderId') riderId,json_extract(n.data,'$.nickname') nickname,MAX(json_extract(c.data,'$.observedAt')) observedAt FROM store_billing_local n JOIN store_billing_local c ON c.scope=n.scope AND c.kind='cash_source_coverage' AND c.day=n.day AND json_extract(c.data,'$.runId')=json_extract(n.data,'$.runId') WHERE n.scope=? AND n.kind='cash_snapshot_order' AND json_extract(n.data,'$.sourceRiderId') IS NOT NULL GROUP BY riderId,nickname ORDER BY observedAt DESC,riderId,nickname",new String[]{scope});
   try{while(c.moveToNext()){String rider=c.getString(0),nickname=c.getString(1);JSONObject item=riders.get(rider);if(item==null){item=new JSONObject().put("riderId",rider).put("aliases",new JSONArray());riders.put(rider,item);}if(selected.add(rider))item.put("nickname",nickname==null?"":nickname);}}finally{c.close();}
   JSONArray result=new JSONArray();for(JSONObject rider:riders.values())result.put(rider);
   JSONObject value=new JSONObject().put("version",1).put("generation",generation).put("riders",result).put("revision",OrdexaClient.digest(new JSONObject().put("riders",result)));String raw=value.toString();
   if(raw.getBytes("UTF-8").length>256*1024)throw new IllegalStateException("Ο κατάλογος διανομέων χρειάζεται μικρότερες σελίδες.");
   // One bounded result cell may exceed the general32KB provider-cell limit.
   // Equality prevents timestamp-only refreshes from creating an outbox entry.
   db.execSQL("INSERT INTO store_billing_local(id,kind,scope,store_id,day,data,dirty) VALUES(?,'cash_catalog',?,'','',?,0) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE store_billing_local.data<>excluded.data",new Object[]{id,scope,raw});
   store.put(stateId,"cloud_catalog_state",scope,"","",new JSONObject().put("input",input),false);db.setTransactionSuccessful();
  }finally{db.endTransaction();}
 }
}
