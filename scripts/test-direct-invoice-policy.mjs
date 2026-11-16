import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {createSimulation} from './fixtures/workforce-simulation.mjs';
import {normalizeFleet} from '../cloudflare-worker/src/worker.js';
const fixture=createSimulation(),{db,call,env}=fixture;env.STANDALONE=true;env.LOCAL_PRIMARY=true;
const boot=await call('/api/auth/bootstrap',{server:true,method:'POST',body:{fullName:'Direct invoice fixture',username:'direct-invoices',password:'DirectInvoiceFixture!7'}});assert.equal(boot.status,200);const token=boot.data.token;
const history=Array.from({length:62},(_,i)=>({id:'legacy-'+i,type:'service',date:'2026-11-01',km:9000,tasks:['Έλεγχος'],attachments:[],invoiceData:{qrJobId:'missing-job-'+i,qrUrl:'https://einvoice.impact.gr/p/fixture-'+i,qrProcessingStatus:i%2?'error':'delayed',qrProcessingStartedAt:'2026-11-01T10:00:00Z'}}));
const fleet=normalizeFleet({bikes:[{id:'b',name:'BTO-756',currentKm:10000,lastServiceKm:9000,intervalKm:3000,history}]});db.sqlite.prepare('UPDATE fleet_snapshot SET data=?,version=123 WHERE id=1').run(JSON.stringify(fleet));
let documents=[],cursor='';do{const result=await call('/api/admin/service-documents?paged=1'+(cursor?'&cursor='+encodeURIComponent(cursor):''),{token});assert.equal(result.status,200);documents.push(...result.data.documents);cursor=result.data.nextCursor;}while(cursor);
assert.equal(documents.length,62,'every failed legacy QR appears even when its old job no longer exists');assert.equal(new Set(documents.map(d=>d.bikeId+':'+d.entryId)).size,62);assert(documents.every(d=>d.status!=='confirmed'));
const payload={bikeId:'b',entryId:'legacy-0',qrUrl:history[0].invoiceData.qrUrl,requestedAt:new Date().toISOString()};
db.sqlite.prepare("INSERT INTO fleet_operations(id,source,type,payload,status,created_at) VALUES('direct-job','fixture','service_document_render',?,'pending',?)").run(JSON.stringify(payload),new Date().toISOString());
let r=await call('/api/server/pending?queue=invoices&local=1&combined=1&known='+encodeURIComponent(JSON.stringify(['direct-job','deleted-job'])),{server:true});assert.equal(r.status,200);assert.deepEqual(r.data.known,[{id:'direct-job',status:'pending'},{id:'deleted-job',status:'missing'}]);
for(let attempt=1;attempt<=6;attempt++){
 const before=Date.now();r=await call('/api/server/operation-error',{server:true,method:'POST',body:{jobId:'direct-job',retryable:true,directAttemptCount:attempt,error:'Synthetic temporary failure'}});assert.equal(r.status,200);
 const row=db.sqlite.prepare("SELECT * FROM fleet_operations WHERE id='direct-job'").get(),data=JSON.parse(row.payload);
 assert.equal(data.directAttemptCount,attempt);assert.equal(row.status,attempt<6?'pending':'error');
 if(attempt<6){const delay=[10000,30000,60000,120000,300000][attempt-1];assert(Date.parse(data.nextAttemptAt)>=before+delay&&Date.parse(data.nextAttemptAt)<Date.now()+delay+1000);assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM system_alerts WHERE type='invoice_processing_failed' AND resolved=0").get().n,0,'temporary retries do not emit actionable alerts');}
}
assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM system_alerts WHERE type='invoice_processing_failed' AND resolved=0").get().n,1,'one final actionable alert');
assert.equal((await call('/api/server/pending?known=not-json',{server:true})).status,400);db.sqlite.close();
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-direct-invoice-policy-'));
try{
 fs.writeFileSync(path.join(dir,'FleetHttp.java'),'package gr.argyrismitsos.fleetserver;public class FleetHttp{static void downloadToFile(String u,java.io.File f,java.util.Map<String,String> h){}static org.json.JSONObject putInvoice(String u,java.io.File f,org.json.JSONObject j,java.util.Map<String,String> h){return new org.json.JSONObject();}public static class HttpStatusException extends java.io.IOException{public final int statusCode;public HttpStatusException(int s){statusCode=s;}}}');
 fs.writeFileSync(path.join(dir,'DirectInvoicePolicyTest.java'),String.raw`package gr.argyrismitsos.fleetserver;import org.json.*;public class DirectInvoicePolicyTest{
 static void check(boolean b,String message){if(!b)throw new AssertionError(message);}static String disk="{}";
 public static void main(String[] args)throws Exception{
  long[] delays={10000,30000,60000,120000,300000};for(int i=1;i<6;i++)check(DirectInvoiceRetry.delay(i)==delays[i-1],"exact retry ladder");check(DirectInvoiceRetry.delay(6)==Long.MAX_VALUE,"six total starts");
  check(DirectInvoiceRetry.transientFailure(new java.net.SocketTimeoutException()),"timeout retry");check(DirectInvoiceRetry.transientFailure(new FleetHttp.HttpStatusException(503)),"503 retry");check(!DirectInvoiceRetry.transientFailure(new FleetHttp.HttpStatusException(403)),"403 final");check(!DirectInvoiceRetry.transientFailure(new java.io.FileNotFoundException()),"missing final");check(!DirectInvoiceRetry.transientFailure(new DirectInvoiceRetry.InvalidInput("corrupt")),"invalid final");
  check(DirectInvoiceRetry.parallelism("none",30,64000000)==2,"two light jobs");check(DirectInvoiceRetry.parallelism("moderate",30,64000000)==1,"thermal throttle");check(DirectInvoiceRetry.parallelism("none",43,64000000)==1,"battery throttle");check(DirectInvoiceRetry.parallelism("none",30,10000000)==1,"memory throttle");
  LocalWorkQueue.Storage storage=new LocalWorkQueue.Storage(){public JSONObject read(){return new JSONObject(disk);}public void write(JSONObject value){disk=value.toString();}};
  LocalWorkQueue queue=new LocalWorkQueue(storage);JSONArray jobs=new JSONArray();for(int i=0;i<62;i++)jobs.put(new JSONObject().put("id","job-"+i));queue.reconcile(jobs,null,null);
  queue.patch("job-0",new JSONObject().put("directAttempts",3).put("directState","waiting").put("retryAt",9000).put("directLastError","temporary"));
  queue=new LocalWorkQueue(storage);queue.reconcile(new JSONArray().put(new JSONObject().put("id","job-0")),null,null);check(queue.known().length()==62,"a short pending page never removes unseen jobs");
  JSONObject row=queue.ready(9000).getJSONObject(0);check(row.getInt("directAttempts")==3&&row.getString("directState").equals("waiting"),"restart and reconciliation retain attempt state");
  queue.reconcile(null,new JSONArray().put(new JSONObject().put("id","job-0").put("status","cancelled")),null);check(queue.known().length()==61,"explicit cancellation removes only its job");
  System.out.println("PASS actual Java Direct retry policy,62-job durable reconciliation/restart, transient/permanent classification and thermal/memory throttling.");
 }} `);
 const sources=['server-android/src/gr/argyrismitsos/fleetserver/LocalWorkQueue.java','independent-android/src/gr/argyrismitsos/fleetserver/DirectInvoiceRetry.java',path.join(dir,'FleetHttp.java'),path.join(dir,'DirectInvoicePolicyTest.java')];
 fs.writeFileSync(path.join(dir,'DirectInvoicesChecks.java'),fs.readFileSync('scripts/fixtures/DirectInvoicesChecks.java.txt','utf8'));
 fs.writeFileSync(path.join(dir,'Context.java'),'package android.content;public class Context{public static final int MODE_PRIVATE=0;public Prefs getSharedPreferences(String n,int m){return new Prefs();}public static class Prefs{public Prefs edit(){return this;}public Prefs putString(String k,String v){return this;}public void apply(){}}}');
 fs.writeFileSync(path.join(dir,'Uri.java'),'package android.net;public class Uri{public static String encode(String s,String allowed){return s;}}');
 sources.push('independent-android/src/gr/argyrismitsos/fleetserver/IndependentInvoices.java',...['DirectInvoicesChecks.java','Context.java','Uri.java'].map(n=>path.join(dir,n)));
 const jar=path.resolve('vendor/json-java/json-20240303.jar');execFileSync('java',['-jar',path.resolve('.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-encoding','UTF-8','-cp',jar,'-d',dir,...sources],{stdio:'inherit'});execFileSync('java',['-cp',dir+path.delimiter+jar,'gr.argyrismitsos.fleetserver.DirectInvoicePolicyTest'],{stdio:'inherit'});execFileSync('java',['-cp',dir+path.delimiter+jar,'gr.argyrismitsos.fleetserver.DirectInvoicesChecks'],{stdio:'inherit',timeout:30000});
}finally{fs.rmSync(dir,{recursive:true,force:true});}
console.log('PASS canonical62 legacy cases, Direct bounded retries/delays, known-state reconciliation and final-only alert. Synthetic only.');
