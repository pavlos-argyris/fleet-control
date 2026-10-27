import assert from 'node:assert/strict';
import {createSimulation} from './fixtures/workforce-simulation.mjs';
import {normalizeFleet} from '../cloudflare-worker/src/worker.js';
import {readServiceEntry} from '../cloudflare-worker/src/snapshot-store.js';

const {db,env,call}=createSimulation(),sql=db.sqlite;
const boot=await call('/api/auth/bootstrap',{server:true,method:'POST',body:{fullName:'Review Fixture',username:'review-fixture',password:'ReviewFixture!7'}});
assert.equal(boot.status,200);const token=boot.data.token,stamp='2026-10-10T10:00:00.000Z';
const key='service-documents/source/service/one.pdf',targetKey='service-documents/target/destination/two.pdf';
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
const api=(path,body)=>call(path,{token,...(body===undefined?{}:{method:'POST',body})});
const file=(id,k,amount='59')=>({id,key:k,name:id+'.pdf',contentType:'application/pdf',uploadedAt:stamp,ocr:{plate:'BTO-756',odometerKm:'9000',totalAmount:amount,rawText:'Σχόλια BTO-756 9000\n'+('Αρχικό κείμενο παραστατικού '.repeat(400))}});
function seed(){
 const fleet=normalizeFleet({bikes:[{id:'source',name:'BTO-756',currentKm:12000,lastServiceKm:10000,intervalKm:3000,createdAt:stamp,updatedAt:stamp,
  history:[{id:'oil',type:'service',km:10000,date:'2026-10-11',oilChanged:true,tasks:['Αλλαγή λαδιών'],updatedAt:stamp},{id:'service',type:'service',km:9000,date:'2026-10-10',tasks:['Γενικός έλεγχος'],notes:'Χειρόγραφη σημείωση',updatedAt:stamp,attachments:[file('one',key)]}]},
  {id:'target',name:'BTO-757',currentKm:15000,lastServiceKm:12000,intervalKm:3000,updatedAt:stamp,history:[{id:'destination',type:'service',km:9000,date:'2026-10-09',tasks:['Τακάκια'],updatedAt:stamp,attachments:[file('two',targetKey,'9')]},{id:'other',type:'check',km:15000,date:'2026-10-12',updatedAt:stamp,notes:'Untouched'}]}]});
 sql.prepare('UPDATE fleet_snapshot SET data=?,version=version+10,updated_at=? WHERE id=1').run(JSON.stringify(fleet),stamp);
}
const snapshot=()=>({...sql.prepare('SELECT data,version FROM fleet_snapshot WHERE id=1').get()});
const counters=()=>({outbox:sql.prepare("SELECT COUNT(*) n FROM fleet_operations WHERE type='snapshot_replace_bike'").get().n,audit:sql.prepare("SELECT COUNT(*) n FROM audit_log WHERE action IN ('service_document_reviewed','service_document_moved')").get().n,receipts:sql.prepare("SELECT COUNT(*) n FROM idempotency_keys WHERE action='service_invoice_review'").get().n});
async function detail(bikeId='source',entryId='service',documentKey=key){const r=ok(await api('/api/admin/service-documents/transfer-options?'+new URLSearchParams({bikeId,entryId,key:documentKey,includeDocument:'1'})));assert.match(r.document.reviewRevision,/^[a-f0-9]{64}$/);return r.document;}
const payload=(record,extra={})=>({bikeId:record.bikeId,entryId:record.entryId,key:record.key,requestId:crypto.randomUUID(),expectedReviewRevision:record.reviewRevision,expectedEntryUpdatedAt:record.serviceUpdatedAt,keepOnCurrent:true,compactResponse:true,
 invoiceData:{plate:'BTO-756',odometerKm:'9000',totalAmount:'60'},...extra});
