import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-invoice-sources-')),root=process.cwd();
try{
 for(const name of ['JSONObject.java','JSONArray.java'])fs.copyFileSync('scripts/fixtures/java-json/'+name,path.join(temp,name));
 const array=path.join(temp,'JSONArray.java');fs.writeFileSync(array,fs.readFileSync(array,'utf8').replace('public JSONArray(){}','public JSONArray(){} public JSONArray(String s){Object copy=JSONObject.cloneValue(JSONObject.snapshots.get(s));if(!(copy instanceof JSONArray))throw new IllegalArgumentException(s);values.addAll(((JSONArray)copy).values);}'));
 fs.writeFileSync(path.join(temp,'Context.java'),'package android.content;import java.io.File;public class Context{File root;public Context(File r){root=r;}public File getFilesDir(){return root;}}');
 fs.writeFileSync(path.join(temp,'FleetHttp.java'),'package gr.argyrismitsos.fleetserver;import java.io.*;import java.util.*;public class FleetHttp{public static void downloadToFile(String u,File f,Map<String,String> h)throws Exception{throw new IOException("Offline fixture");}public static void putStream(String u,InputStream i,long l,String t,Map<String,String> h)throws Exception{throw new IOException("Offline fixture");}}');
 fs.writeFileSync(path.join(temp,'SourcesTest.java'),`package gr.argyrismitsos.fleetserver;import java.io.*;import java.nio.file.*;import java.util.*;import java.util.zip.*;import org.json.*;import android.content.Context;
public class SourcesTest{
 static void check(boolean b){if(!b)throw new AssertionError();}
 public static void main(String[] args)throws Exception{
 Context context=new Context(new File(args[0]));byte[] pdf="%PDF-1.4\\nPDF fixture\\n%%EOF".getBytes("UTF-8"),image=new byte[]{-1,-40,-1,-32,1,2,-1,-39};
 JSONObject photo=new JSONObject().put("id","photo").put("key","service-documents/b/e/photo.jpg").put("name","photo.jpg").put("contentType","image/jpeg"),invoice=new JSONObject().put("id","pdf").put("key","service-documents/b/e/invoice.pdf").put("name","invoice.pdf").put("contentType","application/pdf").put("qrUrl","https://einvoice.impact.gr/p/FIXTURE").put("sourcePhoto",photo);
 JSONObject entry=new JSONObject().put("id","e").put("type","service").put("attachments",new JSONArray().put(invoice)),fleet=new JSONObject().put("bikes",new JSONArray().put(new JSONObject().put("id","b").put("history",new JSONArray().put(entry))));
 File p=ServiceDocumentStore.localFile(context,invoice.optString("key"),"invoice.pdf"),i=ServiceDocumentStore.localFile(context,photo.optString("key"),"photo.jpg");p.getParentFile().mkdirs();Files.write(p.toPath(),pdf);Files.write(i.toPath(),image);
 byte[] archive=ServiceDocumentStore.createArchive(context,fleet);Map<String,BackupArchiveVerifier.Item> inventory=BackupArchiveVerifier.inspect(archive);check(inventory.size()==3);check(inventory.containsKey("documents/0.pdf"));check(inventory.containsKey("documents/1.jpg"));
 check(p.delete());check(i.delete());JSONObject result=ServiceDocumentStore.restoreArchive(context,fleet,archive);check(result.optInt("expected")==2);check(result.optInt("restored")==2);check(Arrays.equals(Files.readAllBytes(p.toPath()),pdf));check(Arrays.equals(Files.readAllBytes(i.toPath()),image));check(entry.optJSONArray("attachments").length()==1);check(invoice.optString("qrUrl").contains("FIXTURE"));
 System.out.println("PASS actual native invoice archive: PDF and original photo have distinct bytes/SHA, both restored, QR relationship retained, one invoice.");
 }} `);
 const sources=['ServiceDocumentStore','BackupArchiveVerifier'].map(name=>path.join(root,'server-android/src/gr/argyrismitsos/fleetserver',name+'.java'));
 execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-d',temp,...['JSONObject.java','JSONArray.java','Context.java','FleetHttp.java','SourcesTest.java'].map(name=>path.join(temp,name)),...sources],{stdio:'inherit'});
 execFileSync('java',['-cp',temp,'gr.argyrismitsos.fleetserver.SourcesTest',temp],{stdio:'inherit'});
 const manager=fs.readFileSync('server-android/src/gr/argyrismitsos/fleetserver/BackupManager.java','utf8');assert.match(manager.slice(manager.indexOf('private static java.util.Set<String> attachmentKeys('),manager.indexOf('public static synchronized JSONObject verifyBackup(')),/ServiceDocumentStore\.invoiceFiles/);
}finally{fs.rmSync(temp,{recursive:true,force:true});}
