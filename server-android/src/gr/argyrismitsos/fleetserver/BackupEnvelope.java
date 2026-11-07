package gr.argyrismitsos.fleetserver;
import android.content.Context;import java.io.*;import java.util.Arrays;

/** One captured key configuration for all parts of a backup, including retries. */
public final class BackupEnvelope implements AutoCloseable {
    private final PortableBackupCipher.Material portable;private final byte[] legacy;
    BackupEnvelope(PortableBackupCipher.Material portable,byte[] legacy){this.portable=portable;this.legacy=legacy.clone();}
    public static BackupEnvelope open(Context context)throws Exception{return new BackupEnvelope(BackupProtection.material(context),BackupManager.encryptionKey());}
    public boolean portable(){return portable!=null;}
    public String keyId()throws Exception{return portable!=null?portable.keyId():BackupArchiveVerifier.digest(legacy).substring(0,12);}
    public BackupCipher.Result encrypt(File source,File destination,String kind,BackupCipher.Progress progress)throws Exception{return portable==null?BackupCipher.encrypt(source,destination,legacy,progress):PortableBackupCipher.encrypt(source,destination,portable,kind,progress);}
    public File decrypt(InputStream source,File destination,String kind,String password)throws Exception{return PortableBackupCipher.decrypt(source,destination,portable,password,legacy,kind);}
    @Override public void close(){if(portable!=null)portable.close();Arrays.fill(legacy,(byte)0);}
}
