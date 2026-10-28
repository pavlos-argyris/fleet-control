import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
import {invoiceText} from './fixtures/invoice-layout.mjs';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare'),{build}=require('esbuild');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-invoice-auto-d1-'));let runtime;
try {
 await build({entryPoints:[path.resolve('cloudflare-worker/src/worker.js')],bundle:true,format:'esm',platform:'neutral',outfile:path.join(folder,'worker.mjs')});
 runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:fs.readFileSync(path.join(folder,'worker.mjs'),'utf8'),compatibilityDate:'2026-10-01',d1Databases:{DB:'invoice-auto-d1'},r2Buckets:{SERVICE_DOCS:'invoice-auto-files'},bindings:{SERVER_KEY:'auto-d1-server',PIN_PEPPER:'auto-d1-pepper'}}));
 const db=await runtime.getD1Database('DB');
 const call=async(url,body,token)=>{const r=await runtime.dispatchFetch('http://fixture'+url,{method:body?'POST':'GET',headers:token?{Authorization:'Bearer '+token,'Content-Type':'application/json'}:{'X-Fleet-Server-Key':'auto-d1-server','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
 const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
 const token=ok(await call('/api/auth/bootstrap',{fullName:'Synthetic D1 Owner',username:'autod1',password:'SyntheticD1Owner!7'})).token;
 const stamp='2026-10-10T10:00:00Z',key='service-documents/b/e/auto.pdf';
 const entry={id:'e',type:'service',date:'2026-10-10',km:9000,tasks:['Γενικός έλεγχος'],notes:'Χειρόγραφη σημείωση',updatedAt:stamp,attachments:[{id:'pdf',key,name:'auto.pdf',contentType:'application/pdf'}]};
 const seed=()=>db.prepare('UPDATE fleet_snapshot SET data=?,version=version+1 WHERE id=1').bind(JSON.stringify({bikes:[{id:'b',name:'BTO-756',currentKm:10000,lastServiceKm:9000,intervalKm:3000,updatedAt:stamp,history:[entry]}]})).run();
 await seed();
 const start=body=>call('/api/admin/service-documents/reprocess-batch',{action:'start',mode:'server-first',items:[{key}],...body},token);
 const starts=await Promise.all([start({batchId:'d1-auto-one'}),start({batchId:'d1-auto-two'})]);assert.equal(starts.filter(r=>r.status===201).length,1,'one atomic owner for racing starts');assert.equal(starts.filter(r=>r.data.started===false).length,1);
 const batch=starts.find(r=>r.status===201).data.batch,local={rawText:invoiceText({count:120}),supplier:'ΣΥΝΘΕΤΙΚΟ ΣΥΝΕΡΓΕΙΟ',localReadStatus:'confident',ocrConfidence:100};
 const result=()=>call('/api/server/service-documents/reprocess-batch',{action:'result',batchId:batch.id,key,localOcr:local});
 const before=await db.prepare('SELECT data,version FROM fleet_snapshot').first();
 await db.prepare("CREATE TRIGGER auto_audit_failure BEFORE INSERT ON fleet_operations WHEN NEW.type='snapshot_replace_bike' BEGIN SELECT RAISE(ABORT,'injected_auto_failure'); END").run();
 ok(await result(),500);assert.deepEqual(await db.prepare('SELECT data,version FROM fleet_snapshot').first(),before);assert.equal((await db.prepare("SELECT COUNT(*) n FROM idempotency_keys WHERE action='service_invoice_review'").first()).n,0);
 await db.prepare('DROP TRIGGER auto_audit_failure').run();
 const responses=await Promise.all([result(),result()]);for(const r of responses)ok(r);
 const status=ok(await call('/api/admin/service-documents/reprocess-batch',undefined,token)).batch;assert.equal(status.completed,1);assert.equal(status.automaticConfirmed,1);assert.equal(status.needsReview,0);assert.equal(status.failed,0);
 const row=await db.prepare('SELECT data FROM fleet_snapshot').first(),saved=JSON.parse(row.data).bikes[0].history[0];assert.equal(saved.attachments[0].ocr.confirmationMethod,'automatic');assert.equal(saved.attachments[0].ocr.lineItems.length,120);assert.equal(saved.tasks.filter(t=>t.startsWith('Εργασία')).length,120);assert.equal(saved.notes,'Χειρόγραφη σημείωση');assert.equal(saved.reviewJournal.length,1);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM fleet_operations WHERE type='snapshot_replace_bike'").first()).n,1);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM idempotency_keys WHERE action='service_invoice_review'").first()).n,1);
 assert.equal((await db.prepare("SELECT COUNT(*) n FROM fleet_operations WHERE type='service_document_reprocess_batch' AND status='pending'").first()).n,1);
 // Retry after a committed result is a no-op even with another read timestamp.
 local.localReadAt=String(Date.now());ok(await result());assert.equal((await db.prepare("SELECT COUNT(*) n FROM fleet_operations WHERE type='snapshot_replace_bike'").first()).n,1);
 console.log('PASS actual Workerd/D1 automatic invoice: 120 complete rows/tasks, atomic racing batch ownership/results, snapshot/receipt/outbox rollback, exactly one confirmation/journal/Server operation and persisted progress. Synthetic only; no production CPU claim.');
} finally {if(runtime)await runtime.dispose();fs.rmSync(folder,{recursive:true,force:true});}
