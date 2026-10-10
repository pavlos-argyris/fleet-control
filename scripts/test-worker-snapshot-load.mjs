import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import worker, { normalizeFleet } from '../cloudflare-worker/src/worker.js';
import { readServiceEntry, writeServiceEntry } from '../cloudflare-worker/src/snapshot-store.js';

class Statement {
  constructor(db, sql, args=[]) { this.db=db; this.sql=sql; this.args=args; }
  bind(...args) { return new Statement(this.db,this.sql,args); }
  async first() { return this.db.prepare(this.sql).get(...this.args) || null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() { const r=this.db.prepare(this.sql).run(...this.args); return { meta: { changes:Number(r.changes), last_row_id:Number(r.lastInsertRowid) } }; }
}
const sqlite=new DatabaseSync(':memory:');
const db={ exec:async sql=>sqlite.exec(sql), prepare:sql=>new Statement(sqlite,sql), batch:async stmts=>{ sqlite.exec('BEGIN'); try { const r=[];for(const s of stmts)r.push(await s.run());sqlite.exec('COMMIT');return r; }catch(e){sqlite.exec('ROLLBACK');throw e;} } };
const env={DB:db, SERVER_KEY:'large-fixture-server-key', PIN_PEPPER:'fixture-pepper',RELEASES:{get:async()=>null}};
const base='https://load-test.invalid';
async function call(path,body,token=null,method=null) {
  const headers=token ? {} : {'X-Fleet-Server-Key':env.SERVER_KEY};
  if(token)headers.Authorization='Bearer '+token;
  if(body!==undefined)headers['Content-Type']='application/json';
  return worker.fetch(new Request(base+path,{method:method || (body===undefined?'GET':'POST'),headers,body:body===undefined?undefined:JSON.stringify(body)}),env);
}
assert.equal((await call('/api/status')).status,200);
const bootstrap=await call('/api/auth/bootstrap',{fullName:'Load Fixture',username:'load-owner',password:'Fixture-Password-123',deviceId:'load-fixture'});
assert.equal(bootstrap.status,200);const token=(await bootstrap.json()).token;
const stamp=new Date().toISOString();
const qr='https://einvoice.impact.gr/p/EL099902715/LOAD';
const source={bikes:Array.from({length:40},(_,b)=>({id:'bike-'+b,name:'BTO-'+(100+b),currentKm:100000,intervalKm:3000,lastServiceKm:99000,
  history:Array.from({length:500},(_,h)=>({id:'entry-'+h,type:h<5?'service':'check',km:1000+h,date:'2026-10-10',tasks:h<5?['Αλλαγή λαδιών']:[],
    attachments:h<5?[{id:'invoice-'+h,key:`service-documents/bike-${b}/entry-${h}/invoice.pdf`,name:'invoice.pdf',contentType:'application/pdf',size:14,uploadedAt:stamp,
      ocr:{plate:'BTO-'+(100+b),totalAmount:'34,00',lineItems:['Λάδι'],rawText:'Παραστατικό '.repeat(400)}}]:[],createdAt:stamp,updatedAt:stamp})),createdAt:stamp,updatedAt:stamp}))};
const fleet=normalizeFleet(source);
sqlite.prepare('UPDATE fleet_snapshot SET data=?,version=50,source=\'canonical\',updated_at=? WHERE id=1').run(JSON.stringify(fleet),stamp);
const before=JSON.stringify(fleet.bikes[39]);
let largeParses=0;const parse=JSON.parse;
JSON.parse=function(value,...args){if(typeof value==='string' && value.length>500000)largeParses++;return parse(value,...args);};
let response;
const start=performance.now();
try { response=await call('/api/snapshot'); } finally { JSON.parse=parse; }
assert.equal(response.status,200);const remote=await response.json();
assert.equal(remote.bikes.length,40);assert.equal(remote.bikes[0].history.length,500);
assert.equal(largeParses,0,'snapshot route must not rebuild a large fleet in Worker JavaScript');
assert.equal(JSON.stringify(remote.bikes[39]),before);
const snapshotReadMs=performance.now()-start;
const unauthorized=await worker.fetch(new Request(base+'/api/snapshot'),env);assert.equal(unauthorized.status,401);
const jobs=Array.from({length:10},(_,i)=>({id:'progress-'+i,payload:{bikeId:'bike-'+i,entryId:'entry-4',qrUrl:qr+i,requestedAt:stamp,attemptCount:0}}));
for(const job of jobs)sqlite.prepare("INSERT INTO fleet_operations(id,source,type,payload,status,created_at) VALUES (?,'fixture','service_document_render',?,'pending',?)").run(job.id,JSON.stringify(job.payload),stamp);
const progressStart=performance.now();
const results=await Promise.all(jobs.map(job=>call('/api/server/operation-progress',{jobId:job.id,progress:55,stage:'Έλεγχος PDF'})));
assert.ok(results.every(r=>r.status===200));
for(const job of jobs)assert.equal((await readServiceEntry(env,job.payload.bikeId,job.payload.entryId)).entry.invoiceData.qrProcessingProgress,'55');
const progressBurstMs=performance.now()-progressStart;
assert.equal(JSON.stringify(parse(sqlite.prepare('SELECT data FROM fleet_snapshot').get().data).bikes[39]),before,'unrelated bike must remain byte-equivalent');
// A single-bike upload preserves all unrelated histories and cannot bypass authentication.
const changedBike=JSON.parse(JSON.stringify(remote.bikes[10]));changedBike.currentKm=100500;changedBike.updatedAt=new Date(Date.now()+1000).toISOString();
let single=await call('/api/sync/bike',{bike:changedBike},token);assert.equal(single.status,200);assert.equal((await single.json()).bike.currentKm,100500);
assert.equal(JSON.stringify(parse(sqlite.prepare('SELECT data FROM fleet_snapshot').get().data).bikes[39]),before);
single=await call('/api/server/snapshot/bike',{bike:changedBike},null,'PUT');assert.equal(single.status,200);assert.equal((await single.json()).unchanged,true);
assert.equal((await worker.fetch(new Request(base+'/api/sync/bike',{method:'POST',body:JSON.stringify({bike:changedBike})}),env)).status,401);
// Entry-level optimistic guards permit unrelated concurrent writes and reject stale edits.
const stale=await readServiceEntry(env,'bike-0','entry-4');
const first={...stale.entry,notes:'Manual correction',updatedAt:stamp};assert.ok(await writeServiceEntry(env,stale,first,'fixture-manual',stamp));
assert.equal(await writeServiceEntry(env,stale,{...stale.entry,notes:'stale overwrite'},'fixture-stale',stamp),0);
assert.equal((await readServiceEntry(env,'bike-0','entry-4')).entry.notes,'Manual correction');
// Gateway failures must not consume the PDF failure budget or leave the queue.
for(let i=0;i<5;i++)assert.equal((await call('/api/server/operation-error',{jobId:jobs[0].id,error:'HTTP 503 • Ray fixture',retryable:true})).status,200);
let row=sqlite.prepare('SELECT payload,status FROM fleet_operations WHERE id=?').get(jobs[0].id);let payload=parse(row.payload);
assert.equal(row.status,'pending');assert.equal(payload.attemptCount,0);assert.equal(payload.transientAttemptCount,5);
assert.ok(Date.parse(payload.nextAttemptAt)>Date.now());
let pending=await (await call('/api/server/pending')).json();assert.ok(!pending.operations.some(x=>x.id===jobs[0].id));
assert.ok(pending.operations.some(x=>x.id===jobs[1].id),'backoff must not block another queued invoice');
for(let i=0;i<3;i++)await call('/api/server/operation-error',{jobId:jobs[1].id,error:'PDF render failed',retryable:false});
assert.equal(sqlite.prepare('SELECT status FROM fleet_operations WHERE id=?').get(jobs[1].id).status,'error');
assert.equal((await call('/api/service-documents/jobs/'+jobs[1].id+'/retry',{},token)).status,200);
payload=parse(sqlite.prepare('SELECT payload FROM fleet_operations WHERE id=?').get(jobs[1].id).payload);assert.equal(payload.attemptCount,0);assert.equal(payload.nextAttemptAt,undefined);
// Completion is terminal; late progress/error callbacks cannot restore an error.
const retryPayload={...jobs[2].payload,entryId:'entry-0'};
sqlite.prepare('UPDATE fleet_operations SET payload=? WHERE id=?').run(JSON.stringify(retryPayload),jobs[2].id);
const existing=await readServiceEntry(env,'bike-2','entry-0');existing.entry.attachments[0].renderJobId=jobs[2].id;
await writeServiceEntry(env,existing,existing.entry,'fixture-complete',stamp);
assert.equal((await (await call('/api/server/operation-progress',{jobId:jobs[2].id,progress:95})).json()).status,'completed');
assert.equal((await (await call('/api/server/operation-error',{jobId:jobs[2].id,error:'late HTTP 503',retryable:true})).json()).status,'completed');
// The completed attachment lives on the job's service.
// Repoint the fixture payload to that service for an actual stored-PDF OCR retry.
const errored=await readServiceEntry(env,'bike-2','entry-0');errored.entry.attachments[0].ocrError='Earlier AI failure';
await writeServiceEntry(env,errored,errored.entry,'fixture-ocr-error',stamp);
let aiCalls=0;const bytes=new TextEncoder().encode('%PDF-1.4\n%%EOF');
env.RELEASES.get=async()=>({arrayBuffer:async()=>bytes.buffer,httpMetadata:{contentType:'application/pdf'}});
env.AI={toMarkdown:async()=>({data:'Synthetic invoice',format:'markdown'}),run:async()=>{aiCalls++;return {response:JSON.stringify({plate:'BTO-102',totalAmount:'34,00',lineItems:['Λάδι'],invoiceDate:'2026-10-10'})};}};
const retryResponse=await call('/api/service-documents/jobs/'+jobs[2].id+'/retry',{},token);
assert.equal(retryResponse.status,200);const retried=await retryResponse.json();assert.equal(retried.reprocessed,true);assert.equal(retried.status,'completed');assert.equal(aiCalls,1);
const afterRetry=await readServiceEntry(env,'bike-2','entry-0');assert.equal(afterRetry.entry.attachments.length,1);assert.equal(afterRetry.entry.attachments[0].ocrError,'');
const listResponse=await call('/api/admin/service-documents',undefined,token);assert.equal(listResponse.status,200);const list=await listResponse.json();assert.equal(list.documents.filter(d=>d.key).length,200);
assert.ok(list.documents.every(d=>d.transferOptions.length===0 && d.transferOptionsLazy===true));
const options=await call('/api/admin/service-documents/transfer-options?bikeId=bike-2&entryId=entry-0&key='+encodeURIComponent(afterRetry.entry.attachments[0].key),undefined,token);assert.equal(options.status,200);assert.ok((await options.json()).options.length<=200);
const sqlArchive=sqlite.prepare("INSERT INTO vehicle_archives(bike_id,name,active,archived_at,archived_by,reason) VALUES ('bike-39','BTO-139',1,?,'fixture','test')");
sqlArchive.run(stamp);
assert.equal((await (await call('/api/snapshot')).json()).bikes.length,39);
assert.equal((await (await call('/api/sync')).json()).archivedBikeIds.includes('bike-39'),true);
const clock=Date.now;Date.now=()=>clock()+6000;
try { assert.equal((await (await call('/api/status')).json()).bikes,39); } finally { Date.now=clock; }
console.log(JSON.stringify({passed:true,bikes:40,historyEntries:20000,invoices:200,concurrentProgress:10,snapshotReadMs,progressBurstMs,scope:'local SQLite integration timings; not Cloudflare production CPU'}));
sqlite.close();
