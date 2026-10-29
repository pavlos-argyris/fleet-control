package gr.argyrismitsos.fleetserver;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Server-owned calculation queue. Worker only pages inputs and stores results. */
public final class OrdexaPayrollSync {
    private static final AtomicBoolean running=new AtomicBoolean();
    private static long attempted=0;
    private static int failures=0;
    public static String monday(long now){Calendar c=Calendar.getInstance(TimeZone.getTimeZone("Europe/Athens"),Locale.US);c.setTimeInMillis(now);c.add(Calendar.DAY_OF_MONTH,-((c.get(Calendar.DAY_OF_WEEK)+5)%7));java.text.SimpleDateFormat f=new java.text.SimpleDateFormat("yyyy-MM-dd",Locale.US);f.setTimeZone(c.getTimeZone());return f.format(c.getTime());}
    private static String day(long time){java.text.SimpleDateFormat f=new java.text.SimpleDateFormat("yyyy-MM-dd",Locale.US);f.setTimeZone(TimeZone.getTimeZone("Europe/Athens"));return f.format(new Date(time));}
    private static String plus(String value,int days)throws Exception{java.text.SimpleDateFormat f=new java.text.SimpleDateFormat("yyyy-MM-dd",Locale.US);f.setTimeZone(TimeZone.getTimeZone("UTC"));return f.format(new Date(f.parse(value).getTime()+days*86400000L));}
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
            String sourceEpoch=control.optString("epoch","");if(sourceEpoch.length()>0&&!sourceEpoch.equals(prefs.getString("ordexa_source_epoch","")))prefs.edit().putString("ordexa_source_epoch",sourceEpoch).commit();
            JSONArray jobs=control.optJSONArray("jobs");if(jobs==null)return;boolean jobFailed=false;
            for(int j=0;j<jobs.length();j++){
                JSONObject leaseJob=jobs.getJSONObject(j);boolean published=false;
                try{
                if(OtaManager.shouldYieldForUpdate(context))throw new Exception("Παύση υπολογισμού για ενημέρωση Server.");if(!sameScope(prefs,base))throw new Exception("Άλλαξε η σύνδεση Server κατά τον υπολογισμό.");
                JSONObject job=jobs.getJSONObject(j);String week=job.getString("weekStart"),lease=job.getString("lease"),prefix=base+"/api/server/ordexa-server/input?week="+query(week)+"&lease="+query(lease);
                JSONObject entry=cache.optJSONObject(week);if(entry==null){entry=new JSONObject();cache.put(week,entry);}
                String currentWeek=monday(now),from=week.compareTo(currentWeek)<0?plus(week,-1):plus(day(now),-1),through=week.compareTo(currentWeek)<0?plus(week,7):day(now);
                String synced=week.compareTo(currentWeek)<=0?OrdexaSync.checkedAt(context,from,through):"";
                if(week.compareTo(currentWeek)<0&&now-entry.optLong("providerAttempt",0)>=120000){
                    entry.put("providerAttempt",now);JSONObject provider=OrdexaSync.status(context);
                    if(provider.optBoolean("enabled")&&!provider.optBoolean("busy")){
                        OrdexaSync.sync(context,new JSONObject().put("from",from).put("to",through));synced=OrdexaSync.checkedAt(context,from,through);
                    }
                }
                JSONObject head=FleetHttp.getJson(prefix,SyncService.serverHeaders());String revision=head.getString("revision"),epoch=head.getString("epoch");
                JSONObject input=entry==null?null:entry.optJSONObject("input");
                if(input==null||!revision.equals(entry.optString("revision"))||!epoch.equals(entry.optString("epoch"))){
                    input=new JSONObject().put("weekStart",week).put("timeZone",head.optString("timeZone","Europe/Athens"));JSONArray tables=head.getJSONArray("tables");
                    int total=0;
                    for(int t=0;t<tables.length();t++){
                        String table=tables.getString(t);if(!Arrays.asList("employees","riders","sessions","schedules","settings","adjustments","payrollAdjustments","vehicles","paid","coverage").contains(table))throw new Exception("Άγνωστη κατηγορία υπολογισμού.");
                        JSONArray rows=new JSONArray();long cursor=0;boolean completed=false;
                        for(int page=0;page<300;page++){
                            if(OtaManager.shouldYieldForUpdate(context))throw new Exception("Παύση υπολογισμού για ενημέρωση Server.");
                            JSONObject result=FleetHttp.getJson(prefix+"&table="+query(table)+"&revision="+query(revision)+"&epoch="+query(epoch)+"&cursor="+cursor,SyncService.serverHeaders());
                            if(!revision.equals(result.optString("revision"))||!epoch.equals(result.optString("epoch")))throw new Exception("Οι είσοδοι άλλαξαν κατά τη λήψη.");
                            JSONArray next=result.getJSONArray("rows");for(int i=0;i<next.length();i++)rows.put(next.getJSONObject(i));total+=next.length();if(rows.length()>20000||total>50000)throw new Exception("Πολλά δεδομένα υπολογισμού. Απαιτείται έλεγχος εύρους.");
                            if(!result.optBoolean("hasMore")){completed=true;break;}long advanced=result.getLong("nextCursor");if(advanced<=cursor)throw new Exception("Η λήψη εισόδων δεν προχώρησε.");cursor=advanced;
                        }
                        if(!completed)throw new Exception("Η λήψη εισόδων δεν ολοκληρώθηκε.");input.put(table,rows);
                    }
                    entry.put("revision",revision).put("epoch",epoch).put("input",input).remove("localHash");entry.remove("remoteHash");cache.put(week,entry);
                }
                ServerWorkTracker.stage("ordexa-payroll","Μισθοδοσία Ordexa","Υπολογισμός εβδομάδας "+week);
                long logicalNow=OrdexaPayrollEngine.time(head.getString("serverTime"));JSONObject payload=OrdexaPayrollEngine.build(input,logicalNow);String localHash=OrdexaPayrollEngine.hash(payload.toString());
                if(synced.length()==0)synced="1970-01-01T00:00:00.000Z";
                JSONObject outgoing=new JSONObject().put("weekStart",week).put("lease",lease).put("revision",revision).put("epoch",epoch).put("engineVersion",OrdexaPayrollEngine.VERSION).put("sourceSyncedAt",synced);
                boolean unchanged=localHash.equals(entry.optString("localHash"))&&entry.optString("remoteHash").length()>0;
                if(unchanged)outgoing.put("payloadHash",entry.getString("remoteHash"));
                if(OtaManager.shouldYieldForUpdate(context))throw new Exception("Παύση πριν τη δημοσίευση για ενημέρωση Server.");if(!sameScope(prefs,base))throw new Exception("Άλλαξε η σύνδεση Server πριν τη δημοσίευση.");
                Map<String,String> headers=new HashMap<String,String>(SyncService.serverHeaders());if(!unchanged)headers.put("X-Fleet-Projection",outgoing.toString());
                JSONObject saved=FleetHttp.sendJson(base+"/api/server/ordexa-server/publish","POST",unchanged?outgoing:payload,headers);if(!saved.optBoolean("saved"))throw new Exception("Δεν επιβεβαιώθηκε η αποθήκευση υπολογισμού.");
                published=true;
                entry.put("localHash",localHash).put("remoteHash",saved.getString("payloadHash")).put("updatedAt",now);
                store.setOrdexaPayrollState(state);
                prefs.edit().putString("ordexa_payroll_success",saved.getString("computedAt")).putString("ordexa_payroll_error","").apply();
                }catch(Exception jobError){jobFailed=true;}finally{if(!published&&sameScope(prefs,base))try{FleetHttp.sendJson(base+"/api/server/ordexa-server/release","POST",new JSONObject().put("weekStart",leaseJob.getString("weekStart")).put("lease",leaseJob.getString("lease")),SyncService.serverHeaders());}catch(Exception ignored){}}
            }
            // Keep only a few recently requested ranges; historical payroll is
            // persisted in the canonical database, not this disposable cache.
            if(cache.length()>6){List<String> keys=new ArrayList<String>();Iterator<String> it=cache.keys();while(it.hasNext())keys.add(it.next());final JSONObject byKey=cache;Collections.sort(keys,new Comparator<String>(){public int compare(String a,String b){return Long.compare(byKey.optJSONObject(b).optLong("updatedAt",0),byKey.optJSONObject(a).optLong("updatedAt",0));}});for(int i=6;i<keys.size();i++)cache.remove(keys.get(i));}
            store.setOrdexaPayrollState(state);failures=0;if(jobFailed)prefs.edit().putString("ordexa_payroll_error","Κάποιο εύρος αναμένει νέο υπολογισμό. Τα υπόλοιπα εύρη συνεχίζουν να ενημερώνονται.").apply();
        }catch(Exception error){failures=Math.min(8,failures+1);prefs.edit().putString("ordexa_payroll_error","Ο υπολογισμός βαρδιών θα επαναληφθεί. Η προηγούμενη επιβεβαιωμένη εικόνα διατηρείται.").apply();}
        finally{if(tracked)ServerWorkTracker.finish("ordexa-payroll");running.set(false);}
    }
}
