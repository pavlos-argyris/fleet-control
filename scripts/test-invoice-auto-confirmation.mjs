import assert from 'node:assert/strict';
import {createSimulation} from './fixtures/workforce-simulation.mjs';
import {invoiceText} from './fixtures/invoice-layout.mjs';
import {normalizeFleet} from '../cloudflare-worker/src/worker.js';
import {readServiceEntry} from '../cloudflare-worker/src/snapshot-store.js';

const {db,env,call,callRaw}=createSimulation(),sql=db.sqlite;
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
const boot=ok(await call('/api/auth/bootstrap',{server:true,method:'POST',body:{fullName:'Synthetic Invoice Owner',username:'invoice-fixture',password:'SyntheticFixture!7'}})),token=boot.token;
const stamp='2026-10-10T10:00:00.000Z',supplier='ΣΥΝΘΕΤΙΚΟ ΣΥΝΕΡΓΕΙΟ',qr='https://invoice.example.invalid/synthetic';
const key=id=>`service-documents/b/${id}/${id}.pdf`;
const local=(id,extra={})=>({rawText:invoiceText({number:'INV'+id,count:60}),supplier,localReadStatus:'confident',ocrConfidence:100,...extra});
const file=(id,data={})=>({id,key:key(id),name:id+'.pdf',contentType:'application/pdf',uploadedAt:stamp,ocr:data});
const entry=(id,data={},extra={})=>({id,type:'service',date:'2026-10-10',km:9000,tasks:['Γενικός έλεγχος'],notes:'Χειρόγραφη σημείωση',updatedAt:stamp,attachments:[file(id,data)],...extra});
function seed(entries=[entry('1')]) {
 const fleet=normalizeFleet({bikes:[{id:'b',name:'BTO-756',currentKm:10000,lastServiceKm:9000,intervalKm:3000,updatedAt:stamp,history:entries}]});
 sql.prepare('UPDATE fleet_snapshot SET data=?,version=version+1 WHERE id=1').run(JSON.stringify(fleet));
 sql.prepare('DELETE FROM fleet_settings WHERE key=?').run('service_invoice_reprocess_batch');
}
const stored=async id=>(await readServiceEntry(env,'b',id)).entry;
const counters=()=>({outbox:sql.prepare("SELECT COUNT(*) n FROM fleet_operations WHERE type='snapshot_replace_bike'").get().n,receipts:sql.prepare("SELECT COUNT(*) n FROM idempotency_keys WHERE action='service_invoice_review'").get().n});
const batchStart=async (ids,mode='server-first')=>ok(await call('/api/admin/service-documents/reprocess-batch',{token,method:'POST',body:{action:'start',batchId:'batch-'+crypto.randomUUID(),mode,items:ids.map(id=>({key:key(id),name:id+'.pdf'}))}}),201).batch;
const batchResult=(batch,id,ocr)=>call('/api/server/service-documents/reprocess-batch',{server:true,method:'POST',body:{action:'result',batchId:batch.id,key:key(id),localOcr:ocr}});
const full=async id=>ok(await call('/api/admin/service-documents/transfer-options?'+new URLSearchParams({bikeId:'b',entryId:id,key:key(id),includeDocument:'1'}),{token})).document;

// A new QR-rendered PDF confirms without opening its review form. Full text
// and >50 rows travel in the body, and the result reaches the Server outbox.
seed([entry('new',{}, {attachments:[]})]);
const job='new-'+crypto.randomUUID();
sql.prepare("INSERT INTO fleet_operations(id,source,type,payload,status,created_at) VALUES(?,'fixture','service_document_render',?,'pending',?)").run(job,JSON.stringify({bikeId:'b',entryId:'new',qrUrl:qr}),stamp);
const upload=async()=>{const form=new FormData();form.set('analysis',JSON.stringify(local('100')));form.set('file',new Blob(['%PDF-1.4\nsynthetic\n%%EOF'],{type:'application/pdf'}),'invoice.pdf');return callRaw('/api/server/service-documents/rendered?'+new URLSearchParams({bikeId:'b',entryId:'new',jobId:job,qrUrl:qr,qrValue:qr,name:'fixture.pdf'}),{server:true,method:'PUT',body:form});};
let counts=counters(),response=ok(await upload(),201),saved=await stored('new');
assert.equal(response.requiresConfirmation,false);assert.equal(response.attachment.ocr.confirmationMethod,'automatic');assert.equal(saved.attachments[0].ocr.lineItems.length,60);
assert.equal(saved.tasks.filter(t=>t.startsWith('Εργασία')).length,60);assert.equal(saved.notes,'Χειρόγραφη σημείωση');assert.equal(saved.km,9000);assert.equal(saved.reviewJournal.length,1);
assert.equal(counters().outbox,counts.outbox+1);counts=counters();ok(await upload());assert.deepEqual(counters(),counts);assert.equal((await stored('new')).attachments.length,1);

