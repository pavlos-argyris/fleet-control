import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createSimulation} from './fixtures/workforce-simulation.mjs';
import {invoiceText} from './fixtures/invoice-layout.mjs';
import {normalizeFleet} from '../cloudflare-worker/src/worker.js';
import {readServiceEntry} from '../cloudflare-worker/src/snapshot-store.js';

const {db,call}=createSimulation(),sql=db.sqlite;
const boot=await call('/api/auth/bootstrap',{server:true,method:'POST',body:{fullName:'Retry Fixture',username:'retry-fixture',password:'RetryFixture!7'}});
assert.equal(boot.status,200);const token=boot.data.token,stamp='2026-10-10T10:00:00.000Z';
const request=(path,body,server=false)=>call(path,{...(server?{server:true}:{token}),...(body===undefined?{}:{method:'POST',body})});
const retry=body=>request('/api/admin/service-documents/retry-failed',body);
const key='service-documents/b/stored/error.pdf',good='service-documents/b/good/ok.pdf';
const file=(key,error)=>({id:key,key,name:key.split('/').pop(),contentType:'application/pdf',renderJobId:error?'stored-old':'good-job',ocrError:error?'Reader failed':'',ocr:{plate:'BTO-756',odometerKm:'9000',totalAmount:'59',...(error?{}:{confirmedAt:stamp,reviewStatus:'confirmed'})}});
const fleet=normalizeFleet({bikes:[{id:'b',name:'BTO-756',currentKm:10000,lastServiceKm:9000,intervalKm:3000,updatedAt:stamp,history:[
 {id:'qr',type:'service',date:'2026-10-10',km:9000,tasks:['Έλεγχος'],attachments:[],invoiceData:{qrJobId:'qr-old',qrUrl:'https://einvoice.impact.gr/p/RETRY-QR',qrProcessingStatus:'error'}},
 {id:'stored',type:'service',date:'2026-10-10',km:9000,tasks:['Έλεγχος'],attachments:[file(key,true)]},
 {id:'good',type:'service',date:'2026-10-10',km:9000,tasks:['Έλεγχος'],attachments:[file(good,false)]}
]}]});
sql.prepare('UPDATE fleet_snapshot SET data=?,version=100,updated_at=? WHERE id=1').run(JSON.stringify(fleet),stamp);
sql.prepare("INSERT OR REPLACE INTO fleet_settings(key,value,updated_at) VALUES('server_offload_protocol','1',?)").run(stamp);
function job(id,payload,status='error'){sql.prepare("INSERT INTO fleet_operations(id,source,type,payload,status,created_at) VALUES(?,'fixture','service_document_render',?,?,?)").run(id,JSON.stringify({...payload,requestedAt:stamp,attemptCount:3,lastError:'Reader failed'}),status,stamp);}
job('qr-old',{bikeId:'b',entryId:'qr',qrUrl:'https://einvoice.impact.gr/p/RETRY-QR'});
job('stored-old',{bikeId:'b',entryId:'stored',documentKey:key});
function alert(id,jobId){sql.prepare("INSERT INTO system_alerts(id,type,severity,title,message,object_type,object_id,dedupe_key,resolved,created_at) VALUES(?,'invoice_processing_failed','warning','Retry','Reader failed','invoice_job',?,?,0,?)").run(id,jobId,'fixture-'+id,stamp);}
alert('qr-alert','qr-old');alert('stored-alert','stored-old');
const before=JSON.stringify((await readServiceEntry({DB:db},'b','good')).entry);
assert.equal((await retry({})).status,400);
assert.equal((await call('/api/admin/service-documents/retry-failed',{method:'POST',body:{key}})).status,401);
let response=await retry({key:good});assert.equal(response.status,200);assert.equal(response.data.skipped,true);
assert.equal(JSON.stringify((await readServiceEntry({DB:db},'b','good')).entry),before);
assert.equal(sql.prepare("SELECT COUNT(*) n FROM fleet_operations WHERE status='pending'").get().n,0,'Successful invoices must not be queued');

const parallel=await Promise.all([retry({key}),retry({alertId:'stored-alert'}),retry({key})]);
for(const r of parallel)assert.equal(r.status,202,JSON.stringify(r.data));
let pending=sql.prepare("SELECT id FROM fleet_operations WHERE status='pending' AND json_extract(payload,'$.documentKey')=?").all(key);
assert.equal(pending.length,1,'Independent requests and notification/card aliases queue only one PDF read');
const storedJob=pending[0].id;
assert.deepEqual({...sql.prepare('SELECT resolved,object_id FROM system_alerts WHERE id=?').get('stored-alert')},{resolved:0,object_id:storedJob});
assert.equal((await request('/api/admin/alerts/stored-alert/resolve',{})).status,409,'Queue acceptance cannot dismiss a failure notice');
let alerts=(await request('/api/admin/alerts')).data.alerts;assert.equal(alerts.find(a=>a.id==='stored-alert').invoice_retry_state,'processing');

const qrResponses=await Promise.all([retry({jobId:'qr-old'}),retry({alertId:'qr-alert'})]);
assert.ok(qrResponses.some(r=>r.status===200));
const qrJob=sql.prepare("SELECT id FROM fleet_operations WHERE status='pending' AND json_extract(payload,'$.entryId')='qr'").get().id;
assert.notEqual(qrJob,'qr-old');assert.equal(sql.prepare("SELECT COUNT(*) n FROM fleet_operations WHERE status='pending' AND json_extract(payload,'$.entryId')='qr'").get().n,1);
assert.deepEqual({...sql.prepare('SELECT resolved,object_id FROM system_alerts WHERE id=?').get('qr-alert')},{resolved:0,object_id:qrJob});
await request('/api/server/operation-error',{jobId:qrJob,error:'Failed again'},true);
assert.equal(sql.prepare("SELECT COUNT(*) n FROM system_alerts WHERE object_id=? AND resolved=0").get(qrJob).n,1,'Retry failures update the same active alert');
assert.equal(sql.prepare('SELECT resolved FROM system_alerts WHERE id=?').get('qr-alert').resolved,0);

