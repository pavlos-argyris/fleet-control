package gr.argyrismitsos.fleetserver;

import org.json.*;
import java.io.*;
import java.security.*;
import java.util.*;

/** Reads matched FCB3 parts into private temporary paths, never the live DB. */
public final class NativeBackupReader {
    public interface Source { InputStream open(String kind)throws Exception; }
    public interface Decoder { File decrypt(InputStream input,File destination,String kind)throws Exception; }
    public static final class Prepared implements AutoCloseable {
        public final File database,documents;public final JSONObject manifest,verification;
        private final File directory;
        Prepared(File directory,File database,File documents,JSONObject manifest,JSONObject verification){this.directory=directory;this.database=database;this.documents=documents;this.manifest=manifest;this.verification=verification;}
        @Override public void close()throws IOException{remove(directory);}
    }
    private NativeBackupReader(){}
    public static boolean isNative(JSONObject root){return root.has("nativeDatabase")||root.optInt("schemaVersion")==6;}
    public static void validate(JSONObject root,boolean portableAuthenticated)throws Exception{
        if(root.optInt("schemaVersion")!=6||!portableAuthenticated||root.has("fleet")||root.has("workforce"))throw new IOException("Η πλήρης κύρια βάση χρειάζεται αυθεντικοποιημένο backup FCB3 και συμβατό Server.");
        JSONObject recovery=root.getJSONObject("nativeRecovery"),protection=root.getJSONObject("protection"),database=root.getJSONObject("nativeDatabase"),documents=root.getJSONObject("documentsBackup");
        String realm=recovery.getString("realm");java.net.URI uri=new java.net.URI(realm);
        if(!"https".equals(uri.getScheme())||uri.getHost()==null||uri.getUserInfo()!=null||uri.getRawQuery()!=null||uri.getRawFragment()!=null||uri.getPath().length()>0||!realm.equals(root.getJSONObject("settings").getString("workerUrl").replaceAll("/+$","")))throw new IOException("Μη έγκυρη σύνδεση ανάκτησης Fleet.");
        if(recovery.optInt("schemaVersion")!=1||!recovery.getString("authPepper").matches("[A-Za-z0-9_-]{43}")||!recovery.getString("recoveryToken").matches("[A-Za-z0-9_-]{43}")||!recovery.getString("sourceGeneration").matches("[a-f0-9-]{36}")||!recovery.getString("sourceFingerprint").matches("[a-f0-9]{64}")||recovery.getString("ownerId").isEmpty())throw new IOException("Μη συμβατά στοιχεία φορητής ανάκτησης.");
        if(!"FCB3".equals(protection.getString("format"))||!protection.getString("keyId").matches("[a-f0-9]{32}")||!database.getString("encryptedSha256").matches("[a-f0-9]{64}")||database.getLong("encryptedBytes")<=0)throw new IOException("Μη έγκυρα στοιχεία κρυπτογράφησης της βάσης backup.");
        int count=database.getJSONArray("objects").length();
        if(documents.getInt("expected")!=count||documents.getInt("included")!=count||count>0&&(!documents.getString("archiveSha256").matches("[a-f0-9]{64}")||!documents.getString("encryptedSha256").matches("[a-f0-9]{64}")||documents.getLong("encryptedBytes")<=0))throw new IOException("Ελλιπής κατάλογος συνοδευτικών αρχείων backup.");
    }
    public static Prepared open(JSONObject root,File cache,Source source,Decoder decoder)throws Exception{
        validate(root,root.optBoolean("_portableAuthenticated"));
        File directory=new File(cache,"native-backup-read-"+UUID.randomUUID());if(!directory.mkdirs())throw new IOException("Δεν δημιουργήθηκε ιδιωτικός χώρος ελέγχου backup.");boolean complete=false;
        try{
            JSONObject manifest=root.getJSONObject("nativeDatabase");File database=new File(directory,"database.sqlite"),documents=null;
            decodePart(source,decoder,database,"database",manifest);
            JSONObject verification=NativeDatabaseSnapshot.verifyReadOnly(database,manifest);int count=manifest.getJSONArray("objects").length();
            if(count>0){
                documents=new File(directory,"documents.zip");JSONObject metadata=root.getJSONObject("documentsBackup");decodePart(source,decoder,documents,"documents",metadata);
                if(!NativeDatabaseSnapshot.digest(documents).equals(metadata.getString("archiveSha256")))throw new IOException("Το αρχείο τιμολογίων δεν αντιστοιχεί σε αυτό το backup.");
                verifyDocuments(documents,manifest);
            }
            verification.put("readable",true).put("complete",true).put("fullPrimaryDatabase",true).put("workforceIncluded",true).put("expectedDocuments",count).put("includedDocuments",count).put("missingDocuments",0).put("documentsVerified",true).put("requiresRecoveryHandover",true).put("message","Επαληθεύτηκαν η πλήρης βάση και όλα τα ιδιωτικά αρχεία. Η δοκιμή ανάκτησης καταγράφεται χωριστά.");
            complete=true;return new Prepared(directory,database,documents,manifest,verification);
        }finally{if(!complete)remove(directory);}
    }
    private static void decodePart(Source source,Decoder decoder,File destination,String kind,JSONObject metadata)throws Exception{
        InputStream raw=source.open(kind);if(raw==null)throw new IOException("Λείπει το συνοδευτικό "+(kind.equals("database")?"αρχείο βάσης (.fcdb).":"αρχείο τιμολογίων (.fcdocs)."));
        final MessageDigest hash=MessageDigest.getInstance("SHA-256");final long[] count={0};
        InputStream checked=new FilterInputStream(raw){@Override public int read()throws IOException{int b=in.read();if(b>=0){hash.update((byte)b);count[0]++;}return b;}@Override public int read(byte[] bytes,int offset,int length)throws IOException{int n=in.read(bytes,offset,length);if(n>0){hash.update(bytes,offset,n);count[0]+=n;}return n;}};
        try{
            PushbackInputStream input=new PushbackInputStream(checked,5);byte[] prefix=new byte[5];int at=0,n;while(at<5&&(n=input.read(prefix,at,5-at))!=-1)at+=n;
            if(at!=5||!new String(prefix,"US-ASCII").equals("FCB3\n"))throw new IOException("Το συνοδευτικό αρχείο δεν έχει φορητή προστασία FCB3.");input.unread(prefix);decoder.decrypt(input,destination,kind);
        }finally{checked.close();}
        StringBuilder sha=new StringBuilder();for(byte b:hash.digest()){sha.append(Character.forDigit((b>>>4)&15,16));sha.append(Character.forDigit(b&15,16));}
        if(count[0]!=metadata.getLong("encryptedBytes")||!sha.toString().equals(metadata.getString("encryptedSha256")))throw new IOException("Το συνοδευτικό αρχείο άλλαξε ή ανήκει σε άλλο backup.");
    }
    private static void verifyDocuments(File documents,JSONObject manifest)throws Exception{
        Map<String,BackupArchiveVerifier.Item> entries=BackupArchiveVerifier.inspect(new FileInputStream(documents));BackupArchiveVerifier.Item index=entries.get("fleet-control-documents.json");
        if(index==null)throw new IOException("Λείπει ο κατάλογος ιδιωτικών αρχείων.");JSONArray archived=new JSONArray(new String(index.manifest,"UTF-8")),objects=manifest.getJSONArray("objects");
        if(archived.length()!=objects.length()||entries.size()!=objects.length()+1)throw new IOException("Δεν συμφωνεί η κάλυψη ιδιωτικών αρχείων.");
        Map<String,JSONObject> expected=new HashMap<String,JSONObject>();for(int i=0;i<objects.length();i++)expected.put(objects.getJSONObject(i).getString("key"),objects.getJSONObject(i));Set<String> seen=new HashSet<String>(),paths=new HashSet<String>();
        for(int i=0;i<archived.length();i++){
            JSONObject item=archived.getJSONObject(i),object=expected.get(item.getString("key"));String path=item.getString("zipName");
            if(object==null||!seen.add(item.getString("key"))||!paths.add(path)||!item.getString("localName").equals(object.getString("local_name"))||!item.getString("name").equals(object.getString("name"))||!item.getString("contentType").equals(object.getString("content_type"))||!item.getString("sha256").equals(object.getString("sha256"))||!BackupArchiveVerifier.matches(entries.get(path),object.getLong("size"),object.getString("sha256")))throw new IOException("Διαφορετικό ιδιωτικό αρχείο στον κατάλογο backup.");
        }
    }
    private static void remove(File file)throws IOException{if(!file.exists())return;if(file.isDirectory()){File[] children=file.listFiles();if(children==null)throw new IOException("Δεν διαβάστηκε ο προσωρινός χώρος backup.");for(File child:children)remove(child);}if(!file.delete())throw new IOException("Δεν καθαρίστηκε ο προσωρινός χώρος backup.");}
}