// Two different PDF uploads with the same invoice identity race between
// the friendly precheck and the D1 transaction. At most one auto-confirms.
seed([entry('race-a',{}, {attachments:[]}),entry('race-b',{}, {attachments:[]})]);
const raceJobs=['race-a','race-b'].map(id=>{const jobId=id+'-'+crypto.randomUUID();sql.prepare("INSERT INTO fleet_operations(id,source,type,payload,status,created_at) VALUES(?,'fixture','service_document_render',?,'pending',?)").run(jobId,JSON.stringify({bikeId:'b',entryId:id,qrUrl:qr+'/'+id}),stamp);return jobId;});
const raceUpload=async(index)=>{const id=index?'race-b':'race-a',form=new FormData();form.set('analysis',JSON.stringify(local('44')));form.set('file',new Blob(['%PDF-1.4 synthetic'],{type:'application/pdf'}),'race.pdf');return callRaw('/api/server/service-documents/rendered?'+new URLSearchParams({bikeId:'b',entryId:id,jobId:raceJobs[index],qrUrl:qr+'/'+id,qrValue:qr+'/'+id,name:'race.pdf'}),{server:true,method:'PUT',body:form});};
const beforeRaceBatch=db.batch.bind(db);let raced=false;
db.batch=async statements=>{if(!raced&&statements[0].sql.includes('INSERT INTO idempotency_keys')){raced=true;ok(await raceUpload(1),201);}return beforeRaceBatch(statements);};
try{ok(await raceUpload(0),201);}finally{db.batch=beforeRaceBatch;}
const raceFiles=[(await stored('race-a')).attachments[0],(await stored('race-b')).attachments[0]];
assert.equal(raceFiles.filter(f=>f.ocr.confirmationMethod==='automatic').length,1);assert.ok(raceFiles.find(f=>!f.ocr.confirmedAt).ocr.reviewIssues.some(r=>r.code==='duplicate-invoice'));

// A mixed retrospective run classifies each committed result. The failed
// read preserves its earlier valid business data and never claims success.
const oldManual={supplier,invoiceNumber:'INV4',invoiceDate:'2026-10-10',plate:'BTO-756',odometerKm:'8800',totalAmount:'99,00',confirmedAt:stamp,reviewedBy:'Owner',correctedByUserAt:stamp,mileageResolution:'keep',mileageResolutionEntryId:'4',mileageResolutionRead:'8800',mileageResolutionServiceKm:'9000',lineItems:['Χειροκίνητη εργασία']};
seed([entry('1'),entry('2'),entry('3',{supplier,totalAmount:'77,00',lineItems:['Παλιό έγκυρο στοιχείο']}),entry('4',oldManual)]);
let batch=await batchStart(['1','2','3','4']);
response=ok(await batchResult(batch,'1',local('1')));assert.equal(response.batch.automaticConfirmed,1);assert.equal((await full('1')).status,'confirmed');
const ambiguous=local('2',{rawText:invoiceText({number:'INV2',km:'9100'})});
response=ok(await batchResult(batch,'2',ambiguous));assert.equal(response.batch.needsReview,1);assert.notEqual((await full('2')).status,'confirmed');
response=ok(await batchResult(batch,'3',{localReadStatus:'failed',ocrFallbackReason:'Synthetic reader failure'}));assert.equal(response.batch.failed,1);saved=await stored('3');assert.equal(saved.attachments[0].ocr.totalAmount,'77,00');assert.deepEqual(saved.attachments[0].ocr.lineItems,['Παλιό έγκυρο στοιχείο']);assert.equal(saved.notes,'Χειρόγραφη σημείωση');
response=ok(await batchResult(batch,'4',local('4')));assert.equal(response.batch.status,'completed_with_errors');assert.equal(response.batch.completed,4);assert.equal(response.batch.automaticConfirmed,1);assert.equal(response.batch.needsReview,2);assert.equal(response.batch.failed,1);
saved=await stored('4');assert.equal(saved.attachments[0].ocr.totalAmount,'99,00');assert.equal(saved.attachments[0].ocr.confirmedAt,stamp);assert.equal(saved.attachments[0].ocr.mileageResolution,'keep');assert.equal(saved.attachments[0].ocr.confirmationMethod,'manual');assert.ok(saved.attachments[0].ocr.reviewIssues.some(p=>p.code==='new-extraction-difference'));assert.equal(saved.km,9000);assert.deepEqual(saved.tasks,['Γενικός έλεγχος']);
counts=counters();response=ok(await batchResult(batch,'4',local('4')));assert.equal(response.ignored,true);assert.deepEqual(counters(),counts);

