package gr.argyrismitsos.fleetserver;
import android.content.*;import android.database.sqlite.SQLiteDatabase;
import org.json.*;import java.io.*;import java.net.URLEncoder;import java.util.*;

/** Current cloud data, not the retired local authority, feeds portable backups. */
public final class CloudBackupPreparation {
    private CloudBackupPreparation(){}
    private static String encoded(String v)throws Exception{return URLEncoder.encode(v,"UTF-8");}
    private static void remove(File file,File root)throws Exception{if(!file.getCanonicalPath().startsWith(root.getCanonicalPath()+File.separator))return;if(file.isDirectory()){File[] files=file.listFiles();if(files!=null)for(File f:files)remove(f,root);}file.delete();}
    public static JSONObject prepare(final Context context,File directory,String id,BackupEnvelope envelope,final NativeBackupBuilder.Progress progress)throws Exception{
        final JSONObject identity=NativeIdentity.read(context);final Map<String,String> headers=SyncService.serverHeaders();final String base=identity.getString("realm")+"/api/server/cloud-backup/";
        File[] leftovers=context.getCacheDir().listFiles();if(leftovers!=null)for(File f:leftovers)if(f.getName().matches("cloud-backup-[a-f0-9-]{36}"))remove(f,context.getCacheDir());
        final File work=new File(context.getCacheDir(),"cloud-backup-"+UUID.randomUUID()),files=new File(work,"files"),docs=new File(files,"service-documents"),cache=new File(work,"cache");if(!docs.mkdirs()||!cache.mkdirs())throw new IOException("Δεν δημιουργήθηκε ο ιδιωτικός χώρος backup Cloudflare.");SQLiteDatabase db=null;
        try{
            progress.stage("Προετοιμασία συνεπούς αντιγράφου Cloudflare",0,0);JSONObject preparing=FleetHttp.sendJson(base+"start","POST",new JSONObject().put("protocol",2),headers);long deadline=System.currentTimeMillis()+15*60*1000;
            String job=preparing.optString("job");
            while(preparing.optBoolean("pending",false)){
                if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Το backup Cloudflare διακόπηκε. Η πρόοδος διατηρείται.");
                if(System.currentTimeMillis()>deadline)throw new IOException("Το backup Cloudflare χρειάζεται συνέχεια. Η πρόοδος και το προηγούμενο αντίγραφο διατηρούνται.");
                if(job.isEmpty()||!job.equals(preparing.optString("job")))throw new IOException("Άλλαξε η εργασία backup Cloudflare.");
                progress.stage("Προετοιμασία cloud backup · "+preparing.optLong("rowsCaptured")+" εγγραφές",preparing.optLong("tablesDone"),preparing.optLong("tablesTotal"));
                preparing=FleetHttp.sendJson(base+"continue","POST",new JSONObject().put("job",job).put("protocol",2),headers);
            }
            final JSONObject point=preparing;if(!identity.getString("realm").equals(point.getString("realm"))||!identity.getString("generation").equals(point.getString("generation")))throw new IOException("Άλλαξε η πηγή του backup Cloudflare.");
            File database=File.createTempFile("cloud-point-",".sqlite",work);db=SQLiteDatabase.openDatabase(database.getAbsolutePath(),null,SQLiteDatabase.OPEN_READWRITE);
            CloudBackupDatabase.copy(db,point,new CloudBackupDatabase.Reader(){public JSONArray rows(String table,String after)throws Exception{String url=base+"rows?point="+point.getString("id")+"&table="+encoded(table)+(after==null?"":"&after="+encoded(after));return FleetHttp.getJson(url,headers).getJSONArray("rows");}},new CloudBackupDatabase.Progress(){public void stage(String table,long done,long total)throws Exception{progress.stage("Backup Cloudflare · "+table,done,total);}});
            BusinessObjects objects=new BusinessObjects(db,docs,new File(cache,"objects"));String after="";long included=0;
            for(;;){JSONArray rows=FleetHttp.getJson(base+"objects?point="+point.getString("id")+"&after="+encoded(after),headers).getJSONArray("objects");if(rows.length()==0)break;for(int i=0;i<rows.length();i++){JSONObject r=rows.getJSONObject(i);String key=r.getString("key");progress.stage("Ιδιωτικά αρχεία Cloudflare",included,point.getLong("objectCount"));File file=File.createTempFile("cloud-document-",".bin",work);try{FleetHttp.downloadToFile(base+"file?point="+point.getString("id")+"&key="+encoded(key),file,headers);if(r.optLong("size")>0&&file.length()!=r.getLong("size")||!r.optString("sha256").isEmpty()&&!NativeDatabaseSnapshot.digest(file).equals(r.getString("sha256")))throw new IOException("Το ιδιωτικό αρχείο δεν συμφωνεί με το σημείο Cloudflare.");objects.storeObject(key,file,new JSONObject(r.getString("metadata_json")));}finally{file.delete();}included++;after=key;}}
            if(included!=point.getLong("objectCount"))throw new IOException("Ελλιπή ιδιωτικά αρχεία Cloudflare.");
            NativePrimaryState.phase(db,"needs_recovery",identity.getString("realm"),identity.getString("generation"),identity.getString("ownerId"),"");
            final Context isolated=new ContextWrapper(context){@Override public File getFilesDir(){return files;}@Override public File getCacheDir(){return cache;}@Override public Context getApplicationContext(){return this;}};
            JSONObject settings=BackupManager.settingsPayload(context).put("cloudSnapshotCapturedAt",point.getString("capturedAt"));
            return NativeBackupBuilder.prepare(isolated,db,directory,id,settings,NativeIdentity.backupRoot(context),envelope,true,progress).put("source","cloudflare").put("sourceCapturedAt",point.getString("capturedAt"));
        }finally{if(db!=null)db.close();remove(work,context.getCacheDir());}
    }
}
