package gr.argyrismitsos.fleetserver;

import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import org.json.*;
import java.io.*;
import java.nio.charset.Charset;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Separates a durable local checkpoint from a potentially slow folder provider. */
public final class BackupJobs {
    private static final AtomicBoolean preparing=new AtomicBoolean(false);
    private static final ExecutorService preparation=Executors.newSingleThreadExecutor();
    // A folder provider may remain busy for minutes. Waiting for its ACK must
    // never occupy the executor which creates the pre-update local checkpoint.
    private static final ExecutorService pendingExports=Executors.newSingleThreadExecutor();
    private static final AtomicBoolean resuming=new AtomicBoolean(false);
    private static final ThreadPoolExecutor exports=new ThreadPoolExecutor(0,2,60,TimeUnit.SECONDS,new SynchronousQueue<Runnable>());
    private static final ScheduledExecutorService watchdog=Executors.newSingleThreadScheduledExecutor();
    private static final Map<String,Transfer> active=new HashMap<String,Transfer>();
    private static final long IDLE_TIMEOUT_MS=90000;
    private static final AtomicBoolean recovered=new AtomicBoolean(false);
    public static void recoverAfterRestart(Context c){if(!recovered.compareAndSet(false,true))return;JSONObject old=BackupStatus.get(c);if(BackupStatus.active(c))BackupStatus.failure(c,old.optString("id"),"Η προηγούμενη διαδικασία διακόπηκε από επανεκκίνηση. Το τελευταίο ολοκληρωμένο backup διατηρείται. Αν υπάρχει τοπικό αντίγραφο, η αποστολή θα επαναληφθεί.",false);}
    private static final String LAST_JOB="backup_checkpoint_job",PAUSED="backup_export_paused_for_update";
    private static final String FLEET_MIGRATION_JOB="fleet_cloud_migration_baseline_job";
    private static final String AUTO_DAY = "backup_automatic_slot_day", AUTO_JOB = "backup_automatic_slot_job";
    private static final long[] AUTO_DELAYS = { 5 * 60000L, 60 * 60000L };
    private BackupJobs(){}
    private static File root(Context c){File f=new File(c.getFilesDir(),"safe-backups");f.mkdirs();return f;}
    private static File journal(Context c,String id){if(!id.matches("[a-f0-9-]{36}"))throw new IllegalArgumentException("Μη έγκυρο αντίγραφο.");return new File(root(c),id+".json");}
    static JSONObject load(Context c,String id)throws Exception{return ServiceDocumentArchive.readJson(journal(c,id));}
    private static synchronized void save(Context c,JSONObject job)throws Exception{ServiceDocumentArchive.atomicJson(journal(c,job.getString("id")),job);}
    private static SharedPreferences prefs(Context c){return c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);}
    private static synchronized String stamp(Context c){long value=Math.max(System.currentTimeMillis()/1000,prefs(c).getLong("backup_name_second",0)+1);prefs(c).edit().putLong("backup_name_second",value).commit();return new SimpleDateFormat("yyyyMMdd_HHmmss",Locale.US).format(new Date(value*1000));}
    public static Set<String> pendingStamps(Context c){Set<String> values=new HashSet<String>();File[] files=root(c).listFiles();if(files!=null)for(File f:files)if(f.getName().matches("[a-f0-9-]{36}\\.json"))try{JSONObject job=ServiceDocumentArchive.readJson(f);if(!job.optBoolean("exported")){String name=job.optString("fileName");if(name.startsWith("FleetControl_backup_")&&name.endsWith(".fcbackup"))values.add(name.substring(20,name.length()-9));}}catch(Exception ignored){}return values;}
    private static synchronized void cleanupLocal(Context c){
        File[] files=root(c).listFiles();if(files==null)return;Arrays.sort(files,new Comparator<File>(){public int compare(File a,File b){return Long.compare(b.lastModified(),a.lastModified());}});
        Set<String> references=new HashSet<String>();List<JSONObject> discarded=new ArrayList<JSONObject>();int retained=0,localRetained=0;
        String fleetBaseline=prefs(c).getString(FLEET_MIGRATION_JOB,"");
        for (File file : files) {
            if (!file.getName().matches("[a-f0-9-]{36}\\.json")) continue;
            try {
                JSONObject job=ServiceDocumentArchive.readJson(file);
                boolean exported=job.optBoolean("exported");
                boolean pinned=!fleetBaseline.isEmpty()&&fleetBaseline.equals(job.optString("id"));
                boolean keep=pinned || (job.optBoolean("localOnly")&&!exported ? localRetained++<2 : !exported||retained++<2);
                if (keep) {
                    references.add(job.optString("dataPath"));
                    references.add(job.optString("docsPath"));
                    references.add(job.optString("databasePath"));
                } else discarded.add(job);
            } catch (Exception ignored) { }
        }
        for(JSONObject j:discarded)try{for(String k:new String[]{"dataPath","docsPath","databasePath"}){String name=j.optString(k);if(name.length()>0&&!references.contains(name)){File f=local(c,name);f.delete();new File(f.getPath()+".json").delete();}}journal(c,j.getString("id")).delete();}catch(Exception ignored){}
        // Only disposable files inside safe-backups; never service originals.
        for(File f:files){String name=f.getName();if(f.isFile()&&(name.endsWith(".part")||((name.endsWith(".fcbackup")||name.endsWith(".fcdocs")||name.endsWith(".fcdb"))&&!references.contains(name)))){f.delete();new File(f.getPath()+".json").delete();}}
    }
    public static String createAndExport(Context c,FleetDataStore store)throws Exception{
        if(prefs(c).getBoolean(PAUSED,false))throw new IOException("Η αποστολή backup έχει παύσει για την ενημέρωση. Το τοπικό αντίγραφο διατηρείται.");
        if(BackupStatus.active(c))throw new IOException("Υπάρχει ήδη backup σε εξέλιξη. Δες το στάδιο και την πρόοδο παρακάτω.");
        JSONObject job=prepare(c,store,"manual","");Transfer transfer=export(c,job);transfer.await();return job.getString("fileName");
    }
    static JSONObject scheduled(Context c, FleetDataStore store, String today, boolean completedToday) throws Exception {
        SharedPreferences preferences = prefs(c);
        if (preferences.getBoolean(PAUSED, false) || !preparing.compareAndSet(false, true)) return null;
        try {
            String reservedDay = preferences.getString(AUTO_DAY, "");
            String reservedJob = preferences.getString(AUTO_JOB, "");
            if (!reservedJob.isEmpty() && journal(c, reservedJob).isFile()) {
                JSONObject previous = load(c, reservedJob);
                if (previous.optBoolean("localReady") && !previous.optBoolean("exported") && !previous.optBoolean("localOnly")) {
                    if (!previous.optString("targetFolder").isEmpty()) {
                        // A failing destination must not cause another large local checkpoint every day.
                        scheduleExport(c, previous);
                        return null;
                    }
                    JSONObject local = keepLocal(c, previous);
                    if (today.equals(reservedDay)) return local;
                }
            }
            if (completedToday || today.compareTo(reservedDay) <= 0) return null;

            String id = UUID.randomUUID().toString();
            if (!preferences.edit().putString(AUTO_DAY, today).putString(AUTO_JOB, id).commit()) {
                throw new IOException("Δεν αποθηκεύτηκε η προγραμματισμένη εργασία backup.");
            }
            JSONObject job = prepareLocked(c, store, "automatic", "", null, id);
            if (job.optString("targetFolder").isEmpty()) return keepLocal(c, job);
            scheduleExport(c, job);
            return null;
        } finally {
            preparing.set(false);
        }
    }

    private static void scheduleExport(Context c, JSONObject job) throws Exception {
        int attempts = job.optInt("automaticExportAttempts");
        long now = System.currentTimeMillis();
        if (attempts > AUTO_DELAYS.length || now < job.optLong("nextAutomaticExportAt")) return;
        if (!job.optString("targetFolder").equals(prefs(c).getString(BackupManager.KEY_FOLDER_URI, ""))) return;
        synchronized (active) {
            if (active.containsKey(job.getString("id"))) return;
        }
        if (!localReady(c, job)) return;
        long next = attempts < AUTO_DELAYS.length ? now + AUTO_DELAYS[attempts] : Long.MAX_VALUE;
        job.put("automaticExportAttempts", attempts + 1).put("nextAutomaticExportAt", next);
        export(c, job);
    }

    public static JSONObject createLocalAutomatic(Context c, FleetDataStore store) throws Exception {
        return keepLocal(c, prepare(c, store, "automatic", ""));
    }

    /** A single private, restart-safe baseline for a verified Fleet migration target. */
    public static JSONObject fleetMigrationBaseline(Context c, FleetDataStore store, String id) throws Exception {
        File entry = journal(c,id);
        if (prefs(c).getBoolean(PAUSED,false) || BackupStatus.active(c) || !preparing.compareAndSet(false,true)) return null;
        try {
            if (!prefs(c).edit().putString(FLEET_MIGRATION_JOB,id).commit()) throw new IOException("Δεν καταγράφηκε η εργασία backup Fleet.");
            JSONObject job=entry.isFile()?load(c,id):prepareLocked(c,store,"fleet-cloud-baseline","",null,id);
            if (!"fleet-cloud-baseline".equals(job.optString("kind"))) throw new IOException("Μη έγκυρο σημείο επανεκκίνησης backup Fleet.");
            JSONObject proof=job.optJSONObject("nativeProof");
            if (job.optLong("databaseBytes")<=0 || proof==null || !proof.optBoolean("restoreVerified") ||
                    !proof.optBoolean("documentsVerified") || job.optInt("missingDocuments")!=0 || !localReady(c,job)) {
                throw new IOException("Δεν επιβεβαιώθηκε το πλήρες backup Fleet και η απομονωμένη ανάκτησή του.");
            }
            if (!job.optBoolean("localOnly")) keepLocal(c,job);
            return new JSONObject().put("id",id).put("verifiedAt",System.currentTimeMillis())
                    .put("databaseSha256",proof.getString("databaseSha256"));
        } finally { preparing.set(false); }
    }

    private static JSONObject keepLocal(Context c, JSONObject job) throws Exception {
        if (!localReady(c, job)) throw new IOException("Το τοπικό backup δεν επαληθεύτηκε.");
        job.put("localOnly", true);
        save(c, job);
        BackupStatus.progress(c, job.getString("id"), "local_ready",
                "Το κρυπτογραφημένο τοπικό backup επαληθεύτηκε · αναμονή επιλογής φακέλου", 70,
                job.optInt("includedDocuments"), job.optInt("expectedDocuments"), 0, 0, job.getString("fileName"));
        return job;
    }
    public static boolean isPreparing(){return preparing.get();}
    public static String lastJob(Context c){return prefs(c).getString(LAST_JOB,"");}
    private static boolean currentUpdate(Context c,String epoch,String release){
        SharedPreferences p=prefs(c);
        if(epoch.length()==0||!epoch.equals(p.getString("ota_pause_epoch",""))||!p.getBoolean("ota_quiescing",false)||p.getBoolean("ota_hold",false))return false;
        try{return release.equals(new JSONObject(p.getString("ota_ready","")).optString("releaseId"));}catch(Exception e){return false;}
    }
    private static void guardUpdate(Context c,String epoch,String release)throws InterruptedIOException{
        if(epoch!=null&&!currentUpdate(c,epoch,release))throw new InterruptedIOException("Η προετοιμασία της προηγούμενης ενημέρωσης ακυρώθηκε. Η νέα προσπάθεια χρησιμοποιεί δικό της αντίγραφο.");
    }
    public static JSONObject requestForUpdate(final Context c,final FleetDataStore store,final String release)throws Exception{
        final String epoch=prefs(c).getString("ota_pause_epoch","");
        if(!currentUpdate(c,epoch,release))return null;
        String id=prefs(c).getString("ota_checkpoint_job","");
        if(id.length()>0){try{JSONObject job=load(c,id);if(release.equals(job.optString("releaseId"))&&epoch.equals(job.optString("pauseEpoch")))return job;}catch(Exception ignored){}}
        if(prefs(c).getString("ota_checkpoint_error","").length()>0)return null;
        if(preparing.compareAndSet(false,true)){
            preparation.execute(new Runnable(){public void run(){try{
                JSONObject job=prepareLocked(c,store,"update",release,epoch);job.put("pauseEpoch",epoch);save(c,job);
                synchronized(ServerWorkTracker.class){
                    if(!currentUpdate(c,epoch,release))return;
                    prefs(c).edit().putString("ota_checkpoint_job",job.getString("id")).commit();
                    if(!prefs(c).getBoolean(PAUSED,false))export(c,job);
                }
            }catch(Exception e){synchronized(ServerWorkTracker.class){if(currentUpdate(c,epoch,release))prefs(c).edit().putString("ota_checkpoint_error",message(e)).apply();}}finally{preparing.set(false);}}});
        }
        return null;
    }
    private static JSONObject prepare(Context c,FleetDataStore store,String kind,String release)throws Exception{if(!preparing.compareAndSet(false,true))throw new IOException("Ολοκληρώνεται ήδη η προετοιμασία άλλου αντιγράφου.");try{return prepareLocked(c,store,kind,release);}finally{preparing.set(false);}}
    private static JSONObject prepareLocked(final Context c,FleetDataStore store,String kind,String release)throws Exception{
        return prepareLocked(c,store,kind,release,null);
    }
    private static JSONObject prepareLocked(Context c, FleetDataStore store, String kind, String release, String epoch) throws Exception {
        return prepareLocked(c, store, kind, release, epoch, UUID.randomUUID().toString());
    }

    private static JSONObject prepareLocked(final Context c,FleetDataStore store,String kind,final String release,final String epoch,final String id)throws Exception{
        guardUpdate(c,epoch,release);
        cleanupLocal(c);
        if (root(c).getUsableSpace() < 16L * 1024 * 1024) throw new IOException("Δεν υπάρχει αρκετός χώρος για νέο backup.");
        final String stamp=stamp(c);BackupStatus.start(c,id,kind);JSONObject job=new JSONObject().put("id",id).put("kind",kind).put("releaseId",release).put("stamp",stamp).put("fileName","FleetControl_backup_"+stamp+".fcbackup").put("docsName","FleetControl_documents_"+stamp+".fcdocs").put("databaseName","FleetControl_database_"+stamp+".fcdb").put("createdAt",System.currentTimeMillis()).put("localReady",false).put("exported",false);
        try(BackupEnvelope envelope=BackupEnvelope.open(c)){
            JSONObject nativeParts=NativeBackupPreparation.prepareIfImported(c,store,root(c),id,envelope,new NativeBackupBuilder.Progress(){public void stage(String label,long done,long total)throws Exception{guardUpdate(c,epoch,release);BackupStatus.progress(c,id,"preparing",label,35,0,0,done,total,"");}});
            if(nativeParts!=null){
                java.util.Iterator<String> keys=nativeParts.keys();while(keys.hasNext()){String key=keys.next();job.put(key,nativeParts.get(key));}
                job.put("prepareMillis",Math.max(0,System.currentTimeMillis()-job.getLong("createdAt"))).put("targetFolder",prefs(c).getString(BackupManager.KEY_FOLDER_URI,""));
                guardUpdate(c,epoch,release);save(c,job);prefs(c).edit().putString(LAST_JOB,id).commit();BackupStatus.localReady(c,id,job.getInt("expectedDocuments"),job.getInt("includedDocuments"),job.getString("fileName"),true);BackupStatus.progress(c,id,"preparing","Το πλήρες τοπικό αντίγραφο είναι έτοιμο · αναμονή αποστολής",70,job.getInt("includedDocuments"),job.getInt("expectedDocuments"),0,job.optLong("docsBytes")+job.optLong("databaseBytes")+job.optLong("dataBytes"),"");return job;
            }
            BackupStatus.progress(c,id,"preparing","Ανάγνωση τοπικών δεδομένων και ρυθμίσεων",3,0,0,0,0,"");
            JSONObject data=BackupManager.preparePayload(c,store);guardUpdate(c,epoch,release);JSONObject inventory=BackupManager.documentInventory(data);
            final File dir=root(c);
            ServiceDocumentArchive.Result archive=ServiceDocumentArchive.create(c,inventory,new File(dir,"archive-cache"),new ServiceDocumentArchive.Progress(){public void stage(String stage,int done,int total,long bytes,long byteTotal,String name)throws Exception{guardUpdate(c,epoch,release);int start=stage.startsWith("Αρχειοθέτηση")?25:10;int percent=start+(int)(15*Math.min(1,byteTotal<=0?0:(double)bytes/byteTotal));BackupStatus.progress(c,id,"preparing",stage,percent,done,total,bytes,byteTotal,name);}});
            data.put("documentsBackup",new JSONObject().put("expected",archive.expected).put("included",archive.included).put("archiveSha256",archive.included>0?archive.sha256:""));
            job.put("expectedDocuments",archive.expected).put("includedDocuments",archive.included).put("missingDocuments",Math.max(0,archive.expected-archive.included)).put("archiveSha256",archive.sha256).put("workforceIncluded",data.optJSONObject("workforce")!=null&&data.optJSONObject("workforce").length()>0);
            if(archive.included>0){
                File encrypted=new File(dir,archive.sha256+"-"+envelope.keyId()+".fcdocs");File marker=new File(encrypted.getPath()+".json");boolean reusable=false;String digest="";
                try{JSONObject known=ServiceDocumentArchive.readJson(marker);digest=known.getString("sha256");reusable=encrypted.isFile()&&encrypted.length()==known.optLong("size")&&digest.equals(BackupCipher.digest(encrypted));}catch(Exception ignored){}
                if(!reusable){BackupCipher.Result result=envelope.encrypt(archive.file,encrypted,"documents",new BackupCipher.Progress(){public void bytes(long done,long total)throws Exception{guardUpdate(c,epoch,release);BackupStatus.progress(c,id,"preparing","Κρυπτογράφηση τοπικού πακέτου τιμολογίων",40+(int)(25*Math.min(1,total<=0?0:(double)done/total)),0,0,done,total,"");}});if(!result.plainSha256.equals(archive.sha256))throw new IOException("Το πακέτο τιμολογίων άλλαξε κατά την προετοιμασία.");digest=result.fileSha256;ServiceDocumentArchive.atomicJson(marker,new JSONObject().put("sha256",digest).put("size",result.size));}
                job.put("docsPath",encrypted.getName()).put("docsSha256",digest).put("docsBytes",encrypted.length());
            }
            BackupStatus.progress(c,id,"preparing","Αποθήκευση τοπικού ασφαλούς αντιγράφου",67,archive.included,archive.expected,0,0,"");
            File file=new File(dir,job.getString("fileName")),plain=new File(dir,"payload-"+id+".json.part");
            BackupCipher.Result encrypted;
            try {
                // FCB2 adds 12 IV + 16 tag bytes and base64. Preserve the old
                // 50 MiB reader limit, checking it before building a huge value.
                long plainBytes=BackupJsonWriter.write(plain,data,((50L*1024*1024-5)/4)*3-28,new BackupJsonWriter.Progress(){public void bytes(long done)throws IOException{guardUpdate(c,epoch,release);BackupStatus.progress(c,id,"preparing","Εγγραφή συμπαγών δεδομένων backup",68,0,0,done,0,"");}});
                encrypted=envelope.encrypt(plain,file,"data",new BackupCipher.Progress(){public void bytes(long done,long total)throws Exception{guardUpdate(c,epoch,release);BackupStatus.progress(c,id,"preparing","Κρυπτογράφηση δεδομένων backup",69,0,0,done,total,"");}});
                job.put("portable",envelope.portable()).put("keyId",envelope.keyId()).put("plainDataBytes",plainBytes).put("documentsReused",archive.reused).put("prepareMillis",Math.max(0,System.currentTimeMillis()-job.getLong("createdAt")));
            } finally {plain.delete();}
            job.put("dataPath",file.getName()).put("dataBytes",file.length()).put("dataSha256",encrypted.fileSha256).put("localReady",true).put("targetFolder",prefs(c).getString(BackupManager.KEY_FOLDER_URI,""));
            guardUpdate(c,epoch,release);save(c,job);prefs(c).edit().putString(LAST_JOB,id).commit();BackupStatus.localReady(c,id,archive.expected,archive.included,job.getString("fileName"),job.optBoolean("workforceIncluded"));BackupStatus.progress(c,id,"preparing","Το τοπικό αντίγραφο είναι έτοιμο · αναμονή αποστολής",70,archive.included,archive.expected,0,job.optLong("docsBytes")+job.optLong("dataBytes")+job.optLong("databaseBytes"),"");return job;
        }catch(Exception e){BackupStatus.failure(c,id,message(e),false);throw e;}
    }
    public static boolean localReady(Context c,JSONObject job)throws Exception{
        if(job==null||!job.optBoolean("localReady"))return false;File data=local(c,job.getString("dataPath"));if(!data.isFile()||data.length()!=job.optLong("dataBytes")||!BackupCipher.digest(data).equals(job.getString("dataSha256")))throw new IOException("Το τοπικό αντίγραφο δεδομένων δεν επαληθεύτηκε.");
        if(job.optLong("docsBytes")>0){File docs=local(c,job.getString("docsPath"));if(!docs.isFile()||docs.length()!=job.optLong("docsBytes")||!BackupCipher.digest(docs).equals(job.getString("docsSha256")))throw new IOException("Το τοπικό πακέτο τιμολογίων δεν επαληθεύτηκε.");}
        if(job.optLong("databaseBytes")>0){File database=local(c,job.getString("databasePath"));if(!database.isFile()||database.length()!=job.optLong("databaseBytes")||!BackupCipher.digest(database).equals(job.getString("databaseSha256")))throw new IOException("Η πλήρης τοπική βάση backup δεν επαληθεύτηκε.");}return true;
    }
    private static File local(Context c,String name)throws Exception{if(name.contains("/")||name.contains("\\")||name.contains(".."))throw new IOException("Μη έγκυρο τοπικό αρχείο backup.");return new File(root(c),name);}
    public static void retry(Context c) throws Exception {
        String id = BackupStatus.get(c).optString("id", lastJob(c));
        if (id.isEmpty()) throw new IOException("Δεν υπάρχει τοπικό αντίγραφο προς επανάληψη.");
        JSONObject job = load(c, id);
        if (!localReady(c, job)) throw new IOException("Δεν ολοκληρώθηκε το τοπικό αντίγραφο. Πάτησε Δημιουργία backup.");
        if (job.optBoolean("exported")) throw new IOException("Το αντίγραφο έχει ήδη αποθηκευτεί.");
        prefs(c).edit().putBoolean(PAUSED, false).apply();
        String folder = prefs(c).getString(BackupManager.KEY_FOLDER_URI, "");
        if (!folder.equals(job.optString("targetFolder"))) {
            // Document URIs are specific to the old folder.
            job.remove("outputUris");
            job.put("targetFolder", folder);
        }
        export(c, job);
    }
    public static void pauseExports(Context c){prefs(c).edit().putBoolean(PAUSED,true).commit();List<Transfer> jobs; synchronized(active){jobs=new ArrayList<Transfer>(active.values());}for(Transfer t:jobs)t.cancel("Η αποστολή παύει για την ενημέρωση. Το τοπικό αντίγραφο διατηρείται και θα αποσταλεί ξανά μετά.",true);}
    public static void resumePending(final Context c){
        synchronized(ServerWorkTracker.class){
            if(prefs(c).getBoolean("ota_quiescing",false))return;
            prefs(c).edit().putBoolean(PAUSED,false).apply();
        }
        if(!resuming.compareAndSet(false,true))return;
        pendingExports.execute(new Runnable(){public void run(){try{
            File[] files=root(c).listFiles();if(files==null)return;
            Arrays.sort(files,new Comparator<File>(){public int compare(File a,File b){return Long.compare(a.lastModified(),b.lastModified());}});
            for (File file : files) {
                if (!file.getName().matches("[a-f0-9-]{36}\\.json")) continue;
                JSONObject job;
                try { job = ServiceDocumentArchive.readJson(file); }
                catch (Exception unreadable) { continue; }
                if (!job.optBoolean("localReady") || job.optBoolean("exported") || job.optBoolean("localOnly")
                        || "automatic".equals(job.optString("kind"))) continue;
                // Older versions recorded failed scheduled exports as manual. Resume
                // the newest pending transfer only. Keep the other checkpoints available.
                try {
                    Transfer transfer;
                    synchronized (ServerWorkTracker.class) {
                        if (prefs(c).getBoolean("ota_quiescing", false) || prefs(c).getBoolean(PAUSED, false)) return;
                        transfer = export(c, job);
                    }
                    transfer.await();
                } catch (Exception ignored) { }
                break;
            }
        }finally{resuming.set(false);}}});
    }
    private static synchronized Transfer export(Context c, JSONObject original) throws Exception {
        String id = original.getString("id");
        synchronized (active) {
            Transfer previous = active.get(id);
            if (previous != null) {
                if (!previous.finished.get()) return previous;
                throw new IOException("Η προηγούμενη αποστολή ακόμη τερματίζεται. Το backup διατηρείται.");
            }
        }
        if (load(c, id).optBoolean("exported")) throw new IOException("Το αντίγραφο έχει ήδη αποθηκευτεί.");
        JSONObject job = new JSONObject(original.toString());
        if (job.optString("targetFolder").isEmpty()) {
            BackupStatus.failure(c, id, "Το τοπικό αντίγραφο είναι έτοιμο. Διάλεξε φάκελο και πάτησε Επανάληψη αποστολής.", false);
            throw new IOException("Διάλεξε φάκελο backup για την αποστολή του τοπικού αντιγράφου.");
        }
        JSONObject status = BackupStatus.get(c);
        if (!id.equals(status.optString("id")) || !"preparing".equals(status.optString("state"))) {
            BackupStatus.start(c, id, job.optString("kind", "manual"));
        }
        job.put("attempt", UUID.randomUUID().toString()).put("exported", false);
        save(c, job);
        Transfer transfer = new Transfer(c, job);
        synchronized (active) { active.put(id, transfer); }
        try {
            exports.execute(transfer);
        } catch (RejectedExecutionException saturated) {
            transfer.terminated();
            transfer.cancel("Ο πάροχος φακέλου δεν έχει τερματίσει προηγούμενες αποστολές. Το τοπικό αντίγραφο διατηρείται.", false);
            throw saturated;
        }
        return transfer;
    }

    private static final class Transfer implements Runnable {
        final Context c;final JSONObject job;final AtomicBoolean finished=new AtomicBoolean(false),cancelled=new AtomicBoolean(false);final CountDownLatch done=new CountDownLatch(1);final CancellationSignal signal=new CancellationSignal();volatile long activity=System.currentTimeMillis();volatile ParcelFileDescriptor descriptor;volatile Exception error;long bytesDone=0,total;ScheduledFuture<?> timeout;
        Transfer(Context c,JSONObject job){this.c=c;this.job=job;total=job.optLong("docsBytes")+job.optLong("dataBytes")+job.optLong("databaseBytes");}
        @Override public void run() {
            try {
                if (finished.get()) return;
                timeout = watchdog.scheduleAtFixedRate(() -> {
                    if (!finished.get() && System.currentTimeMillis() - activity > IDLE_TIMEOUT_MS) {
                        cancel("Ο πάροχος φακέλου δεν απάντησε για 90 δευτερόλεπτα. Το τοπικό αντίγραφο διατηρείται.", false);
                    }
                }, 5, 5, TimeUnit.SECONDS);
                if (finished.get()) timeout.cancel(false);
                check();
                String id = job.getString("id");
                BackupStatus.localReady(c, id, job.optInt("expectedDocuments"), job.optInt("includedDocuments"),
                        job.getString("fileName"), job.optBoolean("workforceIncluded"));
                // The manifest is the final part. Both companion files must be verified first.
                if (job.optLong("docsBytes") > 0) write("docs", job.getString("docsName"));
                if (job.optLong("databaseBytes") > 0) write("database", job.getString("databaseName"));
                write("data", job.getString("fileName"));
                synchronized (this) {
                    check();
                    BackupManager.recordExported(c, job);
                    job.put("exported", true).put("exportedAt", System.currentTimeMillis());
                    save(c, job);
                    BackupStatus.complete(c, id);
                    terminated();
                    finish(null);
                }
                BackupManager.cleanupLater(c, Uri.parse(job.getString("targetFolder")));
            } catch (Exception error) {
                synchronized (this) {
                    if (!finished.get()) {
                        BackupStatus.failure(c, job.optString("id"), message(error), cancelled.get());
                        terminated();
                        finish(error);
                    }
                }
            } finally {
                terminated();
            }
        }

        private void write(String part, String name) throws Exception {
            check();
            activity = System.currentTimeMillis();
            report("Έλεγχος αρχείου στον επιλεγμένο φάκελο", name);
            ContentResolver resolver = c.getContentResolver();
            Uri tree = Uri.parse(job.getString("targetFolder"));
            String expected = job.getString(part + "Sha256");
            long size = job.getLong(part + "Bytes");
            JSONObject outputs = job.optJSONObject("outputUris");
            if (outputs == null) {
                outputs = new JSONObject();
                job.put("outputUris", outputs);
            }

            Uri uri = find(tree, name);
            boolean owned = uri != null && uri.toString().equals(outputs.optString(part));
            if (uri != null) {
                if (verified(resolver, uri, size, expected)) {
                    markVerified(part, uri, size, name);
                    return;
                }
                if (!owned) throw new IOException("Υπάρχει άλλο ή ημιτελές αρχείο με το ίδιο όνομα. Επίλεξε διαφορετικό φάκελο.");
            } else {
                Uri parent = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
                uri = DocumentsContract.createDocument(resolver, parent, "application/octet-stream", name);
                if (uri == null) throw new IOException("Ο φάκελος δεν δημιούργησε το αρχείο backup.");
                uri = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getDocumentId(uri));
                // Record the created URI even if the provider returned after cancellation.
                outputs.put(part, uri.toString());
                save(c, job);
                check();
                try (Cursor row = resolver.query(uri, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null, signal)) {
                    if (row == null || !row.moveToFirst() || !name.equals(row.getString(0))) {
                        throw new IOException("Ο πάροχος φακέλου δεν διατήρησε το όνομα του backup.");
                    }
                }
            }

            try (InputStream input = new BufferedInputStream(new FileInputStream(local(c, job.getString(part + "Path"))))) {
                descriptor = resolver.openFileDescriptor(uri, "wt", signal);
                if (descriptor == null) throw new IOException("Ο φάκελος backup δεν είναι διαθέσιμος.");
                try (OutputStream output = new BufferedOutputStream(new ParcelFileDescriptor.AutoCloseOutputStream(descriptor), 65536)) {
                    byte[] buffer = new byte[65536];
                    int count;
                    long written = 0, reportedAt = 0;
                    while ((count = input.read(buffer)) != -1) {
                        check();
                        output.write(buffer, 0, count);
                        activity = System.currentTimeMillis();
                        written += count;
                        if (activity - reportedAt >= 1000) {
                            report("Εγγραφή κρυπτογραφημένου backup στον φάκελο", name, bytesDone + written);
                            reportedAt = activity;
                        }
                    }
                } finally {
                    descriptor = null;
                }
            }
            if (!verified(resolver, uri, size, expected)) throw new IOException("Δεν επαληθεύτηκε το αποθηκευμένο αρχείο backup.");
            markVerified(part, uri, size, name);
        }

        private Uri find(Uri tree, String name) throws Exception {
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
            String[] columns = {DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME};
            try (Cursor rows = c.getContentResolver().query(children, columns, null, null, null, signal)) {
                if (rows == null) throw new IOException("Δεν ελέγχθηκε ο επιλεγμένος φάκελος backup.");
                Uri result = null;
                while (rows.moveToNext()) {
                    check();
                    if (!name.equals(rows.getString(1))) continue;
                    if (result != null) throw new IOException("Βρέθηκαν διπλά αρχεία στο φάκελο backup.");
                    result = DocumentsContract.buildDocumentUriUsingTree(tree, rows.getString(0));
                }
                return result;
            }
        }

        private boolean verified(ContentResolver resolver, Uri uri, long size, String expected) throws Exception {
            check();
            descriptor = resolver.openFileDescriptor(uri, "r", signal);
            if (descriptor == null) throw new IOException("Δεν ήταν δυνατή η επαλήθευση του αρχείου backup.");
            try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
                MessageDigest hash = MessageDigest.getInstance("SHA-256");
                byte[] buffer = new byte[65536];
                int count;
                long read = 0;
                while ((count = input.read(buffer)) != -1) {
                    check();
                    read += count;
                    if (read > size) return false;
                    hash.update(buffer, 0, count);
                    activity = System.currentTimeMillis();
                }
                return read == size && expected.equals(BackupArchiveVerifier.hex(hash.digest()));
            } finally {
                descriptor = null;
            }
        }

        private void markVerified(String part, Uri uri, long size, String name) throws Exception {
            job.put(part + "Uri", uri.toString());
            save(c, job);
            bytesDone += size;
            report("Επαληθεύτηκε το αρχείο backup", name);
        }

        private void terminated() {
            synchronized (active) { active.remove(job.optString("id"), this); }
        }

        private void report(String stage, String name) throws Exception { report(stage, name, bytesDone); }
        private synchronized void report(String stage, String name, long completed) throws Exception {
            check();
            if (!finished.get()) BackupStatus.progress(c, job.getString("id"), "exporting", stage,
                    percent(completed), 0, 0, completed, total, name);
        }
        private int percent(long completed){return 70+(int)(29*Math.min(1,total<=0?0:(double)completed/total));}
        private void check()throws Exception{if(cancelled.get()||prefs(c).getBoolean(PAUSED,false)||Thread.currentThread().isInterrupted())throw new InterruptedIOException("Η αποστολή διακόπηκε με ασφάλεια. Το τοπικό αντίγραφο διατηρείται.");}
        void await()throws Exception{done.await();if(error!=null)throw error;}
        synchronized void cancel(String reason,boolean paused){if(finished.get())return;cancelled.set(true);BackupStatus.failure(c,job.optString("id"),reason,paused);finish(new IOException(reason));
            // A remote provider may even block cancellation/close. Unblock callers
            // first and keep the cancellation attempt outside the watchdog thread.
            final ParcelFileDescriptor fd=descriptor;new Thread(new Runnable(){public void run(){try{signal.cancel();}catch(Exception ignored){}if(fd!=null)try{fd.close();}catch(Exception ignored){}}},"fleet-backup-cancel").start();
        }
        private void finish(Exception problem){if(!finished.compareAndSet(false,true))return;error=problem;if(timeout!=null)timeout.cancel(false);done.countDown();}
    }
    private static String message(Exception e){return e.getMessage()==null?"Η διαδικασία backup δεν ολοκληρώθηκε. Το προηγούμενο αντίγραφο και τα αρχικά δεδομένα διατηρούνται.":e.getMessage();}
}