// Explicitly accepting the same old/new difference acknowledges that exact
// read. A later different read must require review again.
let manualRecord=await full('4');
ok(await call('/api/admin/service-documents/review',{token,method:'POST',body:{bikeId:'b',entryId:'4',key:key('4'),requestId:'manual-ack-'+crypto.randomUUID(),expectedReviewRevision:manualRecord.reviewRevision,compactResponse:true,keepOnCurrent:true,invoiceData:manualRecord.invoiceData,tasks:manualRecord.tasks}}));
batch=await batchStart(['4']);response=ok(await batchResult(batch,'4',local('4')));assert.equal(response.batch.confirmedPreserved,1);assert.equal((await full('4')).status,'confirmed');
batch=await batchStart(['4']);response=ok(await batchResult(batch,'4',local('4',{rawText:invoiceText({number:'INV4',total:'125,00'})})));assert.equal(response.batch.needsReview,1);assert.equal((await full('4')).status,'warning');

// Transaction failure: no auto confirmation, journal or outbox survives;
// retrying the same batch item safely commits once and advances only once.
seed([entry('5')]);batch=await batchStart(['5']);const before=JSON.stringify(await stored('5'));
sql.exec("CREATE TEMP TRIGGER injected_auto_failure BEFORE INSERT ON fleet_operations WHEN NEW.type='snapshot_replace_bike' BEGIN SELECT RAISE(ABORT,'injected_auto_failure'); END;");
const log=console.error;console.error=()=>{};try{ok(await batchResult(batch,'5',local('5')),500);}finally{console.error=log;sql.exec('DROP TRIGGER injected_auto_failure');}
assert.equal(JSON.stringify(await stored('5')),before);assert.equal(ok(await call('/api/admin/service-documents/reprocess-batch',{token})).batch.completed,0);
counts=counters();response=ok(await batchResult(batch,'5',local('5')));assert.equal(response.batch.automaticConfirmed,1);assert.equal(counters().outbox,counts.outbox+1);assert.equal((await stored('5')).reviewJournal.length,1);

// A UI disconnection can happen after the invoice commit but before queue
// progress. A repeated item reuses its receipt without another service write.
seed([entry('6')]);batch=await batchStart(['6']);let failProgress=true;
const originalBatch=db.batch.bind(db);db.batch=async statements=>{if(failProgress&&statements[0].sql.includes('INSERT INTO fleet_settings')&&statements[0].args.some(v=>typeof v==='string'&&v.includes('"completed":1'))){failProgress=false;throw new Error('Synthetic progress write failure');}return originalBatch(statements);};
console.error=()=>{};try{ok(await batchResult(batch,'6',local('6')),500);}finally{console.error=log;}
counts=counters();response=ok(await batchResult(batch,'6',local('6',{localReadAt:'different-time-on-resume'})));assert.equal(response.batch.automaticConfirmed,1);assert.deepEqual(counters(),counts);assert.equal((await stored('6')).reviewJournal.length,1);db.batch=originalBatch;

