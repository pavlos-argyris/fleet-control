import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { BASELINE_CHUNK_BYTES } from '../cloudflare-worker/hybrid-fleet/baseline.js';
import { invoiceStageProof } from '../cloudflare-worker/hybrid-fleet/invoice-jobs.js';
import { sha256 } from '../cloudflare-worker/hybrid-fleet/ledger.js';
import { invoiceText } from './fixtures/invoice-layout.mjs';

const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const {build}=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-baseline-'));
const api='/api/fleet-sync/v1', origin='https://fleet-baseline-fixture.invalid';
const rw='fixture-baseline-writer.'+'W'.repeat(43), ro='fixture-baseline-reader.'+'R'.repeat(43);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const hashChain=items=>items.reduce((chain,hash)=>digest(chain+':'+hash),'0'.repeat(64));
const fileBytes=Buffer.from('Synthetic private photo bytes', 'utf8'), fileSha=digest(fileBytes);
const machineId='Μηχανή / 21',otherId='42',serviceId='712389',deletedId='old-service';
const fileKey='service-documents/fixture/original.jpg';
const confirmedKey='service-documents/fixture/confirmed.pdf';
const confirmedBytes=Buffer.from('%PDF-1.4\nSynthetic historically confirmed invoice\n%%EOF');
const archivedKey='service-documents/fixture/archived.pdf';
const archivedBytes=Buffer.from('%PDF-1.4\nSynthetic confirmed invoice from archived vehicle\n%%EOF');
const packages=[[fileKey,fileBytes,'image/jpeg'],[confirmedKey,confirmedBytes,'application/pdf'],[archivedKey,archivedBytes,'application/pdf']];
const confirmed=key=>({id:key===confirmedKey?'confirmed-original-id':'archived-original-id',key,name:key.split('/').at(-1),
  contentType:'application/pdf',qrUrl:'https://invoice.fixture.invalid/'+(key===confirmedKey?'paid':'archive-paid'),
  ocr:{confirmedAt:'2026-11-25T08:00:00Z',supplier:'Ελεγμένος προμηθευτής',invoiceNumber:'INV-OLD',
    invoiceDate:'2026-11-25',totalAmount:'67,94',netAmount:'54,79',vatAmount:'13,15',plate:'ΑΒΤ 001'}});
const snapshot={kind:'snapshot',version:19,updatedAt:'2026-11-24T10:00:00Z'};
const machine={kind:'machine',machineId,data:{id:machineId,name:'ΑΒΤ 001',historyDeletedIds:[deletedId],notes:'δοκιμή '.repeat(8200)}};
const service={kind:'history',machineId,recordId:serviceId,data:{id:serviceId,type:'service',km:16550,date:'2026-11-24',
  notes:'Αλλαγή λαδιών',tasks:['Λάδια','Έλεγχος φρένων'],cost:'52,20',attachments:[{key:fileKey,renderJobId:'legacy-job'},
    confirmed(confirmedKey)]}};
const records=[snapshot,machine,{kind:'machine',machineId:otherId,data:{id:42,name:'Μηχανή Β'}},
  {kind:'machine-registry',machineId,data:{name:'Μηχανή Α',odometer:16550,status:'available'}},
  service,{...service,machineId:otherId,data:{...service.data,notes:'Άλλο σέρβις',attachments:[]}},
  {...service,recordId:deletedId,data:{...service.data,id:deletedId,attachments:[]}},
  {kind:'machine-archive',machineId:otherId,data:{machine:{id:42,name:'Μηχανή Β'},active:true}},
  {kind:'archived-history',machineId:otherId,recordId:serviceId,data:{...service.data,attachments:[confirmed(archivedKey)]}},
  {kind:'invoice-job',recordId:'legacy-job',data:{type:'service_document_render',status:'error',input:{bikeId:machineId,entryId:serviceId,documentKey:fileKey}}},
  ...packages.map(([key,bytes,type])=>({kind:'document',recordId:key,data:{name:key.split('/').at(-1),
    contentType:type,size:bytes.length,sha256:digest(bytes)}}))];
const encodeRows=rows=>Buffer.from(rows.map(row=>JSON.stringify(row)).join('\n')+'\n','utf8');
const scoped=encodeRows(records);
let runtime,db,epoch;const readJobs=[];

