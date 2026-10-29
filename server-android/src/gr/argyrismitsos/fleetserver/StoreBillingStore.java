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
        JSONArray r=new JSONArray();Cursor c=db.rawQuery("SELECT id,kind,store_id,day,data FROM store_billing_local WHERE scope=? AND dirty=1 AND kind IN ('order','observation') ORDER BY id LIMIT 50",new String[]{scope});try{while(c.moveToNext())r.put(new JSONObject().put("id",c.getString(0)).put("kind",c.getString(1)).put("storeId",c.getString(2)).put("day",c.getString(3)).put("data",new JSONObject(c.getString(4))));}finally{c.close();}return r;
    }
    public synchronized void acknowledged(JSONArray rows)throws Exception{
        db.beginTransaction();try{for(int i=0;i<rows.length();i++){JSONObject r=rows.getJSONObject(i);db.execSQL("UPDATE store_billing_local SET dirty=0 WHERE id=? AND data=?",new Object[]{r.getString("id"),r.getJSONObject("data").toString()});}db.setTransactionSuccessful();}finally{db.endTransaction();}
    }
    public synchronized void observe(String scope,JSONObject row,String run)throws Exception{
        String source=row.getString("sourceOrderId"),id=key("order",scope,source),store=key("store",scope,row.getString("sourceShopId"));JSONObject old=get(id),clean=new JSONObject(row.toString());
        clean.put("id",id).put("storeId",store);String fingerprint=OrdexaClient.digest(clean);
        if(old==null){clean.put("firstSeen",OrdexaClient.isoNow()).put("lastSeenRun",run).put("active",true);put(id,"order",scope,store,row.getString("businessDay"),clean,true);return;}
        JSONObject before=new JSONObject(old.toString());before.remove("firstSeen");before.remove("lastSeenRun");before.remove("active");
        if(!OrdexaClient.digest(before).equals(fingerprint)){
            String observation=key("observation",scope,source+":"+fingerprint);clean.put("id",observation).put("acceptedOrderId",id).put("review",true).put("observedAt",OrdexaClient.isoNow());
            if(get(observation)==null)put(observation,"observation",scope,store,row.getString("businessDay"),clean,true);
        }
        // Source absence and source correction never erase the accepted version.
        boolean reactivated=!old.optBoolean("active",true);old.put("lastSeenRun",run).put("active",true);db.execSQL("UPDATE store_billing_local SET data=?,dirty=CASE WHEN ?=1 THEN 1 ELSE dirty END WHERE id=?",new Object[]{old.toString(),reactivated?1:0,id});
    }
    /** Called only after a complete, stable final pass for this exact day. */
    public synchronized int reconcile(String scope,String day,String finalPass,JSONObject retention)throws Exception{
        JSONArray absent=new JSONArray();Cursor c=db.rawQuery("SELECT id,data FROM store_billing_local WHERE scope=? AND kind='order' AND day=? AND COALESCE(json_extract(data,'$.active'),1)=1 AND COALESCE(json_extract(data,'$.lastSeenRun'),'')<>?",new String[]{scope,day,finalPass});
        try{while(c.moveToNext())absent.put(new JSONObject(c.getString(1)));}finally{c.close();}
        int removed=0;db.beginTransaction();try{for(int i=0;i<absent.length();i++){
            JSONObject r=absent.getJSONObject(i);if(retention.optBoolean(r.getString("storeId"),false))continue;
            r.put("active",false);put(r.getString("id"),"order",scope,r.getString("storeId"),day,r,true);
            String id=key("observation",scope,r.getString("id")+":deleted:"+finalPass);JSONObject evidence=new JSONObject(r.toString()).put("id",id).put("acceptedOrderId",r.getString("id")).put("event","source_deleted").put("review",false).put("observedAt",OrdexaClient.isoNow());
            put(id,"observation",scope,r.getString("storeId"),day,evidence,true);removed++;
        }db.setTransactionSuccessful();}finally{db.endTransaction();}return removed;
    }
    public synchronized JSONObject counts(String scope,String day,String store,String run)throws Exception{
        Cursor c=db.rawQuery("SELECT COUNT(*),SUM(CASE WHEN json_extract(data,'$.lastSeenRun')<>? THEN 1 ELSE 0 END) FROM store_billing_local WHERE scope=? AND kind='order' AND day=? AND store_id=? AND COALESCE(json_extract(data,'$.active'),1)=1",new String[]{run,scope,day,store});long count=0;int retained=0;try{if(c.moveToFirst()){count=c.getLong(0);retained=c.getInt(1);}}finally{c.close();}
        c=db.rawQuery("SELECT COUNT(*) FROM store_billing_local WHERE scope=? AND kind='observation' AND json_extract(data,'$.review')=1 AND (store_id=? OR json_extract(data,'$.acceptedOrderId') IN(SELECT id FROM store_billing_local WHERE scope=? AND store_id=? AND kind='order')) AND (day=? OR json_extract(data,'$.acceptedOrderId') IN(SELECT id FROM store_billing_local WHERE scope=? AND store_id=? AND day=? AND kind='order'))",new String[]{scope,store,scope,store,day,scope,store,day});int reviews=0;try{if(c.moveToFirst())reviews=c.getInt(0);}finally{c.close();}
        return new JSONObject().put("count",count).put("retained",retained).put("reviews",reviews);
    }
    public synchronized JSONArray exportRows()throws Exception{
        JSONArray out=new JSONArray();Cursor c=db.rawQuery("SELECT id,kind,scope,store_id,day,data,dirty FROM store_billing_local ORDER BY id",null);try{while(c.moveToNext())out.put(new JSONObject().put("id",c.getString(0)).put("kind",c.getString(1)).put("scope",c.getString(2)).put("storeId",c.getString(3)).put("day",c.getString(4)).put("data",new JSONObject(c.getString(5))).put("dirty",c.getInt(6)));}finally{c.close();}return out;
    }
    public synchronized void restore(JSONArray rows)throws Exception{
        // Validate every record before touching the durable archive.
        for(int i=0;i<rows.length();i++){JSONObject r=rows.getJSONObject(i);for(String k:new String[]{"id","kind","scope","storeId","day"})r.getString(k);if(r.getJSONObject("data").toString().getBytes("UTF-8").length>32768)throw new IllegalArgumentException("Μεγάλη εγγραφή καταστημάτων στο backup.");}
        db.beginTransaction();try{for(int i=0;i<rows.length();i++){JSONObject r=rows.getJSONObject(i);if(get(r.getString("id"))==null)put(r.getString("id"),r.getString("kind"),r.getString("scope"),r.getString("storeId"),r.getString("day"),r.getJSONObject("data"),true);}db.setTransactionSuccessful();}finally{db.endTransaction();}
    }
}
