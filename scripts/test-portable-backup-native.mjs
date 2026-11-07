import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const root=process.cwd(),temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-portable-backup-'));
try{
 const write=(name,text)=>fs.writeFileSync(path.join(temp,name),text);
 write('Base64.java','package android.util;public class Base64{public static final int DEFAULT=0,NO_WRAP=2;public static String encodeToString(byte[] b,int flags){return java.util.Base64.getEncoder().encodeToString(b);}public static byte[] decode(String s,int flags){return java.util.Base64.getMimeDecoder().decode(s);}}');
 write('Base64OutputStream.java','package android.util;import java.io.*;public class Base64OutputStream extends FilterOutputStream{public Base64OutputStream(OutputStream output,int flags){super(java.util.Base64.getEncoder().wrap(output));}@Override public void write(byte[] b,int off,int length)throws IOException{out.write(b,off,length);}}');
 write('Base64InputStream.java','package android.util;import java.io.*;public class Base64InputStream extends FilterInputStream{public Base64InputStream(InputStream input,int flags){super(java.util.Base64.getMimeDecoder().wrap(input));}}');
 write('BackupArchiveVerifier.java','package gr.argyrismitsos.fleetserver;public class BackupArchiveVerifier{public static String hex(byte[] bytes){StringBuilder out=new StringBuilder();for(byte b:bytes)out.append(String.format(java.util.Locale.US,"%02x",b&255));return out.toString();}}');
 write('PortableTest.java',String.raw`package gr.argyrismitsos.fleetserver;
import org.json.*;import java.io.*;import java.nio.file.*;import java.util.*;import javax.crypto.*;import javax.crypto.spec.*;
public class PortableTest{
 static void check(boolean b,String message){if(!b)throw new AssertionError(message);}
 static void rejected(File source,File target,PortableBackupCipher.Material known,String password,byte[] legacy,String kind)throws Exception{Files.deleteIfExists(target.toPath());boolean failed=false;try{PortableBackupCipher.decrypt(new FileInputStream(source),target,known,password,legacy,kind);}catch(Exception expected){failed=true;}check(failed&&!target.exists()&&!new File(target+".part").exists(),"invalid backup never exposes plaintext or partial output");}
 public static void main(String[] args)throws Exception{
  File root=new File(args[0]),plain=new File(root,"source.bin"),encrypted=new File(root,"portable.fcbackup"),restored=new File(root,"restored.bin");
  byte[] block=new byte[65536];new Random(71).nextBytes(block);try(FileOutputStream output=new FileOutputStream(plain)){for(int i=0;i<448;i++)output.write(block);}byte[] legacy=new byte[32];new Random(4).nextBytes(legacy);
  String password="Ελληνικός κωδικός 🔑 2026",code=PortableBackupCipher.recoveryCode();check(code.matches("FLEET(-[A-Z2-7]{4}){8}"),"random 160-bit recovery code has portable format");
  try(PortableBackupCipher.Material material=PortableBackupCipher.create(password)){
   JSONObject params=material.parameters;char[] chars=password.toCharArray();byte[] expected=SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(new PBEKeySpec(chars,java.util.Base64.getDecoder().decode(params.getString("salt")),params.getInt("iterations"),256)).getEncoded();check(java.security.MessageDigest.isEqual(expected,material.key()),"explicit UTF-8 PBKDF2 matches standard Unicode/emoji password derivation");Arrays.fill(expected,(byte)0);Arrays.fill(chars,'\0');
   BackupCipher.Result result=PortableBackupCipher.encrypt(plain,encrypted,material,"database",null);check(result.plainSha256.equals(BackupCipher.digest(plain))&&result.fileSha256.equals(BackupCipher.digest(encrypted)),"streamed plain/encrypted digests");
   PortableBackupCipher.decrypt(new FileInputStream(encrypted),restored,material,null,legacy,"database");check(BackupCipher.digest(restored).equals(result.plainSha256),"stored Keystore material supports fast unattended backup verification");
   PortableBackupCipher.decrypt(new FileInputStream(encrypted),restored,null,password,legacy,"database");check(BackupCipher.digest(restored).equals(result.plainSha256),"portable password restores on a different device without its Keystore");
   boolean prompt=false;try{PortableBackupCipher.decrypt(new FileInputStream(encrypted),restored,null,null,legacy,"database");}catch(PortableBackupCipher.PasswordRequired e){prompt=e.parameters.getString("keyId").equals(material.keyId());}check(prompt,"missing recovery code is explicit, not a generic corruption verdict");
   rejected(encrypted,restored,null,"incorrect recovery password",legacy,"database");rejected(encrypted,restored,material,null,legacy,"documents");
   byte[] header;try(InputStream input=new FileInputStream(encrypted)){ByteArrayOutputStream first=new ByteArrayOutputStream();int c,lines=0;while(lines<2&&(c=input.read())!=-1){first.write(c);if(c==10)lines++;}header=first.toByteArray();}
   String original=new String(header,"UTF-8"),tampered=original.replace("310000","310001");File bad=new File(root,"header-tampered.fcbackup");try(OutputStream output=new FileOutputStream(bad);InputStream input=new FileInputStream(encrypted)){output.write(tampered.getBytes("UTF-8"));long skipped=0;while(skipped<header.length)skipped+=input.skip(header.length-skipped);int n;while((n=input.read(block))!=-1)output.write(block,0,n);}
   rejected(bad,restored,material,null,legacy,"database");
   try(RandomAccessFile file=new RandomAccessFile(bad,"rw")){file.setLength(20);}rejected(bad,restored,material,null,legacy,"database");
   File interrupted=new File(root,"interrupted.fcdocs");boolean stopped=false;try{PortableBackupCipher.encrypt(plain,interrupted,material,"documents",(a,b)->{throw new IOException("fixture interruption");});}catch(IOException expectedError){stopped=true;}check(stopped&&!interrupted.exists()&&!new File(interrupted+".part").exists(),"interrupted encryption has no false ready checkpoint");
   JSONObject huge=new JSONObject(params.toString()).put("iterations",Integer.MAX_VALUE);boolean limited=false;try{PortableBackupCipher.derive(password,huge);}catch(IOException expectedError){limited=true;}check(limited,"untrusted KDF iteration limit enforced before expensive work");
  }
  try(PortableBackupCipher.Material a=PortableBackupCipher.create(code);PortableBackupCipher.Material b=PortableBackupCipher.derive(code.toLowerCase(Locale.US).replace("-",""),a.parameters)){check(java.security.MessageDigest.isEqual(a.key(),b.key()),"recovery code case/group formatting remains portable");}
  File old=new File(root,"legacy.fcbackup");BackupCipher.encrypt(plain,old,legacy,null);PortableBackupCipher.decrypt(new FileInputStream(old),restored,null,null,legacy,"data");check(BackupCipher.digest(restored).equals(BackupCipher.digest(plain)),"existing FCB2 backups remain readable");
  System.out.println("PASS actual portable backup: >28 MiB/48 MiB heap streaming, Unicode PBKDF2 parity, 160-bit recovery code, no-KeyStore restore, unattended material, authenticated header/kind, wrong/missing code, corruption/truncation/interruption cleanup, KDF limits and existing FCB2 compatibility.");
 }
}`);
 const jars=[path.resolve('vendor/json-java/json-20240303.jar'),path.resolve('.build/invoice-deps/bcprov.jar')].join(path.delimiter),files=fs.readdirSync(temp).filter(n=>n.endsWith('.java')).map(n=>path.join(temp,n));
 files.push(...['BackupCipher','PortableBackupCipher'].map(n=>path.resolve('server-android/src/gr/argyrismitsos/fleetserver',n+'.java')));
 execFileSync('java',['-jar',path.resolve('.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-classpath',jars,'-d',temp,...files],{stdio:'inherit'});
 execFileSync('java',['-Xmx48m','-cp',temp+path.delimiter+jars,'gr.argyrismitsos.fleetserver.PortableTest',temp],{stdio:'inherit',timeout:90000});
}finally{fs.rmSync(temp,{recursive:true,force:true});}
