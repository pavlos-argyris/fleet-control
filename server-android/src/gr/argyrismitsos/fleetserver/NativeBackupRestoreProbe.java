package gr.argyrismitsos.fleetserver;
import android.content.Context;import android.content.ContextWrapper;
import org.json.*;import java.io.*;import java.util.*;

/** Restores the exact database and all private object versions into disposable paths. */
public final class NativeBackupRestoreProbe {
    private NativeBackupRestoreProbe(){}
    public static JSONObject inventory(JSONObject database)throws Exception{
        JSONArray attachments=new JSONArray(),objects=database.getJSONArray("objects");
        for(int i=0;i<objects.length();i++){JSONObject object=objects.getJSONObject(i);attachments.put(new JSONObject().put("key",object.getString("key")).put("name",object.getString("name")).put("contentType",object.getString("content_type")).put("localName",object.getString("local_name")).put("expectedSha256",object.getString("sha256")));}
        return new JSONObject().put("bikes",new JSONArray().put(new JSONObject().put("id","native-private-objects").put("history",new JSONArray().put(new JSONObject().put("id","private-object-inventory").put("type","service").put("attachments",attachments)))));
    }
    private static void remove(File file)throws Exception{if(!file.exists())return;if(file.isDirectory()){File[] children=file.listFiles();if(children==null)throw new IOException("Δεν διαβάστηκε ο προσωρινός χώρος δοκιμής.");for(File child:children)remove(child);}if(!file.delete())throw new IOException("Δεν καθαρίστηκε ο προσωρινός χώρος δοκιμής ανάκτησης.");}
    public static JSONObject run(final Context context,File database,JSONObject manifest,File documents)throws Exception{
        final File root=new File(context.getCacheDir(),"native-recovery-probe-"+UUID.randomUUID().toString());if(!root.mkdirs())throw new IOException("Δεν δημιουργήθηκε απομονωμένος χώρος ανάκτησης.");
        try{
            JSONObject result=NativeDatabaseSnapshot.verifyIsolated(database,manifest,new File(root,"database"));
            Context isolated=new ContextWrapper(context){@Override public File getFilesDir(){File file=new File(root,"files");file.mkdirs();return file;}@Override public File getCacheDir(){File file=new File(root,"cache");file.mkdirs();return file;}};
            JSONArray objects=manifest.getJSONArray("objects");int restored=0;
            if(objects.length()>0){
                if(documents==null)throw new IOException("Λείπει το πακέτο ιδιωτικών τιμολογίων.");
                Map<String,BackupArchiveVerifier.Item> entries=BackupArchiveVerifier.inspect(new FileInputStream(documents));JSONArray archived=new JSONArray(new String(entries.get("fleet-control-documents.json").manifest,"UTF-8"));
                if(archived.length()!=objects.length())throw new IOException("Το πακέτο τιμολογίων δεν έχει την κάλυψη της βάσης.");
                JSONObject restoredInfo=ServiceDocumentStore.restoreArchive(isolated,inventory(manifest),new FileInputStream(documents));restored=restoredInfo.getInt("restored");
                if(restored!=objects.length())throw new IOException("Δεν ανακτήθηκαν όλα τα ιδιωτικά αρχεία.");
                for(int i=0;i<objects.length();i++){
                    JSONObject object=objects.getJSONObject(i),metadata=new JSONObject().put("key",object.getString("key")).put("name",object.getString("name")).put("localName",object.getString("local_name"));File file=ServiceDocumentStore.inventoryFile(isolated,metadata);
                    if(file.length()!=object.getLong("size")||!NativeDatabaseSnapshot.digest(file).equals(object.getString("sha256")))throw new IOException("Δεν συμφωνεί ιδιωτικό αρχείο μετά την πραγματική ανάκτηση.");
                }
            }
            return result.put("documentsVerified",true).put("documentsRestored",restored).put("fullPrimaryDatabase",true);
        }finally{remove(root);}
    }
}
