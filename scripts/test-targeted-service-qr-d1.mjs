import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { invoiceText } from './fixtures/invoice-layout.mjs';

const require = createRequire(new URL('../cloudflare-worker/package.json', import.meta.url));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { build } = require('esbuild');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-targeted-qr-'));
const origin = 'https://fixture.invalid';
const serverKey = 'synthetic-render-key';
const scanPath = '/api/service-documents/import-targeted-qr';
let runtime;
try {
  const entry = path.join(directory, 'worker.mjs');
  await build({ entryPoints:['cloudflare-worker/src/worker.js'], outfile:entry, bundle:true, format:'esm',
    platform:'neutral', mainFields:['browser','module','main'] });
  runtime = new Miniflare(convertV4MiniflareOptions({ modules:true, script:fs.readFileSync(entry,'utf8'),
    compatibilityDate:'2026-10-01', d1Databases:{DB:'targeted-qr'}, r2Buckets:{SERVICE_DOCS:'targeted-qr-pdf'},
    bindings:{SERVER_KEY:serverKey,PIN_PEPPER:'synthetic-pin-pepper'} }));
  const db = await runtime.getD1Database('DB');
  const bucket = await runtime.getR2Bucket('SERVICE_DOCS');
  const call = async (url, options = {}) => {
    const headers = { ...options.headers };
    if (options.token) headers.Authorization = 'Bearer ' + options.token;
    if (options.server) headers['X-Fleet-Server-Key'] = serverKey;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await runtime.dispatchFetch(origin + url, {
      method:options.method || (options.body === undefined ? 'GET' : 'POST'), headers,
      body:options.bytes || (options.body === undefined ? undefined : JSON.stringify(options.body))
    });
    return { status:response.status, data:await response.json() };
  };
  function expect(result, status) {
    assert.equal(result.status, status, JSON.stringify(result.data));
    return result.data;
  }
  const owner = expect(await call('/api/auth/bootstrap',{server:true,body:{
    fullName:'Synthetic Owner',username:'target-owner',password:'SyntheticOwner!128'
  }}),200).token;
  const date = '2026-11-18';
  const stamp = date + 'T11:00:00.000Z';
  const service = { id:'s',type:'service',date,km:9000,workshop:'',cost:'55,00',
    tasks:['Χειροκίνητη εργασία'],notes:'Σημειώσεις πριν από την επισκευή',attachments:[],createdAt:stamp,updatedAt:stamp };
  const fleet = {bikes:[
    { id:'one',name:'BTO-756',currentKm:9100,intervalKm:3000,history:[service,{...service,id:'another'},{...service,id:'check',type:'check'}] },
    { id:'two',name:'HTP-527',currentKm:9900,intervalKm:3000,history:[{...service,id:'other'}] }
  ]};
  await db.prepare('UPDATE fleet_snapshot SET data=?,version=200 WHERE id=1').bind(JSON.stringify(fleet)).run();
  const inspect = async () => JSON.parse((await db.prepare('SELECT data FROM fleet_snapshot WHERE id=1').first()).data);
  const qr = 'https://einvoice.impact.gr/p/SYNTHETIC-128';
  const body = {bikeId:'one',entryId:'s',value:qr,targetedOperationId:'synthetic-operation-128'};
  expect(await call(scanPath,{body}),401);
  expect(await call(scanPath,{token:owner,body:{...body,entryId:'other'}}),404);
  expect(await call(scanPath,{token:owner,body:{...body,entryId:'check'}}),404);
  expect(await call(scanPath,{token:owner,body:{...body,value:'no URL'}}),422);
  const scans = await Promise.all([
    call(scanPath,{token:owner,body}),
    call(scanPath,{token:owner,body:{...body,targetedOperationId:'synthetic-second-operation'}})
  ]);
  const job = expect(scans[0],202).jobId;
  assert.equal(expect(scans[1],202).jobId,job);
  expect(await call(scanPath,{token:owner,body:{...body,entryId:'another',allowDuplicate:true}}),409);
  for (const bike of (await inspect()).bikes) assert.equal(bike.history[0].attachments.length,0);
  const restarted = expect(await call('/api/admin/service-documents/restart',{token:owner,body:{jobId:job}}),200).jobId;
  assert.notEqual(restarted,job);
  const storedPayload = JSON.parse((await db.prepare('SELECT payload FROM fleet_operations WHERE id=?').bind(restarted).first()).payload);
  assert.equal(storedPayload.targetedOperationId,
    JSON.parse((await db.prepare('SELECT payload FROM fleet_operations WHERE id=?').bind(job).first()).payload).targetedOperationId);
  assert.equal(storedPayload.bikeId,'one');
  assert.equal(storedPayload.entryId,'s');
  const read = invoiceText({plate:'ΗΤΡ 527',km:'12456',date:'25/11/2026'});
  async function rendered(jobId, overrides = {}, local = {}) {
    const params = new URLSearchParams({bikeId:'one',entryId:'s',jobId,qrUrl:qr,qrValue:qr,name:'synthetic.pdf',...overrides});
    const value = {rawText:read,localReadStatus:'confident',ocrConfidence:95,...local};
    return call('/api/server/service-documents/rendered?' + params,{
      server:true,method:'PUT',headers:{'X-Fleet-Local-Ocr':Buffer.from(JSON.stringify(value)).toString('base64url')},
      bytes:new TextEncoder().encode('%PDF-1.4\nsynthetic test file\n%%EOF')
    });
  }
  expect(await rendered(job),410);
  expect(await rendered(restarted,{entryId:'another'}),409);
  expect(await rendered(restarted,{}, {rawText:'Unreadable'}),422);
  assert.equal((await bucket.list()).objects.length,0);
  const results = await Promise.all([rendered(restarted), rendered(restarted)]);
  for (const result of results) assert.ok([200,201].includes(result.status),JSON.stringify(result));
  const actual = (await inspect()).bikes;
  const saved = actual[0].history.find(item=>item.id==='s');
  assert.deepEqual(actual[1],fleet.bikes[1]);
  assert.equal(actual[0].currentKm,9100);
  for (const field of ['date','km','tasks','notes','workshop','cost','createdAt']) assert.deepEqual(saved[field],service[field]);
  assert.equal(saved.attachments.length,1);
  assert.equal(saved.reviewJournal.length,1);
  const attachment = saved.attachments[0];
  assert.equal(attachment.ocr.confirmationMethod,'targeted-qr');
  assert.equal(attachment.ocr.targetedOperationId,storedPayload.targetedOperationId);
  assert.equal(attachment.ocr.invoiceDate,'2026-11-25');
  assert.equal(attachment.ocr.odometerKm,'12456');
  assert.equal(attachment.ocr.plate,'HTP-527');
  assert.equal(attachment.ocr.totalAmount,'124,00');
  assert.match(attachment.name,/2026-11-25\.pdf$/);
  const document = expect(await call('/api/admin/service-documents?paged=1',{token:owner}),200).documents.find(item=>item.key===attachment.key);
  assert.equal(document.status,'confirmed');
  assert.deepEqual(document.warnings,[]);
  assert.equal(document.serviceDate,date);
  assert.equal(document.invoiceData.invoiceDate,'2026-11-25');
  assert.equal((await bucket.list()).objects.length,1);
  const audit = await db.prepare("SELECT new_value FROM audit_log WHERE action='service_document_targeted_qr'").all();
  assert.equal(audit.results.length,1);
  assert.equal(JSON.parse(audit.results[0].new_value).operationId,storedPayload.targetedOperationId);
  assert.equal(expect(await call(scanPath,{token:owner,body}),200).attachment.key,attachment.key);
  expect(await call(scanPath,{token:owner,body:{...body,entryId:'another',targetedOperationId:'synthetic-different-target',allowDuplicate:true}}),409);
  const otherQr = qr + '-ALIAS';
  const alias = expect(await call(scanPath,{token:owner,body:{...body,entryId:'another',value:otherQr,targetedOperationId:'synthetic-alias-operation'}}),202).jobId;
  expect(await rendered(alias,{entryId:'another',qrValue:otherQr,qrUrl:otherQr}),409);
  assert.equal((await bucket.list()).objects.length,1);
  const genericQr = qr + '-GENERAL';
  const generic = expect(await call('/api/service-documents/import-qr',{token:owner,body:{bikeId:'one',entryId:'another',value:genericQr}}),202).jobId;
  const genericInvoice = await rendered(generic,{entryId:'another',qrValue:genericQr,qrUrl:genericQr},{
    rawText:invoiceText({plate:'ΗΤΡ 527',km:'12456',date:'25/11/2026',number:'ΤΔΑ0000456'})
  });
  const genericDocument = expect(genericInvoice,201);
  assert.equal(genericDocument.requiresConfirmation,true);
  assert.equal(genericDocument.attachment.ocr.reviewStatus,'needs_review');
  console.log('PASS Workerd/D1 explicit existing service QR, persisted retry target, preserved service and raw invoice, duplicates, and general matching.');
} finally {
  if (runtime) await runtime.dispose();
  fs.rmSync(directory,{recursive:true,force:true});
}
