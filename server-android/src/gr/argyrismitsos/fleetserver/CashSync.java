package gr.argyrismitsos.fleetserver;

import android.content.Context;
import android.database.Cursor;
import org.json.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Shared reader requests + bounded LOCAL financial work. Never performs provider/Worker HTTP. */
public final class CashSync {
    public interface Authority { boolean ready(); JSONObject apply()throws Exception; }
    // Only the separate independent Application installs this process-local port.
    private static volatile Authority localAuthority;
    public static void installAuthority(Authority authority){localAuthority=authority;}
    static final long PILOT_MS=60000;
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
        JSONObject value=new JSONObject().put("from",day).put("to",day).put("generation",source.getString("generation")).put("requestId",UUID.randomUUID().toString()).put("requestedAt",OrdexaClient.isoNow()).put("reason","background60");
        store.database().execSQL("INSERT INTO store_billing_local(id,kind,scope,store_id,day,data,dirty) VALUES(?,'cash_refresh_request',?,'',?,?,0) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,scope=excluded.scope,day=excluded.day,data=excluded.data,dirty=0 WHERE store_billing_local.kind<>'cash_refresh_request' OR COALESCE(json_extract(store_billing_local.data,'$.generation'),'')<>json_extract(excluded.data,'$.generation')",new Object[]{key,scope,day,value.toString()});
    }
    private static boolean closedSource(StoreBillingStore store,String scope,String day)throws Exception{
        JSONObject coverage=store.get(StoreBillingStore.key("cash-coverage",scope,day));
        if(coverage==null||!coverage.optString("revision").equals(OrdexaCashOrderProtocol.REVISION)||!coverage.optBoolean("timeSemanticsVerified")||!coverage.optBoolean("cancellationSemanticsVerified")||!coverage.optString("sourceDigest").matches("[a-f0-9]{64}")||!coverage.optBoolean("identityVerified")||!coverage.optBoolean("ordersCoverageComplete")||coverage.optBoolean("needsSourceRefresh"))return false;
        try{return StoreBillingEngine.businessDay(OrdexaClient.instant(coverage.getString("sourceAt"))).compareTo(day)>0;}catch(Exception invalid){return false;}
    }
    /** Visit retained history in bounded windows, including gaps. No date is
     * invented before the first retained source day or a real tariff date. */
    private static void history(StoreBillingStore store,JSONObject source,JSONObject meta,String previous)throws Exception{
        String scope=source.getString("scope"),oldest;
        Cursor from=store.database().rawQuery("SELECT MIN(day) FROM (SELECT day FROM store_billing_local WHERE scope=? AND kind IN('coverage','order','aggregate','cash_source_coverage') UNION ALL SELECT effective_day day FROM native_cash_rules r WHERE rate_cents>0 AND effective_day>='2000-01-01' AND EXISTS(SELECT 1 FROM store_billing_local s WHERE s.scope=? AND s.kind='store' AND s.id=r.store_id)) WHERE day GLOB '[12][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]' AND day<=?",new String[]{scope,scope,previous});
        try{oldest=from.moveToFirst()?from.getString(0):null;}finally{from.close();}if(oldest==null)return;
        String latest=StoreBillingEngine.addDay(previous,-1),cursor=meta.optString("historyCursor",latest);if(cursor.compareTo(latest)>0||cursor.compareTo(oldest)<0)cursor=latest;
        // One pending history read at a time; FIFO reader ordering prevents
        // minute updates from starving the archive, or vice versa.
        Cursor queued=store.database().rawQuery("SELECT 1 FROM store_billing_local WHERE scope=? AND kind='cash_refresh_request' AND day<? LIMIT 1",new String[]{scope,previous});
        try{if(queued.moveToFirst())return;}finally{queued.close();}
        for(int visited=0;visited<31&&cursor.compareTo(oldest)>=0;visited++){
            String day=cursor;cursor=StoreBillingEngine.addDay(cursor,-1);
            if(!closedSource(store,scope,day)){enqueue(store,source,day);break;}
        }
        meta.put("historyCursor",cursor.compareTo(oldest)<0?latest:cursor).put("historyFrom",oldest);
        // Reuse already verified history locally, even if the page was never
        // opened. Configuration jobs and manual-review fences remain intact.
        store.database().execSQL("INSERT OR IGNORE INTO store_billing_local(id,kind,scope,store_id,day,data,dirty) SELECT replace(c.id,'cash-coverage:','cash-apply:'),'cash_apply_request',c.scope,'',c.day,json_object('day',c.day,'requestId',?,'requestedAt',?,'reason','retained-history'),0 FROM store_billing_local c WHERE c.scope=? AND c.kind='cash_source_coverage' AND json_extract(c.data,'$.identityVerified')=1 AND json_extract(c.data,'$.ordersCoverageComplete')=1 AND COALESCE(json_extract(c.data,'$.needsSourceRefresh'),0)=0 AND NOT EXISTS(SELECT 1 FROM native_cash_auto_days a WHERE a.scope=c.scope AND a.day=c.day AND a.source_digest=COALESCE(json_extract(c.data,'$.sourceDigest'),'')) ORDER BY c.day DESC LIMIT 31",new Object[]{UUID.randomUUID().toString(),OrdexaClient.isoNow(),scope});
    }
    public static void tick(Context context,FleetDataStore fleet){
        long now=System.currentTimeMillis();if(now<next||!running.compareAndSet(false,true))return;
        boolean tracked=false;
        try{
            Authority local=localAuthority;
            if(local!=null?!local.ready():NativePrimaryService.cloudMode(context)||!NativePrimaryService.jobsAllowed(context)){next=now+5000;return;}
            // begin shares the OTA pause lock: an update either waits for this
            // durable step, or prevents it from starting before its checkpoint.
            if(!ServerWorkTracker.begin(context,"cash-auto","Αυτόματο Ταμείο","Ενημέρωση επαληθευμένων παραδόσεων")){next=now+1000;return;}
            tracked=true;
            JSONObject source=OrdexaSync.storesContext(context);if(!source.optBoolean("configured")||source.optBoolean("historicalOnly")){next=now+5000;return;}
            StoreBillingStore store=new StoreBillingStore(fleet);String scope=source.getString("scope"),generation=source.getString("generation");JSONObject old=store.get(META),meta=old==null?new JSONObject():new JSONObject(old.toString());boolean changed=!scope.equals(meta.optString("scope"))||!generation.equals(meta.optString("generation"));
            JSONObject result=null;
            // First local call initializes the current business schema. Later idle ticks avoid JS work.
            if(!initializedScope.equals(scope+":"+generation)||pending(store,scope)){result=local==null?NativePrimaryService.applyCashBatch(context):local.apply();initializedScope=scope+":"+generation;}
            String today=StoreBillingEngine.businessDay(now),previous=StoreBillingEngine.addDay(today,-1);boolean enabled=wanted(store,scope,today,previous);
            if(changed){meta=new JSONObject().put("nextDue",0);if(enabled)StoreBillingSync.wake(fleet);}
            meta.put("scope",scope).put("generation",generation).put("automaticPollingEnabled",enabled).put("intervalMs",PILOT_MS);
            if(enabled&&now>=meta.optLong("nextDue",0)){
                store.database().beginTransaction();try{store.database().execSQL("UPDATE store_billing_local SET kind='cash_refresh_obsolete' WHERE scope=? AND kind='cash_refresh_request' AND COALESCE(json_extract(data,'$.generation'),'')<>?",new Object[]{scope,generation});if(!closedSource(store,scope,previous))enqueue(store,source,previous);enqueue(store,source,today);history(store,source,meta,previous);meta.put("nextDue",now+PILOT_MS);store.database().setTransactionSuccessful();}finally{store.database().endTransaction();}changed=true;
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
