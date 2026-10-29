package gr.argyrismitsos.fleetserver;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Server-owned calculation queue. Worker only pages inputs and stores results. */
public final class OrdexaPayrollSync {
    private static final AtomicBoolean running=new AtomicBoolean();
    private static final String STATE="ordexa_payroll_projection_v1";
    private static long attempted=0;
    private static int failures=0;
    public static String monday(long now){Calendar c=Calendar.getInstance(TimeZone.getTimeZone("Europe/Athens"),Locale.US);c.setTimeInMillis(now);c.add(Calendar.DAY_OF_MONTH,-((c.get(Calendar.DAY_OF_WEEK)+5)%7));java.text.SimpleDateFormat f=new java.text.SimpleDateFormat("yyyy-MM-dd",Locale.US);f.setTimeZone(c.getTimeZone());return f.format(c.getTime());}
    private static String query(String value)throws Exception{return java.net.URLEncoder.encode(value,"UTF-8");}
    private static boolean sameScope(SharedPreferences prefs,String base){return base.equals(prefs.getString("worker_url",ServerConfig.DEFAULT_WORKER_URL).replaceAll("/+$",""));}
    public static void tick(Context context,FleetDataStore store){
        long now=System.currentTimeMillis();if(now-attempted<Math.min(300000,30000L*(1L<<Math.min(3,failures)))||OtaManager.shouldYieldForUpdate(context)||!running.compareAndSet(false,true))return;
        attempted=now;SharedPreferences prefs=context.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);String base=prefs.getString("worker_url",ServerConfig.DEFAULT_WORKER_URL).replaceAll("/+$","");boolean tracked=false;
        try{
            if(!ServerWorkTracker.begin(context,"ordexa-payroll","Μισθοδοσία Ordexa","Τοπικός υπολογισμός βαρδιών"))return;tracked=true;
            JSONObject state=store.getOrdexaPayrollState();if(!base.equals(state.optString("worker")))state=new JSONObject().put("worker",base).put("weeks",new JSONObject());
            JSONObject cache=state.optJSONObject("weeks");if(cache==null){cache=new JSONObject();state.put("weeks",cache);}
            JSONObject control=FleetHttp.sendJson(base+"/api/server/ordexa-server/control","POST",new JSONObject().put("week",monday(now)),SyncService.serverHeaders());
            JSONArray jobs=control.optJSONArray("jobs");if(jobs==null)return;
            for(int j=0;j<jobs.length();j++){
                if(OtaManager.shouldYieldForUpdate(context))return;if(!sameScope(prefs,base))throw new Exception("Άλλαξε η σύνδεση Server κατά τον υπολογισμό.");
                JSONObject job=jobs.getJSONObject(j);String week=job.getString("weekStart"),lease=job.getString("lease"),prefix=base+"/api/server/ordexa-server/input?week="+query(week)+"&lease="+query(lease);
                JSONObject head=FleetHttp.getJson(prefix,SyncService.serverHeaders());String revision=head.getString("revision"),epoch=head.getString("epoch");JSONObject entry=cache.optJSONObject(week);
                JSONObject input=entry==null?null:entry.optJSONObject("input");
                if(input==null||!revision.equals(entry.optString("revision"))||!epoch.equals(entry.optString("epoch"))){
                    input=new JSONObject().put("weekStart",week).put("timeZone",head.optString("timeZone","Europe/Athens"));JSONArray tables=head.getJSONArray("tables");
                    int total=0;
                    for(int t=0;t<tables.length();t++){
                        String table=tables.getString(t);if(!Arrays.asList("employees","riders","sessions","schedules","settings","adjustments","payrollAdjustments","vehicles","paid","coverage").contains(table))throw new Exception("Άγνωστη κατηγορία υπολογισμού.");
                        JSONArray rows=new JSONArray();long cursor=0;boolean completed=false;
                        for(int page=0;page<300;page++){
                            if(OtaManager.shouldYieldForUpdate(context))return;
                            JSONObject result=FleetHttp.getJson(prefix+"&table="+query(table)+"&revision="+query(revision)+"&epoch="+query(epoch)+"&cursor="+cursor,SyncService.serverHeaders());
                            if(!revision.equals(result.optString("revision"))||!epoch.equals(result.optString("epoch")))throw new Exception("Οι είσοδοι άλλαξαν κατά τη λήψη.");
                            JSONArray next=result.getJSONArray("rows");for(int i=0;i<next.length();i++)rows.put(next.getJSONObject(i));total+=next.length();if(rows.length()>20000||total>50000)throw new Exception("Πολλά δεδομένα υπολογισμού. Απαιτείται έλεγχος εύρους.");
                            if(!result.optBoolean("hasMore")){completed=true;break;}long advanced=result.getLong("nextCursor");if(advanced<=cursor)throw new Exception("Η λήψη εισόδων δεν προχώρησε.");cursor=advanced;
                        }
                        if(!completed)throw new Exception("Η λήψη εισόδων δεν ολοκληρώθηκε.");input.put(table,rows);
                    }
                    entry=new JSONObject().put("revision",revision).put("epoch",epoch).put("input",input);cache.put(week,entry);
                }
                ServerWorkTracker.stage("ordexa-payroll","Μισθοδοσία Ordexa","Υπολογισμός εβδομάδας "+week);
                long logicalNow=OrdexaPayrollEngine.time(head.getString("serverTime"));JSONObject payload=OrdexaPayrollEngine.build(input,logicalNow);String localHash=OrdexaPayrollEngine.hash(payload.toString());
                JSONObject ordexa=OrdexaSync.status(context);String synced=ordexa.optString("lastSuccess","");if(synced.length()==0)synced="1970-01-01T00:00:00.000Z";
                JSONObject outgoing=new JSONObject().put("weekStart",week).put("lease",lease).put("revision",revision).put("epoch",epoch).put("engineVersion",OrdexaPayrollEngine.VERSION).put("sourceSyncedAt",synced);
                boolean unchanged=localHash.equals(entry.optString("localHash"))&&entry.optString("remoteHash").length()>0;
                if(unchanged)outgoing.put("payloadHash",entry.getString("remoteHash"));
                if(!sameScope(prefs,base))throw new Exception("Άλλαξε η σύνδεση Server πριν τη δημοσίευση.");
                Map<String,String> headers=new HashMap<String,String>(SyncService.serverHeaders());if(!unchanged)headers.put("X-Fleet-Projection",outgoing.toString());
                JSONObject saved=FleetHttp.sendJson(base+"/api/server/ordexa-server/publish","POST",unchanged?outgoing:payload,headers);if(!saved.optBoolean("saved"))throw new Exception("Δεν επιβεβαιώθηκε η αποθήκευση υπολογισμού.");
                entry.put("localHash",localHash).put("remoteHash",saved.getString("payloadHash")).put("updatedAt",now);
                store.setOrdexaPayrollState(state);
                prefs.edit().putString("ordexa_payroll_success",saved.getString("computedAt")).putString("ordexa_payroll_error","").apply();
            }
            // Keep only a few recently requested ranges; historical payroll is
            // persisted in the canonical database, not this disposable cache.
            if(cache.length()>6){List<String> keys=new ArrayList<String>();Iterator<String> it=cache.keys();while(it.hasNext())keys.add(it.next());final JSONObject byKey=cache;Collections.sort(keys,new Comparator<String>(){public int compare(String a,String b){return Long.compare(byKey.optJSONObject(b).optLong("updatedAt",0),byKey.optJSONObject(a).optLong("updatedAt",0));}});for(int i=6;i<keys.size();i++)cache.remove(keys.get(i));}
            store.setOrdexaPayrollState(state);failures=0;
        }catch(Exception error){failures=Math.min(8,failures+1);prefs.edit().putString("ordexa_payroll_error","Ο υπολογισμός βαρδιών θα επαναληφθεί. Η προηγούμενη επιβεβαιωμένη εικόνα διατηρείται.").apply();}
        finally{if(tracked)ServerWorkTracker.finish("ordexa-payroll");running.set(false);}
    }
}
