import assert from 'node:assert/strict';
import {createSimulation} from './fixtures/workforce-simulation.mjs';
import {invoiceText} from './fixtures/invoice-layout.mjs';
import {enrichInvoiceExtraction} from '../cloudflare-worker/src/invoice-extraction.js';
import {invoiceReadComparison} from '../cloudflare-worker/src/invoice-read-identity.js';
import '../cloudflare-worker/public/service-model.js';
const M=globalThis.FleetServiceModel;
for(const text of ['ΦΙΛΤΡΟ ΛΑΔΙΟΥ','φιλτρο\nλαδιου','Αλλαγή φίλτρου λαδιού','OIL FILTER','φίλτρο αέρα','ΦΙΛΤΡΟ ΚΑΥΣΙΜΟΥ'])assert.equal(M.isOilTask(text),false,text);
assert.equal(M.isOilTask('Αλλαγή λαδιών'),true);assert.equal(M.isOilTask('YAMALUBE 10W40'),true);
assert.deepEqual(invoiceReadComparison({lineItems:[' ΦΊΛΤΡΟ\n ΛΑΔΙΟΎ ','Βίδα'],odometerKm:'9.000',totalAmount:'124,00'},M.cents),invoiceReadComparison({lineItems:['βίδα','φιλτρο λαδιου'],odometerKm:'9000',totalAmount:'124.00'},M.cents));
const {db,call}=createSimulation(),sql=db.sqlite;
const boot=await call('/api/auth/bootstrap',{server:true,method:'POST',body:{fullName:'Synthetic Recovery',username:'recovery',password:'RecoveryFixture!7'}});assert.equal(boot.status,200);const token=boot.data.token;
const api=(p,b)=>call(p,{token,...(b===undefined?{}:{method:'POST',body:b})}),server=(p,b)=>call(p,{server:true,...(b===undefined?{}:{method:'POST',body:b})});
const stamp='2026-10-10T10:00:00Z',text=i=>invoiceText({count:60,number:'INV'+i,date:'10/10/2026'}).replace('Εργασία 1 1,00','ΦΙΛΤΡΟ ΛΑΔΙΟΥ 1,00');
const history=Array.from({length:57},(_,i)=>({id:'e'+i,type:'service',km:9000,date:'2026-10-10',tasks:['Αλλαγή λαδιών'],attachments:[{id:'f'+i,key:'service-documents/b/e'+i+'/f.pdf',name:'f'+i+'.pdf',ocrError:i?'Previous read failed':'',ocr:i?{plate:'BTO-756'}:{...enrichInvoiceExtraction({rawText:text(i)}),odometerKm:'7000',confirmedAt:stamp,reviewStatus:'confirmed',confirmationMethod:'manual',mileageResolution:'keep',mileageResolutionRead:'7000',mileageResolutionServiceKm:'9000',mileageResolutionEntryId:'e0'}}]}));
history.push({id:'qr',type:'service',km:9000,date:'2026-10-10',tasks:[],invoiceData:{qrUrl:'https://example.invalid/qr',qrJobId:'qr-old',qrProcessingStatus:'error'}});
sql.prepare('UPDATE fleet_snapshot SET data=?,version=10 WHERE id=1').run(JSON.stringify({bikes:[{id:'b',name:'BTO-756',currentKm:9000,history}]}));
sql.prepare("INSERT INTO fleet_operations(id,source,type,payload,status,created_at) VALUES('qr-old','fixture','service_document_render',?,'error',?)").run(JSON.stringify({bikeId:'b',entryId:'qr',qrUrl:'https://example.invalid/qr',requestedAt:stamp}),stamp);
sql.prepare("INSERT OR REPLACE INTO fleet_settings(key,value,updated_at) VALUES('server_offload_protocol','1',?)").run(stamp);
const load=async(p,options)=>{const r=await api(p);if(r.status!==200)throw Object.assign(new Error(r.data.error),{status:r.status});return r.data;};
let cursor='',pages=0,listed=[];
do{const r=await api('/api/admin/service-documents?paged=1'+(cursor?'&cursor='+encodeURIComponent(cursor):''));assert.equal(r.status,200,JSON.stringify(r.data));assert.ok(r.data.documents.length<=40);assert.ok(r.data.documents.every(d=>!d.invoiceData?.rawText));assert.ok(r.data.documents.every(d=>(d.invoiceData?.lineItems||[]).length<=12));listed.push(...r.data.documents);cursor=r.data.nextCursor;pages++;}while(cursor);
assert.equal(pages,15);assert.equal(listed.length,58);assert.equal((await M.loadInvoiceDocuments(load)).documents.length,58);assert.equal((await api('/api/admin/service-documents?paged=1&cursor=9:12')).status,409);
assert.equal(listed.find(d=>d.key===history[0].attachments[0].key).invoiceLineCount,60);
const items=listed.map(d=>({id:d.id,key:d.key,name:d.name,jobId:d.jobId,bikeId:d.bikeId,entryId:d.entryId,qrUrl:d.qrUrl}));
items.push({id:'removed-qr',name:'Removed service',bikeId:'b',entryId:'removed',qrUrl:'https://example.invalid/removed'});
const starts=await Promise.all([api('/api/admin/service-documents/reprocess-batch',{action:'start',recovery:true,items,mode:'server-first'}),api('/api/admin/service-documents/reprocess-batch',{action:'start',recovery:true,items,mode:'server-first'})]);assert.equal(starts.filter(r=>r.data.started).length,1);
let batch=starts.find(r=>r.data.started).data.batch;assert.equal(batch.total,59);
const originalId=batch.id;
for(let n=0;n<59;n++){
 const read=await server('/api/server/service-documents/reprocess-batch?window=10');assert.equal(read.status,200);assert.ok(read.data.items.length<=2,'bounded recovery parallel window');batch=read.data.batch;const item=read.data.item;
 if(n===2){assert.equal((await api('/api/admin/service-documents/reprocess-batch',{action:'pause',batchId:batch.id})).status,200);const paused=await server('/api/server/service-documents/reprocess-batch');assert.equal(paused.data.complete,true);assert.equal(paused.data.batch.currentIndex,2);assert.equal((await api('/api/admin/service-documents/reprocess-batch',{action:'resume',batchId:batch.id})).status,200);}
 const i=Number(String(item.entryId||item.key?.match(/e(\d+)\//)?.[1]).replace(/^e/,''));
 const body={action:'result',batchId:batch.id,index:batch.currentIndex,id:item.id,key:item.key,localOcr:item.key?{...enrichInvoiceExtraction({rawText:text(i)}),localReadStatus:'confident',ocrConfidence:95}:{}},done=await server('/api/server/service-documents/reprocess-batch',body);
 assert.equal(done.status,200,JSON.stringify(done.data));assert.equal(done.data.batch.id,originalId);assert.equal(done.data.batch.currentIndex,n+1);
}
const finished=(await api('/api/admin/service-documents/reprocess-batch')).data.batch;assert.equal(finished.completed,59);assert.equal(finished.results.length,59);assert.equal(finished.failed,1,'removed service failure recorded without preventing other invoices');assert.equal(finished.status,'completed_with_errors');assert.equal(finished.queued,1,'QR submission is not counted as completed analysis');
let saved=JSON.parse(sql.prepare('SELECT data FROM fleet_snapshot').get().data).bikes[0].history;
const confirmed=saved.find(e=>e.id==='e0').attachments[0].ocr;assert.equal(confirmed.confirmedAt,stamp);assert.equal(confirmed.odometerKm,'7000');assert.deepEqual(confirmed.reviewIssues||[],[]);assert.ok(confirmed.acknowledgedReadFields,'migration records independent accepted evidence');
assert.ok(saved.find(e=>e.id==='e1').tasks.includes('ΦΙΛΤΡΟ ΛΑΔΙΟΥ'));assert.ok(saved.find(e=>e.id==='e1').tasks.some(t=>/Αλλαγή λαδιών/.test(t)));
const staleDocument=(await api('/api/admin/service-documents/transfer-options?'+new URLSearchParams({bikeId:'b',entryId:'e0',key:history[0].attachments[0].key,includeDocument:'1'}))).data.document;
for(let attempt=0;attempt<2;attempt++){
 const start=await api('/api/admin/service-documents/reprocess-batch',{action:'start',recovery:true,mode:'server-first',items:[{id:history[0].attachments[0].key,key:history[0].attachments[0].key,name:'new amount'}]});assert.equal(start.status,201,JSON.stringify(start.data));
 const changed=await server('/api/server/service-documents/reprocess-batch',{action:'result',batchId:start.data.batch.id,index:0,id:history[0].attachments[0].key,key:history[0].attachments[0].key,localOcr:{...enrichInvoiceExtraction({rawText:text(0).replace('100,00','101,00').replace('124,00','125,00')}),localReadStatus:'confident',ocrConfidence:95}});assert.equal(changed.status,200,JSON.stringify(changed.data));
 const current=JSON.parse(sql.prepare('SELECT data FROM fleet_snapshot').get().data).bikes[0].history.find(e=>e.id==='e0').attachments[0].ocr;
 assert.ok(current.reviewIssues.some(i=>i.field==='totalAmount'),'actual new amount remains reviewable across repeated reads');assert.ok(!current.reviewIssues.some(i=>i.field==='odometerKm'),'old accepted mileage difference must not reappear with a different new finding');assert.equal(current.odometerKm,'7000');
 if(attempt===0){const stale=await api('/api/admin/service-documents/review',{bikeId:'b',entryId:'e0',key:history[0].attachments[0].key,requestId:crypto.randomUUID(),expectedReviewRevision:staleDocument.reviewRevision,expectedEntryUpdatedAt:staleDocument.serviceUpdatedAt,invoiceData:{odometerKm:'7000'}});assert.equal(stale.status,409,'old editor cannot acknowledge new unread evidence');}
}
const copied=JSON.parse(sql.prepare('SELECT data FROM fleet_snapshot').get().data);const old=copied.bikes[0].history.find(e=>e.id==='e0');copied.bikes[0].history.push({...old,id:'copied',attachments:[{...old.attachments[0],key:'service-documents/b/copied/different.pdf'}]});sql.prepare('UPDATE fleet_snapshot SET data=?,version=version+1 WHERE id=1').run(JSON.stringify(copied));
const different=(await api('/api/admin/service-documents/transfer-options?'+new URLSearchParams({bikeId:'b',entryId:'copied',key:'service-documents/b/copied/different.pdf',includeDocument:'1'}))).data.document;assert.equal(different.invoiceData.confirmedAt,undefined,'confirmation must stay bound to its original document key');
assert.equal((await api('/api/admin/service-documents/reprocess-batch',{action:'start',recovery:true,mode:'server-first',items:[],total:5})).status,400);
console.log('PASS #37: 59 durable items, concurrent start, 4-entry paged previews, complete 60-line detail, bounded native window, pause/resume without duplicates, failed QR isolation, preserved legacy manual mileage and separate oil filter. Synthetic SQLite/Worker only.');
