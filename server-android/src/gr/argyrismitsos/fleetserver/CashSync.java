package gr.argyrismitsos.fleetserver;

import android.content.Context;
import android.database.Cursor;
import org.json.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Shared reader requests + bounded LOCAL financial work. Never performs provider/Worker HTTP. */
public final class CashSync {
    static final long PILOT_MS=120000;
    private static final String META="meta:cash-sync";
    private static final AtomicBoolean running=new AtomicBoolean();
    private static volatile long next=0;
    private static String initializedScope="";
    private static boolean wanted(StoreBillingStore store,String scope,String day,String previous)throws Exception{
        Cursor cursor=store.database().rawQuery("SELECT 1 FROM native_cash_rules r WHERE r.rate_cents>0 AND r.effective_day<=? AND r.id=(SELECT x.id FROM native_cash_rules x WHERE x.store_id=r.store_id AND x.category=r.category AND x.effective_day<=? ORDER BY x.effective_day DESC,x.revision DESC LIMIT 1) AND (EXISTS(SELECT 1 FROM store_billing_local s WHERE s.kind='store' AND s.scope=? AND s.id=r.store_id) OR EXISTS(SELECT 1 FROM store_billing_records s WHERE s.kind='store' AND s.scope=? AND s.id=r.store_id)) UNION ALL SELECT 1 FROM native_cash_auto_orders WHERE scope=? AND business_day BETWEEN ? AND ? AND event_id IS NOT NULL LIMIT 1",new String[]{day,day,scope,scope,scope,previous,day});
        try{return cursor.moveToFirst();}finally{cursor.close();}
    }
    private static boolean pending(StoreBillingStore store,String scope)throws Exception{
        Cursor cursor=store.database().rawQuery("SELECT 1 FROM store_billing_local WHERE scope=? AND kind='cash_apply_request' LIMIT 1",new String[]{scope});try{return cursor.moveToFirst();}finally{cursor.close();}
    }
    private static void enqueue(StoreBillingStore store,JSONObject source,String day)throws Exception{
        String scope=source.getString("scope"),key=StoreBillingStore.key("cash-refresh",scope,day);
        // Pilot requests coalesce with an existing/manual request without invalidating its ACK.
        JSONObject existing=store.get(key);if(existing==null||!source.getString("generation").equals(existing.optString("generation")))store.put(key,"cash_refresh_request",scope,"",day,new JSONObject().put("from",day).put("to",day).put("generation",source.getString("generation")).put("requestId",UUID.randomUUID().toString()).put("requestedAt",OrdexaClient.isoNow()).put("reason","pilot120"),false);
    }
    public static void tick(Context context,FleetDataStore fleet){
        long now=System.currentTimeMillis();if(now<next||!running.compareAndSet(false,true))return;
        boolean tracked=false;
        try{
            if(NativePrimaryService.cloudMode(context)||!NativePrimaryService.jobsAllowed(context)){next=now+5000;return;}
            // begin shares the OTA pause lock: an update either waits for this
            // durable step, or prevents it from starting before its checkpoint.
            if(!ServerWorkTracker.begin(context,"cash-auto","Αυτόματο Ταμείο","Ενημέρωση επαληθευμένων παραδόσεων")){next=now+1000;return;}
            tracked=true;
            JSONObject source=OrdexaSync.storesContext(context);if(!source.optBoolean("configured")||source.optBoolean("historicalOnly")){next=now+5000;return;}
            StoreBillingStore store=new StoreBillingStore(fleet);String scope=source.getString("scope"),generation=source.getString("generation");JSONObject old=store.get(META),meta=old==null?new JSONObject():new JSONObject(old.toString());boolean changed=!scope.equals(meta.optString("scope"))||!generation.equals(meta.optString("generation"));
            JSONObject result=null;
            // First local call initializes the current business schema. Later idle ticks avoid JS work.
            if(!initializedScope.equals(scope+":"+generation)||pending(store,scope)){result=NativePrimaryService.applyCashBatch(context);initializedScope=scope+":"+generation;}
            String today=StoreBillingEngine.businessDay(now),previous=StoreBillingEngine.addDay(today,-1);boolean enabled=wanted(store,scope,today,previous);
            if(changed){meta=new JSONObject().put("nextDue",0);if(enabled)StoreBillingSync.wake(fleet);}
            meta.put("scope",scope).put("generation",generation).put("automaticPollingEnabled",enabled).put("intervalMs",PILOT_MS);
            if(enabled&&now>=meta.optLong("nextDue",0)){
                store.database().beginTransaction();try{enqueue(store,source,today);enqueue(store,source,previous);meta.put("nextDue",now+PILOT_MS);store.database().setTransactionSuccessful();}finally{store.database().endTransaction();}changed=true;
            }
            if(result!=null)meta.put("financialState",result.optString("state",result.optBoolean("idle")?"idle":"pending"));
            if(changed||result!=null||old==null||!old.optString("error","").isEmpty()||old.optBoolean("automaticPollingEnabled")!=enabled||now-meta.optLong("lastTick",0)>=30000){meta.put("lastTick",now).put("error","");store.put(META,"meta","","","",meta,false);}
            next=now+(result!=null&&"applying".equals(result.optString("state"))?250:enabled?1000:5000);
        }catch(Exception error){
            // No raw provider/identity/error body is copied to diagnostics.
            try{StoreBillingStore store=new StoreBillingStore(fleet);JSONObject meta=store.get(META);if(meta==null)meta=new JSONObject();store.put(META,"meta","","","",meta.put("error","Το αυτόματο Ταμείο θα επαναληφθεί. Οι προηγούμενες κινήσεις διατηρούνται.").put("lastTick",now),false);}catch(Exception ignored){}next=now+5000;
        }finally{if(tracked)ServerWorkTracker.finish("cash-auto");running.set(false);}
    }
}
