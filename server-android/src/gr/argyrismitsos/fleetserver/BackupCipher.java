package gr.argyrismitsos.fleetserver;

import android.util.Base64;
import android.util.Base64InputStream;
import android.util.Base64OutputStream;
import java.io.*;
import java.nio.charset.Charset;
import java.security.MessageDigest;
import java.security.SecureRandom;

import org.bouncycastle.crypto.engines.AESEngine;
import org.bouncycastle.crypto.modes.GCMBlockCipher;
import org.bouncycastle.crypto.modes.GCMModeCipher;
import org.bouncycastle.crypto.params.AEADParameters;
import org.bouncycastle.crypto.params.KeyParameter;

/** File streaming with the existing FCB2 wire format and encryption key. */
public final class BackupCipher {
    private static final byte[] MAGIC="FCB2\n".getBytes(Charset.forName("UTF-8"));
    public static final long MAX_DOCUMENT_BYTES=258L*1024*1024;
    public interface Progress { void bytes(long done,long total)throws Exception; }
    public static final class Result {public final String fileSha256,plainSha256;public final long size;Result(String f,String p,long s){fileSha256=f;plainSha256=p;size=s;}}
    private BackupCipher(){}
    public static String digest(File file)throws Exception {MessageDigest digest=MessageDigest.getInstance("SHA-256");InputStream in=new BufferedInputStream(new FileInputStream(file));try{byte[] b=new byte[65536];int n;while((n=in.read(b))!=-1)digest.update(b,0,n);}finally{in.close();}return BackupArchiveVerifier.hex(digest.digest());}
    public static Result encrypt(File source,File destination,byte[] key,Progress progress)throws Exception{
        File part=new File(destination.getPath()+".part");File parent=part.getParentFile();if(!parent.isDirectory()&&!parent.mkdirs())throw new IOException("Δεν δημιουργήθηκε ο τοπικός φάκελος backup.");
        MessageDigest plainHash=MessageDigest.getInstance("SHA-256"),fileHash=MessageDigest.getInstance("SHA-256");
        FileOutputStream disk=new FileOutputStream(part);InputStream input=null;Base64OutputStream encoded=null;boolean complete=false;
        try{
            final java.security.DigestOutputStream digest=new java.security.DigestOutputStream(disk,fileHash);digest.write(MAGIC);
            OutputStream shield=new FilterOutputStream(digest){@Override public void close()throws IOException{flush();}};
            encoded=new Base64OutputStream(shield,Base64.NO_WRAP);byte[] iv=new byte[12];new SecureRandom().nextBytes(iv);encoded.write(iv);
            // Use the bundled incremental GCM implementation. Android providers
            // are allowed to buffer an entire AEAD message even through streams.
            GCMModeCipher cipher=GCMBlockCipher.newInstance(AESEngine.newInstance());cipher.init(true,new AEADParameters(new KeyParameter(key),128,iv));byte[] transformed=new byte[65568];
            input=new BufferedInputStream(new FileInputStream(source));byte[] buffer=new byte[65536];int n;long done=0;
            while((n=input.read(buffer))!=-1){if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Η προετοιμασία backup διακόπηκε με ασφάλεια.");done+=n;if(done>MAX_DOCUMENT_BYTES)throw new IOException("Το πακέτο τιμολογίων υπερβαίνει το όριο 256 MB.");plainHash.update(buffer,0,n);int amount=cipher.processBytes(buffer,0,n,transformed,0);encoded.write(transformed,0,amount);if(progress!=null)progress.bytes(done,source.length());}
            int tail=cipher.doFinal(transformed,0);encoded.write(transformed,0,tail);encoded.close();encoded=null;disk.getFD().sync();disk.close();input.close();input=null;
            if(destination.exists()&&!destination.delete())throw new IOException("Δεν αντικαταστάθηκε το τοπικό αντίγραφο.");if(!part.renameTo(destination))throw new IOException("Δεν ολοκληρώθηκε το τοπικό αντίγραφο.");complete=true;
            return new Result(BackupArchiveVerifier.hex(fileHash.digest()),BackupArchiveVerifier.hex(plainHash.digest()),destination.length());
        }finally{if(input!=null)try{input.close();}catch(Exception ignored){}if(encoded!=null)try{encoded.close();}catch(Exception ignored){}try{disk.close();}catch(Exception ignored){}if(!complete)part.delete();}
    }
    public static File decrypt(InputStream raw,File destination,byte[] key)throws Exception{
        File part=new File(destination.getPath()+".part");
        InputStream bounded=new FilterInputStream(raw){long count;private void counted(int n)throws IOException{if(n>0){count+=n;if(count>360L*1024*1024)throw new IOException("Το κρυπτογραφημένο αρχείο τιμολογίων υπερβαίνει το όριο ασφαλείας.");}}@Override public int read()throws IOException{int n=in.read();if(n>=0)counted(1);return n;}@Override public int read(byte[] b,int off,int len)throws IOException{int n=in.read(b,off,len);counted(n);return n;}};
        PushbackInputStream input=new PushbackInputStream(new BufferedInputStream(bounded),MAGIC.length);OutputStream out=null;boolean complete=false;
        try{
            byte[] prefix=new byte[MAGIC.length];int count=0,n;while(count<prefix.length&&(n=input.read(prefix,count,prefix.length-count))!=-1)count+=n;
            boolean encrypted=count==MAGIC.length&&java.util.Arrays.equals(prefix,MAGIC);InputStream payload=input;GCMModeCipher cipher=null;
            if(encrypted){Base64InputStream decoded=new Base64InputStream(input,Base64.DEFAULT);byte[] iv=new byte[12];int at=0;while(at<iv.length&&(n=decoded.read(iv,at,iv.length-at))!=-1)at+=n;if(at!=12)throw new IOException("Το κρυπτογραφημένο backup είναι ελλιπές.");cipher=GCMBlockCipher.newInstance(AESEngine.newInstance());cipher.init(false,new AEADParameters(new KeyParameter(key),128,iv));payload=decoded;}else input.unread(prefix,0,count);
            out=new BufferedOutputStream(new FileOutputStream(part));byte[] buffer=new byte[65536],transformed=new byte[65568];long size=0,received=0;
            while((n=payload.read(buffer))!=-1){received+=n;if(received>MAX_DOCUMENT_BYTES+16)throw new IOException("Το πακέτο τιμολογίων υπερβαίνει το όριο ασφαλείας.");int amount=encrypted?cipher.processBytes(buffer,0,n,transformed,0):n;size+=amount;if(size>MAX_DOCUMENT_BYTES)throw new IOException("Το αρχείο τιμολογίων υπερβαίνει το όριο 256 MB.");out.write(encrypted?transformed:buffer,0,amount);}
            // Explicit doFinal: an invalid GCM tag must fail before any restore write.
            if(encrypted){int tail=cipher.doFinal(transformed,0);size+=tail;if(size>MAX_DOCUMENT_BYTES)throw new IOException("Μεγάλο πακέτο τιμολογίων.");out.write(transformed,0,tail);}payload.close();out.close();out=null;
            if(!part.renameTo(destination))throw new IOException("Δεν ολοκληρώθηκε ο έλεγχος του backup.");complete=true;return destination;
        }finally{try{input.close();}catch(Exception ignored){}if(out!=null)try{out.close();}catch(Exception ignored){}if(!complete)part.delete();}
    }
}
