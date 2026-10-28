import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {execFileSync,spawn} from 'node:child_process';
import {invoiceText} from './fixtures/invoice-layout.mjs';
const root=path.resolve('.'),folder=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-invoice-transport-')),jar=path.join(root,'vendor/json-java/json-20240303.jar');
let server;
try {
 const text=invoiceText({count:512}),analysis={rawText:text,localReadStatus:'confident',lineItems:Array.from({length:512},(_,i)=>'Συνθετική εργασία '+i),fieldEvidence:{plate:{score:95,evidence:'Σχόλια ΒΤΟ 756 9000'}}};
 const bytes=Buffer.from('%PDF-1.4\n'+('synthetic PDF bytes\n'.repeat(5000))+'%%EOF');
 fs.writeFileSync(path.join(folder,'analysis.json'),JSON.stringify(analysis));fs.writeFileSync(path.join(folder,'invoice.pdf'),bytes);
 fs.writeFileSync(path.join(folder,'ServerConfig.java'),'package gr.argyrismitsos.fleetserver; public class ServerConfig { public static final String SERVER_VERSION="transport-fixture"; }');
 fs.writeFileSync(path.join(folder,'TransportTest.java'),`import java.io.*;import java.util.*;import org.json.*;import gr.argyrismitsos.fleetserver.FleetHttp;
public class TransportTest { public static void main(String[] args)throws Exception{
 String raw=new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(args[1])),"UTF-8");
 JSONObject saved=FleetHttp.putInvoice(args[0],new File(args[2]),new JSONObject(raw),Collections.singletonMap("X-Test-Auth","synthetic"));
 if(!saved.optBoolean("ok"))throw new AssertionError(saved.toString());
 System.out.println("PASS actual FleetHttp multipart body acknowledgement");}}
`);
 execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-cp',jar,'-d',folder,path.join(root,'server-android/src/gr/argyrismitsos/fleetserver/FleetHttp.java'),path.join(folder,'ServerConfig.java'),path.join(folder,'TransportTest.java')]);
 let received=false,requestError;
 server=http.createServer(async(req,res)=>{try{
   assert.equal(req.method,'PUT');assert.equal(req.headers['x-fleet-local-ocr'],undefined);assert.equal(req.headers['x-test-auth'],'synthetic');
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);assert.equal(Number(req.headers['content-length']),body.length);
   const form=await new Request('http://synthetic/upload',{method:'PUT',headers:{'content-type':req.headers['content-type']},body}).formData();
   assert.deepEqual(JSON.parse(form.get('analysis')),analysis);assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()),bytes);assert.ok(Buffer.byteLength(form.get('analysis'))>32000);received=true;
   res.writeHead(200,{'content-type':'application/json'}).end('{"ok":true}');
 }catch(error){requestError=error;console.error(error);res.writeHead(500).end('{"error":"fixture failed"}');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const child=spawn('java',['-cp',folder+path.delimiter+jar,'TransportTest',`http://127.0.0.1:${server.address().port}/upload`,path.join(folder,'analysis.json'),path.join(folder,'invoice.pdf')],{stdio:'inherit'});
 await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Transport test exit '+code)));});
 if(requestError)throw requestError;assert.equal(received,true);
 console.log('PASS Java-to-HTTP multipart: full 512-line Unicode analysis >32 KB and byte-exact PDF, no oversized OCR header, bounded streaming and explicit acknowledgement. Synthetic only.');
} finally {if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(folder,{recursive:true,force:true});}
