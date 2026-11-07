package gr.argyrismitsos.fleetserver;
import org.json.*;import java.io.*;import java.util.*;

/** Cold-process directory swap with a durable journal. Never opens a live SQLite connection. */
public final class NativeColdRestore {
    public interface Ports {
        void verifyPending(JSONObject marker)throws Exception;
        void verifySource(File database,JSONObject manifest)throws Exception;
        void installSecrets(JSONObject marker)throws Exception;
        void rollbackSecrets(JSONObject marker)throws Exception;
        void syncDirectory(File directory)throws Exception;
        default void checkpoint(String name)throws Exception{}
    }
    public static final String DATABASE_NAME="fleet-control-server.db";
    private final File root,databases,documents;
    private final Ports ports;
    public NativeColdRestore(File files,File databases,File documents,Ports ports){this.root=new File(files,"native-recovery");this.databases=databases;this.documents=documents;this.ports=ports;}
    public File directory(String id)throws Exception{if(!id.matches("[a-f0-9-]{36}"))throw new IOException("Μη έγκυρη ταυτότητα ανάκτησης.");File value=new File(root,id);if(!value.getCanonicalFile().getParentFile().equals(root.getCanonicalFile()))throw new IOException("Μη έγκυρος χώρος ανάκτησης.");return value;}
    private File marker(){return new File(root,"state.json");}
    public JSONObject state()throws Exception{return marker().exists()?ServiceDocumentArchive.readJson(marker()):new JSONObject();}
    private void save(JSONObject value,String phase)throws Exception{value.put("phase",phase).put("updatedAt",System.currentTimeMillis());ServiceDocumentArchive.atomicJson(marker(),value);ports.syncDirectory(root);ports.checkpoint(phase);}
    private void move(File from,File to)throws Exception{if(!from.exists()||to.exists()||!from.renameTo(to))throw new IOException("Δεν ολοκληρώθηκε η ατομική μεταφορά αρχείων ανάκτησης.");ports.syncDirectory(from.getParentFile());if(!from.getParentFile().equals(to.getParentFile()))ports.syncDirectory(to.getParentFile());ports.checkpoint("move:"+from.getName());}
    /** Files and isolated proof are prepared first; this only arms the next process. */
    public void arm(String id,JSONObject manifest,String pendingHash)throws Exception{
        JSONObject old=state();if(!old.optString("phase").isEmpty()&&!Arrays.asList("installed","failed").contains(old.optString("phase")))throw new IOException("Υπάρχει ήδη ανάκτηση που χρειάζεται συνέχεια.");
        if(!root.exists()&&!root.mkdirs())throw new IOException("Δεν δημιουργήθηκε ο χώρος ανάκτησης.");File directory=directory(id),stagedDb=new File(directory,"new-databases"),stagedDocs=new File(directory,"new-documents");
        if(!stagedDb.isDirectory()||!stagedDocs.isDirectory()||!pendingHash.matches("[a-f0-9]{64}"))throw new IOException("Δεν προετοιμάστηκαν όλα τα αρχεία ανάκτησης.");
        ports.verifySource(new File(stagedDb,DATABASE_NAME),manifest);
        JSONObject value=new JSONObject().put("id",id).put("manifest",manifest).put("pendingHash",pendingHash).put("oldDatabaseDirectory",databases.exists()).put("oldDocumentsDirectory",documents.exists());ports.verifyPending(value);save(value,"ready");
    }
    public boolean apply()throws Exception{
        JSONObject value=state();String phase=value.optString("phase");if(phase.isEmpty()||phase.equals("installed")||phase.equals("failed"))return false;
        if(!Arrays.asList("ready","swapping","database_installed","documents_installed","installing_secrets").contains(phase))throw new IOException("Μη συμβατή κατάσταση ανάκτησης.");
        File directory=directory(value.getString("id")),newDb=new File(directory,"new-databases"),newDocs=new File(directory,"new-documents"),oldDb=new File(directory,"old-databases"),oldDocs=new File(directory,"old-documents");
        try{
            ports.verifyPending(value);
            if(phase.equals("ready")||phase.equals("swapping")){
                if(newDb.exists())ports.verifySource(new File(newDb,DATABASE_NAME),value.getJSONObject("manifest"));else if(!databases.isDirectory())throw new IOException("Λείπει η προετοιμασμένη βάση ανάκτησης.");
                save(value,"swapping");
                if(value.getBoolean("oldDatabaseDirectory")&&!oldDb.exists())move(databases,oldDb);
                if(newDb.exists())move(newDb,databases);
                ports.verifySource(new File(databases,DATABASE_NAME),value.getJSONObject("manifest"));save(value,"database_installed");
            }
            if(!Arrays.asList("documents_installed","installing_secrets").contains(value.getString("phase"))){
                if(value.getBoolean("oldDocumentsDirectory")&&!oldDocs.exists())move(documents,oldDocs);
                if(newDocs.exists())move(newDocs,documents);if(!documents.isDirectory())throw new IOException("Λείπουν τα προετοιμασμένα ιδιωτικά αρχεία.");save(value,"documents_installed");
            }
            save(value,"installing_secrets");ports.installSecrets(value);ports.checkpoint("secrets-installed");save(value,"installed");return true;
        }catch(Exception error){
            // A process death (not an Exception) resumes forward from the journal.
            // An ordinary filesystem/validation failure restores the original directories.
            try{
                if(oldDb.exists()){if(databases.exists())move(databases,new File(directory,"failed-new-databases"));move(oldDb,databases);}else if(!value.getBoolean("oldDatabaseDirectory")&&!newDb.exists()&&databases.exists())move(databases,new File(directory,"failed-new-databases"));
                if(oldDocs.exists()){if(documents.exists())move(documents,new File(directory,"failed-new-documents"));move(oldDocs,documents);}else if(!value.getBoolean("oldDocumentsDirectory")&&!newDocs.exists()&&documents.exists())move(documents,new File(directory,"failed-new-documents"));
                ports.rollbackSecrets(value);value.put("error","Η ανάκτηση δεν εφαρμόστηκε. Διατηρήθηκαν τα προηγούμενα αρχεία.");save(value,"failed");
            }catch(Exception rollback){throw new IOException("Η ανάκτηση χρειάζεται αποκατάσταση πριν ανοίξει η βάση. Τα προηγούμενα αρχεία διατηρούνται στον ιδιωτικό χώρο ανάκτησης.",rollback);}
            throw error;
        }
    }
}