// Reader failure keeps the existing invoice, alert and manual service intact.
let result=await request('/api/server/service-documents/analysis-result',{jobId:storedJob,localOcr:{localReadStatus:'failed',ocrConfidence:0}},true);
assert.equal(result.status,200,JSON.stringify(result.data));assert.ok(result.data.ocrWarning);
assert.equal(sql.prepare('SELECT resolved FROM system_alerts WHERE id=?').get('stored-alert').resolved,0);
assert.equal((await readServiceEntry({DB:db},'b','stored')).entry.km,9000);
assert.equal((await readServiceEntry({DB:db},'b','stored')).entry.attachments[0].key,key);
await request('/api/server/ack',{ids:[storedJob]},true);
response=await retry({alertId:'stored-alert'});assert.equal(response.status,202,JSON.stringify(response.data));
const nextJob=response.data.jobId;assert.notEqual(nextJob,storedJob);
sql.exec("CREATE TRIGGER injected_retry_save_failure BEFORE UPDATE ON fleet_snapshot BEGIN SELECT RAISE(ABORT,'injected_retry_save_failure'); END");
const originalError=console.error;console.error=()=>{};const badSave=await request('/api/server/service-documents/analysis-result',{jobId:nextJob,localOcr:{localReadStatus:'confident',ocrConfidence:95,plate:'BTO-756',odometerKm:'9000'}},true);console.error=originalError;
assert.equal(badSave.status,500);assert.equal(sql.prepare('SELECT resolved FROM system_alerts WHERE id=?').get('stored-alert').resolved,0,'A failed result save cannot resolve the alert');sql.exec('DROP TRIGGER injected_retry_save_failure');
result=await request('/api/server/service-documents/analysis-result',{jobId:nextJob,localOcr:{rawText:invoiceText({count:4,number:'INV123',date:'10/10/2026',net:'47,58',vat:'11,42',total:'59,00'}),localReadStatus:'confident',ocrConfidence:95,plate:'BTO-756',odometerKm:'9000',totalAmount:'59',invoiceDate:'2026-10-10',invoiceNumber:'INV123',lineItems:['Έλεγχος']}},true);
assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.ocrWarning,'');
assert.equal(result.data.automaticConfirmed,true,JSON.stringify(result.data.document.invoiceData));assert.equal(result.data.document.status,'confirmed');assert.equal((await readServiceEntry({DB:db},'b','stored')).entry.attachments[0].ocr.lineItems.length,4,'Retry preserves every extracted invoice row');
assert.equal(sql.prepare('SELECT resolved FROM system_alerts WHERE id=?').get('stored-alert').resolved,1,'Only a saved successful analysis closes its alert');
assert.equal((await request('/api/admin/alerts')).data.alerts.some(a=>a.id==='stored-alert'),false);
assert.equal((await retry({alertId:'stored-alert'})).data.skipped,true);
assert.equal(sql.prepare("SELECT COUNT(*) n FROM fleet_settings WHERE key LIKE 'invoice_retry_lock:%'").get().n,0);

// Shipped controller: sequential bounded work, mixed results, duplicate clicks,
// deduped records, request-vs-analysis counts and isolation after logout.
vm.runInThisContext(fs.readFileSync('cloudflare-worker/public/invoice-retry.js','utf8'));
const model=globalThis.FleetInvoiceRetry;
const rows=Array.from({length:120},(_,i)=>({id:String(i),key:'fixture-'+i,status:'error',error:'failed'}));
assert.equal(model.candidates([...rows,rows[0],{id:'ok',key:'ok',status:'confirmed',error:'old'}]).length,120);
let live=0,max=0,calls=0,scope='owner';const changes=[];
const controller=model.create({context:()=>scope,onProgress:p=>changes.push(p),submit:async r=>{calls++;live++;max=Math.max(max,live);await Promise.resolve();live--;if(r.id==='2')throw new Error('HTTP 503, state unknown');if(r.id==='3')return {ocrWarning:'Reader failed'};if(r.id==='4')return {busy:true};return Number(r.id)%2?{status:'completed'}:{queued:true,status:'processing'};}});
const run=controller.batch([...rows,rows[0]]);assert.equal(controller.batch(rows),run);const report=await run;
assert.equal(calls,120);assert.equal(max,1);assert.equal(report.processed,120);assert.equal(report.failed,2);assert.equal(report.skipped,1);assert.equal(report.queued+report.completed+report.skipped+report.failed,120);assert.equal(changes.at(-1).done,true);
const one=controller.retry(rows[0]);assert.equal(controller.retry(rows[0]),one);await one;assert.equal(calls,121);
let submitted=0;const isolated=model.create({context:()=>scope,submit:async()=>{submitted++;scope='other';return {queued:true};}});const stopped=await isolated.batch(rows);assert.equal(submitted,1);assert.equal(stopped.cancelled,true);
console.log('PASS invoice retry actions: actual Worker/SQLite auth, current-state eligibility, parallel aliases, QR replacement, alert retention/failure/success, no service loss; 120-item bounded UI batch and session isolation.');