async function start(enabled,workspace='state') {
  runtime=new Miniflare(convertV4MiniflareOptions({
    modules:true,script:fs.readFileSync(path.join(dir,'worker.mjs'),'utf8'),compatibilityDate:'2026-09-05',
    d1Databases:{FLEET_DB:'fleet-baseline-fixture'},r2Buckets:['FLEET_DOCUMENTS'],
    resourcePersistencePath:path.join(dir,workspace),
    bindings:{FLEET_REHEARSAL_ENABLED:'1',FLEET_BASELINE_TRANSFER:enabled?'1':'0',FLEET_INVOICE_PROCESSING:'1',
      FLEET_INVOICE_HOSTS:'invoice.fixture.invalid'},
    serviceBindings:{FLEET_INVOICE_READER:async request=>{
      const {qrUrl}=await request.json();
      readJobs.push(qrUrl);
      assert.equal(qrUrl,'https://invoice.fixture.invalid/123','only recoverable unconfirmed invoices may reach the reader');
      const rawText=invoiceText({number:'ΤΔΑ0000341',plate:'ΗΤΡ 527',km:'12456',date:'25/11/2026'});
      const pdfBase64=Buffer.from('%PDF-1.4\nSynthetic converted QR invoice\n%%EOF').toString('base64');
      return Response.json({rawText,pdfBase64});
    }}
  }));
  db=await runtime.getD1Database('FLEET_DB');
}
async function request(url,{method='GET',body,token=rw,sendEpoch=epoch,headers={}}={}) {
  const response=await runtime.dispatchFetch(origin+url,{method,body,
    headers:{...headers,...token&&{Authorization:'Bearer '+token},...sendEpoch&&{'X-Fleet-Epoch':sendEpoch}}});
  return {status:response.status,data:await response.json()};
}
async function post(url,value,overrides) {
  return request(api+url,{method:'POST',body:JSON.stringify(value),headers:{'Content-Type':'application/json'},...overrides});
}
function expect(reply,status) {
  assert.equal(reply.status,status,JSON.stringify(reply.data));
  return reply.data;
}
async function install() {
  for (const file of fs.readdirSync('cloudflare-worker/hybrid-fleet/migrations').sort()) {
    const sql=fs.readFileSync('cloudflare-worker/hybrid-fleet/migrations/'+file,'utf8').replace(/^--.*$/gm,'');
    const trigger=sql.indexOf('CREATE TRIGGER'),list=(trigger===-1?sql:sql.slice(0,trigger)).split(';').filter(s=>s.trim());
    if (trigger!==-1) list.push(sql.slice(trigger));
    await db.batch(list.map(s=>db.prepare(s)));
  }
  for(const [credential,scope] of [[rw,'sync-read-write'],[ro,'sync-read']]) {
    const [id,secret]=credential.split('.');
    await db.prepare('INSERT INTO fleet_sync_credentials(id,secret_sha256,scope,expires_at) VALUES(?,?,?,?)')
      .bind(id,await sha256(secret),scope,Date.now()+600000).run();
  }
  epoch=expect(await request(api+'/state'),200).epoch;
}
async function tick() {
  const outcome=await (await runtime.getWorker()).scheduled({cron:'* * * * *'});
  assert.equal(outcome.outcome,'ok');
}
const servicePath=(machine,service)=>api+'/baseline/service?'+new URLSearchParams({machineId:machine,serviceId:service});
const projection=async()=>expect(await request(api+'/baseline',{token:ro}),200).projection;
const working=async()=>expect(await request(api+'/baseline',{token:ro}),200).ledger;

