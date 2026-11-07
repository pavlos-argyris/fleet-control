package gr.argyrismitsos.fleetserver;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import org.json.*;
import java.security.MessageDigest;
import java.util.*;

/** Local-only identity snapshots on the existing reader. No provider calls or cash ledger writes. */
public final class OrdexaCashSourceStore {
    private final StoreBillingStore archive;
    private final SQLiteDatabase db;
    public OrdexaCashSourceStore(StoreBillingStore archive){this.archive=archive;this.db=archive.database();}
    private static String rowKey(String scope,String run,String order)throws Exception{return StoreBillingStore.key("cash-row",scope,run+":"+order);}
    public void stage(String scope,String run,String day,String pageKey,JSONObject raw,JSONObject validated,long cutoff)throws Exception{
        JSONObject parsed=OrdexaCashOrderProtocol.page(raw,validated);JSONArray rows=parsed.getJSONArray("rows");
        db.beginTransaction();try{
            db.execSQL("DELETE FROM store_billing_local WHERE scope=? AND kind='cash_identity_stage' AND json_extract(data,'$.runId')=? AND json_extract(data,'$.pageKey')=?",new Object[]{scope,run,pageKey});
            for(int i=0;i<rows.length();i++){
                JSONObject row=rows.getJSONObject(i);if(!day.equals(row.getString("businessDay"))||OrdexaClient.instant(row.getString("at"))>cutoff)continue;
                JSONObject data=new JSONObject(row.toString()).put("runId",run).put("pageKey",pageKey);
                String key=rowKey(scope,run,row.getString("sourceOrderId"));
                if(archive.get(key)!=null)throw new IllegalArgumentException("Διπλή ταυτότητα παραγγελίας στο δείγμα Ταμείου.");
                archive.put(key,"cash_identity_stage",scope,StoreBillingStore.key("store",scope,row.getString("sourceShopId")),day,data,false);
            }
            archive.put(StoreBillingStore.key("cash-page",scope,run+":"+pageKey),"cash_identity_page",scope,"",day,
                new JSONObject().put("runId",run).put("pageKey",pageKey).put("identityVerified",parsed.getBoolean("identityVerified"))
                    .put("page",validated.getInt("page")).put("pages",validated.getInt("pages")).put("total",validated.getInt("total")).put("rowsOnPage",raw.getJSONArray("rows").length()),false);
            db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    public String digest(String scope,String run)throws Exception{
        return digestRows(scope,run,"cash_identity_stage",null);
    }
    private String digestRows(String scope,String run,String kind,String day)throws Exception{
        MessageDigest digest=MessageDigest.getInstance("SHA-256");
        Cursor cursor=db.rawQuery("SELECT data FROM store_billing_local WHERE scope=? AND kind=? AND json_extract(data,'$.runId')=?"+(day==null?"":" AND day=?")+" ORDER BY json_extract(data,'$.sourceOrderId')",day==null?new String[]{scope,kind,run}:new String[]{scope,kind,run,day});
        try{while(cursor.moveToNext()){
            JSONObject row=new JSONObject(cursor.getString(0));
            String identity=row.getString("sourceOrderId")+":"+(row.optBoolean("identityVerified")?row.getString("fingerprint"):"unverified")+"\n";
            digest.update(identity.getBytes("UTF-8"));
        }}finally{cursor.close();}
        StringBuilder out=new StringBuilder();for(byte b:digest.digest())out.append(String.format(Locale.US,"%02x",b&255));return out.toString();
    }
    /** The active pointer changes in one SQLite transaction; incomplete scans retain the prior snapshot. */
    public void promote(String scope,String run,String day,String sourceAt,boolean repeatedIdentitiesMatch)throws Exception{
        String coverageKey=StoreBillingStore.key("cash-coverage",scope,day);JSONObject previous=archive.get(coverageKey);
        if(previous!=null&&run.equals(previous.optString("runId"))&&previous.optBoolean("ordersCoverageComplete")&&!previous.optBoolean("needsSourceRefresh"))return;
        JSONObject coverage=new JSONObject().put("revision",OrdexaCashOrderProtocol.REVISION).put("sourceAt",sourceAt)
            .put("observedAt",OrdexaClient.isoNow()).put("ordersCoverageComplete",false).put("identityVerified",false)
            .put("timeSemanticsVerified",false).put("cancellationSemanticsVerified",false).put("automaticWritesEnabled",false);
        if(previous!=null&&previous.has("runId"))coverage.put("runId",previous.getString("runId")).put("lastCompleteAt",previous.optString("lastCompleteAt",""));
        boolean valid=repeatedIdentitiesMatch;int pageCount=0;
        Map<String,Set<Integer>> seenPages=new HashMap<String,Set<Integer>>();Map<String,Integer> expectedPages=new HashMap<String,Integer>(),totals=new HashMap<String,Integer>(),counts=new HashMap<String,Integer>();
        Cursor pages=db.rawQuery("SELECT data FROM store_billing_local WHERE scope=? AND kind='cash_identity_page' AND day=? AND json_extract(data,'$.runId')=?",new String[]{scope,day,run});
        try{while(pages.moveToNext()){
            pageCount++;JSONObject page=new JSONObject(pages.getString(0));if(!page.optBoolean("identityVerified"))valid=false;
            String pageKey=page.getString("pageKey"),group=pageKey.substring(0,pageKey.lastIndexOf(':'));
            if(!seenPages.containsKey(group)){seenPages.put(group,new HashSet<Integer>());expectedPages.put(group,page.getInt("pages"));totals.put(group,page.getInt("total"));counts.put(group,0);}
            if(expectedPages.get(group)!=page.getInt("pages")||totals.get(group)!=page.getInt("total")||!seenPages.get(group).add(page.getInt("page")))valid=false;
            counts.put(group,counts.get(group)+page.getInt("rowsOnPage"));
        }}finally{pages.close();}
        for(String group:seenPages.keySet()){
            if(counts.get(group).intValue()!=totals.get(group).intValue()||seenPages.get(group).size()!=expectedPages.get(group))valid=false;
            for(int page=1;page<=expectedPages.get(group);page++)if(!seenPages.get(group).contains(page))valid=false;
        }
        if(!valid||pageCount==0){coverage.put("state",repeatedIdentitiesMatch?"identity-unverified":"partial");archive.put(coverageKey,"cash_source_coverage",scope,"",day,coverage,false);return;}
        String prior=previous==null?"":previous.optString("runId","");String at=OrdexaClient.isoNow();
        db.beginTransaction();try{
            // Preserve only genuine identity/presence changes as immutable observations.
            // Their payload survives pruning of superseded snapshots; money is not touched.
            db.execSQL("INSERT OR IGNORE INTO store_billing_local(id,kind,scope,store_id,day,data,dirty) SELECT 'cash-event:'||n.id,'cash_source_event',n.scope,n.store_id,n.day,json_object('event','observed-identity','runId',?,'observedAt',?,'before',json(o.data),'after',json(n.data)),0 FROM store_billing_local n LEFT JOIN store_billing_local o ON o.scope=n.scope AND o.kind='cash_snapshot_order' AND o.day=n.day AND json_extract(o.data,'$.runId')=? AND json_extract(o.data,'$.sourceOrderId')=json_extract(n.data,'$.sourceOrderId') WHERE n.scope=? AND n.kind='cash_identity_stage' AND n.day=? AND json_extract(n.data,'$.runId')=? AND (o.id IS NULL OR json_extract(o.data,'$.fingerprint')<>json_extract(n.data,'$.fingerprint'))",new Object[]{run,at,prior,scope,day,run});
            db.execSQL("INSERT OR IGNORE INTO store_billing_local(id,kind,scope,store_id,day,data,dirty) SELECT 'cash-absence:'||?||':'||o.id,'cash_source_event',o.scope,o.store_id,o.day,json_object('event','absent-from-complete-snapshot','runId',?,'observedAt',?,'before',json(o.data),'after',null),0 FROM store_billing_local o WHERE o.scope=? AND o.kind='cash_snapshot_order' AND o.day=? AND json_extract(o.data,'$.runId')=? AND NOT EXISTS(SELECT 1 FROM store_billing_local n WHERE n.scope=o.scope AND n.kind='cash_identity_stage' AND n.day=o.day AND json_extract(n.data,'$.runId')=? AND json_extract(n.data,'$.sourceOrderId')=json_extract(o.data,'$.sourceOrderId'))",new Object[]{run,run,at,scope,day,prior,run});
            Cursor names=db.rawQuery("SELECT DISTINCT json_extract(data,'$.sourceRiderId'),json_extract(data,'$.nickname') FROM store_billing_local WHERE scope=? AND kind='cash_identity_stage' AND day=? AND json_extract(data,'$.runId')=? AND json_extract(data,'$.sourceRiderId') IS NOT NULL",new String[]{scope,day,run});
            try{while(names.moveToNext()){
                String rider=names.getString(0),nickname=names.getString(1);String key=StoreBillingStore.key("cash-alias",scope,rider+":"+nickname);
                if(archive.get(key)==null)archive.put(key,"cash_rider_alias",scope,"","",new JSONObject().put("riderId",rider).put("nickname",nickname).put("observedAt",at),false);
            }}finally{names.close();}
            db.execSQL("UPDATE store_billing_local SET kind='cash_snapshot_order' WHERE scope=? AND kind='cash_identity_stage' AND day=? AND json_extract(data,'$.runId')=?",new Object[]{scope,day,run});
            coverage.put("state","identity-ready").put("runId",run).put("identityVerified",true).put("ordersCoverageComplete",true)
                .put("lastCompleteAt",at).put("sourceDigest",digestRows(scope,run,"cash_snapshot_order",day));
            archive.put(coverageKey,"cash_source_coverage",scope,"",day,coverage,false);
            db.execSQL("DELETE FROM store_billing_local WHERE scope=? AND kind='cash_snapshot_order' AND day=? AND json_extract(data,'$.runId')<>?",new Object[]{scope,day,run});
            db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    public JSONObject nextRequest(String scope,String generation)throws Exception{
        for(;;){
            Cursor cursor=db.rawQuery("SELECT id,data FROM store_billing_local WHERE scope=? AND kind='cash_refresh_request' ORDER BY day DESC LIMIT 1",new String[]{scope});
            String id,raw;try{if(!cursor.moveToFirst())return null;id=cursor.getString(0);raw=cursor.getString(1);}finally{cursor.close();}
            JSONObject value=new JSONObject(raw);
            if(generation.equals(value.optString("generation")))return new JSONObject(value.toString()).put("cashRefreshId",id).put("cashRefreshValue",raw);
            db.execSQL("UPDATE store_billing_local SET kind='cash_refresh_obsolete' WHERE id=? AND data=?",new Object[]{id,raw});
        }
    }
    public void acknowledge(JSONObject job)throws Exception{
        if(job.has("cashRefreshId"))db.execSQL("DELETE FROM store_billing_local WHERE id=? AND kind='cash_refresh_request' AND data=?",new Object[]{job.getString("cashRefreshId"),job.getString("cashRefreshValue")});
    }
}
