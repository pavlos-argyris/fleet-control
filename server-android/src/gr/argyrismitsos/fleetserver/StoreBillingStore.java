package gr.argyrismitsos.fleetserver;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.content.ContentValues;
import org.json.*;
import java.util.*;

/** Small durable SQLite cells; no whole-history JSON/SharedPreferences cell. */
public final class StoreBillingStore {
    private final SQLiteDatabase db;
    public StoreBillingStore(FleetDataStore store){
        db=store.getWritableDatabase();
        db.execSQL("CREATE TABLE IF NOT EXISTS store_billing_local (id TEXT PRIMARY KEY,kind TEXT NOT NULL,scope TEXT NOT NULL,store_id TEXT NOT NULL DEFAULT '',day TEXT NOT NULL DEFAULT '',data TEXT NOT NULL,dirty INTEGER NOT NULL DEFAULT 1)");
        db.execSQL("CREATE INDEX IF NOT EXISTS store_billing_local_scope ON store_billing_local(scope,kind,day,store_id)");
        // The authoritative local order ledger must remain efficient as history grows.
        // This partial index accelerates durable pending-order reads without indexing
        // every acknowledged historical row. It does not change cloud publication yet.
        db.execSQL("CREATE INDEX IF NOT EXISTS store_billing_local_pending_orders ON store_billing_local(scope,id) WHERE dirty=1 AND kind IN ('order','observation')");
    }
    public static String key(String type,String scope,String source)throws Exception{return type+":"+OrdexaClient.digest(new JSONObject().put("scope",scope).put("id",source));}
    public synchronized JSONObject get(String id)throws Exception{
        Cursor c=db.rawQuery("SELECT data FROM store_billing_local WHERE id=?",new String[]{id});try{return c.moveToFirst()?new JSONObject(c.getString(0)):null;}finally{c.close();}
    }
    public synchronized void put(String id,String kind,String scope,String store,String day,JSONObject data,boolean dirty)throws Exception{
        String raw=data.toString();if(raw.getBytes("UTF-8").length>32768)throw new IllegalArgumentException("Μεγάλη εγγραφή καταστήματος· δεν αποθηκεύτηκε με περικοπή.");
        ContentValues v=new ContentValues();v.put("id",id);v.put("kind",kind);v.put("scope",scope);v.put("store_id",store);v.put("day",day);v.put("data",raw);v.put("dirty",dirty?1:0);
        if(db.insertWithOnConflict("store_billing_local",null,v,SQLiteDatabase.CONFLICT_REPLACE)<0)throw new IllegalStateException("Δεν αποθηκεύτηκε το αρχείο καταστημάτων.");
    }
    public synchronized JSONArray rows(String scope,String kind)throws Exception{
        JSONArray r=new JSONArray();Cursor c=db.rawQuery("SELECT data FROM store_billing_local WHERE scope=? AND kind=? ORDER BY id",new String[]{scope,kind});try{while(c.moveToNext())r.put(new JSONObject(c.getString(0)));}finally{c.close();}return r;
    }
    public synchronized JSONArray dirty(String scope)throws Exception{
        JSONArray r=new JSONArray();Cursor c=db.rawQuery("SELECT id,kind,store_id,day,data FROM store_billing_local WHERE scope=? AND dirty=1 AND kind IN ('order','observation') ORDER BY id LIMIT 32",new String[]{scope});try{while(c.moveToNext())r.put(new JSONObject().put("id",c.getString(0)).put("kind",c.getString(1)).put("storeId",c.getString(2)).put("day",c.getString(3)).put("data",new JSONObject(c.getString(4))));}finally{c.close();}return r;
    }
    public synchronized void acknowledged(JSONArray rows)throws Exception{
        db.beginTransaction();try{for(int i=0;i<rows.length();i++){JSONObject r=rows.getJSONObject(i);db.execSQL("UPDATE store_billing_local SET dirty=0 WHERE id=? AND data=?",new Object[]{r.getString("id"),r.getJSONObject("data").toString()});}db.setTransactionSuccessful();}finally{db.endTransaction();}
    }
    public synchronized void observe(String scope,JSONObject row,String run)throws Exception{
        String source=row.getString("sourceOrderId"),id=key("order",scope,source),store=key("store",scope,row.getString("sourceShopId"));JSONObject old=get(id),clean=new JSONObject(row.toString());
        clean.put("id",id).put("storeId",store);String fingerprint=OrdexaClient.digest(clean);
        if(old==null){clean.put("firstSeen",OrdexaClient.isoNow()).put("lastSeenRun",run).put("active",true);put(id,"order",scope,store,row.getString("businessDay"),clean,true);return;}
        JSONObject before=new JSONObject(old.toString());before.remove("firstSeen");before.remove("lastSeenRun");before.remove("active");before.remove("pendingDeleteRun");
        if(!OrdexaClient.digest(before).equals(fingerprint)){
            String observation=key("observation",scope,source+":"+fingerprint);clean.put("id",observation).put("acceptedOrderId",id).put("review",true).put("observedAt",OrdexaClient.isoNow());
            if(get(observation)==null)put(observation,"observation",scope,store,row.getString("businessDay"),clean,true);
        }
        // Source absence and source correction never erase the accepted version.
        boolean unchanged=OrdexaClient.digest(before).equals(fingerprint),reactivated=unchanged&&!old.optBoolean("active",true);old.put("lastSeenRun",run);old.remove("pendingDeleteRun");if(unchanged)old.put("active",true);db.execSQL("UPDATE store_billing_local SET data=?,dirty=CASE WHEN ?=1 THEN 1 ELSE dirty END WHERE id=?",new Object[]{old.toString(),reactivated?1:0,id});
    }
    /** Called only after a complete, stable final pass for this exact day. */
    public synchronized int reconcile(String scope,String day,String finalPass,JSONObject retention)throws Exception{
        JSONArray absent=new JSONArray();Cursor c=db.rawQuery("SELECT id,data FROM store_billing_local WHERE scope=? AND kind='order' AND day=? AND COALESCE(json_extract(data,'$.active'),1)=1 AND COALESCE(json_extract(data,'$.lastSeenRun'),'')<>?",new String[]{scope,day,finalPass});
        try{while(c.moveToNext())absent.put(new JSONObject(c.getString(1)));}finally{c.close();}
        int removed=0;db.beginTransaction();try{for(int i=0;i<absent.length();i++){
            JSONObject r=absent.getJSONObject(i);if(retention.optBoolean(r.getString("storeId"),false)){r.remove("pendingDeleteRun");db.execSQL("UPDATE store_billing_local SET data=? WHERE id=?",new Object[]{r.toString(),r.getString("id")});continue;}
            // Prepare only. A policy change can still reject the cloud transaction.
            r.put("pendingDeleteRun",finalPass);db.execSQL("UPDATE store_billing_local SET data=? WHERE id=?",new Object[]{r.toString(),r.getString("id")});removed++;
        }db.setTransactionSuccessful();}finally{db.endTransaction();}return removed;
    }
    public synchronized JSONObject counts(String scope,String day,String store,String run)throws Exception{
        Cursor c=db.rawQuery("SELECT COUNT(*),SUM(CASE WHEN json_extract(data,'$.lastSeenRun')<>? THEN 1 ELSE 0 END) FROM store_billing_local WHERE scope=? AND kind='order' AND day=? AND store_id=? AND COALESCE(json_extract(data,'$.active'),1)=1 AND COALESCE(json_extract(data,'$.pendingDeleteRun'),'')<>?",new String[]{run,scope,day,store,run});long count=0;int retained=0;try{if(c.moveToFirst()){count=c.getLong(0);retained=c.getInt(1);}}finally{c.close();}
        c=db.rawQuery("SELECT COUNT(*) FROM store_billing_local WHERE scope=? AND kind='observation' AND json_extract(data,'$.review')=1 AND (store_id=? OR json_extract(data,'$.acceptedOrderId') IN(SELECT id FROM store_billing_local WHERE scope=? AND store_id=? AND kind='order')) AND (day=? OR json_extract(data,'$.acceptedOrderId') IN(SELECT id FROM store_billing_local WHERE scope=? AND store_id=? AND day=? AND kind='order'))",new String[]{scope,store,scope,store,day,scope,store,day});int reviews=0;try{if(c.moveToFirst())reviews=c.getInt(0);}finally{c.close();}
        return new JSONObject().put("count",count).put("retained",retained).put("reviews",reviews);
    }
    public synchronized int pendingCount(){Cursor c=db.rawQuery("SELECT COUNT(*) FROM store_billing_local WHERE kind='outbox'",null);try{return c.moveToFirst()?c.getInt(0):0;}finally{c.close();}}
    public synchronized void observePage(String scope,JSONArray seen,String run)throws Exception{db.beginTransaction();try{for(int i=0;i<seen.length();i++)observe(scope,seen.getJSONObject(i).getJSONObject("row"),run);db.setTransactionSuccessful();}finally{db.endTransaction();}}
    public static String resultHash(JSONObject row)throws Exception{JSONObject v=new JSONObject(row.toString());for(String k:new String[]{"sourceLastSuccessAt","computedAt","runId"})v.remove(k);return OrdexaClient.digest(v);}
    public synchronized JSONArray snapshotRows(String scope,String run)throws Exception{
        JSONArray out=new JSONArray();Cursor c=db.rawQuery("SELECT data FROM store_billing_local WHERE scope=? AND kind='outbox_row' AND json_extract(data,'$.runId')=? ORDER BY store_id",new String[]{scope,run});try{while(c.moveToNext())out.put(new JSONObject(c.getString(0)));}finally{c.close();}return out;
    }
    public synchronized void localCatalogue(String scope,JSONArray shops)throws Exception{
        db.beginTransaction();try{for(int i=0;i<shops.length();i++){JSONObject row=new JSONObject(shops.getJSONObject(i).toString());String id=key("store",scope,row.getString("sourceShopId"));JSONObject old=get(id);if(old!=null)continue;
            row.put("id",id).put("revision",0).put("retainOrders",false);put(id,"store",scope,"","",row,false);
            JSONArray terms=row.getJSONArray("sourceTerms");for(int n=0;n<terms.length();n++){JSONObject t=new JSONObject(terms.getJSONObject(n).toString());String tid=key("local-terms",scope,id+":"+n);t.put("id",tid).put("storeId",id).put("version",1);put(tid,"terms",scope,id,t.optString("effectiveDay"),t,false);}
        }db.setTransactionSuccessful();}finally{db.endTransaction();}
    }
    /** Local result, confirmed absence audit and immutable outbox commit together. */
    public synchronized void completeDay(JSONObject job)throws Exception{
        String scope=job.getString("scope"),day=job.getString("day"),run=job.getString("runId");
        db.beginTransaction();try{
            db.execSQL("DELETE FROM store_billing_local WHERE scope=? AND day=? AND kind IN ('outbox','outbox_row')",new Object[]{scope,day});
            Cursor c=db.rawQuery("SELECT store_id,data FROM store_billing_local WHERE scope=? AND day=? AND kind='computed' AND id LIKE ? ORDER BY store_id",new String[]{scope,day,"computed:"+run+":%"});int count=0;
            try{while(c.moveToNext()){String id=c.getString(0);JSONObject row=new JSONObject(c.getString(1));put(key("local-day",scope,day+":"+id),"local_day",scope,id,day,row,false);row.put("runId",run);put("outbox:"+run+":"+id,"outbox_row",scope,id,day,row,false);count++;}}finally{c.close();}
            if(count!=job.getInt("resultCount"))throw new IllegalStateException("Incomplete local aggregate snapshot");
            JSONObject pending=new JSONObject(job.toString());pending.put("day",day).put("sourceAt",job.getString("sourceAt"));put(key("outbox",scope,day),"outbox",scope,"",day,pending,false);
            commitReconcileRows(scope,day,job.getString("finalPass"));
            put(key("coverage",scope,day),"coverage",scope,"",day,new JSONObject().put("runId",job.getString("finalPass")).put("sourceAt",job.getString("sourceAt")),false);
            db.execSQL("DELETE FROM store_billing_local WHERE scope=? AND kind='computed' AND day=?",new Object[]{scope,day});db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    public synchronized void invalidateAck(String scope,String day){db.execSQL("DELETE FROM store_billing_local WHERE scope=? AND day=? AND kind='aggregate_ack'",new Object[]{scope,day});}
    public synchronized void ackDay(JSONObject job,JSONArray all)throws Exception{
        String scope=job.getString("scope"),day=job.getString("day"),id=key("outbox",scope,day);db.beginTransaction();try{
            JSONObject current=get(id);if(current==null||!current.getString("runId").equals(job.getString("runId")))return;
            for(int i=0;i<all.length();i++){JSONObject r=all.getJSONObject(i);put(key("aggregate-ack",scope,day+":"+r.getString("storeId")),"aggregate_ack",scope,r.getString("storeId"),day,new JSONObject().put("hash",resultHash(r)),false);}
            db.execSQL("DELETE FROM store_billing_local WHERE id=?",new Object[]{id});db.execSQL("DELETE FROM store_billing_local WHERE scope=? AND kind='outbox_row' AND json_extract(data,'$.runId')=?",new Object[]{scope,job.getString("runId")});db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    public synchronized JSONArray exportRows()throws Exception{
        JSONArray out=new JSONArray();Cursor c=db.rawQuery("SELECT id,kind,scope,store_id,day,data,dirty FROM store_billing_local WHERE kind IN ('store','terms','order','observation','coverage','local_day') ORDER BY id",null);try{while(c.moveToNext())out.put(new JSONObject().put("id",c.getString(0)).put("kind",c.getString(1)).put("scope",c.getString(2)).put("storeId",c.getString(3)).put("day",c.getString(4)).put("data",new JSONObject(c.getString(5))).put("dirty",c.getInt(6)));}finally{c.close();}return out;
    }
    public synchronized JSONArray staged(String scope,String kind,String run,int offset,int limit)throws Exception{
        JSONArray out=new JSONArray();Cursor c=db.rawQuery("SELECT data FROM store_billing_local WHERE scope=? AND kind=? AND json_extract(data,'$.runId')=? ORDER BY id LIMIT ? OFFSET ?",new String[]{scope,kind,run,String.valueOf(limit),String.valueOf(offset)});try{while(c.moveToNext())out.put(new JSONObject(c.getString(0)));}finally{c.close();}return out;
    }
    public synchronized void activateInputs(String scope,String run)throws Exception{
        db.beginTransaction();try{
            db.execSQL("DELETE FROM store_billing_local WHERE scope=? AND kind IN ('store','terms')",new Object[]{scope});
            Cursor c=db.rawQuery("SELECT data FROM store_billing_local WHERE scope=? AND kind='input_stage' AND json_extract(data,'$.runId')=? ORDER BY id",new String[]{scope,run});
            try{while(c.moveToNext()){JSONObject r=new JSONObject(c.getString(0)).getJSONObject("record"),data=new JSONObject(r.getString("data"));data.put("revision",r.getLong("revision"));put(r.getString("id"),r.getString("kind"),scope,r.getString("store_id"),r.getString("day"),data,false);}}finally{c.close();}
            db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    public synchronized String passDigest(String scope,String pass)throws Exception{
        JSONArray ids=new JSONArray();Cursor c=db.rawQuery("SELECT data FROM store_billing_local WHERE scope=? AND kind='seen' AND json_extract(data,'$.runId')=? ORDER BY id",new String[]{scope,pass});try{while(c.moveToNext())ids.put(new JSONObject(c.getString(0)).getJSONObject("row"));}finally{c.close();}
        return OrdexaClient.digest(new JSONObject().put("ids",ids));
    }
    public synchronized void stagePage(String scope,String pass,String day,String page,JSONArray rows,long cutoff)throws Exception{
        db.beginTransaction();try{
            db.execSQL("DELETE FROM store_billing_local WHERE scope=? AND kind IN ('seen','raw_seen') AND json_extract(data,'$.runId')=? AND json_extract(data,'$.pageKey')=?",new Object[]{scope,pass,page});
            for(int i=0;i<rows.length();i++){
                JSONObject row=rows.getJSONObject(i);String identity=key("identity",scope,row.getString("sourceOrderId")),raw="raw:"+pass+":"+identity;
                if(get(raw)!=null)throw new Exception("Διπλή παραγγελία ή ασυνεπές φίλτρο Ordexa. Η λήψη παραμένει μη πλήρης.");
                JSONObject meta=new JSONObject().put("runId",pass).put("pageKey",page);put(raw,"raw_seen",scope,"",day,meta,false);
                if(row.getString("businessDay").equals(day)&&OrdexaClient.instant(row.getString("at"))<=cutoff)put("seen:"+pass+":"+identity,"seen",scope,"",day,new JSONObject(meta.toString()).put("row",row),false);
            }db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    public synchronized JSONArray removals(String scope,String day,String pass,int offset)throws Exception{
        JSONArray out=new JSONArray();Cursor c=db.rawQuery("SELECT data FROM store_billing_local WHERE scope=? AND kind='order' AND day=? AND json_extract(data,'$.pendingDeleteRun')=? ORDER BY id LIMIT 32 OFFSET ?",new String[]{scope,day,pass,String.valueOf(offset)});try{while(c.moveToNext()){JSONObject r=new JSONObject(c.getString(0));out.put(new JSONObject().put("orderId",r.getString("id")).put("storeId",r.getString("storeId")));}}finally{c.close();}return out;
    }
    public synchronized void commitReconcile(String scope,String day,String pass)throws Exception{db.beginTransaction();try{commitReconcileRows(scope,day,pass);db.setTransactionSuccessful();}finally{db.endTransaction();}}
    private void commitReconcileRows(String scope,String day,String pass)throws Exception{for(;;){JSONArray rows=removals(scope,day,pass,0);if(rows.length()==0)break;for(int i=0;i<rows.length();i++){
            JSONObject pair=rows.getJSONObject(i),r=get(pair.getString("orderId"));r.put("active",false);r.remove("pendingDeleteRun");put(r.getString("id"),"order",scope,r.getString("storeId"),day,r,false);
            String id=key("observation",scope,r.getString("id")+":deleted:"+pass);JSONObject event=new JSONObject(r.toString()).put("id",id).put("acceptedOrderId",r.getString("id")).put("event","source_deleted").put("review",false).put("observedAt",OrdexaClient.isoNow());put(id,"observation",scope,r.getString("storeId"),day,event,true);
        }}
    }
    public synchronized void importArchive(String scope,JSONObject row)throws Exception{
        String kind=row.getString("kind"),id=row.getString("id");JSONObject data=new JSONObject(row.getString("data"));
        if("publication".equals(kind)){if(data.optInt("protocol",1)==2&&get(key("authority",scope,"ledger"))==null)throw new IllegalArgumentException("Το ιστορικό καταστημάτων βρίσκεται στον προηγούμενο Server. Χρειάζεται επαναφορά πλήρους backup πριν δημοσίευση.");put(key("coverage",scope,row.getString("day")),"coverage",scope,"",row.getString("day"),new JSONObject().put("sourceAt",data.getString("sourceLastSuccessAt")).put("runId",data.optString("sourcePass",data.getString("activeRun")+":p2")),false);return;}
        if(!"order".equals(kind)&&!"observation".equals(kind))throw new IllegalArgumentException("Άγνωστη κατηγορία αρχείου καταστημάτων.");
        Cursor c=db.rawQuery("SELECT dirty FROM store_billing_local WHERE id=?",new String[]{id});boolean dirty;try{dirty=c.moveToFirst()&&c.getInt(0)!=0;}finally{c.close();}
        if(get(id)==null){data.remove("pendingDeleteRun");put(id,kind,scope,row.getString("store_id"),row.getString("day"),data,false);}
    }
    public synchronized String oldestCoverage(String scope,String before)throws Exception{
        Cursor c=db.rawQuery("SELECT day FROM store_billing_local WHERE scope=? AND kind='coverage' AND day<? ORDER BY json_extract(data,'$.sourceAt'),day LIMIT 1",new String[]{scope,before});try{return c.moveToFirst()?c.getString(0):"";}finally{c.close();}
    }
    public synchronized void cleanupTemporary(String scope)throws Exception{db.execSQL("DELETE FROM store_billing_local WHERE scope=? AND kind IN ('setup','input_stage','seen','raw_seen')",new Object[]{scope});}
    public static void validateBackup(JSONArray rows)throws Exception{
        if(rows==null)throw new IllegalArgumentException("Λείπει το αρχείο καταστημάτων στο backup.");
        Set<String> ids=new HashSet<String>();Map<String,String> shops=new HashMap<String,String>();
        for(int i=0;i<rows.length();i++){JSONObject r=rows.getJSONObject(i);for(String k:new String[]{"id","scope","storeId","day"})if(r.getString(k).length()>200)throw new IllegalArgumentException("Μη έγκυρη ταυτότητα καταστημάτων στο backup.");
            String id=r.getString("id"),scope=r.getString("scope"),kind=r.getString("kind");JSONObject data=r.getJSONObject("data");
            if(!id.matches("[A-Za-z0-9_:-]{1,200}")||!scope.matches("[A-Za-z0-9_:-]{1,100}")||!Arrays.asList("store","terms","order","observation","coverage","local_day").contains(kind)||!ids.add(id))throw new IllegalArgumentException("Μη έγκυρη κατηγορία ή διπλή εγγραφή καταστημάτων.");
            if(data.toString().getBytes("UTF-8").length>32768)throw new IllegalArgumentException("Μεγάλη εγγραφή καταστημάτων στο backup.");
            if(!r.getString("day").isEmpty())OrdexaClient.day(r.getString("day"));
            if(kind.equals("store")){if(!data.getString("id").equals(id)||!(data.get("retainOrders") instanceof Boolean)||!data.getString("sourceShopId").matches("[A-Za-z0-9_:-]{1,100}"))throw new IllegalArgumentException("Μη έγκυρο κατάστημα στο backup.");shops.put(scope+":"+id,data.getString("sourceShopId"));}
            else if(kind.equals("order")||kind.equals("observation")){if(!id.equals(data.getString("id"))||!r.getString("storeId").equals(data.getString("storeId"))||!r.getString("day").equals(data.getString("businessDay"))||!StoreBillingEngine.businessDay(OrdexaClient.instant(data.getString("at"))).equals(r.getString("day"))||data.getString("sourceOrderId").isEmpty()||(kind.equals("order")&&!(data.get("active") instanceof Boolean)))throw new IllegalArgumentException("Μη έγκυρη παραγγελία στο backup.");}
            else if(kind.equals("terms")){if(!id.equals(data.getString("id"))||!r.getString("storeId").equals(data.getString("storeId"))||!r.getString("day").equals(data.getString("effectiveDay")))throw new IllegalArgumentException("Μη έγκυροι όροι στο backup.");if(data.optBoolean("supported")){StoreBillingEngine.day(r.getString("storeId"),"2026-01-01",0,data,"",0,0);}}
            else if(kind.equals("local_day")){if(!data.getString("storeId").equals(r.getString("storeId"))||!data.getString("businessDay").equals(r.getString("day")))throw new IllegalArgumentException("Invalid local daily result");}
            else{OrdexaClient.instant(data.getString("sourceAt"));if(data.getString("runId").isEmpty())throw new IllegalArgumentException("Μη έγκυρη κάλυψη στο backup.");}
        }
        for(int i=0;i<rows.length();i++){JSONObject r=rows.getJSONObject(i);String kind=r.getString("kind");if(kind.equals("order")||kind.equals("observation")||kind.equals("terms")){String source=shops.get(r.getString("scope")+":"+r.getString("storeId"));if(source==null||(!kind.equals("terms")&&!source.equals(r.getJSONObject("data").getString("sourceShopId"))))throw new IllegalArgumentException("Λείπει το σωστό κατάστημα από το backup.");}}
    }

    public synchronized void restore(JSONArray rows)throws Exception{
        // Validate every record before touching the durable archive.
        validateBackup(rows);
        db.beginTransaction();try{db.execSQL("DELETE FROM store_billing_local");for(int i=0;i<rows.length();i++){JSONObject r=rows.getJSONObject(i);JSONObject data=new JSONObject(r.getJSONObject("data").toString());data.remove("pendingDeleteRun");put(r.getString("id"),r.getString("kind"),r.getString("scope"),r.getString("storeId"),r.getString("day"),data,"order".equals(r.getString("kind"))||"observation".equals(r.getString("kind")));}Set<String> scopes=new HashSet<String>();for(int i=0;i<rows.length();i++)scopes.add(rows.getJSONObject(i).getString("scope"));for(String scope:scopes)put(key("authority",scope,"ledger"),"authority",scope,"","",new JSONObject().put("restored",true),false);
            for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);if("local_day".equals(row.getString("kind"))){String scope=row.getString("scope"),day=row.getString("day");put(key("outbox",scope,day),"outbox",scope,"",day,new JSONObject().put("scope",scope).put("day",day).put("runId",UUID.randomUUID().toString()),false);}}
            db.setTransactionSuccessful();}finally{db.endTransaction();}
    }
}
