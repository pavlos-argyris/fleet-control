package gr.argyrismitsos.fleetserver;
import android.content.*;import android.net.Uri;import android.provider.DocumentsContract;import org.json.*;import java.io.*;import java.util.*;

/** Export all verified encrypted parts to an owner-selected, separately stored folder; manifest last. */
public final class IndependentBackup {
    private IndependentBackup(){}
    static JSONObject export(Context c,Uri tree,String password)throws Exception{
        JSONObject config=IndependentConfig.read(c);IndependentRuntime runtime=IndependentRuntime.get(c);BackupProtection.configure(c,password);
        String id=UUID.randomUUID().toString(),stamp=new java.text.SimpleDateFormat("yyyyMMdd_HHmmss",Locale.US).format(new Date());File directory=new File(c.getFilesDir(),"independent-backups/"+id);if(!directory.mkdirs())throw new IOException("Δεν δημιουργήθηκε ο ιδιωτικός χώρος backup.");
        JSONObject recovery=new JSONObject().put("schemaVersion",1).put("realm",runtime.realm()).put("authPepper",config.getString("authPepper")).put("recoveryToken",config.getString("recoveryToken")).put("ownerId",config.getString("ownerId")).put("sourceGeneration",config.getString("generation")).put("sourceFingerprint",BusinessRuntime.sha256(config.getString("instanceId").getBytes("UTF-8")));
        JSONObject result;try(FleetDataStore store=new FleetDataStore(c);BackupEnvelope envelope=BackupEnvelope.open(c)){
            result=NativeBackupBuilder.prepare(c,store.getWritableDatabase(),directory,id,new JSONObject().put("workerUrl",runtime.realm()).put("sourceScopeRealm",config.getString("sourceScopeRealm")),recovery,envelope,new NativeBackupBuilder.Progress(){public void stage(String label,long done,long total){c.getSharedPreferences("independent_ui",Context.MODE_PRIVATE).edit().putString("backup",label).apply();}});
        }
        if(!result.getJSONObject("nativeProof").optBoolean("restoreVerified"))throw new IOException("Δεν επαληθεύτηκε η ανάκτηση του νέου backup.");
        Uri parent=DocumentsContract.buildDocumentUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree));
        write(c,parent,new File(directory,result.getString("databasePath")),"FleetControl_database_"+stamp+".fcdb");
        if(result.optInt("includedDocuments")>0)write(c,parent,new File(directory,result.getString("docsPath")),"FleetControl_documents_"+stamp+".fcdocs");
        write(c,parent,new File(directory,result.getString("dataPath")),"FleetControl_backup_"+stamp+".fcbackup");
        IndependentConfig.save(c,IndependentConfig.read(c).put("lastBackupAt",System.currentTimeMillis()).put("lastBackupExternalFolder",tree.toString()));return result.put("exported",true);
    }
    private static int countName(Context c,Uri parent,String name)throws Exception{int count=0;Uri children=DocumentsContract.buildChildDocumentsUriUsingTree(parent,DocumentsContract.getDocumentId(parent));try(android.database.Cursor cursor=c.getContentResolver().query(children,new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null)){if(cursor==null)throw new IOException("Δεν ελέγχθηκε ο φάκελος backup.");while(cursor.moveToNext())if(name.equals(cursor.getString(0)))count++;}return count;}
    private static void write(Context c,Uri parent,File source,String name)throws Exception{
        if(countName(c,parent,name)!=0)throw new IOException("Υπάρχει ήδη αρχείο με αυτό το όνομα backup. Επανάλαβε για νέο ξεχωριστό πακέτο.");
        Uri created=DocumentsContract.createDocument(c.getContentResolver(),parent,"application/octet-stream",name);if(created==null)throw new IOException("Δεν δημιουργήθηκε το αρχείο εξαγωγής backup.");boolean ok=false;
        try{
            if(!name.equals(BackupManager.queryDisplayName(c,created))||countName(c,parent,name)!=1)throw new IOException("Ο πάροχος αρχείων άλλαξε ή διπλασίασε το όνομα backup. Δεν δημοσιεύεται πλήρες πακέτο.");
            try(InputStream in=new FileInputStream(source);OutputStream out=c.getContentResolver().openOutputStream(created,"w")){if(out==null)throw new IOException("Δεν άνοιξε το αρχείο backup.");byte[] buffer=new byte[65536];int n;while((n=in.read(buffer))!=-1)out.write(buffer,0,n);}
            java.security.MessageDigest digest=java.security.MessageDigest.getInstance("SHA-256");long count=0;try(InputStream input=c.getContentResolver().openInputStream(created)){if(input==null)throw new IOException("Δεν διαβάστηκε ξανά το εξαγόμενο backup.");byte[] buffer=new byte[65536];int n;while((n=input.read(buffer))!=-1){digest.update(buffer,0,n);count+=n;}}
            if(count!=source.length()||!BusinessPrimitives.hex(digest.digest()).equals(NativeDatabaseSnapshot.digest(source)))throw new IOException("Το εξαγόμενο backup δεν συμφωνεί με το ελεγμένο αρχείο.");ok=true;
        }finally{if(!ok)try{DocumentsContract.deleteDocument(c.getContentResolver(),created);}catch(Exception ignored){}}
    }
}
