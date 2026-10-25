import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import vm from 'node:vm';
import worker,{mergeBike} from '../cloudflare-worker/src/worker.js';
import {readServiceEntry,writeServiceEntry} from '../cloudflare-worker/src/snapshot-store.js';

const sqlite=new DatabaseSync(':memory:');
class Statement{
 constructor(sql,args=[]){this.sql=sql;this.args=args;}
 bind(...args){return new Statement(this.sql,args);}
 async first(){return sqlite.prepare(this.sql).get(...this.args)||null;}
 async all(){return {results:sqlite.prepare(this.sql).all(...this.args)};}
 async run(){const r=sqlite.prepare(this.sql).run(...this.args);return {meta:{changes:Number(r.changes)}};}
}
const objects=new Map(),DB={prepare:sql=>new Statement(sql),exec:async sql=>sqlite.exec(sql),batch:async rows=>{sqlite.exec('BEGIN');try{const results=[];for(const row of rows)results.push(await row.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
const env={DB,SERVER_KEY:'qr-failure-fixture',PIN_PEPPER:'fixture-pepper',SERVICE_DOCS:{head:async key=>objects.has(key)?{size:objects.get(key).bytes.length}:null,put:async(key,body,metadata)=>objects.set(key,{bytes:new Uint8Array(await new Response(body).arrayBuffer()),...metadata}),delete:async key=>objects.delete(key),get:async key=>objects.get(key)||null}};
const base='https://fixture.invalid',stamp='2026-10-10T16:41:10.000Z',qr='https://einvoice.impact.gr/p/EL099902715/FAILURE-FIXTURE';
async function call(path,body,token,method){const headers=token?{Authorization:'Bearer '+token}:{'X-Fleet-Server-Key':env.SERVER_KEY};if(body!==undefined)headers['Content-Type']='application/json';return worker.fetch(new Request(base+path,{method:method||(body===undefined?'GET':'POST'),headers,body:body===undefined?undefined:JSON.stringify(body)}),env);}
assert.equal((await call('/api/status')).status,200);
const bootstrap=await call('/api/auth/bootstrap',{fullName:'QR Fixture',username:'qr-owner',password:'Fixture-Password-123',deviceId:'qr-device'});assert.equal(bootstrap.status,200);const token=(await bootstrap.json()).token;
const source={bikes:[{id:'bike',name:'ΤΝΗ 921',currentKm:10000,lastServiceKm:9000,intervalKm:3000,createdAt:stamp,updatedAt:stamp,history:[{id:'service',type:'service',date:'2026-07-27',km:9000,tasks:['Γενικός έλεγχος'],attachments:[],createdAt:stamp,updatedAt:stamp,invoiceData:{qrUrl:qr,qrJobId:'legacy-job',qrProcessingStatus:'completed',qrProcessingProgress:'100',qrProcessingStartedAt:stamp,qrProcessingUpdatedAt:stamp}}]}]};
sqlite.prepare('UPDATE fleet_snapshot SET data=?,version=100,source=\'canonical\',updated_at=? WHERE id=1').run(JSON.stringify(source),stamp);
const payload={bikeId:'bike',entryId:'service',qrUrl:qr,qrValue:qr,requestedAt:stamp,progress:70,progressStage:'Ανεβαίνει το PDF'};
sqlite.prepare("INSERT INTO fleet_operations(id,source,type,payload,status,created_at,applied_at) VALUES ('legacy-job','fixture','service_document_render',?,'applied',?,?)").run(JSON.stringify(payload),stamp,stamp);
const before=await readServiceEntry(env,'bike','service');
const missing=await (await call('/api/service-documents/jobs/legacy-job',undefined,token)).json();assert.equal(missing.status,'error');assert.equal(missing.code,'document_missing');assert.ok(missing.progress<100);assert.equal(missing.canRetry,true);
assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM system_alerts WHERE type='invoice_processing_failed'").get().n,1);
const alert=sqlite.prepare("SELECT * FROM system_alerts WHERE type='invoice_processing_failed'").get();assert.match(alert.message,/ΤΝΗ 921.*27\/07\/2026/);assert.equal(sqlite.prepare("SELECT channel FROM alert_rules WHERE type='invoice_processing_failed'").get().channel,'both');
await call('/api/service-documents/jobs/legacy-job',undefined,token);assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM system_alerts WHERE type='invoice_processing_failed'").get().n,1);
assert.deepEqual((await readServiceEntry(env,'bike','service')).entry,before.entry,'Detection must not rewrite the service or launch a retry');
const list=await (await call('/api/admin/service-documents',undefined,token)).json();const orphan=list.documents.filter(x=>x.jobId==='legacy-job');assert.equal(orphan.length,1);assert.equal(orphan[0].status,'error');
const anonymous=await worker.fetch(new Request(base+'/api/service-documents/jobs/legacy-job'),env);assert.equal(anonymous.status,401);
// A normal retry gets a new identity, because an older Server may remember
// the old ID as already applied. Existing files must remain untouched.
const restart=await call('/api/admin/service-documents/restart',{jobId:'legacy-job'},token);assert.equal(restart.status,200);const fresh=await restart.json();assert.notEqual(fresh.jobId,'legacy-job');assert.equal(sqlite.prepare("SELECT status FROM fleet_operations WHERE id='legacy-job'").get().status,'cancelled');
assert.equal(sqlite.prepare('SELECT resolved FROM system_alerts WHERE id=?').get(alert.id).resolved,1);
assert.equal((await readServiceEntry(env,'bike','service')).entry.km,9000);
for(let i=0;i<3;i++){const result=await (await call('/api/server/operation-error',{jobId:fresh.jobId,error:'Δεν ανέβηκε το PDF'})).json();assert.equal(result.status,i===2?'error':'delayed');}
assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM system_alerts WHERE type='invoice_processing_failed'").get().n,2);
await call('/api/server/operation-error',{jobId:fresh.jobId,error:'Δεν ανέβηκε το PDF'});assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM system_alerts WHERE type='invoice_processing_failed'").get().n,2,'One alert per failed attempt');
// Uploading an actual PDF result commits its link and resolves the warning.
const local={localReadStatus:'confident',ocrConfidence:95,plate:'ΤΝΗ 921',totalAmount:'59,00',invoiceDate:'2026-07-27',lineItems:['Γενικός έλεγχος']};
const params=new URLSearchParams({bikeId:'bike',entryId:'service',jobId:fresh.jobId,qrUrl:qr,qrValue:qr,name:'invoice.pdf'});
const upload=await worker.fetch(new Request(base+'/api/server/service-documents/rendered?'+params,{method:'PUT',headers:{'X-Fleet-Server-Key':env.SERVER_KEY,'X-Fleet-Local-Ocr':Buffer.from(JSON.stringify(local)).toString('base64url')},body:new TextEncoder().encode('%PDF-1.4\nfixture\n%%EOF')}),env);assert.equal(upload.status,201);assert.equal(objects.size,1);
await call('/api/server/ack',{ids:[fresh.jobId]});const ready=await (await call('/api/service-documents/jobs/'+fresh.jobId,undefined,token)).json();assert.equal(ready.status,'completed');assert.ok(ready.attachment?.key);assert.equal(ready.progress,100);
assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM system_alerts WHERE type='invoice_processing_failed' AND resolved=0").get().n,0);
const lateError=await (await call('/api/server/operation-error',{jobId:fresh.jobId,error:'Late failure'})).json();assert.equal(lateError.status,'completed');
// Even with another invoice present, a completed flag for a missing QR must
// become actionable. Repeated reads cannot revive a dismissed notice.
const located=await readServiceEntry(env,'bike','service');located.entry.attachments[0].renderJobId='other';located.entry.attachments[0].qrUrl='https://einvoice.impact.gr/p/OTHER';delete located.entry.attachments[0].qrValue;
await writeServiceEntry(env,located,located.entry,'fixture-unrelated-document',new Date().toISOString());
const orphanAgain=await (await call('/api/service-documents/jobs/'+fresh.jobId,undefined,token)).json();assert.equal(orphanAgain.status,'error');assert.equal(objects.size,1,'Detection does not delete stored objects');
const unresolved=sqlite.prepare("SELECT * FROM system_alerts WHERE type='invoice_processing_failed' AND resolved=0").get();assert.ok(unresolved);sqlite.prepare('UPDATE system_alerts SET resolved=1 WHERE id=?').run(unresolved.id);
await call('/api/service-documents/jobs/'+fresh.jobId,undefined,token);assert.equal(sqlite.prepare('SELECT resolved FROM system_alerts WHERE id=?').get(unresolved.id).resolved,1);

// A photograph with a decoded QR remains available while the electronic PDF
// is created, then becomes one invoice bundle rather than a second bill.
const snapshot=await (await call('/api/snapshot')).json();snapshot.bikes[0].history.push({id:'photo-service',type:'service',date:'2026-07-28',km:9100,tasks:['Γενικός έλεγχος'],attachments:[],createdAt:stamp,updatedAt:stamp});assert.equal((await call('/api/server/snapshot',snapshot,undefined,'PUT')).status,200);
const photoBytes=new Uint8Array([255,216,255,224,0,0,255,217]),form=new FormData();form.append('bikeId','bike');form.append('entryId','photo-service');form.append('qrValue',qr+'-PHOTO');form.append('uploadId','photo-idempotent-fixture');form.append('file',new Blob([photoBytes],{type:'image/jpeg'}),'original.jpg');
const photoResponse=await worker.fetch(new Request(base+'/api/service-documents',{method:'POST',headers:{Authorization:'Bearer '+token},body:form}),env);assert.equal(photoResponse.status,201);const photo=(await photoResponse.json()).attachment;
const photoQr=await call('/api/service-documents/import-qr',{bikeId:'bike',entryId:'photo-service',value:qr+'-PHOTO',sourcePhotoKey:photo.key},token);assert.equal(photoQr.status,202);const photoJob=(await photoQr.json()).jobId;
assert.equal(JSON.parse(sqlite.prepare('SELECT payload FROM fleet_operations WHERE id=?').get(photoJob).payload).sourcePhotoKey,photo.key);
const during=(await (await call('/api/admin/service-documents',undefined,token)).json()).documents.filter(row=>row.entryId==='photo-service');assert.equal(during.length,1);assert.equal(during[0].status,'processing');assert.equal(during[0].key,photo.key);
assert.notEqual((await (await call('/api/service-documents/jobs/'+photoJob,undefined,token)).json()).status,'completed','An uploaded photo is not completion of the pending electronic PDF');
const pairedParams=new URLSearchParams({bikeId:'bike',entryId:'photo-service',jobId:photoJob,qrUrl:qr+'-PHOTO',qrValue:qr+'-PHOTO',name:'electronic.pdf'});
const pairedResponse=await worker.fetch(new Request(base+'/api/server/service-documents/rendered?'+pairedParams,{method:'PUT',headers:{'X-Fleet-Server-Key':env.SERVER_KEY,'X-Fleet-Local-Ocr':Buffer.from(JSON.stringify(local)).toString('base64url')},body:new TextEncoder().encode('%PDF-1.4\npaired\n%%EOF')}),env);assert.equal(pairedResponse.status,201);
const paired=(await pairedResponse.json()).attachment;assert.equal(paired.sourcePhoto.key,photo.key);assert.deepEqual(objects.get(photo.key).bytes,photoBytes);
const repeatedPhoto=await worker.fetch(new Request(base+'/api/service-documents',{method:'POST',headers:{Authorization:'Bearer '+token},body:form}),env);assert.equal(repeatedPhoto.status,200);assert.equal((await repeatedPhoto.json()).attachment.key,paired.key,'Retry after a lost response returns the existing PDF bundle');
const repeatedImport=await call('/api/service-documents/import-qr',{bikeId:'bike',entryId:'photo-service',value:qr+'-PHOTO',sourcePhotoKey:photo.key},token);assert.equal(repeatedImport.status,200);assert.equal((await repeatedImport.json()).attachment.key,paired.key);
const pairedEntry=(await readServiceEntry(env,'bike','photo-service')).entry;assert.equal(pairedEntry.attachments.length,1);assert.equal(pairedEntry.attachments[0].key,paired.key);assert.equal(globalThis.FleetServiceModel.summary([{history:[pairedEntry]}]).cents,5900,'Photo plus PDF count as one invoice cost');
const pairList=(await (await call('/api/admin/service-documents',undefined,token)).json()).documents.filter(row=>row.entryId==='photo-service');assert.equal(pairList.length,1);assert.equal(pairList[0].sourcePhoto.key,photo.key);assert.equal(pairList[0].qrUrl,qr+'-PHOTO');
const oldClient={...(await readServiceEntry(env,'bike','photo-service')).bike,updatedAt:'2099-01-01T00:00:00Z',history:[{...pairedEntry,attachments:[photo],updatedAt:'2099-01-01T00:00:00Z'}]};const merged=mergeBike({...oldClient,history:[pairedEntry]},oldClient);assert.equal(merged.history.find(row=>row.id==='photo-service').attachments[0].sourcePhoto.key,photo.key,'An older client cannot strip the original photo or replace the PDF bundle');
objects.delete(photo.key);const restoreParams=new URLSearchParams({bikeId:'bike',entryId:'photo-service',key:photo.key,name:'original.jpg'});const restored=await worker.fetch(new Request(base+'/api/server/service-documents/restore?'+restoreParams,{method:'PUT',headers:{'X-Fleet-Server-Key':env.SERVER_KEY},body:photoBytes}),env);assert.equal(restored.status,200);assert.deepEqual(objects.get(photo.key).bytes,photoBytes,'The source photo is restored from backup using its exact service link');

// Execute the shipped browser state/renderer/notification functions.
const app=fs.readFileSync('cloudflare-worker/public/app.js','utf8');const extract=name=>{const m=app.match(new RegExp('^  (?:async )?function '+name+'\\([^]*?^  \\}','m'));assert.ok(m,name);return m[0];};
const model=globalThis.FleetServiceModel,legacy=source.bikes[0].history[0],modelState=model.qrDocumentState(legacy,Date.now());assert.equal(modelState.needsVerification,true);assert.notEqual(modelState.data.qrProcessingProgress,'100');
assert.equal(model.qrDocumentState({...legacy,attachments:[{key:'ok',renderJobId:'legacy-job'}]}).visible,false);
const toasts=[],saved=new Map(),entry={...legacy,attachments:[]},bike={id:'bike',name:'ΤΝΗ 921',history:[entry]};
const ctx=vm.createContext({window:{FleetServiceModel:model},currentUser:{id:'owner'},qrNoticeMemory:new Set(),qrRetries:new Set(),localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},showToast:s=>toasts.push(s),fleetScreenActive:()=>true,formatDate:String,normalizeInvoiceData:x=>x,escapeHtml:String,canManageHistory:()=>true,getBike:()=>bike,getHistoryEntry:()=>entry,saveBikes(){},activeBikeId:'bike',elements:{detailHistory:{}},renderDetail(){assert.ok(entry.attachments.length,'Link exists before completion is rendered');}});
vm.runInContext(['qrEntryState','qrProcessingMarkup','qrProgressModel','qrTimestampMs','qrElapsedLabel','qrElapsedLabelValue','notifyQrFailures','updateQrProcessingLocal'].map(extract).join('\n'),ctx);
const markup=ctx.qrProcessingMarkup(legacy);assert.match(markup,/Επανάληψη/);assert.doesNotMatch(markup,/>100%/);
const rows=[{bike,entry,state:{attention:true,needsVerification:false,status:'error',data:{qrJobId:'legacy-job',qrProcessingStartedAt:stamp,qrProcessingError:'Αποτυχία PDF'}}}];ctx.notifyQrFailures(rows);ctx.notifyQrFailures(rows);assert.equal(toasts.length,1);
ctx.updateQrProcessingLocal('bike','service',{jobId:'legacy-job',status:'completed',progress:100,attachment:{key:'ready',renderJobId:'legacy-job'}});assert.equal(entry.attachments.length,1);
console.log('PASS actual QR failure handling: legacy 100% without PDF, alerts/push rule/deduplication, no service rewrite or automatic retry, safe new attempt, real upload/resolution, late callbacks, multiple invoices, auth and atomic browser completion.');