async function testBlocked(workspace,fixture,reason,retainedRows) {
  await runtime.dispose();
  await start(true,workspace);
  await install();
  const raw=encodeRows(fixture),chunks=[];
  for(let start=0;start<raw.length;start+=BASELINE_CHUNK_BYTES) chunks.push(raw.subarray(start,start+BASELINE_CHUNK_BYTES));
  expect(await post('/baseline/begin',{format:'fleet-baseline-v1',sourceSha256:sourceSha,dataBytes:raw.length,
    dataChain:hashChain(chunks.map(digest)),files:0,fileBytes:0,fileChain:hashChain([])}),200);
  for(const [ordinal,chunk] of chunks.entries()) {
    expect(await post('/baseline/records',{ordinal,sha256:digest(chunk),data:chunk.toString('base64')}),200);
  }
  expect(await post('/baseline/seal',{}),200);
  for(let page=0;page<6&&(await projection()).state!=='blocked';page++) await tick();
  assert.deepEqual(await projection(),{state:'blocked',reason,indexedRows:retainedRows});
  assert.equal(expect(await request(servicePath(machineId,serviceId),{token:ro}),409).error,'baseline_projection_unverified');
  assert.equal(expect(await request(api+'/baseline/page?ordinal=0',{token:ro}),200).sha256,digest(chunks[0]));
  assert.equal((await db.prepare('SELECT count(*) AS n FROM fleet_baseline_rows').first()).n,retainedRows);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM fleet_records').first()).n,0);
}

async function runJava({lose,expectedUpload}={}) {
  const jar=path.resolve('vendor/json-java/json-20240303.jar');
  const child=spawn('java',['-cp',dir+path.delimiter+jar,'gr.argyrismitsos.fleetdirect.Fixture',
    path.join(dir,'records.ndjson'),epoch,sourceSha,...packages.flatMap(([,bytes,type])=>[bytes.toString('base64'),type])],
  {stdio:['pipe','pipe','inherit']});
  const completion=once(child,'exit');
  let uploads=0,pages=0,files=0,injected=false,marker='';
  try {
    for await (const line of createInterface({input:child.stdout})) {
      if (line.startsWith('RESULT ')) { marker=line; continue; }
      const call=JSON.parse(line);
      let reply;
      if (call.upload) {
        uploads++;
        const bytes=Buffer.from(call.upload,'base64');
        reply=await request(api+'/invoice-file?sha256='+call.sha,{method:'PUT',body:bytes,
          headers:{'Content-Type':call.type,'Content-Length':String(bytes.length)}});
      } else {
        if (call.path.endsWith('/records')) pages++;
        if (call.path.endsWith('/files')) files++;
        reply=await request(call.path,{method:'POST',body:JSON.stringify(call.payload),headers:{'Content-Type':'application/json'}});
      }
      if (!injected&&lose&&call.path?.endsWith(lose)&&reply.status===200) {
        injected=true;
        reply={status:503,data:{error:'synthetic lost durable acknowledgement'}};
      }
      child.stdin.write(JSON.stringify(reply)+'\n');
    }
  } finally {
    child.stdin.end();
    if (!marker&&child.exitCode===null) child.kill();
  }
  const [code]=await completion;
  assert.equal(code,lose?2:0);
  assert.equal(injected,Boolean(lose));
  if(expectedUpload!==undefined) assert.equal(uploads,expectedUpload);
  return {pages,files};
}