// Labelled text is read before an LLM; the explicit Workers AI mode still
// invokes it. Both paths must apply the same deterministic confirmation.
seed([entry('8'),entry('9')]);let llmCalls=0;
for(const id of ['8','9'])await env.RELEASES.put(key(id),new Blob(['%PDF-1.4 synthetic'],{type:'application/pdf'}),{httpMetadata:{contentType:'application/pdf'}});
env.AI={toMarkdown:async value=>({data:invoiceText({number:value.name.includes('8')?'INV8':'INV9'})}),run:async()=>{llmCalls++;return {response:'{}'};}};
batch=await batchStart(['8']);response=ok(await batchResult(batch,'8',{localReadStatus:'failed'}));assert.equal(response.batch.automaticConfirmed,1);assert.equal(llmCalls,0,'deterministic complete text does not need an LLM');
batch=await batchStart(['9'],'workers-ai');response=ok(await batchResult(batch,'9',{localReadStatus:'failed'}));assert.equal(response.batch.automaticConfirmed,1);assert.equal(llmCalls,1,'forced Workers AI mode remains available');delete env.AI;

// At the bounded service-task capacity, preserve every previous task and
// the full invoice. Never auto-confirm a silently truncated task merge.
const priorTasks=Array.from({length:5120},(_,i)=>'Προηγούμενη εργασία '+i);
seed([entry('10',{}, {tasks:priorTasks,workshop:'Χειροκίνητο συνεργείο'})]);batch=await batchStart(['10']);response=ok(await batchResult(batch,'10',local('10')));assert.equal(response.batch.needsReview,1);saved=await stored('10');assert.deepEqual(saved.tasks,priorTasks);assert.equal(saved.attachments[0].ocr.lineItems.length,60);assert.ok(saved.attachments[0].ocr.reviewIssues.some(r=>r.code==='service-task-limit'));assert.equal(saved.workshop,'Χειροκίνητο συνεργείο');

// The QR-library draft path also reaches the same confirmation rules after
// the user explicitly chooses/creates its service. No 2000-char task fragment.
seed([]);const draftQr=qr+'/draft-512';
const scan=ok(await call('/api/admin/invoice-imports',{token,method:'POST',body:{action:'scan',value:draftQr}}),202);
const draftForm=new FormData();draftForm.set('analysis',JSON.stringify(local('512',{rawText:invoiceText({count:512,number:'INV512'})})));draftForm.set('file',new Blob(['%PDF-1.4 synthetic'],{type:'application/pdf'}),'draft.pdf');
ok(await callRaw('/api/server/service-documents/rendered?'+new URLSearchParams({bikeId:'draft-'+scan.draftId,entryId:'draft',jobId:scan.jobId,qrUrl:draftQr,qrValue:draftQr,name:'draft.pdf'}),{server:true,method:'PUT',body:draftForm}),201);
const imported=ok(await call('/api/admin/invoice-imports',{token,method:'POST',body:{action:'commit',id:scan.draftId,bikeId:'b',date:'2026-10-10',km:9000}}));
saved=await stored(imported.entryId);assert.equal(saved.tasks.length,512);assert.ok(saved.tasks.at(-1).includes('Εργασία 512'));assert.equal(saved.attachments[0].ocr.lineItems.length,512);assert.equal(saved.attachments[0].ocr.confirmationMethod,'automatic');

// No batch or retroactive AI runs on startup; starting twice has one owner.
seed([entry('7')]);assert.equal(ok(await call('/api/admin/service-documents/reprocess-batch',{token})).batch,null);
const starts=await Promise.all(['first-start','other-start'].map(batchId=>call('/api/admin/service-documents/reprocess-batch',{token,method:'POST',body:{action:'start',mode:'server-first',items:[{key:key('7')}],batchId}})));
assert.equal(starts.filter(r=>r.status===201&&r.data.started===true).length,1);
assert.equal(starts.filter(r=>r.status===200&&r.data.started===false).length,1);
assert.equal(starts[0].data.batch.id,starts[1].data.batch.id,'Both callers observe the one winner, whichever request won');
assert.equal((await call('/api/admin/service-documents/reprocess-batch',{method:'POST',body:{action:'start',items:[{key:key('7')}]}})).status,401);
console.log('PASS full Worker/SQLite automatic invoices: new multipart PDF, 60 complete tasks, retroactive mixed summary, manual protection/new differences, rollback, interrupted progress/retry, no duplicates, concurrent starts, authorization and no unsolicited batch. Synthetic only.');