const review=body=>api('/api/admin/service-documents/review',body);
async function injectedFailure(body,trigger){
 const before=snapshot(),counts=counters(),registry=JSON.stringify(sql.prepare('SELECT * FROM vehicle_registry ORDER BY bike_id').all());
 sql.exec(trigger);const errorLog=console.error;console.error=error=>{if(!String(error).includes('injected_review_failure'))errorLog(error);};
 try{ok(await review(body),500);}finally{console.error=errorLog;sql.exec('DROP TRIGGER injected_review_failure');}
 assert.deepEqual(snapshot(),before,'A failed transaction must preserve both data and version');assert.deepEqual(counters(),counts,'No receipt, audit or outbox may survive a failed transaction');assert.equal(JSON.stringify(sql.prepare('SELECT * FROM vehicle_registry ORDER BY bike_id').all()),registry);
}

// Opening a new invoice must not invalidate its own old-client save guard.
seed();let listed=ok(await api('/api/admin/service-documents')).documents.find(d=>d.key===key),before=snapshot();
assert.equal(listed.detailsLazy,true);assert.equal(listed.invoiceData.rawText,undefined);assert.deepEqual(listed.reviewJournal,[]);
ok(await api('/api/admin/service-documents/seen',{bikeId:'source',entryId:'service',key}));
assert.equal((await readServiceEntry(env,'source','service')).entry.updatedAt,stamp);
const afterSeen=snapshot();assert.equal(afterSeen.version,before.version+1);
assert.equal(ok(await api('/api/admin/service-documents/seen',{bikeId:'source',entryId:'service',key})).unchanged,true);assert.deepEqual(snapshot(),afterSeen);
ok(await review({bikeId:'source',entryId:'service',key,expectedEntryUpdatedAt:listed.serviceUpdatedAt,invoiceData:{plate:'BTO-756',odometerKm:'9000',totalAmount:'59'}}));

// Outbox failure after snapshot/registry writes rolls everything back.
seed();let record=await detail();assert.ok(record.invoiceData.rawText.length>10000);let body=payload(record);
await injectedFailure(body,"CREATE TEMP TRIGGER injected_review_failure BEFORE INSERT ON fleet_operations WHEN NEW.type='snapshot_replace_bike' BEGIN SELECT RAISE(ABORT,'injected_review_failure'); END;");
let counts=counters();let saved=ok(await review(body));assert.equal(saved.document.status,'confirmed');assert.equal(saved.document.invoiceData.rawText,undefined);assert.ok(!sql.prepare("SELECT response FROM idempotency_keys WHERE id LIKE ?").get('%:'+body.requestId)?.response.includes('Αρχικό κείμενο παραστατικού'),'Retry receipts do not duplicate raw OCR');assert.equal(saved.invoiceChanged,true);assert.equal(saved.document.serviceKm,9000);assert.equal(saved.serviceChanged,false);
assert.equal((await readServiceEntry(env,'source','service')).entry.notes,'Χειρόγραφη σημείωση','No-change tasks must not replace handwritten service notes');
assert.equal(counters().outbox,counts.outbox+1);assert.equal(counters().audit,counts.audit+1);
const afterSave=snapshot();counts=counters();const journal=(await readServiceEntry(env,'source','service')).entry.reviewJournal.length;
const replay=ok(await review(body));assert.equal(replay.reused,true);assert.equal(replay.version,saved.version);assert.deepEqual(snapshot(),afterSave);assert.deepEqual(counters(),counts);assert.equal((await readServiceEntry(env,'source','service')).entry.reviewJournal.length,journal);
ok(await review({...body,invoiceData:{...body.invoiceData,totalAmount:'99'}}),409);assert.deepEqual(snapshot(),afterSave);

// A fresh request with the same confirmed values is a true no-op.
record=await detail();const noOp=ok(await review(payload(record)));assert.equal(noOp.unchanged,true);assert.equal(noOp.serviceChanged,false);assert.deepEqual(snapshot(),afterSave);assert.equal(counters().audit,counts.audit);assert.equal(counters().outbox,counts.outbox);

