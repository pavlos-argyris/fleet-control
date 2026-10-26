package gr.argyrismitsos.fleetserver;

import android.util.Base64;
import android.util.Base64InputStream;
import android.util.Base64OutputStream;
import java.io.*;
import java.nio.charset.Charset;
import java.security.MessageDigest;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.CipherOutputStream;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

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
        FileOutputStream disk=new FileOutputStream(part);InputStream input=null;OutputStream cipherOut=null;boolean complete=false;
        try{
            final java.security.DigestOutputStream digest=new java.security.DigestOutputStream(disk,fileHash);digest.write(MAGIC);
            OutputStream shield=new FilterOutputStream(digest){@Override public void close()throws IOException{flush();}};
            Base64OutputStream encoded=new Base64OutputStream(shield,Base64.NO_WRAP);byte[] iv=new byte[12];new SecureRandom().nextBytes(iv);encoded.write(iv);
            Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,iv));cipherOut=new CipherOutputStream(encoded,cipher);
            input=new BufferedInputStream(new FileInputStream(source));byte[] buffer=new byte[65536];int n;long done=0;
            while((n=input.read(buffer))!=-1){if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Η προετοιμασία backup διακόπηκε με ασφάλεια.");done+=n;if(done>MAX_DOCUMENT_BYTES)throw new IOException("Το πακέτο τιμολογίων υπερβαίνει το όριο 256 MB.");plainHash.update(buffer,0,n);cipherOut.write(buffer,0,n);if(progress!=null)progress.bytes(done,source.length());}
            cipherOut.close();cipherOut=null;disk.getFD().sync();disk.close();input.close();input=null;
            if(destination.exists()&&!destination.delete())throw new IOException("Δεν αντικαταστάθηκε το τοπικό αντίγραφο.");if(!part.renameTo(destination))throw new IOException("Δεν ολοκληρώθηκε το τοπικό αντίγραφο.");complete=true;
            return new Result(BackupArchiveVerifier.hex(fileHash.digest()),BackupArchiveVerifier.hex(plainHash.digest()),destination.length());
        }finally{if(input!=null)try{input.close();}catch(Exception ignored){}if(cipherOut!=null)try{cipherOut.close();}catch(Exception ignored){}try{disk.close();}catch(Exception ignored){}if(!complete)part.delete();}
    }
    public static File decrypt(InputStream raw,File destination,byte[] key)throws Exception{
        File part=new File(destination.getPath()+".part");
        InputStream bounded=new FilterInputStream(raw){long count;private void counted(int n)throws IOException{if(n>0){count+=n;if(count>360L*1024*1024)throw new IOException("Το κρυπτογραφημένο αρχείο τιμολογίων υπερβαίνει το όριο ασφαλείας.");}}@Override public int read()throws IOException{int n=in.read();if(n>=0)counted(1);return n;}@Override public int read(byte[] b,int off,int len)throws IOException{int n=in.read(b,off,len);counted(n);return n;}};
        PushbackInputStream input=new PushbackInputStream(new BufferedInputStream(bounded),MAGIC.length);OutputStream out=null;boolean complete=false;
        try{
            byte[] prefix=new byte[MAGIC.length];int count=0,n;while(count<prefix.length&&(n=input.read(prefix,count,prefix.length-count))!=-1)count+=n;
            boolean encrypted=count==MAGIC.length&&java.util.Arrays.equals(prefix,MAGIC);InputStream payload=input;Cipher cipher=null;
            if(encrypted){Base64InputStream decoded=new Base64InputStream(input,Base64.DEFAULT);byte[] iv=new byte[12];int at=0;while(at<iv.length&&(n=decoded.read(iv,at,iv.length-at))!=-1)at+=n;if(at!=12)throw new IOException("Το κρυπτογραφημένο backup είναι ελλιπές.");cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,iv));payload=decoded;}else input.unread(prefix,0,count);
            out=new BufferedOutputStream(new FileOutputStream(part));byte[] buffer=new byte[65536];long size=0,received=0;
            while((n=payload.read(buffer))!=-1){received+=n;if(received>MAX_DOCUMENT_BYTES+16)throw new IOException("Το πακέτο τιμολογίων υπερβαίνει το όριο ασφαλείας.");byte[] bytes=encrypted?cipher.update(buffer,0,n):java.util.Arrays.copyOf(buffer,n);if(bytes!=null){size+=bytes.length;if(size>MAX_DOCUMENT_BYTES)throw new IOException("Το αρχείο τιμολογίων υπερβαίνει το όριο 256 MB.");out.write(bytes);}}
            // Explicit doFinal: an invalid GCM tag must fail before any restore write.
            if(encrypted){byte[] tail=cipher.doFinal();size+=tail.length;if(size>MAX_DOCUMENT_BYTES)throw new IOException("Μεγάλο πακέτο τιμολογίων.");out.write(tail);}payload.close();out.close();out=null;
            if(!part.renameTo(destination))throw new IOException("Δεν ολοκληρώθηκε ο έλεγχος του backup.");complete=true;return destination;
        }finally{try{input.close();}catch(Exception ignored){}if(out!=null)try{out.close();}catch(Exception ignored){}if(!complete)part.delete();}
    }
}
