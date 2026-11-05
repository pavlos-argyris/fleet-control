package gr.argyrismitsos.fleetserver;

import org.json.*;
import java.io.*;
import java.security.*;
import java.util.*;
import android.util.Base64;
import android.util.Base64InputStream;
import org.bouncycastle.crypto.digests.SHA256Digest;
import org.bouncycastle.crypto.generators.PKCS5S2ParametersGenerator;
import org.bouncycastle.crypto.engines.AESEngine;
import org.bouncycastle.crypto.modes.GCMBlockCipher;
import org.bouncycastle.crypto.modes.GCMModeCipher;
import org.bouncycastle.crypto.params.*;

/** Portable authenticated FCB3 framing; existing FCB2 files remain readable. */
public final class PortableBackupCipher {
    public static final int ITERATIONS=310000;
    public static final long MAX_DATABASE_BYTES=1024L*1024*1024;
    private static final byte[] MAGIC="FCB3\n".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
    public static final class Material implements AutoCloseable {
        public final JSONObject parameters;private final byte[] secret;
        public Material(JSONObject parameters,byte[] secret)throws Exception{this.parameters=new JSONObject(parameters.toString());this.secret=secret.clone();if(secret.length!=32)throw new IOException("Μη έγκυρο κλειδί backup.");}
        public byte[] key(){return secret.clone();}
        public String keyId(){return parameters.optString("keyId");}
        @Override public void close(){Arrays.fill(secret,(byte)0);}
    }
    public static final class PasswordRequired extends IOException {
        public final JSONObject parameters;
        public PasswordRequired(JSONObject parameters){super("Χρειάζεται ο κωδικός αυτού του backup.");this.parameters=parameters;}
    }
    private PortableBackupCipher(){}
    private static String encode(byte[] b){return Base64.encodeToString(b,Base64.NO_WRAP);}
    private static byte[] decode(String s){return Base64.decode(s,Base64.DEFAULT);}
    private static String hex(byte[] b){StringBuilder out=new StringBuilder();for(byte value:b){out.append(Character.forDigit((value>>>4)&15,16));out.append(Character.forDigit(value&15,16));}return out.toString();}
    private static String sha(byte[] b)throws Exception{return hex(MessageDigest.getInstance("SHA-256").digest(b));}
    private static String normalized(String password){String compact=password.toUpperCase(Locale.US).replace("-","");return compact.matches("FLEET[A-Z2-7]{32}")?compact:password;}
    public static String recoveryCode(){byte[] bytes=new byte[20];new SecureRandom().nextBytes(bytes);String alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";StringBuilder data=new StringBuilder();int buffer=0,bits=0;for(byte b:bytes){buffer=(buffer<<8)|(b&255);bits+=8;while(bits>=5){bits-=5;data.append(alphabet.charAt((buffer>>>bits)&31));}}StringBuilder result=new StringBuilder("FLEET");for(int i=0;i<data.length();i+=4)result.append('-').append(data.substring(i,i+4));Arrays.fill(bytes,(byte)0);return result.toString();}
    public static Material create(String password)throws Exception{
        if(password==null||password.length()<12||password.length()>256)throw new IOException("Ο κωδικός backup χρειάζεται 12 έως 256 χαρακτήρες.");byte[] salt=new byte[16];new SecureRandom().nextBytes(salt);
        return derive(password,new JSONObject().put("version",1).put("kdf","PBKDF2-SHA256-UTF8").put("iterations",ITERATIONS).put("salt",encode(salt)));
    }
    public static Material derive(String password,JSONObject parameters)throws Exception{
        if(password==null||password.length()<12||password.length()>256)throw new IOException("Ο κωδικός backup χρειάζεται 12 έως 256 χαρακτήρες.");
        validate(parameters);byte[] pass=normalized(password).getBytes("UTF-8"),salt=decode(parameters.getString("salt"));PKCS5S2ParametersGenerator generator=new PKCS5S2ParametersGenerator(new SHA256Digest());
        byte[] key=null;try{generator.init(pass,salt,parameters.getInt("iterations"));key=((KeyParameter)generator.generateDerivedParameters(256)).getKey();String id=sha(key).substring(0,32);if(parameters.has("keyId")&&!MessageDigest.isEqual(id.getBytes("US-ASCII"),parameters.getString("keyId").getBytes("US-ASCII")))throw new IOException("Ο κωδικός backup δεν είναι σωστός.");return new Material(new JSONObject(parameters.toString()).put("keyId",id),key);}finally{Arrays.fill(pass,(byte)0);if(key!=null)Arrays.fill(key,(byte)0);}
    }
    private static void validate(JSONObject header)throws Exception{
        if(header.optInt("version")!=1||!"PBKDF2-SHA256-UTF8".equals(header.optString("kdf"))||header.optInt("iterations")<100000||header.optInt("iterations")>1000000||decode(header.getString("salt")).length!=16||header.has("keyId")&&!header.getString("keyId").matches("[a-f0-9]{32}"))throw new IOException("Μη συμβατή προστασία backup. Χρειάζεται συμβατή έκδοση Server.");
    }
    private static long limit(String kind)throws Exception{if(kind.equals("database"))return MAX_DATABASE_BYTES;if(kind.equals("data")||kind.equals("documents"))return BackupCipher.MAX_DOCUMENT_BYTES;throw new IOException("Άγνωστο τμήμα backup.");}
    public static BackupCipher.Result encrypt(File source,File destination,Material material,String kind,BackupCipher.Progress progress)throws Exception{
        validate(material.parameters);JSONObject header=new JSONObject(material.parameters.toString()).put("kind",kind);byte[] framing=("FCB3\n"+header.toString()+"\n").getBytes("UTF-8"),key=material.key();try{return BackupCipher.encryptFramed(source,destination,key,framing,framing,limit(kind),progress);}finally{Arrays.fill(key,(byte)0);}
    }
    public static File decrypt(InputStream raw,File destination,Material configured,String password,byte[] legacyKey,String expectedKind)throws Exception{
        final long rawLimit=(limit(expectedKind)+16)*4/3+8192;
        InputStream bounded=new FilterInputStream(raw){long count;private void check(int n)throws IOException{if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Ο έλεγχος backup διακόπηκε με ασφάλεια.");if(n>0&&((count+=n)>rawLimit))throw new IOException("Το backup υπερβαίνει το όριο ασφαλείας.");}@Override public int read()throws IOException{int n=in.read();check(n<0?0:1);return n;}@Override public int read(byte[] bytes,int offset,int length)throws IOException{int n=in.read(bytes,offset,length);check(n);return n;}};
        PushbackInputStream input=new PushbackInputStream(new BufferedInputStream(bounded),5);File part=new File(destination.getPath()+".part");boolean complete=false;Material derived=null;
        try{
            byte[] prefix=new byte[5];int count=0,n;while(count<5&&(n=input.read(prefix,count,5-count))!=-1)count+=n;
            if(count!=5||!Arrays.equals(prefix,MAGIC)){input.unread(prefix,0,count);return BackupCipher.decrypt(input,destination,legacyKey);}
            ByteArrayOutputStream line=new ByteArrayOutputStream();for(;;){int b=input.read();if(b<0)throw new IOException("Ελλιπής κεφαλίδα backup.");if(b==10)break;if(line.size()>=2048)throw new IOException("Μεγάλη κεφαλίδα προστασίας backup.");line.write(b);}
            JSONObject header=new JSONObject(new String(line.toByteArray(),"UTF-8"));validate(header);String kind=header.getString("kind");long maximum=limit(kind);if(!kind.equals(expectedKind))throw new IOException("Επιλέχθηκε διαφορετικό τμήμα του backup.");
            Material selected=configured;
            if(selected==null||!selected.keyId().equals(header.optString("keyId"))){if(password==null||password.isEmpty())throw new PasswordRequired(header);derived=derive(password,header);selected=derived;}
            byte[] key=selected.key(),aad=new byte[5+line.size()+1];System.arraycopy(MAGIC,0,aad,0,5);System.arraycopy(line.toByteArray(),0,aad,5,line.size());aad[aad.length-1]=10;
            try{
                Base64InputStream payload=new Base64InputStream(input,Base64.DEFAULT);byte[] iv=new byte[12];int at=0;while(at<12&&(n=payload.read(iv,at,12-at))!=-1)at+=n;if(at!=12)throw new IOException("Ελλιπές κρυπτογραφημένο backup.");
                GCMModeCipher cipher=GCMBlockCipher.newInstance(AESEngine.newInstance());cipher.init(false,new AEADParameters(new KeyParameter(key),128,iv,aad));byte[] bytes=new byte[65536],output=new byte[65568];long size=0,received=0;
                try(FileOutputStream disk=new FileOutputStream(part)){
                    while((n=payload.read(bytes))!=-1){if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("Ο έλεγχος backup διακόπηκε με ασφάλεια.");received+=n;if(received>maximum+16)throw new IOException("Το backup υπερβαίνει το όριο ασφαλείας.");int amount=cipher.processBytes(bytes,0,n,output,0);size+=amount;if(size>maximum)throw new IOException("Μεγάλο πακέτο backup.");disk.write(output,0,amount);}
                    int tail=cipher.doFinal(output,0);size+=tail;if(size>maximum)throw new IOException("Μεγάλο πακέτο backup.");disk.write(output,0,tail);disk.getFD().sync();
                }
            }finally{Arrays.fill(key,(byte)0);}
            if(destination.exists()&&!destination.delete())throw new IOException("Δεν αντικαταστάθηκε το προσωρινό αντίγραφο.");if(!part.renameTo(destination))throw new IOException("Δεν ολοκληρώθηκε ο έλεγχος backup.");complete=true;return destination;
        }finally{if(derived!=null)derived.close();try{input.close();}finally{if(!complete)part.delete();}}
    }
}