const originalBatch=db.batch.bind(db);let race=null;
db.batch=async statements=>{if(race&&statements.some(s=>s.sql.includes('INSERT INTO idempotency_keys'))){const hook=race;race=null;await hook();}return originalBatch(statements);};
function mutate(bikeId,entryId,change){const root=JSON.parse(snapshot().data),bike=root.bikes.find(b=>b.id===bikeId);change(bike.history.find(e=>e.id===entryId));sql.prepare('UPDATE fleet_snapshot SET data=?,version=version+1 WHERE id=1').run(JSON.stringify(root));}
// Unrelated fleet progress does not create a global-version conflict.
seed();record=await detail();race=()=>mutate('target','other',e=>{e.notes='Concurrent real update';e.updatedAt='2026-10-27T20:00:00Z';});ok(await review(payload(record)));assert.equal((await readServiceEntry(env,'target','other')).entry.notes,'Concurrent real update');
// Volatile progress on this very service causes a guarded retry, not stale UI.
seed();record=await detail();race=()=>mutate('source','service',e=>{e.invoiceData={...(e.invoiceData||{}),qrProcessingProgress:'65'};e.updatedAt='2026-10-27T20:00:01Z';});ok(await review(payload(record)));assert.equal((await readServiceEntry(env,'source','service')).entry.invoiceData.qrProcessingProgress,'65');
// A genuine concurrent mileage edit remains protected.
seed();record=await detail();counts=counters();race=()=>mutate('source','service',e=>{e.km=9100;e.updatedAt='2026-10-27T20:00:02Z';});ok(await review(payload(record)),409);assert.equal((await readServiceEntry(env,'source','service')).entry.km,9100);assert.deepEqual(counters(),counts);

// Mileage correction recomputes only affected metrics and preserves other history.
seed();record=await detail();const unrelated=JSON.parse(snapshot().data).bikes[1];saved=ok(await review(payload(record,{updateServiceKm:true,mileageDecision:'apply',expectedServiceKm:9000,invoiceData:{odometerKm:'9500',totalAmount:'59'}})));assert.equal(saved.document.serviceKm,9500);assert.equal(saved.serviceChanged,true);const root=JSON.parse(snapshot().data);assert.equal(root.bikes[0].lastServiceKm,10000);assert.equal(root.bikes[0].currentKm,10000);assert.deepEqual(root.bikes[1],unrelated);

// Reviews can start in one order and commit in the opposite order. Server
// replacement payloads must be delivered in commit order, never request time.
seed();const pairRoot=JSON.parse(snapshot().data),thirdKey='service-documents/source/oil/three.pdf';pairRoot.bikes[0].history.find(e=>e.id==='oil').attachments=[{...file('three',thirdKey),ocr:{plate:'BTO-756',odometerKm:'10000',totalAmount:'59'}}];sql.prepare('UPDATE fleet_snapshot SET data=? WHERE id=1').run(JSON.stringify(pairRoot));
record=await detail();const otherRecord=await detail('source','oil',thirdKey),firstBody=payload(record),secondBody=payload(otherRecord,{invoiceData:{plate:'BTO-756',odometerKm:'10000',totalAmount:'61'}});
const NativeDate=Date;let reviewClock=NativeDate.now();globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[reviewClock]));}static now(){return reviewClock;}};
let secondSave;try{race=async()=>{reviewClock+=1000;secondSave=ok(await review(secondBody));};saved=ok(await review(firstBody));}finally{globalThis.Date=NativeDate;}
const pair=ok(await call('/api/server/pending?queue=sync&limit=100',{server:true})).operations.filter(o=>[saved.operationId,secondSave.operationId].includes(o.id)),latestBike=pair.at(-1).payload.bike;assert.equal(pair.length,2);
assert.equal(latestBike.history.find(e=>e.id==='service').attachments[0].ocr.totalAmount,'60','The last Server replacement must include both concurrently saved invoice reviews');
assert.equal(latestBike.history.find(e=>e.id==='oil').attachments[0].ocr.totalAmount,'61');
assert.ok(Date.parse(JSON.parse(snapshot().data).bikes[0].updatedAt)>=reviewClock,'A delayed commit cannot move the bike stamp backwards');

