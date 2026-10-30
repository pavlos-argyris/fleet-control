package gr.argyrismitsos.fleetserver;

import android.content.*;
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
    private static final ThreadPoolExecutor exports=new ThreadPoolExecutor(0,2,60,TimeUnit.SECONDS,new SynchronousQueue<Runnable>());
    private static final ScheduledExecutorService watchdog=Executors.newSingleThreadScheduledExecutor();
    private static final Map<String,Transfer> active=new HashMap<String,Transfer>();
    private static final long IDLE_TIMEOUT_MS=90000;
    private static final AtomicBoolean recovered=new AtomicBoolean(false);
    public static void recoverAfterRestart(Context c){if(!recovered.compareAndSet(false,true))return;JSONObject old=BackupStatus.get(c);if(BackupStatus.active(c))BackupStatus.failure(c,old.optString("id"),"Η προηγούμενη διαδικασία διακόπηκε από επανεκκίνηση. Το τελευταίο ολοκληρωμένο backup διατηρείται. Αν υπάρχει τοπικό αντίγραφο, η αποστολή θα επαναληφθεί.",false);}
    private static final String LAST_JOB="backup_checkpoint_job",PAUSED="backup_export_paused_for_update";
    private BackupJobs(){}
    private static File root(Context c){File f=new File(c.getFilesDir(),"safe-backups");f.mkdirs();return f;}
    private static File journal(Context c,String id){if(!id.matches("[a-f0-9-]{36}"))throw new IllegalArgumentException("Μη έγκυρο αντίγραφο.");return new File(root(c),id+".json");}
    static JSONObject load(Context c,String id)throws Exception{return ServiceDocumentArchive.readJson(journal(c,id));}
    private static void save(Context c,JSONObject job)throws Exception{ServiceDocumentArchive.atomicJson(journal(c,job.getString("id")),job);}
    private static SharedPreferences prefs(Context c){return c.getSharedPreferences(BackupManager.PREFS,Context.MODE_PRIVATE);}
    private static synchronized String stamp(Context c){long value=Math.max(System.currentTimeMillis()/1000,prefs(c).getLong("backup_name_second",0)+1);prefs(c).edit().putLong("backup_name_second",value).commit();return new SimpleDateFormat("yyyyMMdd_HHmmss",Locale.US).format(new Date(value*1000));}
    public static Set<String> pendingStamps(Context c){Set<String> values=new HashSet<String>();File[] files=root(c).listFiles();if(files!=null)for(File f:files)if(f.getName().matches("[a-f0-9-]{36}\\.json"))try{JSONObject job=ServiceDocumentArchive.readJson(f);if(!job.optBoolean("exported")){String name=job.optString("fileName");if(name.startsWith("FleetControl_backup_")&&name.endsWith(".fcbackup"))values.add(name.substring(20,name.length()-9));}}catch(Exception ignored){}return values;}
    private static void cleanupLocal(Context c){
        File[] files=root(c).listFiles();if(files==null)return;Arrays.sort(files,new Comparator<File>(){public int compare(File a,File b){return Long.compare(b.lastModified(),a.lastModified());}});
        Set<String> references=new HashSet<String>();List<JSONObject> discarded=new ArrayList<JSONObject>();int retained=0,localRetained=0;
        for(File f:files)if(f.getName().matches("[a-f0-9-]{36}\\.json"))try{JSONObject j=ServiceDocumentArchive.readJson(f);if(j.optBoolean("localOnly")&&!j.optBoolean("exported")?localRetained++<2:!j.optBoolean("exported")||retained++<2){references.add(j.optString("dataPath"));references.add(j.optString("docsPath"));}else discarded.add(j);}catch(Exception ignored){}
        for(JSONObject j:discarded)try{for(String k:new String[]{"dataPath","docsPath"}){String name=j.optString(k);if(name.length()>0&&!references.contains(name)){File f=local(c,name);f.delete();new File(f.getPath()+".json").delete();}}journal(c,j.getString("id")).delete();}catch(Exception ignored){}
        // Only disposable files inside safe-backups; never service originals.
        for(File f:files){String name=f.getName();if(f.isFile()&&(name.endsWith(".part")||((name.endsWith(".fcbackup")||name.endsWith(".fcdocs"))&&!references.contains(name)))){f.delete();new File(f.getPath()+".json").delete();}}
    }
    public static String createAndExport(Context c,FleetDataStore store)throws Exception{
        if(prefs(c).getBoolean(PAUSED,false))throw new IOException("Η αποστολή backup έχει παύσει για την ενημέρωση. Το τοπικό αντίγραφο διατηρείται.");
        if(BackupStatus.active(c))throw new IOException("Υπάρχει ήδη backup σε εξέλιξη. Δες το στάδιο και την πρόοδο παρακάτω.");
        JSONObject job=prepare(c,store,"manual","");Transfer transfer=export(c,job,false);transfer.await();return job.getString("fileName");
    }
    public static JSONObject createLocalAutomatic(Context c,FleetDataStore store)throws Exception{
        JSONObject job=prepare(c,store,"automatic","");if(!localReady(c,job))throw new IOException("Το τοπικό backup δεν επαληθεύτηκε.");job.put("localOnly",true);save(c,job);BackupStatus.progress(c,job.getString("id"),"local_ready","Το κρυπτογραφημένο τοπικό backup επαληθεύτηκε · αναμονή επιλογής φακέλου",70,job.optInt("includedDocuments"),job.optInt("expectedDocuments"),0,0,job.getString("fileName"));return job;
    }
    public static boolean isPreparing(){return preparing.get();}
    public static String lastJob(Context c){return prefs(c).getString(LAST_JOB,"");}
    public static JSONObject requestForUpdate(final Context c,final FleetDataStore store,final String release)throws Exception{
        final String epoch=prefs(c).getString("ota_pause_epoch","");
        String id=prefs(c).getString("ota_checkpoint_job","");
        if(id.length()>0){try{JSONObject job=load(c,id);if(release.equals(job.optString("releaseId"))&&epoch.equals(job.optString("pauseEpoch")))return job;}catch(Exception ignored){}}
        if(prefs(c).getString("ota_checkpoint_error","").length()>0)return null;
        if(preparing.compareAndSet(false,true)){
            preparation.execute(new Runnable(){public void run(){try{JSONObject job=prepareLocked(c,store,"update",release);job.put("pauseEpoch",epoch);save(c,job);synchronized(ServerWorkTracker.class){if(epoch.equals(prefs(c).getString("ota_pause_epoch",""))&&prefs(c).getBoolean("ota_quiescing",false)&&!prefs(c).getBoolean("ota_hold",false))prefs(c).edit().putString("ota_checkpoint_job",job.getString("id")).commit();}if(!prefs(c).getBoolean(PAUSED,false))export(c,job,false);}catch(Exception e){prefs(c).edit().putString("ota_checkpoint_error",message(e)).apply();}finally{preparing.set(false);}}});
        }
        return null;
    }
    private static JSONObject prepare(Context c,FleetDataStore store,String kind,String release)throws Exception{if(!preparing.compareAndSet(false,true))throw new IOException("Ολοκληρώνεται ήδη η προετοιμασία άλλου αντιγράφου.");try{return prepareLocked(c,store,kind,release);}finally{preparing.set(false);}}
    private static JSONObject prepareLocked(final Context c,FleetDataStore store,String kind,String release)throws Exception{
        cleanupLocal(c);
        final String id=UUID.randomUUID().toString(),stamp=stamp(c);BackupStatus.start(c,id,kind);JSONObject job=new JSONObject().put("id",id).put("kind",kind).put("releaseId",release).put("stamp",stamp).put("fileName","FleetControl_backup_"+stamp+".fcbackup").put("docsName","FleetControl_documents_"+stamp+".fcdocs").put("createdAt",System.currentTimeMillis()).put("localReady",false).put("exported",false);
        try{
            BackupStatus.progress(c,id,"preparing","Ανάγνωση τοπικών δεδομένων και ρυθμίσεων",3,0,0,0,0,"");
            JSONObject data=BackupManager.preparePayload(c,store),inventory=BackupManager.documentInventory(data);
            final File dir=root(c);
            ServiceDocumentArchive.Result archive=ServiceDocumentArchive.create(c,inventory,new File(dir,"archive-cache"),new ServiceDocumentArchive.Progress(){public void stage(String stage,int done,int total,long bytes,long byteTotal,String name){int start=stage.startsWith("Αρχειοθέτηση")?25:10;int percent=start+(int)(15*Math.min(1,byteTotal<=0?0:(double)bytes/byteTotal));BackupStatus.progress(c,id,"preparing",stage,percent,done,total,bytes,byteTotal,name);}});
            data.put("documentsBackup",new JSONObject().put("expected",archive.expected).put("included",archive.included).put("archiveSha256",archive.included>0?archive.sha256:""));
            job.put("expectedDocuments",archive.expected).put("includedDocuments",archive.included).put("missingDocuments",Math.max(0,archive.expected-archive.included)).put("archiveSha256",archive.sha256).put("workforceIncluded",data.optJSONObject("workforce")!=null&&data.optJSONObject("workforce").length()>0);
            if(archive.included>0){
                File encrypted=new File(dir,archive.sha256+"-"+BackupArchiveVerifier.digest(BackupManager.encryptionKey()).substring(0,12)+".fcdocs");File marker=new File(encrypted.getPath()+".json");boolean reusable=false;String digest="";
                try{JSONObject known=ServiceDocumentArchive.readJson(marker);digest=known.getString("sha256");reusable=encrypted.isFile()&&encrypted.length()==known.optLong("size")&&digest.equals(BackupCipher.digest(encrypted));}catch(Exception ignored){}
                if(!reusable){BackupCipher.Result result=BackupCipher.encrypt(archive.file,encrypted,BackupManager.encryptionKey(),new BackupCipher.Progress(){public void bytes(long done,long total){BackupStatus.progress(c,id,"preparing","Κρυπτογράφηση τοπικού πακέτου τιμολογίων",40+(int)(25*Math.min(1,total<=0?0:(double)done/total)),0,0,done,total,"");}});if(!result.plainSha256.equals(archive.sha256))throw new IOException("Το πακέτο τιμολογίων άλλαξε κατά την προετοιμασία.");digest=result.fileSha256;ServiceDocumentArchive.atomicJson(marker,new JSONObject().put("sha256",digest).put("size",result.size));}
                job.put("docsPath",encrypted.getName()).put("docsSha256",digest).put("docsBytes",encrypted.length());
            }
            BackupStatus.progress(c,id,"preparing","Αποθήκευση τοπικού ασφαλούς αντιγράφου",67,archive.included,archive.expected,0,0,"");
            byte[] bytes=BackupManager.encrypt(data.toString(2).getBytes(Charset.forName("UTF-8")));if(bytes.length>50*1024*1024)throw new IOException("Το αρχείο δεδομένων υπερβαίνει το όριο ασφαλούς επαναφοράς 50 MB.");
            File file=new File(dir,job.getString("fileName")),part=new File(file.getPath()+".part");FileOutputStream output=new FileOutputStream(part);try{output.write(bytes);output.flush();output.getFD().sync();}finally{output.close();}if(!part.renameTo(file))throw new IOException("Δεν ολοκληρώθηκε το τοπικό αρχείο δεδομένων.");
            job.put("dataPath",file.getName()).put("dataBytes",file.length()).put("dataSha256",BackupCipher.digest(file)).put("localReady",true).put("targetFolder",prefs(c).getString(BackupManager.KEY_FOLDER_URI,""));
            save(c,job);prefs(c).edit().putString(LAST_JOB,id).commit();BackupStatus.localReady(c,id,archive.expected,archive.included,job.getString("fileName"),job.optBoolean("workforceIncluded"));BackupStatus.progress(c,id,"preparing","Το τοπικό αντίγραφο είναι έτοιμο · αναμονή αποστολής",70,archive.included,archive.expected,0,job.optLong("docsBytes")+job.optLong("dataBytes"),"");return job;
        }catch(Exception e){BackupStatus.failure(c,id,message(e),false);throw e;}
    }
    public static boolean localReady(Context c,JSONObject job)throws Exception{
        if(job==null||!job.optBoolean("localReady"))return false;File data=local(c,job.getString("dataPath"));if(!data.isFile()||data.length()!=job.optLong("dataBytes")||!BackupCipher.digest(data).equals(job.getString("dataSha256")))throw new IOException("Το τοπικό αντίγραφο δεδομένων δεν επαληθεύτηκε.");
        if(job.optLong("docsBytes")>0){File docs=local(c,job.getString("docsPath"));if(!docs.isFile()||docs.length()!=job.optLong("docsBytes")||!BackupCipher.digest(docs).equals(job.getString("docsSha256")))throw new IOException("Το τοπικό πακέτο τιμολογίων δεν επαληθεύτηκε.");}return true;
    }
    private static File local(Context c,String name)throws Exception{if(name.contains("/")||name.contains("\\")||name.contains(".."))throw new IOException("Μη έγκυρο τοπικό αρχείο backup.");return new File(root(c),name);}
    public static void retry(Context c)throws Exception{String id=BackupStatus.get(c).optString("id",lastJob(c));if(id.length()==0)throw new IOException("Δεν υπάρχει τοπικό αντίγραφο προς επανάληψη.");JSONObject job=load(c,id);if(!localReady(c,job))throw new IOException("Δεν ολοκληρώθηκε το τοπικό αντίγραφο. Πάτησε Δημιουργία backup.");prefs(c).edit().putBoolean(PAUSED,false).apply();job.put("targetFolder",prefs(c).getString(BackupManager.KEY_FOLDER_URI,""));export(c,job,true);}
    public static void pauseExports(Context c){prefs(c).edit().putBoolean(PAUSED,true).commit();List<Transfer> jobs; synchronized(active){jobs=new ArrayList<Transfer>(active.values());}for(Transfer t:jobs)t.cancel("Η αποστολή παύει για την ενημέρωση. Το τοπικό αντίγραφο διατηρείται και θα αποσταλεί ξανά μετά.",true);}
    public static void resumePending(final Context c){prefs(c).edit().putBoolean(PAUSED,false).apply();preparation.execute(new Runnable(){public void run(){File[] files=root(c).listFiles();if(files==null)return;Arrays.sort(files,new Comparator<File>(){public int compare(File a,File b){return Long.compare(a.lastModified(),b.lastModified());}});for(File f:files){if(!f.getName().matches("[a-f0-9-]{36}\\.json"))continue;try{JSONObject job=ServiceDocumentArchive.readJson(f);if(job.optBoolean("localReady")&&!job.optBoolean("exported"))export(c,job,true).await();}catch(Exception ignored){}}}});}
    private static synchronized Transfer export(Context c,JSONObject original,boolean retry)throws Exception{
        synchronized(active){Transfer previous=active.get(original.getString("id"));if(previous!=null&&!previous.finished.get())return previous;}
        JSONObject job=new JSONObject(original.toString());if(job.optString("targetFolder").length()==0){BackupStatus.failure(c,job.getString("id"),"Το τοπικό αντίγραφο είναι έτοιμο. Διάλεξε φάκελο και πάτησε Επανάληψη αποστολής.",false);throw new IOException("Διάλεξε φάκελο backup για την αποστολή του τοπικού αντιγράφου.");}
        if(retry){String next=stamp(c);job.put("fileName","FleetControl_backup_"+next+".fcbackup").put("docsName","FleetControl_documents_"+next+".fcdocs");}
        JSONObject live=BackupStatus.get(c);if(!job.getString("id").equals(live.optString("id"))||!"preparing".equals(live.optString("state")))BackupStatus.start(c,job.getString("id"),job.optString("kind","manual"));
        job.put("attempt",UUID.randomUUID().toString()).put("exported",false);save(c,job);Transfer transfer=new Transfer(c,job);synchronized(active){active.put(job.getString("id"),transfer);}
        try{exports.execute(transfer);}catch(RejectedExecutionException e){transfer.cancel("Ο πάροχος φακέλου δεν έχει τερματίσει προηγούμενες αποστολές. Διάλεξε άλλο φάκελο ή επανεκκίνησε τον Server. Το τοπικό αντίγραφο διατηρείται.",false);throw e;}return transfer;
    }
    private static final class Transfer implements Runnable {
        final Context c;final JSONObject job;final AtomicBoolean finished=new AtomicBoolean(false),cancelled=new AtomicBoolean(false);final CountDownLatch done=new CountDownLatch(1);final CancellationSignal signal=new CancellationSignal();volatile long activity=System.currentTimeMillis();volatile ParcelFileDescriptor descriptor;volatile Exception error;long bytesDone=0,total;ScheduledFuture<?> timeout;
        Transfer(Context c,JSONObject job){this.c=c;this.job=job;total=job.optLong("docsBytes")+job.optLong("dataBytes");}
        public void run(){if(finished.get())return;timeout=watchdog.scheduleAtFixedRate(new Runnable(){public void run(){if(!finished.get()&&System.currentTimeMillis()-activity>IDLE_TIMEOUT_MS)cancel("Ο πάροχος φακέλου δεν απάντησε για 90 δευτερόλεπτα. Το τοπικό αντίγραφο είναι ασφαλές. Πάτησε Επανάληψη αποστολής ή διάλεξε εσωτερική μνήμη.",false);}},5,5,TimeUnit.SECONDS);if(finished.get())timeout.cancel(false);
            try{
                check();BackupStatus.localReady(c,job.getString("id"),job.optInt("expectedDocuments"),job.optInt("includedDocuments"),job.getString("fileName"),job.optBoolean("workforceIncluded"));
                // Write the invoice package first; metadata is never advertised
                // as a complete backup before its companion has been written.
                if(job.optLong("docsBytes")>0)write(job.getString("docsPath"),job.getString("docsName"),job.getString("docsSha256"));
                write(job.getString("dataPath"),job.getString("fileName"),job.getString("dataSha256"));
                synchronized(this){check();job.put("exported",true).put("exportedAt",System.currentTimeMillis());save(c,job);BackupManager.recordExported(c,job);BackupStatus.complete(c,job.getString("id"));finish(null);}
                BackupManager.cleanupLater(c,Uri.parse(job.getString("targetFolder")));
            }catch(Exception e){synchronized(this){if(!finished.get()){BackupStatus.failure(c,job.optString("id"),message(e),cancelled.get());finish(e);}}}
        }
        private void write(String localName,String displayName,String expected)throws Exception{
            check();activity=System.currentTimeMillis();report("Δημιουργία αρχείου στον επιλεγμένο φάκελο",displayName);
            ContentResolver resolver=c.getContentResolver();Uri tree=Uri.parse(job.getString("targetFolder"));Uri parent=DocumentsContract.buildDocumentUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree));Uri uri=DocumentsContract.createDocument(resolver,parent,"application/octet-stream",displayName);check();if(uri==null)throw new IOException("Ο φάκελος δεν δημιούργησε το αρχείο backup.");
            android.database.Cursor named=resolver.query(uri,new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null,signal);
            try{if(named==null||!named.moveToFirst()||!displayName.equals(named.getString(0)))throw new IOException("Ο φάκελος άλλαξε το όνομα του backup. Δοκίμασε Επανάληψη αποστολής για νέο ζεύγος αρχείων.");}finally{if(named!=null)named.close();}
            activity=System.currentTimeMillis();descriptor=resolver.openFileDescriptor(uri,"w",signal);check();if(descriptor==null)throw new IOException("Ο φάκελος backup δεν είναι διαθέσιμος.");
            InputStream input=new BufferedInputStream(new FileInputStream(local(c,localName)));OutputStream output=new BufferedOutputStream(new ParcelFileDescriptor.AutoCloseOutputStream(descriptor),65536);MessageDigest digest=MessageDigest.getInstance("SHA-256");
            try{byte[] b=new byte[65536];int n;while((n=input.read(b))!=-1){check();output.write(b,0,n);digest.update(b,0,n);bytesDone+=n;activity=System.currentTimeMillis();report("Εγγραφή κρυπτογραφημένου backup στον φάκελο",displayName);}output.flush();check();report("Αναμονή επιβεβαίωσης εγγραφής από τον φάκελο",displayName);output.close();descriptor=null;check();activity=System.currentTimeMillis();if(!expected.equals(BackupArchiveVerifier.hex(digest.digest())))throw new IOException("Το τοπικό αρχείο backup άλλαξε. Δεν δηλώθηκε ολοκλήρωση.");if(displayName.endsWith(".fcbackup"))job.put("dataUri",uri.toString());else job.put("docsUri",uri.toString());
            }finally{input.close();try{output.close();}catch(Exception ignored){}descriptor=null;}
        }
        private synchronized void report(String stage,String name)throws Exception{check();if(!finished.get())BackupStatus.progress(c,job.getString("id"),"exporting",stage,percent(),0,0,bytesDone,total,name);}
        private int percent(){return 70+(int)(29*Math.min(1,total<=0?0:(double)bytesDone/total));}
        private void check()throws Exception{if(cancelled.get()||prefs(c).getBoolean(PAUSED,false)||Thread.currentThread().isInterrupted())throw new InterruptedIOException("Η αποστολή διακόπηκε με ασφάλεια. Το τοπικό αντίγραφο διατηρείται.");}
        void await()throws Exception{done.await();if(error!=null)throw error;}
        synchronized void cancel(String reason,boolean paused){if(finished.get())return;cancelled.set(true);BackupStatus.failure(c,job.optString("id"),reason,paused);finish(new IOException(reason));
            // A remote provider may even block cancellation/close. Unblock callers
            // first and keep the cancellation attempt outside the watchdog thread.
            final ParcelFileDescriptor fd=descriptor;new Thread(new Runnable(){public void run(){try{signal.cancel();}catch(Exception ignored){}if(fd!=null)try{fd.close();}catch(Exception ignored){}}},"fleet-backup-cancel").start();
        }
        private void finish(Exception problem){if(!finished.compareAndSet(false,true))return;error=problem;if(timeout!=null)timeout.cancel(false);done.countDown();synchronized(active){if(active.get(job.optString("id"))==this)active.remove(job.optString("id"));}}
    }
    private static String message(Exception e){return e.getMessage()==null?"Η διαδικασία backup δεν ολοκληρώθηκε. Το προηγούμενο αντίγραφο και τα αρχικά δεδομένα διατηρούνται.":e.getMessage();}
}
