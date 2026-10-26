package gr.argyrismitsos.fleetserver;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.Charset;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Full, reusable archive of the original invoice files; no archive-sized RAM buffer. */
public final class ServiceDocumentArchive {
    public interface Progress {void stage(String stage,int files,int total,long bytes,long byteTotal,String name)throws Exception;}
    public static final class Result {public File file;public String sha256;public int expected,included;public long bytes;public boolean reused;}
    private static final Charset UTF8=Charset.forName("UTF-8");
    private ServiceDocumentArchive(){}
    static void atomicJson(File file,JSONObject value)throws Exception{File part=new File(file.getPath()+".part");FileOutputStream out=new FileOutputStream(part);try{out.write(value.toString().getBytes(UTF8));out.flush();out.getFD().sync();}finally{out.close();}if(!part.renameTo(file))throw new IOException("Δεν αποθηκεύτηκε η πρόοδος backup.");}
    static JSONObject readJson(File file)throws Exception{InputStream in=new FileInputStream(file);ByteArrayOutputStream out=new ByteArrayOutputStream();try{byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1){if(out.size()+n>2*1024*1024)throw new IOException("Μεγάλος κατάλογος backup.");out.write(b,0,n);}}finally{in.close();}return new JSONObject(new String(out.toByteArray(),UTF8));}
    public static Result create(Context context,JSONObject fleet,File directory,Progress progress)throws Exception{
        if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("Δεν δημιουργήθηκε ο φάκελος προετοιμασίας backup.");
        Map<String,JSONObject> unique=new TreeMap<String,JSONObject>();JSONArray bikes=fleet.optJSONArray("bikes");
        if(bikes!=null)for(int i=0;i<bikes.length();i++){JSONObject bike=bikes.optJSONObject(i);JSONArray history=bike==null?null:bike.optJSONArray("history");if(history==null)continue;
            for(int j=0;j<history.length();j++){JSONObject entry=history.optJSONObject(j);JSONArray files=ServiceDocumentStore.invoiceFiles(entry==null?null:entry.optJSONArray("attachments"));for(int k=0;k<files.length();k++){JSONObject f=files.optJSONObject(k);String key=f.optString("key","");if(!key.startsWith("service-documents/")||unique.containsKey(key))continue;
                File local=ServiceDocumentStore.localFile(context,key,f.optString("name",""));JSONObject item=new JSONObject().put("key",key).put("bikeId",bike.optString("id")).put("entryId",entry.optString("id")).put("name",f.optString("name","τιμολόγιο")).put("originalName",f.optString("originalName","")).put("contentType",f.optString("contentType","application/pdf")).put("qrValue",f.optString("qrValue","")).put("qrUrl",f.optString("qrUrl","")).put("renderJobId",f.optString("renderJobId","")).put("localSize",local.isFile()?local.length():0).put("localModified",local.isFile()?local.lastModified():0);unique.put(key,item);
            }}
        }
        Result result=new Result();result.expected=unique.size();JSONArray signature=new JSONArray();long total=0;List<JSONObject> available=new ArrayList<JSONObject>();
        for(JSONObject item:unique.values()){signature.put(item);long size=item.optLong("localSize");if(size<=0)continue;if(size>15L*1024*1024)throw new IOException("Το τιμολόγιο "+item.optString("name")+" υπερβαίνει τα 15 MB.");total+=size;if(total>256L*1024*1024)throw new IOException("Τα αρχεία backup υπερβαίνουν το όριο 256 MB. Τα αρχικά αρχεία διατηρούνται.");available.add(item);}
        String fingerprint=BackupArchiveVerifier.digest(signature.toString().getBytes(UTF8));File index=new File(directory,"archive-index.json"),zipFile=new File(directory,"documents.zip");
        try{JSONObject saved=readJson(index);if(zipFile.isFile()&&zipFile.length()==saved.optLong("size")&&fingerprint.equals(saved.optString("fingerprint"))&&saved.optString("sha256").equals(BackupArchiveVerifier.digest(zipFile))){result.file=zipFile;result.sha256=saved.getString("sha256");result.bytes=zipFile.length();result.included=saved.optInt("included");result.reused=true;if(progress!=null)progress.stage("Αμετάβλητα αρχεία · χρήση έτοιμου πακέτου",result.included,result.expected,total,total,"");return result;}}catch(Exception ignored){}
        if(directory.getUsableSpace()<total*5/2+10L*1024*1024)throw new IOException("Δεν υπάρχει αρκετός ελεύθερος χώρος για ασφαλή προετοιμασία backup. Ελευθέρωσε χώρο και επανάλαβε· τα αρχικά αρχεία διατηρούνται.");
        JSONArray manifest=new JSONArray();int checked=0;long checkedBytes=0;byte[] buffer=new byte[65536];
        for(JSONObject item:available){File local=ServiceDocumentStore.localFile(context,item.getString("key"),item.getString("name"));MessageDigest hash=MessageDigest.getInstance("SHA-256");CRC32 crc=new CRC32();InputStream in=new BufferedInputStream(new FileInputStream(local));long size=0;try{int n;while((n=in.read(buffer))!=-1){if(Thread.currentThread().isInterrupted())throw new InterruptedIOException();hash.update(buffer,0,n);crc.update(buffer,0,n);size+=n;checkedBytes+=n;if(progress!=null)progress.stage("Έλεγχος αρχικών τιμολογίων",checked,available.size(),checkedBytes,total,item.getString("name"));}}finally{in.close();}
            if(size!=item.optLong("localSize")||local.lastModified()!=item.optLong("localModified"))throw new IOException("Το τιμολόγιο άλλαξε κατά το backup. Δοκίμασε ξανά.");
            item.put("size",size).put("sha256",BackupArchiveVerifier.hex(hash.digest())).put("crc",crc.getValue()).put("zipName","documents/"+checked+extension(item.getString("name")));item.remove("localSize");item.remove("localModified");manifest.put(item);checked++;
        }
        File part=new File(zipFile.getPath()+".part");FileOutputStream disk=new FileOutputStream(part);MessageDigest archiveHash=MessageDigest.getInstance("SHA-256");ZipOutputStream zip=new ZipOutputStream(new BufferedOutputStream(new java.security.DigestOutputStream(disk,archiveHash)));long written=0;boolean complete=false;
        try{
            byte[] json=manifest.toString().getBytes(UTF8);CRC32 crc=new CRC32();crc.update(json);entry(zip,"fleet-control-documents.json",json.length,crc.getValue());zip.write(json);zip.closeEntry();
            for(int i=0;i<manifest.length();i++){JSONObject item=manifest.getJSONObject(i);entry(zip,item.getString("zipName"),item.optLong("size"),item.optLong("crc"));InputStream in=new BufferedInputStream(new FileInputStream(ServiceDocumentStore.localFile(context,item.getString("key"),item.getString("name"))));try{int n;while((n=in.read(buffer))!=-1){if(Thread.currentThread().isInterrupted())throw new InterruptedIOException();zip.write(buffer,0,n);written+=n;if(progress!=null)progress.stage("Αρχειοθέτηση τιμολογίων",i,manifest.length(),written,total,item.getString("name"));}}finally{in.close();}zip.closeEntry();}
            zip.finish();zip.flush();disk.getFD().sync();zip.close();if(!part.renameTo(zipFile))throw new IOException("Δεν ολοκληρώθηκε η αρχειοθέτηση.");
            result.file=zipFile;result.sha256=BackupArchiveVerifier.hex(archiveHash.digest());result.bytes=zipFile.length();result.included=manifest.length();
            atomicJson(index,new JSONObject().put("fingerprint",fingerprint).put("size",result.bytes).put("sha256",result.sha256).put("included",result.included));complete=true;return result;
        }finally{try{zip.close();}catch(Exception ignored){}if(!complete)part.delete();}
    }
    private static void entry(ZipOutputStream zip,String name,long size,long crc)throws Exception{ZipEntry entry=new ZipEntry(name);entry.setMethod(ZipEntry.STORED);entry.setSize(size);entry.setCompressedSize(size);entry.setCrc(crc);entry.setTime(0);zip.putNextEntry(entry);}
    private static String extension(String name){String s=name.toLowerCase(java.util.Locale.ROOT);return s.endsWith(".pdf")?".pdf":s.endsWith(".png")?".png":s.endsWith(".webp")?".webp":".jpg";}
}
