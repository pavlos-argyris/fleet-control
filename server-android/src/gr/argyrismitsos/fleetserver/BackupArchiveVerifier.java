package gr.argyrismitsos.fleetserver;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.File;
import java.io.FileInputStream;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Reads every ZIP entry and its CRC; never creates files or changes the store. */
public final class BackupArchiveVerifier {
    public static final class Item {
        public long size;
        public String sha256;
        public byte[] prefix;
        public byte[] manifest;
    }
    private BackupArchiveVerifier() {}
    public static String hex(byte[] value) {
        StringBuilder out=new StringBuilder();for(byte b:value)out.append(String.format(java.util.Locale.US,"%02x",b&255));return out.toString();
    }
    public static String digest(byte[] bytes)throws Exception {return hex(MessageDigest.getInstance("SHA-256").digest(bytes));}
    public static boolean matches(Item item,long size,String sha){return item!=null&&item.size==size&&(sha==null||sha.length()==0||sha.equals(item.sha256));}
    public static Map<String,Item> inspect(byte[] bytes)throws Exception { return inspect(new ByteArrayInputStream(bytes)); }
    public static String digest(File file)throws Exception {MessageDigest hash=MessageDigest.getInstance("SHA-256");InputStream in=new FileInputStream(file);try{byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)hash.update(b,0,n);}finally{in.close();}return hex(hash.digest());}
    public static Map<String,Item> inspect(InputStream stream)throws Exception {
        Map<String,Item> items=new LinkedHashMap<String,Item>();long total=0;
        ZipInputStream zip=new ZipInputStream(stream);
        try {
            ZipEntry entry;
            while((entry=zip.getNextEntry())!=null){
                String name=entry.getName();
                if(entry.isDirectory()||name.startsWith("/")||name.contains("\\")||name.contains("../")||name.equals("..")||items.containsKey(name)||items.size()>=10000)throw new IOException("Μη έγκυρη δομή αρχείου τιμολογίων.");
                boolean manifest="fleet-control-documents.json".equals(name);
                if(!manifest&&!name.startsWith("documents/"))throw new IOException("Άγνωστο αρχείο στο backup τιμολογίων.");
                MessageDigest hash=MessageDigest.getInstance("SHA-256");ByteArrayOutputStream first=new ByteArrayOutputStream();ByteArrayOutputStream content=manifest?new ByteArrayOutputStream():null;
                long length=0;byte[] buffer=new byte[65536];int read;
                while((read=zip.read(buffer))!=-1){length+=read;total+=read;if(length>(manifest?1048576:15*1024*1024)||total>256L*1024*1024)throw new IOException("Το αρχείο τιμολογίων υπερβαίνει τα όρια ελέγχου.");hash.update(buffer,0,read);if(first.size()<8)first.write(buffer,0,Math.min(read,8-first.size()));if(content!=null)content.write(buffer,0,read);}
                zip.closeEntry();Item item=new Item();item.size=length;item.sha256=hex(hash.digest());item.prefix=first.toByteArray();item.manifest=content==null?null:content.toByteArray();items.put(name,item);
            }
        }finally{zip.close();}
        if(!items.containsKey("fleet-control-documents.json"))throw new IOException("Λείπει ο κατάλογος τιμολογίων από το backup.");
        return items;
    }
}
