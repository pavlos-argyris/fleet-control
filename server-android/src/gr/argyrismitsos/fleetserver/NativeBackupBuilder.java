package gr.argyrismitsos.fleetserver;
import android.content.Context;import android.database.sqlite.SQLiteDatabase;
import org.json.*;import java.io.*;

/** Prepares three immutable encrypted parts; the small manifest is written last. */
public final class NativeBackupBuilder {
    public interface Progress{void stage(String label,long done,long total)throws Exception;}
    private NativeBackupBuilder(){}
    public static JSONObject prepare(final Context context,SQLiteDatabase database,File directory,String id,JSONObject settings,JSONObject recovery,BackupEnvelope envelope,final Progress progress)throws Exception{
        return prepare(context,database,directory,id,settings,recovery,envelope,true,progress);
    }
    public static JSONObject prepare(final Context context,SQLiteDatabase database,File directory,String id,JSONObject settings,JSONObject recovery,BackupEnvelope envelope,boolean testRestore,final Progress progress)throws Exception{
        if(!envelope.portable())throw new IOException("Η κύρια βάση χρειάζεται φορητό κωδικό backup πριν από ασφαλή ανάκτηση.");
        if(!id.matches("[a-f0-9-]{36}"))throw new IOException("Μη έγκυρη ταυτότητα αντιγράφου.");
        NativeDatabaseSnapshot.Capture capture=null;File plain=null,probeDatabase=null,probeDocuments=null;
        try{
            progress.stage("Συνεπές στιγμιότυπο πλήρους SQLite",0,0);capture=NativeDatabaseSnapshot.create(database,new File(directory,"database-capture"));
            JSONObject manifest=capture.manifest;
            long objectBytes=0;for(int i=0;i<manifest.getJSONArray("objects").length();i++)objectBytes+=manifest.getJSONArray("objects").getJSONObject(i).getLong("size");
            if(directory.getUsableSpace()<capture.file.length()*(testRestore?4:2)+objectBytes*(testRestore?6:3)+16L*1024*1024)throw new IOException("Δεν υπάρχει αρκετός χώρος για πλήρες ασφαλές backup και δοκιμή ανάκτησης. Τα προηγούμενα αντίγραφα διατηρούνται.");
            JSONObject safeRoot=new JSONObject();for(String key:new String[]{"schemaVersion","realm","authPepper","recoveryToken","ownerId","sourceGeneration","sourceFingerprint"})safeRoot.put(key,recovery.get(key));
            JSONObject state=NativePrimaryState.read(database);if(!safeRoot.getString("realm").equals(state.getString("realm")))throw new IOException("Το στοιχείο ανάκτησης ανήκει σε διαφορετική σύνδεση Fleet.");
            if(safeRoot.getInt("schemaVersion")!=1||!safeRoot.getString("authPepper").matches("[A-Za-z0-9_-]{43}")||!safeRoot.getString("recoveryToken").matches("[A-Za-z0-9_-]{43}")||!safeRoot.getString("sourceGeneration").matches("[a-f0-9-]{36}")||!safeRoot.getString("sourceFingerprint").matches("[a-f0-9]{64}"))throw new IOException("Μη συμβατό στοιχείο φορητής ανάκτησης.");
            if(!state.optString("generation").isEmpty()&&!state.getString("generation").equals(safeRoot.getString("sourceGeneration")))throw new IOException("Άλλαξε η ταυτότητα Server πριν από το backup.");
            final BackupCipher.Progress encryptProgress=(done,total)->progress.stage("Κρυπτογράφηση πλήρους αντιγράφου",done,total);
            File encryptedDatabase=new File(directory,"native-"+id+".fcdb");BackupCipher.Result dbResult=envelope.encrypt(capture.file,encryptedDatabase,"database",encryptProgress);
            if(!dbResult.plainSha256.equals(manifest.getString("sha256")))throw new IOException("Το στιγμιότυπο της βάσης άλλαξε κατά την κρυπτογράφηση.");
            JSONObject inventory=NativeBackupRestoreProbe.inventory(manifest);
            ServiceDocumentArchive.Result archive=ServiceDocumentArchive.create(context,inventory,new File(directory,"archive-cache"),(label,done,total,bytes,byteTotal,name)->progress.stage(label,bytes,byteTotal));
            if(archive.expected!=manifest.getJSONArray("objects").length()||archive.included!=archive.expected)throw new IOException("Λείπουν ιδιωτικά τιμολόγια. Το νέο backup δεν δηλώθηκε πλήρες.");
            JSONObject job=new JSONObject().put("databasePath",encryptedDatabase.getName()).put("databaseBytes",encryptedDatabase.length()).put("databaseSha256",dbResult.fileSha256).put("databasePlainSha256",dbResult.plainSha256).put("expectedDocuments",archive.expected).put("includedDocuments",archive.included).put("missingDocuments",0).put("workforceIncluded",true).put("portable",true).put("keyId",envelope.keyId()).put("documentsReused",archive.reused);
            if(archive.included>0){
                File documents=new File(directory,archive.sha256+"-"+envelope.keyId()+".fcdocs"),marker=new File(documents.getPath()+".json");boolean reusable=false;String sha="";
                try{JSONObject previous=ServiceDocumentArchive.readJson(marker);sha=previous.getString("sha256");reusable=documents.isFile()&&documents.length()==previous.getLong("size")&&BackupCipher.digest(documents).equals(sha);}catch(Exception ignored){}
                if(!reusable){BackupCipher.Result result=envelope.encrypt(archive.file,documents,"documents",encryptProgress);if(!result.plainSha256.equals(archive.sha256))throw new IOException("Το πακέτο τιμολογίων άλλαξε κατά την κρυπτογράφηση.");sha=result.fileSha256;ServiceDocumentArchive.atomicJson(marker,new JSONObject().put("sha256",sha).put("size",result.size));}
                job.put("docsPath",documents.getName()).put("docsSha256",sha).put("docsBytes",documents.length()).put("archiveSha256",archive.sha256);
            }
            JSONObject proof=new JSONObject().put("restoreVerified",false).put("integrityVerified",true).put("databaseSha256",manifest.getString("sha256")).put("documentsVerified",true);
            if(testRestore){
                progress.stage("Πραγματική δοκιμή ανάκτησης πλήρους βάσης και αρχείων",0,0);
                probeDatabase=File.createTempFile("native-probe-",".sqlite",context.getCacheDir());envelope.decrypt(new FileInputStream(encryptedDatabase),probeDatabase,"database",null);
                if(archive.included>0){probeDocuments=File.createTempFile("native-probe-",".zip",context.getCacheDir());envelope.decrypt(new FileInputStream(new File(directory,job.getString("docsPath"))),probeDocuments,"documents",null);if(!NativeDatabaseSnapshot.digest(probeDocuments).equals(archive.sha256))throw new IOException("Δεν συμφωνεί το αποκρυπτογραφημένο πακέτο τιμολογίων.");}
                proof=NativeBackupRestoreProbe.run(context,probeDatabase,manifest,probeDocuments);
            }
            // No legacy empty fleet/workforce: an older APK must reject this
            // format, never mistake it for a valid empty production database.
            JSONObject data=new JSONObject().put("schemaVersion",6).put("application","Fleet Control Server").put("createdAt",manifest.getString("capturedAt")).put("settings",settings)
                .put("nativeDatabase",new JSONObject(manifest.toString()).put("encryptedSha256",dbResult.fileSha256).put("encryptedBytes",dbResult.size)).put("nativeRecovery",safeRoot)
                .put("documentsBackup",new JSONObject().put("expected",archive.expected).put("included",archive.included).put("archiveSha256",archive.included>0?archive.sha256:"").put("encryptedSha256",job.optString("docsSha256")).put("encryptedBytes",job.optLong("docsBytes"))).put("protection",new JSONObject().put("format","FCB3").put("keyId",envelope.keyId()));
            plain=new File(directory,"native-manifest-"+id+".json.part");BackupJsonWriter.write(plain,data,37L*1024*1024,null);File encryptedManifest=new File(directory,"native-"+id+".fcbackup");BackupCipher.Result dataResult=envelope.encrypt(plain,encryptedManifest,"data",encryptProgress);
            return job.put("dataPath",encryptedManifest.getName()).put("dataBytes",encryptedManifest.length()).put("dataSha256",dataResult.fileSha256).put("plainDataBytes",plain.length()).put("nativeProof",proof).put("localReady",true);
        }finally{if(plain!=null)plain.delete();if(probeDatabase!=null)probeDatabase.delete();if(probeDocuments!=null)probeDocuments.delete();if(capture!=null){try{NativeDatabaseSnapshot.release(database,capture.id);}finally{capture.file.delete();}}}
    }
}
