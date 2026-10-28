import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
import {invoiceText} from './fixtures/invoice-layout.mjs';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{Miniflare,convertV4MiniflareOptions}=require('miniflare'),{build}=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-retry-d1-'));let runtime;
try{
 await build({entryPoints:['cloudflare-worker/src/worker.js'],outfile:path.join(dir,'worker.mjs'),bundle:true,format:'esm',platform:'neutral'});
 runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:fs.readFileSync(path.join(dir,'worker.mjs'),'utf8'),compatibilityDate:'2026-10-01',d1Databases:{DB:'retry-fixture'},bindings:{SERVER_KEY:'retry-fixture',PIN_PEPPER:'retry-pepper'}}));
 const db=await runtime.getD1Database('DB');
 const call=async(url,body,token)=>{const response=await runtime.dispatchFetch('https://fixture'+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{'X-Fleet-Server-Key':'retry-fixture'})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};};
 const boot=await call('/api/auth/bootstrap',{fullName:'D1 Retry',username:'retryd1',password:'RetryFixture!123'});assert.equal(boot.status,200);const token=boot.data.token,stamp='2026-10-10T10:00:00Z',key='service-documents/b/e/f.pdf';
 const fleet={bikes:[{id:'b',name:'BTO-756',currentKm:10000,lastServiceKm:9000,intervalKm:3000,history:[{id:'e',type:'service',date:'2026-10-10',km:9000,tasks:['Έλεγχος'],attachments:[{id:'pdf-fixture',key,name:'f.pdf',contentType:'application/pdf',renderJobId:'old',ocrError:'Read failed',ocr:{plate:'BTO-756',odometerKm:'9000'}}]}]}]};
 await db.prepare('UPDATE fleet_snapshot SET data=?,version=10 WHERE id=1').bind(JSON.stringify(fleet)).run();
 await db.prepare("INSERT OR REPLACE INTO fleet_settings(key,value,updated_at) VALUES('server_offload_protocol','1',?)").bind(stamp).run();
 await db.prepare("INSERT INTO fleet_operations(id,source,type,payload,status,created_at) VALUES('old','fixture','service_document_render',?,'error',?)").bind(JSON.stringify({documentKey:key,bikeId:'b',entryId:'e',requestedAt:stamp}),stamp).run();
 await db.prepare("INSERT INTO system_alerts(id,type,severity,title,message,object_type,object_id,resolved,created_at) VALUES('notice','invoice_processing_failed','warning','Failure','Reader failed','invoice_job','old',0,?)").bind(stamp).run();
 const before=await db.prepare('SELECT data,version FROM fleet_snapshot').first();
 const results=await Promise.all(Array.from({length:8},(_,i)=>call('/api/admin/service-documents/retry-failed',i%2?{key}:{alertId:'notice'},token)));
 for(const r of results)assert.ok([200,202].includes(r.status),JSON.stringify(r));
 const pending=(await db.prepare("SELECT id FROM fleet_operations WHERE status='pending' AND type='service_document_render'").all()).results;assert.equal(pending.length,1);
 assert.deepEqual(await db.prepare('SELECT data,version FROM fleet_snapshot').first(),before,'Queueing must preserve the actual invoice/service');
 const notice=await db.prepare("SELECT resolved,object_id FROM system_alerts WHERE id='notice'").first();assert.equal(notice.resolved,0);assert.equal(notice.object_id,pending[0].id);
 assert.equal((await call('/api/admin/alerts/notice/resolve',{},token)).status,409);
 let result=await call('/api/server/service-documents/analysis-result',{jobId:pending[0].id,localOcr:{rawText:invoiceText({count:60,number:'INV123',date:'10/10/2026',net:'47,58',vat:'11,42',total:'59,00'}),localReadStatus:'confident',ocrConfidence:95,plate:'BTO-756',odometerKm:'9000',totalAmount:'59',invoiceDate:'2026-10-10',invoiceNumber:'INV123',lineItems:['Έλεγχος']}},null);assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.automaticConfirmed,true,'Retried stored invoice receives the shared automatic confirmation');assert.equal(result.data.document.invoiceLineCount,60);assert.equal(result.data.document.previewTruncated,true);const savedEntry=JSON.parse((await db.prepare('SELECT data FROM fleet_snapshot WHERE id=1').first()).data).bikes[0].history.find(e=>e.id==='e');assert.equal(savedEntry.attachments.find(a=>a.key===key).ocr.lineItems.length,60,'All rows survive the retry and D1 commit; compact response is preview only');
 assert.equal((await db.prepare("SELECT resolved FROM system_alerts WHERE id='notice'").first()).resolved,1);
 assert.equal((await call('/api/admin/alerts',undefined,token)).data.alerts.some(a=>a.id==='notice'),false);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM fleet_settings WHERE key LIKE 'invoice_retry_lock:%'").first()).n,0);
 console.log('PASS actual Workerd/D1: eight concurrent card/notification retries, one queue item, retained invoice/service and active alert, protected manual resolution, stored analysis commit and automatic alert completion.');
}finally{if(runtime)await runtime.dispose();fs.rmSync(dir,{recursive:true,force:true});}
