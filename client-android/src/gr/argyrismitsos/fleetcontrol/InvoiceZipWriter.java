package gr.argyrismitsos.fleetcontrol;

import java.io.InputStream;
import java.io.OutputStream;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.util.List;
import java.util.Set;
import java.util.HashSet;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Bounded streaming PDF archive. No complete PDF or ZIP is held in memory. */
public final class InvoiceZipWriter {
    public static final long MAX_FILE = 15L * 1024 * 1024;
    public static final long MAX_TOTAL = 512L * 1024 * 1024;
    public static final class Item {
        public final String key, name;
        public Item(String key, String name) { this.key=key; this.name=name; }
    }
    public interface Source { InputStream open(String key) throws Exception; }
    public interface Control { boolean cancelled(); void progress(int files,int total,long bytes); }
    private static void check(Control control) throws InterruptedIOException { if(control.cancelled()||Thread.currentThread().isInterrupted())throw new InterruptedIOException("Cancelled"); }
    public static long write(List<Item> files,OutputStream output,Source source,Control control) throws Exception {
        if(files==null||files.isEmpty()||files.size()>500)throw new IOException("Invalid PDF count");
        Set<String> names=new HashSet<String>(),keys=new HashSet<String>();
        for(Item file:files){if(file==null||file.key==null||!file.key.startsWith("service-documents/")||file.key.contains("..")||file.key.contains("\n")||file.key.contains("\r")||file.key.length()>500||!keys.add(file.key))throw new IOException("Invalid document key");
            if(file.name==null||file.name.length()>260||file.name.startsWith("/")||file.name.contains("\\")||file.name.indexOf('\0')>=0||!file.name.toLowerCase(java.util.Locale.ROOT).endsWith(".pdf")||!names.add(file.name))throw new IOException("Invalid archive name");
            for(String part:file.name.split("/",-1))if(part.length()==0||".".equals(part)||"..".equals(part))throw new IOException("Unsafe archive name");
        }
        long total=0;int completed=0;ZipOutputStream zip=new ZipOutputStream(output);zip.setLevel(1);
        try {byte[] buffer=new byte[32*1024];for(Item file:files){check(control);InputStream input=source.open(file.key);if(input==null)throw new IOException("PDF unavailable");
            try{byte[] prefix=new byte[5];int prefixSize=0;while(prefixSize<5){check(control);int n=input.read(prefix,prefixSize,5-prefixSize);if(n<0)break;if(n>0)prefixSize+=n;}
                if(prefixSize!=5||prefix[0]!='%'||prefix[1]!='P'||prefix[2]!='D'||prefix[3]!='F'||prefix[4]!='-')throw new IOException("Invalid PDF");
                ZipEntry entry=new ZipEntry(file.name);entry.setTime(0L);zip.putNextEntry(entry);zip.write(prefix);long size=5;total+=5;
                int count;while((count=input.read(buffer))!=-1){check(control);if(count==0)continue;size+=count;total+=count;if(size>MAX_FILE||total>MAX_TOTAL)throw new IOException("PDF archive size limit");zip.write(buffer,0,count);}
                zip.closeEntry();completed++;control.progress(completed,files.size(),total);
            }finally{input.close();}
        }check(control);zip.finish();output.flush();return total;
        }finally{zip.close();}
    }
    private InvoiceZipWriter() {}
}
