import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-backup-json-'));
const jar=path.join(root,'vendor/json-java/json-20240303.jar');
try {
  fs.writeFileSync(path.join(dir,'WriterTest.java'),String.raw`
import java.io.*;import java.nio.file.*;import org.json.*;import gr.argyrismitsos.fleetserver.BackupJsonWriter;
public class WriterTest {
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  File directory=new File(args[0]),small=new File(directory,"small.json");
  JSONObject original=new JSONObject().put("unicode","Ελληνικά 🛵 \\" + "\n\t\r\b\f\u0000")
   .put("null",JSONObject.NULL).put("boolean",true).put("number",1.25).put("array",new JSONArray().put(0).put(false).put(new JSONObject().put("key","a/b")));
  long bytes=BackupJsonWriter.write(small,original,4096,null);
  byte[] actual=Files.readAllBytes(small.toPath());check(bytes==actual.length,"UTF-8 byte count");
  check(new JSONObject(new String(actual,"UTF-8")).similar(original),"exact independent JSON roundtrip");
  check(!new String(actual,"UTF-8").contains("\n"),"no formatting whitespace in compact checkpoint");
  File limited=new File(directory,"limited.json");boolean rejected=false;
  try{BackupJsonWriter.write(limited,original,10,null);}catch(IOException e){rejected=true;}
  check(rejected&&!limited.exists(),"limit failure removes partial plaintext");
  File interrupted=new File(directory,"interrupted.json");rejected=false;
  try{BackupJsonWriter.write(interrupted,original,4096,new BackupJsonWriter.Progress(){public void bytes(long done)throws IOException{if(done>0)throw new IOException("injected interruption");}});}catch(IOException e){rejected=true;}
  check(rejected&&!interrupted.exists(),"interruption never advertises or leaves plaintext checkpoint");
  JSONObject large=new JSONObject();JSONArray rows=new JSONArray();StringBuilder text=new StringBuilder();
  for(int i=0;i<2048;i++)text.append('Δ');String shared=text.toString();
  for(int i=0;i<7000;i++)rows.put(new JSONObject().put("id","row-"+i).put("notes",shared));
  large.put("rows",rows);final long[] last={0};
  long largeBytes=BackupJsonWriter.write(new File(directory,"large.json"),large,37L*1024*1024,new BackupJsonWriter.Progress(){public void bytes(long done){check(done>=last[0],"monotonic actual byte progress");last[0]=done;}});
  check(largeBytes>27L*1024*1024&&largeBytes==last[0],"large checkpoint streams under a 48 MiB Java heap");
  System.out.println("PASS native backup JSON writer: real JSON/Unicode roundtrip, bounded compact UTF-8, interruption/limit cleanup and >27 MiB checkpoint under 48 MiB heap.");
 }
}`);
  execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-classpath',jar,'-d',dir,path.join(root,'server-android/src/gr/argyrismitsos/fleetserver/BackupJsonWriter.java'),path.join(dir,'WriterTest.java')],{stdio:'inherit'});
  execFileSync('java',['-Xmx48m','-cp',dir+path.delimiter+jar,'WriterTest',dir],{stdio:'inherit',timeout:60000});
  execFileSync('python3',['-c',`import json,sys
with open(sys.argv[1],encoding='utf-8') as f: rows=json.load(f)['rows']
assert len(rows)==7000
assert all(row['id']=='row-'+str(i) and row['notes']=='Δ'*2048 for i,row in enumerate(rows))
print('PASS independent Python reader: all 7000 IDs and complete Unicode fields preserved.')`,path.join(dir,'large.json')],{stdio:'inherit',timeout:15000});
} finally {fs.rmSync(dir,{recursive:true,force:true});}
