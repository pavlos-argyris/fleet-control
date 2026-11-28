import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { invoiceStageProof } from '../cloudflare-worker/hybrid-fleet/invoice-jobs.js';
import { sha256 } from '../cloudflare-worker/hybrid-fleet/ledger.js';
import { invoiceText } from './fixtures/invoice-layout.mjs';
import { stageNativeInvoicePlan } from './hybrid-fleet-invoice-stage.mjs';

const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const {build}=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-invoice-backlog-'));
const origin='https://fleet-hybrid-fixture.invalid';
const sync='/api/fleet-sync/v1',web='/api/fleet-web/v1';
const recovery='R'.repeat(43);
const devices=[{id:'device-synthetic-123456789',secret:'Z'.repeat(43)},{id:'device-synthetic-987654321',secret:'Y'.repeat(43)}];
const token=device=>device.id+'.'+device.secret;
const base='https://einvoice.impact.gr/p/';
let runtime, db, reads=0, temporaryReads=0, epoch, auth='', trusted='', csrf='', ticket='';
try {
  const bundle=path.join(dir,'worker.mjs');
  await build({entryPoints:['cloudflare-worker/hybrid-fleet/worker.js'],outfile:bundle,bundle:true,format:'esm',platform:'neutral'});
  async function start() {
    runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:fs.readFileSync(bundle,'utf8'),compatibilityDate:'2026-09-05',
      d1Databases:{FLEET_DB:'fleet-invoice-fixture'},r2Buckets:['FLEET_DOCUMENTS'],resourcePersistencePath:path.join(dir,'state'),
      bindings:{FLEET_REHEARSAL_ENABLED:'1',FLEET_INVOICE_PROCESSING:'1',FLEET_INVOICE_HOSTS:'einvoice.impact.gr',
        FLEET_PIN_PEPPER:'synthetic-fixture-pepper-value-'.repeat(2),FLEET_RECOVERY_CREDENTIAL_SHA256:await sha256(recovery)},
      serviceBindings:{FLEET_INVOICE_READER:async request=>{
        reads++;
        const {qrUrl}=await request.json();
        assert(qrUrl.startsWith(base));
        assert(!qrUrl.endsWith('/CONFIRMED'));
        if (qrUrl.endsWith('/TEMP') && temporaryReads++===0) return new Response(null,{status:503});
        const number=qrUrl.endsWith('/NEW')?'ΤΔΑ0000222':'ΤΔΑ0000111';
        const raw=invoiceText({number,plate:'ΗΤΡ 527',km:'12456',date:'25/11/2026'});
        const rawText=number.endsWith('222')?raw.replace('999999999999999','999999999999998'):raw;
        const pdfBase64=Buffer.from('%PDF-1.4\nSynthetic '+number+'\n%%EOF').toString('base64');
        return Response.json({rawText,pdfBase64});
      }}}));
    db=await runtime.getD1Database('FLEET_DB');
  }
  async function call(url, {method='GET',body,headers={},bearer=ticket}={}) {
    const response=await runtime.dispatchFetch(origin+url,{method,headers:{...(bearer?{Authorization:'Bearer '+bearer}:{}),
      ...(epoch?{'X-Fleet-Epoch':epoch}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},body:body&&JSON.stringify(body)});
    return {status:response.status,value:await response.json(),cookies:response.headers.getSetCookie()};
  }
  function expect(result,status) { assert.equal(result.status,status,JSON.stringify(result.value)); return result.value; }
  async function owner(url,body,headers={}) {
    return call(web+url,{method:'POST',body,headers:{Origin:origin,Cookie:auth||trusted,'X-Fleet-CSRF':csrf,...headers},bearer:''});
  }
  const cookie=(response,name)=>response.cookies.find(value=>value.startsWith(name+'=')).split(';')[0];
  async function login(pin) {
    const response=await owner('/login',{pin},{Cookie:trusted});
    csrf=expect(response,200).csrf;
    auth=trusted+'; '+cookie(response,'__Host-fleetSession');
  }
  await start();
  const setupPage=await runtime.dispatchFetch(origin+'/fleet-cloud/setup');
  assert.equal(setupPage.status,200);
  assert.match(await setupPage.text(),/Δημιουργία PIN/);
  const setupJs=await runtime.dispatchFetch(origin+'/fleet-cloud/setup.js');
  assert.equal(setupJs.status,200);
  assert.match(setupJs.headers.get('Content-Type'),/^application\/javascript/);
  const content=await setupJs.text();
  assert.doesNotThrow(()=>new Script(content));
  assert.doesNotMatch(content,/synthetic-fixture-pepper|Z{43}|Y{43}/);
  const migrations=path.resolve('cloudflare-worker/hybrid-fleet/migrations');
  for (const file of fs.readdirSync(migrations).sort()) {
    const sql=fs.readFileSync(path.join(migrations,file),'utf8').replace(/^--.*$/gm,'');
    const trigger=sql.indexOf('CREATE TRIGGER'),list=(trigger===-1?sql:sql.slice(0,trigger)).split(';').filter(statement=>statement.trim());
    if (trigger!==-1) list.push(sql.slice(trigger));
    await db.batch(list.map(statement=>db.prepare(statement)));
  }
  expect(await call(sync+'/state'),401);
  expect(await owner('/sync-device',{action:'approve',id:devices[0].id,secretSha256:await sha256(devices[0].secret)}),401);
  const enrollment=await owner('/enroll',{recoveryCredential:recovery,pin:'0384'});
  expect(enrollment,200);
  trusted=cookie(enrollment,'__Host-fleetDevice');
  await login('0384');
  const approval=async (device,replaceId,headers)=>owner('/sync-device',{
    action:'approve',id:device.id,secretSha256:await sha256(device.secret),replaceId
  },headers);
  expect(await approval(devices[0],undefined,{'X-Fleet-CSRF':'incorrect'}),403);
  expect(await approval(devices[0],undefined,{Origin:'https://foreign.invalid'}),403);
  expect(await approval(devices[0]),201);
  expect(await approval(devices[0]),200);
  expect(await approval(devices[1]),409);
  ticket=token(devices[0]);
  epoch=expect(await call(sync+'/state'),200).epoch;
  const originalMachine='Μηχανή / 7', sharedService='σέρβις 01';
  const ops=[
    {kind:'machine',machineId:originalMachine,recordId:originalMachine,data:{name:'BTO-756',plateKey:'BTO756',currentKm:9500}},
    {kind:'machine',machineId:'other-machine',recordId:'other-machine',data:{name:'HTP-527',plateKey:'HTP527'}},
    {kind:'service',machineId:originalMachine,recordId:sharedService,data:{date:'2026-11-18',km:9000,notes:'Σημειώσεις πριν από το σέρβις',tasks:['Έλεγχος κινητήρα'],cost:'55,00'}},
    {kind:'service',machineId:'other-machine',recordId:sharedService,data:{date:'2026-11-20',km:9500,notes:'Άλλο μηχανάκι'}},
    {kind:'invoice',machineId:originalMachine,recordId:'existing',serviceId:sharedService,data:{qrUrl:base+'CONFIRMED',invoiceNumber:'OLD',totalAmount:'124,00',reviewedAt:'2026-11-21T08:00:00Z'}}
  ];
  const operations=ops.map((op,i)=>({...op,operationId:'seed-operation-'+i+'-invoice',expectedRevision:0,deleted:false}));
  assert(expect(await call(sync+'/mutations',{method:'POST',body:{operations}}),200).operations.every(op=>op.status==='committed'));
  const job=(tag,other={})=>({operationId:'synthetic-invoice-'+tag,machineId:originalMachine,serviceId:sharedService,qrValue:base+tag,
    sourceKey:'',sourceSha256:'',source:'legacy-operation',sourceId:'old-'+tag,explicitId:'',...other});
  const fileBytes=Buffer.from('synthetic private photo');
  const photo={key:'service-documents/original-machine/same-id/photograph',local_name:'a'.repeat(64)+'-'+'b'.repeat(64)+'.jpg',
    sha256:createHash('sha256').update(fileBytes).digest('hex'),content_type:'image/jpeg',size:fileBytes.length};
  fs.writeFileSync(path.join(dir,photo.local_name),fileBytes);
  const jobs=[job('TEMP',{explicitId:'manual-explicit-on-direct',sourceKey:photo.key,sourceSha256:photo.sha256}),job('CONFIRMED'),
    job('NO-TARGET',{machineId:'missing-machine'}),job('UNSAFE',{qrValue:'https://einvoice.impact.gr.evil.invalid/p/NO'}),
    job('ALIAS',{explicitId:'manual-no-second-record'})];
  const stage=(jobs)=>call(sync+'/invoice-jobs',{method:'POST',body:{jobs}});
  const manifestHash=await invoiceStageProof(jobs);
  const plan={format:'private-fleet-invoice-plan-v1',count:jobs.length,jobs,manifestHash,objects:[photo],backupBlockingReasons:[]};
  const transfer=(fail)=>stageNativeInvoicePlan(plan,dir,async (url,request)=>{
    if (fail&&url==='/invoice-stage') throw new Error('synthetic disconnect after batch receipt');
    const response=await runtime.dispatchFetch(origin+sync+url,{...request,headers:{...request.headers,
      Authorization:'Bearer '+ticket,'X-Fleet-Epoch':epoch}});
    assert.equal(response.status,200);
    return response.json();
  });
  await assert.rejects(transfer(true),/synthetic disconnect after batch receipt/);
  const first=expect(await stage(jobs),200).jobs;
  assert.deepEqual(first.map(job=>job.status),['queued','already_confirmed','review','review','queued']);
  assert(expect(await stage(jobs),200).jobs.every(item=>item.replayed));
  expect(await stage([{...jobs[0],serviceId:'different'}]),409);
  async function process() {
    const outcome=await (await runtime.getWorker()).scheduled({cron:'*/15 * * * *'});
    assert.equal(outcome.outcome,'ok');
  }
  await process();
  assert.equal(reads,0);
  const seal=body=>call(sync+'/invoice-stage',{method:'POST',body});
  expect(await seal({count:jobs.length,manifestHash:manifestHash.replace(/^./,manifestHash[0]==='f'?'e':'f')}),409);
  assert.equal((await transfer(false)).verified,true);
  expect(await stage([job('TOO-LATE')]),409);
  const newScan=job('NEW',{source:'targeted-scan',explicitId:'synthetic-invoice-NEW'});
  expect(await stage([{...newScan,serviceId:sharedService+' '}]),422);
  expect(await stage([{...newScan,serviceId:'missing'}]),404);
  expect(await stage([newScan]),200);
  // A lost worker lease is recovered after restart. The durable mutation and
  // its fiscal identities protect the selected service against a parallel alias.
  await db.prepare(`UPDATE fleet_invoice_jobs SET status='running',available_at=0,lease_until=0,lease_token='expired' WHERE operation_id=?`)
    .bind(jobs[0].operationId).run();
  await db.prepare('UPDATE fleet_invoice_jobs SET available_at=? WHERE operation_id=?').bind(Date.now()+86400000,jobs.at(-1).operationId).run();
  await process();
  assert.equal((await db.prepare('SELECT status FROM fleet_invoice_jobs WHERE operation_id=?').bind(jobs[0].operationId).first()).status,'queued');
  await runtime.dispose();
  auth=''; csrf='';
  await start();
  await db.prepare('UPDATE fleet_invoice_jobs SET available_at=0 WHERE operation_id=?').bind(jobs[0].operationId).run();
  await Promise.all([process(),process(),process()]);
  assert.equal((await db.prepare('SELECT status FROM fleet_invoice_jobs WHERE operation_id=?').bind(jobs[0].operationId).first()).status,'completed');
  await db.prepare('UPDATE fleet_invoice_jobs SET available_at=0 WHERE operation_id=?').bind(jobs.at(-1).operationId).run();
  await process();
  const queue=expect(await call(sync+'/invoice-status'),200);
  assert.equal(queue.counts.completed,2,JSON.stringify(queue));
  assert.equal(queue.counts.already_confirmed,1);
  assert.equal(queue.counts.review,3);
  assert(queue.review.some(job=>job.reason==='original_service_not_verified'));
  assert(queue.review.some(job=>job.reason==='qr_provider_not_verified'));
  assert(queue.review.some(job=>job.reason==='possible_duplicate_invoice'||job.reason==='invoice_target_changed_or_duplicate'));
  const invoices=(await db.prepare("SELECT machine_id,service_id,data FROM fleet_records WHERE kind='invoice' ORDER BY record_id").all()).results;
  assert.equal(invoices.length,3);
  const restoredPhoto=await (await runtime.getR2Bucket('FLEET_DOCUMENTS')).get('sha256/'+photo.sha256);
  assert.deepEqual(Buffer.from(await restoredPhoto.arrayBuffer()),fileBytes);
  for (const row of invoices.filter(row=>JSON.parse(row.data).sha256)) {
    assert.equal(row.machine_id,originalMachine);
    assert.equal(row.service_id,sharedService);
    const invoice=JSON.parse(row.data);
    assert.equal(invoice.invoiceDate,'2026-11-25');
    assert.equal(invoice.odometerKm,'12456');
    assert.equal(invoice.plate,'HTP-527');
    assert.equal(invoice.totalAmount,'124,00');
    assert((await (await runtime.getR2Bucket('FLEET_DOCUMENTS')).head('sha256/'+invoice.sha256)).size>0);
  }
  const service=await db.prepare("SELECT data,revision FROM fleet_records WHERE kind='service' AND machine_id=?").bind(originalMachine).first();
  assert.deepEqual(JSON.parse(service.data),ops[2].data);
  assert.equal(service.revision,1);
  await login('0384');
  const rotate=await approval(devices[1],devices[0].id);
  expect(rotate,201);
  expect(await call(sync+'/state'),401);
  ticket=token(devices[1]);
  expect(await call(sync+'/state'),200);
  expect(await owner('/change-pin',{currentPin:'0384',pin:'4502',confirmation:'4503'}),400);
  expect(await owner('/change-pin',{currentPin:'0384',pin:'4502',confirmation:'4502'}),200);
  expect(await owner('/sync-device',{action:'revoke',id:devices[1].id}),401);
  expect(await owner('/login',{pin:'0384'},{Cookie:trusted}),401);
  await login('4502');
  expect(await owner('/sync-device',{action:'revoke',id:devices[1].id}),200);
  expect(await call(sync+'/state'),401);
  console.log('PASS isolated Workerd invoice migration receipts, Android-offline queue/restart, PDF, service history, duplicate protection, PIN, approval, rotation and revocation.');
} finally {
  if (runtime) await runtime.dispose();
  fs.rmSync(dir,{recursive:true,force:true});
}
