package gr.argyrismitsos.fleetserver;
import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import org.json.*;
import java.util.*;

/** Durable provider-cache delta. Financial writes execute only in Cloudflare.
 * A journal revision is acknowledged only if no local change happened meanwhile. */
public final class CloudSourceSync {
    private static volatile long next=0,lastHealth=0;
    private CloudSourceSync(){}
    public static void install(SQLiteDatabase db){CloudSourceJournal.install(db);}
    private static JSONArray query(SQLiteDatabase db,String sql,Object...args)throws Exception{return new BusinessSqlite(db).call("sql.query",new JSONObject().put("sql",sql).put("params",new JSONArray(Arrays.asList(args)))).getJSONArray("results");}
    public static void tick(Context c,FleetDataStore fleet){
        long now=System.currentTimeMillis();if(now<next)return;next=now+15000;
        try{
            SQLiteDatabase db=fleet.getWritableDatabase();if(!NativePrimaryState.read(db).optString("phase").equals("cloud_remote"))return;install(db);
            JSONObject context=OrdexaSync.storesContext(c);if(!context.has("scope"))return;if(!context.has("generation"))context.put("generation","");
            if(context.optBoolean("configured"))context.put("cashOrdersProtocol",new StoreBillingStore(fleet).orderProtocolEvidence(context.getString("scope")));
            JSONArray entries=query(db,"SELECT d.id,d.deleted,d.kind,d.revision,s.scope,s.store_id,s.day,s.data FROM cloud_source_dirty d LEFT JOIN store_billing_local s ON s.id=d.id WHERE d.kind<>'cash_source_coverage' ORDER BY CASE WHEN d.kind IN ('coverage','cash_source_coverage') THEN 1 ELSE 0 END,d.id LIMIT 64"),changes=new JSONArray(),ack=new JSONArray();
            for(int i=0;i<entries.length();i++){JSONObject r=entries.getJSONObject(i);JSONObject change=new JSONObject().put("id",r.getString("id")).put("kind",r.getString("kind")).put("deleted",r.optInt("deleted")==1);if(!change.getBoolean("deleted")){if(r.isNull("data"))continue;change.put("scope",r.getString("scope")).put("store_id",r.getString("store_id")).put("day",r.getString("day")).put("data",r.getString("data"));}changes.put(change);}
            JSONArray pendingAck=query(db,"SELECT r.id,r.request_id FROM cloud_source_requests r WHERE NOT EXISTS(SELECT 1 FROM store_billing_local s WHERE s.id=r.id AND s.kind='cash_refresh_request' AND json_extract(s.data,'$.requestId')=r.request_id) LIMIT 64");
            for(int i=0;i<pendingAck.length();i++){JSONObject r=pendingAck.getJSONObject(i);ack.put(new JSONObject().put("id",r.getString("id")).put("requestId",r.getString("request_id")));}
            JSONObject request=new JSONObject().put("context",context).put("changes",changes).put("ack",ack);
            if(now-lastHealth>=60000){JSONObject proof=new JSONObject(c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE).getString(BackupManager.KEY_RESTORE_TEST,"{}"));JSONObject health=new JSONObject().put("serverLastSeenAt",OrdexaClient.isoNow()).put("ordexaLastSuccessAt",OrdexaSync.status(c).optString("lastSuccess")).put("storesLastSuccessAt",StoreBillingSync.status(fleet).optString("lastSuccess")).put("freeBytes",c.getFilesDir().getUsableSpace()).put("versions",new JSONObject().put("server",ServerConfig.SERVER_VERSION));if(proof.optBoolean("restoreVerified"))health.put("backupLastVerifiedRestoreAt",proof.optString("checkedAt"));request.put("health",health);}
            String realm=c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE).getString("worker_url",ServerConfig.DEFAULT_WORKER_URL).replaceAll("/+$","");JSONObject response=FleetHttp.sendJson(realm+"/api/server/cloud-source","POST",request,SyncService.serverHeaders());
            if(!response.optBoolean("saved"))throw new java.io.IOException("Δεν επιβεβαιώθηκε η αποθήκευση πηγής στο Cloudflare.");
            db.beginTransaction();try{
                for(int i=0;i<entries.length();i++){JSONObject r=entries.getJSONObject(i);db.execSQL("DELETE FROM cloud_source_dirty WHERE id=? AND revision=?",new Object[]{r.getString("id"),r.getString("revision")});}
                for(int i=0;i<pendingAck.length();i++){JSONObject r=pendingAck.getJSONObject(i);db.execSQL("DELETE FROM cloud_source_requests WHERE id=? AND request_id=?",new Object[]{r.getString("id"),r.getString("request_id")});}
                StoreBillingStore store=new StoreBillingStore(fleet);JSONArray pending=response.optJSONArray("pending");if(pending!=null)for(int i=0;i<pending.length();i++){JSONObject r=pending.getJSONObject(i),data=new JSONObject(r.getString("data"));store.put(r.getString("id"),"cash_refresh_request",r.getString("scope"),"",r.getString("day"),data,false);db.execSQL("INSERT INTO cloud_source_requests VALUES(?,?) ON CONFLICT(id) DO UPDATE SET request_id=excluded.request_id",new Object[]{r.getString("id"),data.getString("requestId")});}
                JSONObject pilot=store.get("meta:cash-sync");if(pilot==null)pilot=new JSONObject();boolean enabled=response.optBoolean("wanted")&&context.optBoolean("configured");
                if(enabled&&now>=pilot.optLong("nextDue")){String today=StoreBillingEngine.businessDay(now);for(String date:new String[]{today,StoreBillingEngine.addDay(today,-1)}){String key=StoreBillingStore.key("cash-refresh",context.getString("scope"),date);if(store.get(key)==null)store.put(key,"cash_refresh_request",context.getString("scope"),"",date,new JSONObject().put("from",date).put("to",date).put("generation",context.getString("generation")).put("requestId",UUID.randomUUID().toString()).put("requestedAt",OrdexaClient.isoNow()).put("reason","cloud-pilot120"),false);}pilot.put("nextDue",now+120000);StoreBillingSync.wake(fleet);}
                if(now-pilot.optLong("lastTick")>=60000||pilot.optBoolean("automaticPollingEnabled")!=enabled){pilot.put("scope",context.getString("scope")).put("generation",context.getString("generation")).put("automaticPollingEnabled",enabled).put("lastTick",now).put("error","");store.put("meta:cash-sync","meta","","","",pilot,false);}
                db.setTransactionSuccessful();
            }finally{db.endTransaction();}
            if(!c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE).getString("cloud_source_error","").isEmpty())c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE).edit().putString("cloud_source_error","").apply();if(request.has("health"))lastHealth=now;if(CloudCashSourceSync.tick(db,realm,context)||entries.length()==64||"applying".equals(response.optJSONObject("automatic")==null?"":response.optJSONObject("automatic").optString("state")))next=now+500;
        }catch(Exception error){next=now+10000;c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE).edit().putString("cloud_source_error","Η ενημέρωση των αποτελεσμάτων Cloudflare θα επαναληφθεί. Τα δεδομένα διατηρούνται.").apply();}
    }
}