// A transfer's second outbox failure also rolls back its source and destination.
seed();record=await detail();body=payload(record,{keepOnCurrent:false,moveToBikeId:'target',moveToEntryId:'destination',invoiceData:{plate:'BTO-757',odometerKm:'9000',totalAmount:'50'}});
await injectedFailure(body,"CREATE TEMP TRIGGER injected_review_failure BEFORE INSERT ON fleet_operations WHEN NEW.type='snapshot_replace_bike' AND json_extract(NEW.payload,'$.bike.id')='target' BEGIN SELECT RAISE(ABORT,'injected_review_failure'); END;");
counts=counters();saved=ok(await review(body));assert.equal(saved.moved,true);assert.equal((await readServiceEntry(env,'source','service')).entry.attachments.length,0);assert.equal((await readServiceEntry(env,'target','destination')).entry.attachments.length,2);assert.equal(counters().outbox,counts.outbox+2);assert.equal(counters().audit,counts.audit+1);before=snapshot();counts=counters();assert.equal(ok(await review(body)).reused,true);assert.deepEqual(snapshot(),before);assert.deepEqual(counters(),counts);

// Moving between two services on the same bike queues that bike only once.
seed();record=await detail();counts=counters();saved=ok(await review(payload(record,{keepOnCurrent:false,moveToBikeId:'source',moveToEntryId:'oil'})));assert.equal(saved.document.entryId,'oil');assert.equal(counters().outbox,counts.outbox+1);assert.equal((await readServiceEntry(env,'source','service')).entry.attachments.length,0);assert.equal((await readServiceEntry(env,'source','oil')).entry.attachments.length,1);
// A delete between reading and committing must never resurrect the invoice.
seed();record=await detail();counts=counters();race=()=>mutate('source','service',e=>{e.attachments=[];});ok(await review(payload(record)),404);assert.equal((await readServiceEntry(env,'source','service')).entry.attachments.length,0);assert.deepEqual(counters(),counts);

assert.equal((await call('/api/admin/service-documents/transfer-options?'+new URLSearchParams({bikeId:'target',entryId:'destination',key,includeDocument:'1'}))).status,401);
// A failed AI extraction records the failure without cleaning up or rewriting
// manually entered service data, timestamps or the Server outbox.
seed();let originalEntry=(await readServiceEntry(env,'source','service')).entry;
const beforeFailure=JSON.stringify({km:originalEntry.km,tasks:originalEntry.tasks,notes:originalEntry.notes,workshop:originalEntry.workshop,invoiceData:originalEntry.invoiceData,updatedAt:originalEntry.updatedAt});counts=counters();
await env.RELEASES.put(key,new TextEncoder().encode('%PDF-1.4\nfixture\n%%EOF'),{httpMetadata:{contentType:'application/pdf'}});
env.AI={toMarkdown:async()=>({data:'Synthetic invoice',format:'markdown'}),run:async()=>{throw new Error('injected_reader_unavailable');}};
const failedRead=ok(await api('/api/admin/service-documents/reprocess',{key,forceAi:true}));assert.match(failedRead.ocrWarning,/injected_reader_unavailable/);assert.equal(failedRead.serviceChanged,false);
let afterFailure=(await readServiceEntry(env,'source','service')).entry;
assert.equal(JSON.stringify({km:afterFailure.km,tasks:afterFailure.tasks,notes:afterFailure.notes,workshop:afterFailure.workshop,invoiceData:afterFailure.invoiceData,updatedAt:afterFailure.updatedAt}),beforeFailure);assert.match(afterFailure.attachments[0].ocrError,/injected_reader_unavailable/);assert.equal(counters().outbox,counts.outbox);
console.log('PASS actual Worker/SQLite review reliability: seen metadata, full lazy detail, atomic receipt/snapshot/outbox/audit rollback, safe identical retries, changed-request rejection, no-op confirmation, unrelated/progress races, real edit protection, targeted mileage and two-bike transfer. Synthetic data only.');
