import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const root=process.cwd(),temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-zip-native-'));
try{
fs.writeFileSync(path.join(temp,'OperationsNativeTest.java'),`import java.io.*;import java.util.*;import java.util.zip.*;import gr.argyrismitsos.fleetcontrol.InvoiceZipWriter;import gr.argyrismitsos.fleetserver.HistoryMergePolicy;
public class OperationsNativeTest{
 static void check(boolean b){if(!b)throw new AssertionError();}
 static InvoiceZipWriter.Control control=new InvoiceZipWriter.Control(){public boolean cancelled(){return false;}public void progress(int f,int t,long b){check(f>0&&f<=t&&b>0);}};
 static InvoiceZipWriter.Source good=new InvoiceZipWriter.Source(){public InputStream open(String k)throws Exception{return new ByteArrayInputStream("%PDF-1.4\\nfixture\\n%%EOF".getBytes("UTF-8"));}};
 static List<InvoiceZipWriter.Item> item(String name){return Arrays.asList(new InvoiceZipWriter.Item("service-documents/b/e/file.pdf",name));}
 static boolean rejects(List<InvoiceZipWriter.Item> files,InvoiceZipWriter.Source source,InvoiceZipWriter.Control c){try{InvoiceZipWriter.write(files,new ByteArrayOutputStream(),source,c);return false;}catch(Exception e){return true;}}
 public static void main(String[] args)throws Exception{
  ByteArrayOutputStream out=new ByteArrayOutputStream();long count=InvoiceZipWriter.write(item("ΒΤΟ 756/2026-10-02_Τιμολόγιο.pdf"),out,good,control);check(count>5);ZipInputStream zip=new ZipInputStream(new ByteArrayInputStream(out.toByteArray()));ZipEntry e=zip.getNextEntry();check(e.getName().contains("ΒΤΟ"));ByteArrayOutputStream pdf=new ByteArrayOutputStream();byte[] buf=new byte[128];int n;while((n=zip.read(buf))!=-1)pdf.write(buf,0,n);zip.close();check(new String(pdf.toByteArray(),"UTF-8").startsWith("%PDF-"));
  for(String name:new String[]{"../outside.pdf","/outside.pdf","bike/../outside.pdf","bike/file.txt","bike\\\\file.pdf"})check(rejects(item(name),good,control));
  check(rejects(Arrays.asList(item("a.pdf").get(0),item("a.pdf").get(0)),good,control));
  check(rejects(item("a.pdf"),new InvoiceZipWriter.Source(){public InputStream open(String k){return new ByteArrayInputStream("not a PDF".getBytes());}},control));
  check(rejects(item("a.pdf"),good,new InvoiceZipWriter.Control(){public boolean cancelled(){return true;}public void progress(int f,int t,long b){throw new AssertionError();}}));
  check(rejects(item("big.pdf"),new InvoiceZipWriter.Source(){public InputStream open(String k){return new InputStream(){long offset=0;byte[] prefix="%PDF-".getBytes();public int read(){if(offset>InvoiceZipWriter.MAX_FILE)return -1;int v=offset<5?prefix[(int)offset]:'x';offset++;return v;}};}},control));
  Map<String,String> r=new HashMap<String,String>(),d=new HashMap<String,String>();check(HistoryMergePolicy.deleted("one",r,d));r.put("one","2026-10-02T00:00:00.000Z");d.put("one","2026-10-01T00:00:00.000Z");check(!HistoryMergePolicy.deleted("one",r,d));d.put("one","2026-10-03T00:00:00.000Z");check(HistoryMergePolicy.deleted("one",r,d));
  System.out.println("OK actual native PDF ZIP: streaming Unicode archive/CRC, wrong PDF, paths/duplicates, cancellation and 15MB cap; restored service survives stale deletion and newer deletion takes effect.");
 }
}`);
execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-d',temp,path.join(root,'client-android/src/gr/argyrismitsos/fleetcontrol/InvoiceZipWriter.java'),path.join(root,'server-android/src/gr/argyrismitsos/fleetserver/HistoryMergePolicy.java'),path.join(temp,'OperationsNativeTest.java')],{stdio:'inherit'});
execFileSync('java',['-cp',temp,'OperationsNativeTest'],{stdio:'inherit'});
}finally{fs.rmSync(temp,{recursive:true,force:true});}
