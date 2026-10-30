package gr.argyrismitsos.fleetserver;

import android.content.Context;
import org.json.*;
import java.util.*;
import java.net.URLEncoder;
import java.util.concurrent.atomic.AtomicBoolean;

/** Resumable small-step store queue. An idle tick performs no network request. */
public final class StoreBillingSync {
    private static final String META="meta:store-billing";
    private static final AtomicBoolean running=new AtomicBoolean();
    private static volatile long next=0, publishNext=0;
    private static JSONObject state(StoreBillingStore s)throws Exception{JSONObject r=s.get(META);return r==null?new JSONObject():r;}
    private static void save(StoreBillingStore s,JSONObject r)throws Exception{s.put(META,"meta","","","",r,false);}
    public static JSONObject status(FleetDataStore fleet)throws Exception{JSONObject s=state(new StoreBillingStore(fleet));return new JSONObject().put("busy",s.has("job")).put("stage",s.optString("stage","Δεν έχει γίνει λήψη καταστημάτων")).put("lastSuccess",s.optString("lastSuccess","")).put("nextDue",s.optLong("nextDue",0)).put("error",s.optString("error","")).put("syncIntervalMs",3600000).put("cutoffHour",5).put("pendingDays",new StoreBillingStore(fleet).pendingCount()).put("cloudError",s.optString("cloudError",""));}
    public static void wake(FleetDataStore fleet)throws Exception{StoreBillingStore s=new StoreBillingStore(fleet);s.put("meta:store-billing-wake","meta","","","",new JSONObject().put("at",System.currentTimeMillis()),false);next=0;}
    public static JSONObject request(Context c,FleetDataStore fleet,String from,String to)throws Exception{
        OrdexaClient.day(from);OrdexaClient.day(to);if(to.compareTo(from)<0||to.compareTo(StoreBillingEngine.addDay(from,30))>0)throw new IllegalArgumentException("Επίλεξε περίοδο καταστημάτων έως31 ημέρες.");JSONObject source=OrdexaSync.storesContext(c);if(!source.getBoolean("configured"))throw new IllegalArgumentException("Συνδέσου πρώτα στο Ordexa και επίλεξε πόλη.");
        StoreBillingStore store=new StoreBillingStore(fleet);JSONObject m=state(store);if(m.has("job"))throw new IllegalArgumentException("Εκτελείται ήδη εισαγωγή καταστημάτων. Περίμενε την ολοκλήρωση.");
        m.put("localRequest",new JSONObject().put("from",from).put("to",to));save(store,m);wake(fleet);return new JSONObject().put("queued",true).put("local",true);

    }
    private static JSONObject envelope(JSONObject j)throws Exception{return new JSONObject().put("scope",j.getString("scope")).put("generation",j.getString("generation")).put("epoch",j.getString("epoch")).put("operationId",j.getString("operationId")).put("lease",j.getString("lease"));}
    private static void same(Context c,JSONObject j)throws Exception{JSONObject current=OrdexaSync.storesContext(c);if(!current.getString("scope").equals(j.getString("scope"))||!current.getString("generation").equals(j.getString("generation")))throw new Exception("Η σύνδεση καταστημάτων Ordexa άλλαξε.");}
    private static JSONObject post(Context c,JSONObject j,String action,JSONObject body)throws Exception{
        same(c,j);JSONObject b=envelope(j);Iterator<String> keys=body.keys();while(keys.hasNext()){String k=keys.next();b.put(k,body.get(k));}
        JSONObject r=FleetHttp.sendJson(j.getString("worker")+"/api/server/store-billing/"+action,"POST",b,SyncService.serverHeaders());if(!r.optBoolean("saved"))throw new Exception("Δεν επιβεβαιώθηκε η αποθήκευση καταστημάτων.");same(c,j);return r;
    }
    private static String query(JSONObject j,long cursor,String table)throws Exception{
        JSONObject b=envelope(j).put("cursor",cursor).put("revision",j.getLong("inputRevision")).put("table",table);List<String> keys=new ArrayList<String>();Iterator<String> i=b.keys();while(i.hasNext())keys.add(i.next());Collections.sort(keys);StringBuilder q=new StringBuilder();for(String k:keys){if(q.length()>0)q.append('&');q.append(k).append('=').append(URLEncoder.encode(String.valueOf(b.get(k)),"UTF-8"));}return q.toString();
    }
    private static void progress(Context c,JSONObject j,String stage,String state)throws Exception{
        // Progress is advisory. Cloud availability must never gate local ingestion.
        try{JSONObject r=post(c,j,"progress",new JSONObject().put("state",state).put("stage",stage));j.put("hasPending",r.optBoolean("hasPending",false));}catch(Exception ignored){}j.put("lastProgress",System.currentTimeMillis());
    }
    private static String pass(JSONObject j)throws Exception{return j.getString("runId")+":p"+j.optInt("pass",1);}
    private static void dayStart(JSONObject j,String day)throws Exception{j.put("day",day).put("runId",UUID.randomUUID().toString()).put("pass",1).put("page",1).put("shopIndex",0).put("mode","city").put("sourceAt",OrdexaClient.isoNow()).put("cutoffAt",System.currentTimeMillis()).put("removalCount",0).put("removalCursor",0);j.remove("firstDigest");j.put("phase",day.compareTo(StoreBillingEngine.businessDay(System.currentTimeMillis()))>0?"future":j.getString("type").equals("reprice")?"reprice":"orders");}
    private static JSONArray stores(StoreBillingStore s,JSONObject j)throws Exception{return s.rows(j.getString("scope"),"store");}
    private static Set<String> known(JSONArray shops)throws Exception{Set<String> set=new HashSet<String>();for(int i=0;i<shops.length();i++)set.add(shops.getJSONObject(i).getString("sourceShopId"));return set;}
    private static void start(Context c,StoreBillingStore s,JSONObject m,JSONObject source)throws Exception{
        String today=StoreBillingEngine.businessDay(System.currentTimeMillis()),from=StoreBillingEngine.addDay(today,-1);
        if(m.optString("historyPending","").length()>0)from=today=m.getString("historyPending");
        JSONObject requested=m.optJSONObject("localRequest");if(requested!=null){from=requested.getString("from");today=requested.getString("to");}
        JSONObject input=new JSONObject(source.toString()).put("from",from).put("to",today).put("protocol",2).put("allowAuto",requested!=null||(source.getBoolean("enabled")&&System.currentTimeMillis()>=m.optLong("nextDue",0))||m.optString("historyPending","").length()>0);
        JSONObject r;
        try{r=FleetHttp.sendJson(source.getString("worker")+"/api/server/store-billing/control","POST",input,SyncService.serverHeaders());}
        catch(Exception offline){
            JSONObject cached=m.optJSONObject("control");JSONObject j=new JSONObject(source.toString()).put("operationId",UUID.randomUUID().toString()).put("lease",UUID.randomUUID().toString()).put("type","sync").put("from",from).put("to",today).put("phase","localSetup").put("offline",true);
            if(cached!=null&&source.getString("scope").equals(cached.optString("scope"))&&source.getString("generation").equals(cached.optString("generation"))&&(s.get(StoreBillingStore.key("authority",source.getString("scope"),"ledger"))!=null||m.optString("archiveEpoch","").startsWith(source.getString("scope")+":"+cached.getString("epoch")+":")))j.put("epoch",cached.getString("epoch")).put("inputRevision",cached.getLong("inputRevision"));
            m.put("job",j).remove("localRequest");return;
        }if(r.optBoolean("idle",false)){m.put("wake",false).put("nextDue",Math.max(m.optLong("nextDue",0),System.currentTimeMillis()+60000));return;}JSONObject job=r.getJSONObject("job");
        same(c,source);JSONObject j=new JSONObject(source.toString()).put("epoch",r.getString("epoch")).put("operationId",job.getString("id")).put("lease",job.getString("lease")).put("type",job.getString("type")).put("from",job.getString("from")).put("to",job.getString("to")).put("inputRevision",r.getJSONObject("connection").getLong("revision")).put("catalogueHash",r.getJSONObject("connection").optString("catalogueHash","")).put("inputCursor",0).put("inputCount",0).put("phase",job.getString("type").equals("reprice")?"inputs":"setup");
        JSONObject authority=s.get(StoreBillingStore.key("authority",j.getString("scope"),"ledger"));
        boolean legacyComplete=m.optString("archiveEpoch","").startsWith(j.getString("scope")+":"+j.getString("epoch")+":");
        if(authority==null&&legacyComplete){authority=new JSONObject().put("complete",true);s.put(StoreBillingStore.key("authority",j.getString("scope"),"ledger"),"authority",j.getString("scope"),"","",authority,false);}
        j.put("needsHydrate",authority==null);
        m.put("control",new JSONObject().put("scope",j.getString("scope")).put("generation",j.getString("generation")).put("epoch",j.getString("epoch")).put("inputRevision",j.getLong("inputRevision")));if(requested!=null&&j.getString("from").equals(requested.getString("from"))&&j.getString("to").equals(requested.getString("to"))&&j.getString("type").equals("sync"))m.remove("localRequest");
        s.cleanupTemporary(j.getString("scope"));m.put("job",j).put("wake",false).put("error","").put("stage","Έλεγχος συμβατότητας Ordexa");
    }
    private static String step(Context c,StoreBillingStore s,JSONObject j)throws Exception{
        String scope=j.getString("scope"),op=j.getString("operationId"),phase=j.getString("phase");same(c,j);
        if(phase.equals("localSetup")){
            JSONArray shops=StoreBillingProtocol.setup(OrdexaSync.storesRead(c,j,true,"","",1,null));s.localCatalogue(scope,shops);dayStart(j,j.getString("from"));return "Τοπική εισαγωγή · το Cloudflare δεν είναι διαθέσιμο";
        }
        if(phase.equals("future")){progress(c,j,"Αποθηκεύτηκαν οι όροι για μελλοντική ημερομηνία","completed");j.put("phase","done");return "Η μελλοντική τιμή θα χρησιμοποιηθεί από την ημερομηνία ισχύος";}
        if(phase.equals("setup")){
            JSONArray shops=StoreBillingProtocol.setup(OrdexaSync.storesRead(c,j,true,"","",1,null));String hash=OrdexaClient.digest(new JSONObject().put("shops",shops));
            if(hash.equals(j.getString("catalogueHash"))){j.put("phase","inputs");return "Ο κατάλογος καταστημάτων είναι αμετάβλητος";}
            for(int i=0;i<shops.length();i++){JSONObject shop=shops.getJSONObject(i);shop.put("id",StoreBillingStore.key("store",scope,shop.getString("sourceShopId")));s.put("setup:"+op+":"+String.format(Locale.US,"%05d",i),"setup",scope,"","",new JSONObject().put("runId",op).put("shop",shop),false);}
            j.put("catalogueHash",hash).put("catalogueCount",shops.length()).put("catalogueCursor",0).put("phase","catalogue");return "Έλεγχος καταλόγου · "+shops.length()+" καταστήματα";
        }
        if(phase.equals("catalogue")){
            int cursor=j.getInt("catalogueCursor");JSONArray candidates=s.staged(scope,"setup",op,cursor,25),batch=new JSONArray();int versions=0;
            for(int i=0;i<candidates.length();i++){JSONObject shop=candidates.getJSONObject(i).getJSONObject("shop");int count=shop.getJSONArray("sourceTerms").length();if(batch.length()>0&&(versions+count>100||batch.toString().length()+shop.toString().length()>55000))break;versions+=count;batch.put(shop);}
            if(batch.length()==0&&cursor<j.getInt("catalogueCount"))throw new Exception("Μεγάλη καταχώρηση όρων Ordexa. Απαιτείται έλεγχος χωρίς περικοπή.");
            boolean done=cursor+batch.length()==j.getInt("catalogueCount");JSONObject r=post(c,j,"catalogue",new JSONObject().put("stores",batch).put("complete",done).put("catalogueHash",j.getString("catalogueHash")));j.put("inputRevision",r.getLong("revision")).put("catalogueCursor",cursor+batch.length());if(done)j.put("phase","inputs");return "Αποθήκευση καταλόγου · "+(cursor+batch.length())+"/"+j.getInt("catalogueCount");
        }
        if(phase.equals("inputs")){
            JSONObject r=FleetHttp.getJson(j.getString("worker")+"/api/server/store-billing/inputs?"+query(j,j.getLong("inputCursor"),"terms"),SyncService.serverHeaders());JSONArray input=r.getJSONArray("rows");
            if(j.getInt("inputCount")+input.length()>20000)throw new Exception("Πολλές εκδόσεις όρων καταστημάτων. Χρειάζεται μικρότερο εύρος.");
            for(int i=0;i<input.length();i++){JSONObject row=input.getJSONObject(i);s.put("input:"+op+":"+row.getString("id"),"input_stage",scope,"","",new JSONObject().put("runId",op).put("record",row),false);}
            long nextCursor=r.getLong("nextCursor");if(r.optBoolean("hasMore")&&nextCursor<=j.getLong("inputCursor"))throw new Exception("Η λήψη όρων δεν προχώρησε.");j.put("inputCursor",nextCursor).put("inputCount",j.getInt("inputCount")+input.length());
            if(!r.optBoolean("hasMore")){s.activateInputs(scope,op);if(j.optBoolean("needsHydrate"))j.put("archiveCursor",0).put("phase","hydrate");else dayStart(j,j.getString("from"));}
            return "Λήψη ανεξάρτητων όρων Fleet · "+j.getInt("inputCount")+" εγγραφές";
        }
        if(phase.equals("hydrate")){
            JSONObject r=FleetHttp.getJson(j.getString("worker")+"/api/server/store-billing/inputs?"+query(j,j.getLong("archiveCursor"),"archive"),SyncService.serverHeaders());JSONArray records=r.getJSONArray("rows");
            for(int i=0;i<records.length();i++)s.importArchive(scope,records.getJSONObject(i));long cursor=r.getLong("nextCursor");if(r.optBoolean("hasMore")&&cursor<=j.getLong("archiveCursor"))throw new Exception("Το αρχείο καταστημάτων δεν προχώρησε.");j.put("archiveCursor",cursor);
            if(!r.optBoolean("hasMore")){s.put(StoreBillingStore.key("authority",scope,"ledger"),"authority",scope,"","",new JSONObject().put("complete",true),false);j.put("hydrated",true);if(j.getString("type").equals("reprice"))j.put("type","sync");dayStart(j,j.getString("from"));}return "Ανάκτηση διατηρημένου αρχείου Fleet · "+cursor;
        }
        if(phase.equals("orders")){
            JSONArray shops=stores(s,j);if(shops.length()==0){j.put("phase","archive");j.put("finalPass",pass(j));return "Δεν υπάρχουν καταστήματα στην πηγή";}
            String selected=j.getString("mode").equals("filtered")?shops.getJSONObject(j.getInt("shopIndex")).getString("sourceShopId"):null;
            String day=j.getString("day");int page=j.getInt("page");JSONObject r=StoreBillingProtocol.page(OrdexaSync.storesRead(c,j,false,StoreBillingEngine.addDay(day,-1),StoreBillingEngine.addDay(day,1),page,selected),page,selected,known(shops));
            if(r.getBoolean("needsShopFilter")){j.put("mode","filtered").put("shopIndex",0).put("page",1);return "Ασφαλής αντιστοίχιση με ταυτότητα καταστήματος";}
            if(page==1)j.put("pageTotal",r.getInt("total")).put("pagePages",r.getInt("pages")).put("pageRows",0);
            if(r.getInt("total")!=j.getInt("pageTotal")||r.getInt("pages")!=j.getInt("pagePages"))throw new Exception("Η σελιδοποίηση Ordexa άλλαξε. Η λήψη παραμένει μη πλήρης· επανάλαβε.");
            JSONArray sourceRows=r.getJSONArray("rows");String pass=pass(j);
            s.stagePage(scope,pass,day,(selected==null?"city":selected)+":"+page,sourceRows,j.getLong("cutoffAt"));
            j.put("pageRows",j.getInt("pageRows")+sourceRows.length());
            if(page==r.getInt("pages")&&j.getInt("pageRows")!=j.getInt("pageTotal"))throw new Exception("Η πλήρης λήψη Ordexa δεν συμφωνεί με το πλήθος παραγγελιών. Δεν εφαρμόστηκε διαγραφή.");
            if(page<r.getInt("pages")){j.put("page",page+1);return "Ανάγνωση Ordexa · "+day+" · σελίδα "+page+"/"+r.getInt("pages");}
            if(selected!=null&&j.getInt("shopIndex")+1<shops.length()){j.put("shopIndex",j.getInt("shopIndex")+1).put("page",1);return "Έλεγχος καταστημάτων · "+day+" · "+j.getInt("shopIndex")+"/"+shops.length();}
            String digest=s.passDigest(scope,pass);if(j.getInt("pass")==1){j.put("firstDigest",digest).put("pass",2).put("page",1).put("shopIndex",0);return "Επαλήθευση πλήρους λήψης · "+day;}
            if(!digest.equals(j.getString("firstDigest")))throw new Exception("Οι παραγγελίες άλλαξαν κατά τη λήψη. Δεν εφαρμόστηκε διαγραφή ή πλήρες νέο σύνολο· επανάλαβε.");
            j.put("finalPass",pass).put("acceptCursor",0).put("phase","accept");return "Επαληθεύτηκαν δύο πλήρεις λήψεις · "+day;
        }
        if(phase.equals("accept")){
            int cursor=j.getInt("acceptCursor");JSONArray seen=s.staged(scope,"seen",j.getString("finalPass"),cursor,50);s.observePage(scope,seen,j.getString("finalPass"));j.put("acceptCursor",cursor+seen.length());
            if(seen.length()<50){JSONArray shops=stores(s,j);JSONObject retain=new JSONObject();for(int i=0;i<shops.length();i++){JSONObject shop=shops.getJSONObject(i);retain.put(shop.getString("id"),shop.optBoolean("retainOrders",false));}
                int removed=s.reconcile(scope,j.getString("day"),j.getString("finalPass"),retain);j.put("removalCount",removed).put("phase","archive");}
            return "Αρχειοθέτηση επαληθευμένων παραγγελιών · "+(cursor+seen.length());
        }
        if(phase.equals("archive")){
j.put("stageCursor",0).put("phase","stage");return "Αποθηκεύτηκε το αρχείο · προετοιμασία χρεώσεων";
        }
        if(phase.equals("reprice")){
            JSONObject coverage=s.get(StoreBillingStore.key("coverage",scope,j.getString("day")));if(coverage==null){j.put("phase","next");return "Δεν έχει ληφθεί ακόμη η ημέρα "+j.getString("day")+" · δεν δημιουργήθηκε εικονικό μηδέν";}
            if(coverage.optBoolean("needsSourceRefresh",false)){j.put("phase","orders");return "Επαλήθευση πηγής μετά την επαναφορά backup · "+j.getString("day");}
            JSONObject retain=new JSONObject();JSONArray shops=stores(s,j);for(int i=0;i<shops.length();i++){JSONObject shop=shops.getJSONObject(i);retain.put(shop.getString("id"),shop.optBoolean("retainOrders",false));}
            int removed=s.reconcile(scope,j.getString("day"),coverage.getString("runId"),retain);
            j.put("sourceAt",coverage.getString("sourceAt")).put("finalPass",coverage.getString("runId")).put("removalCount",removed).put("stageCursor",0).put("phase","stage");return "Επανυπολογισμός αποθηκευμένων στοιχείων χωρίς νέα λήψη Ordexa";
        }
        if(phase.equals("stage")){
            JSONArray shops=stores(s,j),terms=s.rows(scope,"terms"),output=new JSONArray();int cursor=j.getInt("stageCursor"),end=Math.min(shops.length(),cursor+32);String day=j.getString("day");
            for(int i=cursor;i<end;i++){
                JSONObject shop=shops.getJSONObject(i);String id=shop.getString("id");JSONArray own=new JSONArray();for(int n=0;n<terms.length();n++)if(id.equals(terms.getJSONObject(n).getString("storeId")))own.put(terms.getJSONObject(n));
                JSONObject counts=s.counts(scope,day,id,j.getString("finalPass")),row=StoreBillingEngine.day(id,day,counts.getLong("count"),StoreBillingEngine.termsFor(own,day),j.getString("sourceAt"),counts.getInt("retained"),counts.getInt("reviews"));row.put("storeRevision",shop.getLong("revision")).put("retentionUsed",shop.optBoolean("retainOrders",false));output.put(row);
            }
            for(int i=0;i<output.length();i++){JSONObject row=output.getJSONObject(i);s.put("computed:"+j.getString("runId")+":"+row.getString("storeId"),"computed",scope,row.getString("storeId"),day,row,false);}
            j.put("stageCursor",end).put("resultCount",shops.length());if(end==shops.length())j.put("phase","localCommit");return "Τοπικός υπολογισμός χρεώσεων · "+day+" · "+end+"/"+shops.length();
        }
        if(phase.equals("localCommit")){
            s.completeDay(j);j.put("phase","next");return "Η ημέρα "+j.getString("day")+" αποθηκεύτηκε στη SQLite · αναμονή cloud";
        }
        if(phase.equals("next")){
            if(j.getString("day").compareTo(j.getString("to"))<0){dayStart(j,StoreBillingEngine.addDay(j.getString("day"),1));return "Επόμενη ημέρα · "+j.getString("day");}
            progress(c,j,"Η εισαγωγή ολοκληρώθηκε τοπικά · εκκρεμεί δημοσίευση συγκεντρωτικών","completed");j.put("phase","done");s.cleanupTemporary(scope);return "Ολοκληρώθηκε ο συγχρονισμός καταστημάτων";
        }
        throw new Exception("Άγνωστο στάδιο καταστημάτων· επανάλαβε τη διαδικασία.");
    }
    private static boolean flush(Context c,StoreBillingStore s)throws Exception{
        JSONObject source=OrdexaSync.storesContext(c);if(!source.optBoolean("configured"))return false;
        JSONArray queue=s.rows(source.getString("scope"),"outbox");
        // Bounded daily pages, immutable snapshots and byte-matched ACK.
        if(queue.length()==0)return false;JSONObject job=queue.getJSONObject(0);
        if(!job.has("epoch")||!source.getString("generation").equals(job.optString("generation"))) {FleetHttp.getJson(source.getString("worker")+"/api/server/connection-check",SyncService.serverHeaders());s.invalidateAck(job.getString("scope"),job.getString("day"));wakeForRefresh(s,job);return false;}same(c,job);
        JSONArray all=s.snapshotRows(job.getString("scope"),job.getString("runId")),changed=new JSONArray();
        for(int i=0;i<all.length();i++){JSONObject row=all.getJSONObject(i),ack=s.get(StoreBillingStore.key("aggregate-ack",job.getString("scope"),row.getString("businessDay")+":"+row.getString("storeId")));if(ack==null||!ack.optString("hash").equals(StoreBillingStore.resultHash(row)))changed.put(row);}
        JSONObject base=new JSONObject(job.toString());base.remove("worker");base.put("protocol",2).put("count",all.length()).put("changedCount",changed.length());
        try{
            for(int offset=0;offset<changed.length();offset+=32){JSONArray page=new JSONArray();for(int i=offset;i<Math.min(offset+32,changed.length());i++)page.put(changed.getJSONObject(i));JSONObject body=new JSONObject(base.toString()).put("rows",page);JSONObject r=FleetHttp.sendJson(job.getString("worker")+"/api/server/store-billing/aggregate-stage","POST",body,SyncService.serverHeaders());if(!r.optBoolean("saved"))throw new Exception("Aggregate stage unconfirmed");}
            JSONObject r=FleetHttp.sendJson(job.getString("worker")+"/api/server/store-billing/aggregate-publish","POST",base,SyncService.serverHeaders());if(!r.optBoolean("saved"))throw new Exception("Aggregate publish unconfirmed");s.ackDay(job,all);return true;
        }catch(FleetHttp.HttpStatusException conflict){if(conflict.statusCode==409){s.invalidateAck(job.getString("scope"),job.getString("day"));wakeForRefresh(s,job);}throw conflict;}
    }
    private static void wakeForRefresh(StoreBillingStore s,JSONObject job)throws Exception{JSONObject m=state(s);m.put("historyPending",job.getString("day")).put("wake",true).put("nextDue",0);save(s,m);}
    public static void tick(Context c,FleetDataStore fleet){
        long time=System.currentTimeMillis();if(time<next||!running.compareAndSet(false,true))return;
        StoreBillingStore s=null;JSONObject m=null,j=null;boolean tracked=false;
        try{
            if(OtaManager.shouldYieldForUpdate(c)){next=time+5000;return;}
            s=new StoreBillingStore(fleet);m=state(s);
            if(time>=publishNext){publishNext=time+300000;try{long deadline=System.currentTimeMillis()+5000;for(int days=0;days<32&&System.currentTimeMillis()<deadline;days++)if(!flush(c,s))break;m=state(s);m.remove("cloudError");}catch(Exception cloud){m=state(s);m.put("cloudError","Εκκρεμεί δημοσίευση συγκεντρωτικών · ασφαλής επανάληψη");}save(s,m);}JSONObject source=OrdexaSync.storesContext(c);j=m.optJSONObject("job");
            JSONObject signal=s.get("meta:store-billing-wake");long wakeAt=signal==null?0:signal.optLong("at",0);if(wakeAt>m.optLong("lastWakeHandled",0))m.put("wake",true).put("nextDue",0);
            if(!source.getBoolean("configured")||j==null&&!m.optBoolean("wake")&&(!source.getBoolean("enabled")||time<m.optLong("nextDue",0))){next=time+10000;return;}
            if(j!=null&&(!j.getString("scope").equals(source.getString("scope"))||!j.getString("generation").equals(source.getString("generation")))){m.remove("job");j=null;}
            if(!ServerWorkTracker.begin(c,"stores","Καταστήματα Ordexa","Μικρή παρτίδα συγχρονισμού")){next=time+5000;return;}tracked=true;
            if(j==null){if(!m.optBoolean("wake")&&m.optString("historyPending","").length()==0)m.put("autoCycle",true);start(c,s,m,source);m.put("lastWakeHandled",wakeAt);if(!m.has("job")){save(s,m);next=time+100;return;}j=m.getJSONObject("job");}else{
                String stage=step(c,s,j);m.put("stage",stage).put("error","");ServerWorkTracker.stage("stores","Καταστήματα Ordexa",stage);
                if(j.optBoolean("hydrated"))m.put("archiveEpoch",j.getString("scope")+":"+j.getString("epoch")+":"+j.getString("generation"));
                if(j.getString("phase").equals("done")){
                    m.remove("job");if(m.optString("cloudError","").isEmpty())publishNext=Math.min(publishNext,time+1000);m.put("lastSuccess",OrdexaClient.isoNow()).put("nextDue",time+3600000).put("failures",0).put("error","").put("wake",j.optBoolean("hasPending"));
                    if(m.optString("historyPending","").equals(j.getString("from"))&&j.getString("from").equals(j.getString("to")))m.remove("historyPending");
                    if(m.optBoolean("autoCycle")&&source.getBoolean("enabled")){
                        String previous=StoreBillingEngine.addDay(StoreBillingEngine.businessDay(time),-1),old=s.oldestCoverage(j.getString("scope"),previous);if(old.length()>0)m.put("historyPending",old).put("wake",true);m.put("autoCycle",false);
                    }
                    if(m.has("localRequest")||m.optBoolean("wake")||m.optString("historyPending","").length()>0)m.put("wake",true).put("nextDue",0);
                }
                else if(time-j.optLong("lastProgress",0)>300000)progress(c,j,stage,"running");
            }
            save(s,m);next=time+100;
        }catch(Exception e){
            try{String message=e.getMessage()==null?"Η λήψη καταστημάτων απέτυχε.":e.getMessage();
                if(message.contains("ήδη ενέργεια Ordexa")){if(m!=null){m.put("stage","Αναμονή ολοκλήρωσης της ανάγνωσης βαρδιών Ordexa");save(s,m);}next=time+2000;return;}
                String safe=(message.contains("Ordexa")||message.contains("καταστημ")||message.contains("παραγγελί")||message.contains("όρο")||message.contains("Οι "))?message.substring(0,Math.min(300,message.length())):"Δεν ολοκληρώθηκε η επικοινωνία καταστημάτων. Τα προηγούμενα αποτελέσματα διατηρούνται· δοκίμασε Ανανέωση.";
                if(m!=null){int failures=m.optInt("failures",0)+1;m.put("failures",failures).put("error",safe).put("stage",safe).put("nextDue",time+Math.min(3600000L,60000L*(1L<<Math.min(5,failures-1))));
                    boolean definite=e instanceof FleetHttp.HttpStatusException&&((FleetHttp.HttpStatusException)e).statusCode>=400&&((FleetHttp.HttpStatusException)e).statusCode<500&&((FleetHttp.HttpStatusException)e).statusCode!=408&&((FleetHttp.HttpStatusException)e).statusCode!=429;
                    boolean uncertainPublish=j!=null&&"publish".equals(j.optString("phase"))&&!definite&&!message.contains("άδεια εργασίας")&&!message.contains("άλλαξ");
                    if(!uncertainPublish){if(j!=null){try{same(c,j);if("sync".equals(j.getString("type"))&&Arrays.asList("catalogue","inputs","hydrate").contains(j.optString("phase")))m.put("localRequest",new JSONObject().put("from",j.getString("from")).put("to",j.getString("to")));}catch(Exception ignored){}try{progress(c,j,safe,"failed");}catch(Exception ignored){}}m.remove("job");}
                    save(s,m);next=m.getLong("nextDue");}
            }catch(Exception ignored){next=time+60000;}
        }finally{if(tracked)ServerWorkTracker.finish("stores");running.set(false);}
    }
}