const sourceSha=digest('synthetic verified backup');
try {
  await build({entryPoints:['cloudflare-worker/hybrid-fleet/worker.js'],outfile:path.join(dir,'worker.mjs'),bundle:true,format:'esm',platform:'neutral'});
  await start(false);
  await install();
  expect(await request(api+'/baseline'),404);
  await runtime.dispose();
  await start(true);
  assert.equal(expect(await request(api+'/state'),200).baselineVersion,1);
  expect(await request(api+'/baseline',{token:''}),401);
  expect(await request(api+'/baseline',{sendEpoch:'changed'}),409);
  assert.equal(expect(await request(api+'/baseline'),200).phase,'empty');
  expect(await post('/baseline/begin',{}, {token:ro}),403);
  expect(await post('/baseline/begin',{format:'payroll-export'}),400);
  expect(await request(api+'/baseline/page?ordinal=0'),404);

  fs.writeFileSync(path.join(dir,'records.ndjson'),scoped);
  fs.writeFileSync(path.join(dir,'Base64.java'),[
    'package android.util; public final class Base64 {',
    'public static final int NO_WRAP=2;',
    'public static String encodeToString(byte[] bytes,int flags){return java.util.Base64.getEncoder().encodeToString(bytes);}}'
  ].join('\n'));
  fs.writeFileSync(path.join(dir,'Fixture.java'),[
    'package gr.argyrismitsos.fleetdirect;',
    'import org.json.JSONObject; import java.io.*; import java.nio.charset.StandardCharsets;',
    'public class Fixture {',
    '  public static void main(String[] args) throws Exception {',
    '    BufferedReader replies=new BufferedReader(new InputStreamReader(System.in,StandardCharsets.UTF_8));',
    '    FleetCloudBaseline.Transport fixture=new FleetCloudBaseline.Transport(){',
    '      private JSONObject relay(JSONObject request)throws Exception{',
    '        System.out.println(request); System.out.flush();',
    '        JSONObject reply=new JSONObject(replies.readLine());',
    '        if(reply.getInt("status")!=200)throw new IOException("injected network response");',
    '        return reply.getJSONObject("data");',
    '      }',
    '      public JSONObject send(String path,JSONObject body)throws Exception {',
    '        return relay(new JSONObject().put("path",path).put("payload",body));',
    '      }',
    '      public JSONObject putFile(String sha,String type,long size,InputStream input)throws Exception {',
    '        return relay(new JSONObject().put("sha",sha).put("type",type).put("size",size)',
    '          .put("upload",java.util.Base64.getEncoder().encodeToString(input.readAllBytes())));',
    '      }',
    '    };',
    '    java.util.List<FleetCloudBaseline.Document> docs=new java.util.ArrayList<>();',
    '    for(int n=3;n<args.length;n+=2) {',
    '      byte[] bytes=java.util.Base64.getDecoder().decode(args[n]);',
    '      docs.add(new FleetCloudBaseline.Document(FleetCloudBaseline.digest(bytes),args[n+1],bytes.length,()->new ByteArrayInputStream(bytes)));',
    '    }',
    '    try { FleetCloudBaseline.stage(args[1],args[2],new File(args[0]),docs,fixture);',
    '      System.out.println("RESULT staged");',
    '    } catch(IOException error){System.out.println("RESULT interrupted");System.exit(2);}',
    '  }',
    '}'
  ].join('\n'));
  const compiler=path.join(process.env.FLEET_ANDROID_TOOLCHAIN_ROOT||'.android-toolchain','usr/share/java/eclipse-jdt-core-3.32.0.jar');
  const compilerExists=fs.existsSync(compiler);
  execFileSync(compilerExists?'java':'javac',[...compilerExists?['-jar',compiler,'-proc:none','-source','8','-target','8','-nowarn']:[],
    '-cp',path.resolve('vendor/json-java/json-20240303.jar'),'-d',dir,
    path.join(dir,'Base64.java'),path.join(dir,'Fixture.java'),
    'unified-android/src/gr/argyrismitsos/fleetdirect/FleetCloudBaseline.java'],{stdio:'inherit'});

  const expectedHashes=[];
  for (let i=0;i<scoped.length;i+=BASELINE_CHUNK_BYTES) expectedHashes.push(digest(scoped.subarray(i,i+BASELINE_CHUNK_BYTES)));
  const fileChain=hashChain(packages.map(([,bytes])=>digest(digest(bytes)+':'+bytes.length)));
  expect(await post('/baseline/begin',{format:'fleet-baseline-v1',sourceSha256:sourceSha,dataBytes:scoped.length,
    dataChain:hashChain(expectedHashes),files:packages.length,fileBytes:packages.reduce((size,[,bytes])=>size+bytes.length,0),fileChain}),200);
  expect(await post('/baseline/files',{ordinal:0,size:fileBytes.length,sha256:fileSha}),409,'file must already exist');
  assert.deepEqual(await runJava({lose:'/records',expectedUpload:packages.length}),{pages:1,files:packages.length});
  const interrupted=expect(await request(api+'/baseline'),200);
  assert.equal(interrupted.phase,'copying');
  assert.equal(interrupted.records.next,1);
  assert.equal(interrupted.files.next,packages.length);
  await tick();
  assert.equal((await projection()).state,'waiting','unsealed bytes cannot be indexed');
  expect(await post('/baseline/seal',{}),409);
  expect(await request(api+'/baseline/page?ordinal=0'),404);
  expect(await post('/baseline/begin',{...interrupted.manifest,sourceSha256:'f'.repeat(64)}),409);
  const first=scoped.subarray(0,BASELINE_CHUNK_BYTES);
  expect(await post('/baseline/records',{ordinal:4,sha256:digest(first),data:first.toString('base64')}),409);
  expect(await post('/baseline/records',{ordinal:0,sha256:'f'.repeat(64),data:first.toString('base64')}),422);
  const different=Buffer.alloc(BASELINE_CHUNK_BYTES,'e');
  expect(await post('/baseline/records',{ordinal:0,sha256:digest(different),data:different.toString('base64')}),409);
  assert.deepEqual(expect(await post('/baseline/records',{ordinal:0,sha256:digest(first),data:first.toString('base64')}),200),interrupted.records);
  await runtime.dispose();
  await start(true);
  const resumed=await runJava({expectedUpload:0});
  const state=expect(await request(api+'/baseline',{token:ro}),200);
  assert.equal(state.phase,'staged');
  assert.equal(resumed.pages,state.records.next-1);
  assert.equal(resumed.files,0);
  assert.deepEqual(await runJava({expectedUpload:0}),{pages:0,files:0});
  const restored=[];
  for(let index=0;index<state.records.next;index++){
    const page=expect(await request(api+'/baseline/page?ordinal='+index,{token:ro}),200);
    assert.equal(page.ordinal,index);
    const bytes=Buffer.from(page.data,'base64');
    assert.equal(digest(bytes),page.sha256);
    restored.push(bytes);
  }
  assert.deepEqual(Buffer.concat(restored),scoped);
  assert.equal(state.manifest.dataChain,hashChain(restored.map(digest)));
  assert.equal(state.manifest.fileChain,fileChain);
  const file=await (await runtime.getR2Bucket('FLEET_DOCUMENTS')).get('sha256/'+fileSha);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()),fileBytes);
  const target=servicePath(machineId,serviceId);
  const job={operationId:'fixture-legacy-invoice',machineId,serviceId,qrValue:'https://invoice.fixture.invalid/123',
    sourceKey:fileKey,sourceSha256:fileSha,source:'legacy-operation',sourceId:'legacy-job',explicitId:'manual-legacy-operation-stored'};
  expect(await request(target,{token:''}),401);
  expect(await request(target,{sendEpoch:'superseded',token:ro}),409);
  assert.equal(expect(await request(target,{token:ro}),409).error,'baseline_projection_unverified');
  assert.equal(expect(await post('/invoice-jobs',{jobs:[job]}),409).error,'baseline_projection_unverified');
  await tick();
  const partial=await projection();
  assert.equal(partial.state,'indexing');
  assert(partial.indexedRows>0&&partial.indexedRows<records.length);
  await runtime.dispose();
  await start(true);
  assert.deepEqual(await projection(),partial,'projection checkpoint survives restart');
  for(let page=0;page<6&&(await projection()).state==='indexing';page++) await Promise.all([tick(),tick()]);
  assert.deepEqual(await projection(),{state:'verified',reason:'',indexedRows:records.length});
  const exact=expect(await request(target,{token:ro}),200);
  assert.equal(exact.recordSha256,digest(JSON.stringify(service)));
  assert.deepEqual(exact.service,service.data);
  expect(await request(servicePath(otherId,serviceId),{token:ro}),404);
  expect(await request(servicePath(machineId,deletedId),{token:ro}),404);
  expect(await request(servicePath(machineId+' ',serviceId),{token:ro}),400);
  const rows=await db.prepare('SELECT ordinal,digest FROM fleet_baseline_rows ORDER BY ordinal').all();
  assert.deepEqual(rows.results.map(row=>row.digest),records.map(row=>digest(JSON.stringify(row))));
  assert.equal((await db.prepare('SELECT count(*) AS n FROM fleet_records').first()).n,0,'indexing does not change the trial ledger');
  assert.equal(expect(await request(api+'/delta',{token:ro}),409).error,'baseline_working_ledger_unready');
  expect(await post('/mutations',{operations:[]}),409);
  await tick();
  const partialLedger=await working();
  assert.equal(partialLedger.state,'loading');
  assert.equal(partialLedger.seededRows,3);
  expect(await request(api+'/delta',{token:ro}),409);
  expect(await post('/invoice-jobs',{jobs:[job]}),409);
  await runtime.dispose();
  await start(true);
  assert.deepEqual(await working(),partialLedger);
  for(let page=0;page<5&&(await working()).state==='loading';page++) await Promise.all([tick(),tick()]);
  assert.deepEqual(await working(),{state:'ready',reason:'',seededRows:3});
  const initial=expect(await request(api+'/delta',{token:ro}),200);
  assert.deepEqual(initial.changes.map(change=>[change.kind,change.machineId,change.recordId]),
    [['machine',machineId,machineId],['service',machineId,serviceId],['invoice',machineId,'confirmed-original-id']]);
  const stagedService=initial.changes[1].data;
  assert.equal(stagedService.notes,service.data.notes);
  assert.deepEqual(stagedService.tasks,service.data.tasks);
  assert.equal(stagedService.date,service.data.date);
  assert.equal(stagedService.km,service.data.km);
  assert.equal(initial.changes[2].data.totalAmount,'67,94');
  assert.equal(initial.changes[2].data.sha256,digest(confirmedBytes));
  const jobs=[job,{...job,operationId:'fixture-archived-invoice',machineId:otherId},
    {...job,operationId:'fixture-unverified-file',sourceKey:'service-documents/unverified.jpg'},
    {...job,operationId:'fixture-previously-confirmed',qrValue:'https://invoice.fixture.invalid/paid',sourceKey:'',sourceSha256:''},
    {...job,operationId:'fixture-archived-confirmed',qrValue:'https://invoice.fixture.invalid/archive-paid',sourceKey:'',sourceSha256:''}];
  const queued=expect(await post('/invoice-jobs',{jobs}),200).jobs;
  assert.deepEqual(queued.map(job=>[job.status,job.reason]),
    [['queued',''],['review','original_service_not_verified'],['review','original_attachment_unverified'],
      ['already_confirmed',''],['review','invoice_attached_elsewhere']]);
  await tick();
  assert.equal(readJobs.length,0,'unsealed jobs remain idle');
  expect(await post('/invoice-stage',{count:jobs.length,manifestHash:await invoiceStageProof(jobs)}),200);
  await Promise.all([tick(),tick()]);
  assert.deepEqual(readJobs,[job.qrValue]);
  const status=expect(await request(api+'/invoice-status'),200);
  assert.deepEqual(status.counts,{already_confirmed:1,completed:1,review:3});
  const updated=expect(await request(api+'/delta?cursor='+initial.nextCursor,{token:ro}),200).changes;
  assert.equal(updated.length,1);
  assert.equal(updated[0].kind,'invoice');
  assert.equal(updated[0].machineId,machineId);
  assert.equal(updated[0].serviceId,serviceId);
  assert.equal(updated[0].data.plate,'HTP-527');
  assert.equal(updated[0].data.invoiceDate,'2026-11-25');
  assert.equal(updated[0].data.odometerKm,'12456');
  assert.equal(updated[0].data.totalAmount,'124,00');
  const updatedFile=await (await runtime.getR2Bucket('FLEET_DOCUMENTS')).get('sha256/'+updated[0].data.sha256);
  assert.equal(digest(Buffer.from(await updatedFile.arrayBuffer())),updated[0].data.sha256);
  const compactMachine={...machine,data:{id:machineId,name:'Μηχανή Α'}};
  await testBlocked('missing-document',[snapshot,compactMachine,service],'baseline_document_missing',3);
  await testBlocked('duplicate-record',[snapshot,compactMachine,compactMachine],'baseline_duplicate_record',0);
  await testBlocked('duplicate-after-progress',[snapshot,machine,compactMachine],'baseline_duplicate_record',2);
  await testBlocked('missing-parent',[snapshot,{...service,data:{...service.data,attachments:[]}}],'baseline_parent_missing',2);
  await testBlocked('missing-file-proof',[snapshot,records.at(-1)],'baseline_document_proof_mismatch',0);
  console.log('PASS actual Android transfer with Workerd/D1/R2: lost ACK, restart, verified bytes, exact service scope, resumable trial ledger, preserved original invoice and recovered QR.');
} finally {
  if(runtime) await runtime.dispose();
  fs.rmSync(dir,{recursive:true,force:true});
}
