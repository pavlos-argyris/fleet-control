package gr.argyrismitsos.fleetserver;

import android.content.*;
import org.json.*;
import java.io.*;
import java.net.URLEncoder;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Explicit owner-requested handover. Original SQLite/files and old D1 remain.
 * Every retry uses the same frozen snapshot, target, row hashes and certificate. */
public final class CloudReturnController {
    private static final AtomicBoolean running=new AtomicBoolean();
    private static volatile boolean cancelled;
    private static final String STATUS="cloud_return_status";
    private CloudReturnController(){}
    private static SharedPreferences prefs(Context c){return c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);}
    private static Map<String,String> headers(JSONObject identity)throws Exception{Map<String,String> h=new HashMap<String,String>();h.put("X-Fleet-Server-Key",ServerConfig.SERVER_KEY);h.put("X-Fleet-Primary-Ticket",identity.getString("migrationTicket"));return h;}
    private static JSONObject post(JSONObject identity,String action,JSONObject body)throws Exception{return FleetHttp.sendJson(identity.getString("realm")+"/api/primary/cloud-return/"+action,"POST",body,headers(identity));}
    private static JSONObject body(JSONObject identity,JSONObject saved)throws Exception{return new JSONObject().put("generation",identity.getString("generation")).put("transferId",saved.getString("transferId")).put("inventoryHash",saved.getString("inventoryHash"));}
    private static void stage(Context c,String text)throws Exception{if(cancelled||Thread.currentThread().isInterrupted()||OtaManager.shouldYieldForUpdate(c))throw new InterruptedIOException("Η επιστροφή σταμάτησε σε ασφαλές σημείο. Πάτησε Συνέχεια επιστροφής.");prefs(c).edit().putString(STATUS,new JSONObject().put("stage",text).toString()).apply();ServerWorkTracker.stage("action:cloudReturn","Επιστροφή στο Cloudflare",text);}
    public static void cancel(){cancelled=true;}
    public static JSONObject status(Context c)throws Exception{JSONObject s=new JSONObject(prefs(c).getString(STATUS,"{}"));try(FleetDataStore store=new FleetDataStore(c)){s.put("phase",NativePrimaryState.read(store.getReadableDatabase()).optString("phase","cloud"));}return s.put("busy",running.get()).put("portableBackupEnabled",BackupProtection.state(c).optBoolean("enabled"));}
    public static JSONObject migrate(final Context c)throws Exception{
        if(!running.compareAndSet(false,true))throw new IOException("Εκτελείται ήδη επιστροφή στο Cloudflare.");cancelled=false;boolean locked=false;
        try(final FleetDataStore store=new FleetDataStore(c)){
            NativeWorkGate.exclusive(new NativeWorkGate.Check(){public void check()throws Exception{stage(c,"Αναμονή ολοκλήρωσης τρεχουσών εργασιών");}});locked=true;
            JSONObject identity=NativeIdentity.read(c);if(identity.length()==0||!identity.has("migrationTicket"))throw new IOException("Λείπει η προστατευμένη άδεια της ενεργής κύριας βάσης.");
            String phase=NativePrimaryState.read(store.getReadableDatabase()).optString("phase");if(phase.equals("cloud_remote"))return new JSONObject().put("active",true);
            if(!Arrays.asList("active","cloud_return").contains(phase))throw new IOException("Η κύρια βάση δεν επιτρέπει επιστροφή από αυτή την κατάσταση.");
            if(!BackupProtection.state(c).optBoolean("enabled"))throw new IOException("Χρειάζεται ο ήδη ρυθμισμένος φορητός κωδικός backup πριν από την επιστροφή.");
            JSONObject saved=identity.optJSONObject("cloudReturn");if(saved==null){saved=new JSONObject().put("transferId",UUID.randomUUID().toString());identity.put("cloudReturn",saved);NativeIdentity.save(c,identity);}
            NativePrimaryService.get(c).freezeForCloudReturn(saved.getString("transferId"));
            if(saved.has("inventoryHash")){
                JSONObject remote=post(identity,"status",body(identity,saved));if(remote.optBoolean("active"))return finishLocal(c,store,identity,saved,remote);
            }
            stage(c,"Πλήρες φορητό backup και δοκιμή ανάκτησης πριν από την επιστροφή");
            JSONObject backup=null;try{if(saved.has("backupJobId"))backup=BackupJobs.load(c,saved.getString("backupJobId"));}catch(Exception missing){}
            if(backup==null||!BackupJobs.localReady(c,backup)||(backup.optJSONObject("nativeProof")==null||!backup.optJSONObject("nativeProof").optBoolean("restoreVerified"))){backup=BackupJobs.createLocalAutomatic(c,store);saved.put("backupJobId",backup.getString("id"));NativeIdentity.save(c,identity);}
            JSONObject proof=backup.optJSONObject("nativeProof");if(!backup.optBoolean("localReady")||proof==null||!proof.optBoolean("restoreVerified")||!proof.optBoolean("documentsVerified"))throw new IOException("Δεν επαληθεύτηκε πλήρες backup και πραγματική ανάκτηση.");
            final CloudReturnSnapshot.Progress progress=new CloudReturnSnapshot.Progress(){public void stage(String table,long count,long total)throws Exception{CloudReturnController.stage(c,"Απογραφή και σύγκριση "+table+" · "+count+" / "+total);}};
            stage(c,"Απογραφή όλων των δεδομένων και ιδιωτικών αρχείων");
            if(!saved.has("inventoryHash")){String json=CloudReturnSnapshot.manifest(store.getReadableDatabase(),identity,progress).toString();saved.put("inventoryJson",json).put("inventoryHash",BusinessRuntime.sha256(json.getBytes("UTF-8")));saved.put("certificate",PrimaryCipher.cloudReturnCertificate(identity,saved.getString("transferId"),saved.getString("inventoryHash")));NativeIdentity.save(c,identity);}
            JSONObject manifest=new JSONObject(saved.getString("inventoryJson"));
            JSONObject init=body(identity,saved).put("schema",1).put("inventoryJson",saved.getString("inventoryJson")).put("ownerId",identity.getString("ownerId")).put("authPepper",identity.getString("authPepper")).put("eventSigningKey",identity.getString("eventSigningKey")).put("context",NativePrimaryService.get(c).cloudSourceContext()).put("backup",new JSONObject().put("restoreVerified",true).put("databaseSha256",proof.getString("databaseSha256"))).put("certificate",saved.getJSONObject("certificate"));
            JSONObject remote=post(identity,"init",init);Map<String,JSONObject> checkpoints=new HashMap<String,JSONObject>();JSONArray points=remote.getJSONArray("tables");for(int i=0;i<points.length();i++)checkpoints.put(points.getJSONObject(i).getString("name"),points.getJSONObject(i));
            JSONArray tables=manifest.getJSONArray("tables");
            if(!remote.optBoolean("prepared"))for(int i=0;i<tables.length();i++){
                JSONObject t=tables.getJSONObject(i),point=checkpoints.get(t.getString("name"));String after=point==null||point.isNull("last_row")?null:point.getString("last_row");long sent=point==null?0:point.getLong("count");
                while(sent<t.getLong("rows")){
                    stage(c,"Μεταφορά "+(i+1)+" / "+tables.length()+" · "+t.getString("name")+" · "+sent+" / "+t.getLong("rows"));JSONArray rows=new JSONArray();int bytes=0;
                    for(int j=0;j<64;j++){JSONObject row=CloudReturnSnapshot.next(store.getReadableDatabase(),t,after);if(row==null)break;int size=row.toString().getBytes("UTF-8").length;if(rows.length()>0&&bytes+size>512*1024)break;if(size>11*1024*1024)throw new IOException("Μία εγγραφή υπερβαίνει το ασφαλές όριο μεταφοράς. Τα αρχικά δεδομένα διατηρούνται.");rows.put(row);bytes+=size;after=row.getString("rowid");}
                    if(rows.length()==0)throw new IOException("Άλλαξε το πλήθος εγγραφών της παγωμένης βάσης.");JSONObject reply=post(identity,"rows",body(identity,saved).put("table",t.getString("name")).put("rows",rows));sent=reply.getLong("count");
                }
            }
            String after=null;long fileCount=0;for(;;){JSONObject object=CloudReturnSnapshot.nextObject(store.getReadableDatabase(),after);if(object==null)break;stage(c,"Μεταφορά και έλεγχος ιδιωτικών αρχείων · "+(++fileCount)+" / "+manifest.getJSONObject("objects").getLong("count"));String name=object.getString("localName");if(!BusinessObjects.validLocalName(name))throw new IOException("Μη έγκυρο ιδιωτικό αρχείο.");File file=new File(new File(c.getFilesDir(),"service-documents"),name);if(!file.isFile()||file.length()!=object.getLong("size")||!NativeDatabaseSnapshot.digest(file).equals(object.getString("sha256")))throw new IOException("Το ιδιωτικό αρχείο δεν συμφωνεί με το πλήρες backup.");
                String address=identity.getString("realm")+"/api/primary/cloud-return/object-bytes?key="+URLEncoder.encode(object.getString("key"),"UTF-8")+"&sha256="+object.getString("sha256")+"&size="+object.getLong("size");if(!FleetHttp.getJson(address,headers(identity)).optBoolean("stored"))try(InputStream input=new BufferedInputStream(new FileInputStream(file))){FleetHttp.putStream(address,input,file.length(),"application/octet-stream",headers(identity));}
                after=object.getString("key");object.remove("localName");post(identity,"object",body(identity,saved).put("object",object));
            }
            stage(c,"Τελική αντιπαραβολή της αρχικής βάσης");JSONObject finalManifest=CloudReturnSnapshot.manifest(store.getReadableDatabase(),identity,progress);if(!NativeMigrationCoordinator.canonical(manifest).equals(NativeMigrationCoordinator.canonical(finalManifest)))throw new IOException("Άλλαξε η πηγή μετά το backup. Η νέα βάση δεν ενεργοποιήθηκε.");
            post(identity,"prepare",body(identity,saved));stage(c,"Έλεγχος λειτουργίας και ενεργοποίηση Cloudflare");JSONObject activated;
            do{activated=post(identity,"finish",body(identity,saved));if(activated.optBoolean("waiting"))Thread.sleep(Math.min(1000,Math.max(10,activated.optLong("notBefore")-System.currentTimeMillis())));stage(c,"Επιβεβαίωση μοναδικής κύριας βάσης Cloudflare");}while(activated.optBoolean("waiting"));
            return finishLocal(c,store,identity,saved,activated);
        }catch(Exception error){prefs(c).edit().putString(STATUS,new JSONObject().put("stage","Η επιστροφή χρειάζεται συνέχεια").put("error","Η επιστροφή δεν ολοκληρώθηκε. Τα δεδομένα και το backup διατηρούνται. Επανάλαβε Συνέχεια επιστροφής.").toString()).commit();throw new IOException("Η επιστροφή χρειάζεται συνέχεια. Τα δεδομένα και το ελεγμένο backup διατηρούνται.",error);}
        finally{if(locked)NativeWorkGate.release();running.set(false);}
    }
    private static JSONObject finishLocal(Context c,FleetDataStore store,JSONObject identity,JSONObject saved,JSONObject remote)throws Exception{
        JSONObject cert=remote.optJSONObject("cloudReturn");if(!remote.optBoolean("active")||!saved.getString("transferId").equals(remote.optString("cloudBusiness"))||cert==null||!NativeMigrationCoordinator.canonical(cert).equals(NativeMigrationCoordinator.canonical(saved.getJSONObject("certificate"))))throw new IOException("Δεν επιβεβαιώθηκε η υπογεγραμμένη επιστροφή.");
        store.getWritableDatabase().beginTransaction();try{NativePrimaryState.phase(store.getWritableDatabase(),"cloud_remote",identity.getString("realm"),identity.getString("generation"),identity.getString("ownerId"),saved.getString("inventoryHash"));CloudSourceSync.install(store.getWritableDatabase());store.getWritableDatabase().setTransactionSuccessful();}finally{store.getWritableDatabase().endTransaction();}
        NativePrimaryService.get(c).pause();prefs(c).edit().putString(STATUS,new JSONObject().put("phase","cloud_remote").put("stage","Η κύρια βάση λειτουργεί στο Cloudflare. Τα αρχικά δεδομένα του κινητού διατηρούνται.").toString()).commit();return new JSONObject().put("active",true);
    }
}
