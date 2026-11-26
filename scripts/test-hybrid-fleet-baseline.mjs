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
import { sha256 } from '../cloudflare-worker/hybrid-fleet/ledger.js';

const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url));
const {Miniflare,convertV4MiniflareOptions}=require('miniflare');
const {build}=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-baseline-'));
const api='/api/fleet-sync/v1', origin='https://fleet-baseline-fixture.invalid';
const rw='fixture-baseline-writer.'+'W'.repeat(43), ro='fixture-baseline-reader.'+'R'.repeat(43);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const hashChain=items=>items.reduce((chain,hash)=>digest(chain+':'+hash),'0'.repeat(64));
const fileBytes=Buffer.from('Synthetic private photo bytes', 'utf8'), fileSha=digest(fileBytes);
const scoped=Buffer.from(JSON.stringify({kind:'machine',machineId:'synthetic-van',data:{notes:'δοκιμή '.repeat(20000)}})+'\n','utf8');
let runtime,db,epoch;

async function start(enabled) {
  runtime=new Miniflare(convertV4MiniflareOptions({
    modules:true,script:fs.readFileSync(path.join(dir,'worker.mjs'),'utf8'),compatibilityDate:'2026-09-05',
    d1Databases:{FLEET_DB:'fleet-baseline-fixture'},r2Buckets:['FLEET_DOCUMENTS'],
    resourcePersistencePath:path.join(dir,'state'),
    bindings:{FLEET_REHEARSAL_ENABLED:'1',FLEET_BASELINE_TRANSFER:enabled?'1':'0'}
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

async function runJava({lose,expectedUpload}={}) {
  const jar=path.resolve('vendor/json-java/json-20240303.jar');
  const child=spawn('java',['-cp',dir+path.delimiter+jar,'gr.argyrismitsos.fleetdirect.Fixture',
    path.join(dir,'records.ndjson'),epoch,sourceSha],{stdio:['pipe','pipe','inherit']});
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
    '    byte[] file="Synthetic private photo bytes".getBytes(StandardCharsets.UTF_8);',
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
    '    FleetCloudBaseline.Document doc=new FleetCloudBaseline.Document(',
    '      FleetCloudBaseline.digest(file),"image/jpeg",file.length,()->new ByteArrayInputStream(file));',
    '    try { FleetCloudBaseline.stage(args[1],args[2],new File(args[0]),java.util.Collections.singletonList(doc),fixture);',
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
  expect(await post('/baseline/begin',{format:'fleet-baseline-v1',sourceSha256:sourceSha,dataBytes:scoped.length,
    dataChain:hashChain(expectedHashes),files:1,fileBytes:fileBytes.length,fileChain:hashChain([digest(fileSha+':'+fileBytes.length)])}),200);
  expect(await post('/baseline/files',{ordinal:0,size:fileBytes.length,sha256:fileSha}),409,'file must already exist');
  assert.deepEqual(await runJava({lose:'/records',expectedUpload:1}),{pages:1,files:1});
  const interrupted=expect(await request(api+'/baseline'),200);
  assert.equal(interrupted.phase,'copying');
  assert.equal(interrupted.records.next,1);
  assert.equal(interrupted.files.next,1);
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
  assert.equal(state.manifest.fileChain,hashChain([digest(fileSha+':'+fileBytes.length)]));
  const file=await (await runtime.getR2Bucket('FLEET_DOCUMENTS')).get('sha256/'+fileSha);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()),fileBytes);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM fleet_records').first()).n,0,'staging cannot change the current writer');
  console.log('PASS actual Android transfer class with Workerd/D1/R2: guarded scope, lost ACK, JVM and Worker restart, prefix proof, full multibyte read-back and preserved bytes.');
} finally {
  if(runtime) await runtime.dispose();
  fs.rmSync(dir,{recursive:true,force:true});
}
