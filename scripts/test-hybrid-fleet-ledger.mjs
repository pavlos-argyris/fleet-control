import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sha256 } from '../cloudflare-worker/hybrid-fleet/ledger.js';

const require = createRequire(new URL('../cloudflare-worker/package.json', import.meta.url));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { build } = require('esbuild');
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'fleet-ledger-test-'));
const statePath = '/api/fleet-sync/v1/state';
const deltaPath = '/api/fleet-sync/v1/delta';
const mutationsPath = '/api/fleet-sync/v1/mutations';
const writable = 'test-fixture-writer.' + 'A'.repeat(43);
const readonly = 'test-fixture-reader.' + 'B'.repeat(43);
const recovery = 'R'.repeat(43);
const recoveryHash = await sha256(recovery);
const origin = 'https://hybrid-fixture.invalid';
let runtime;
try {
  const module = path.join(temp,'worker.mjs');
  await build({entryPoints:['cloudflare-worker/hybrid-fleet/worker.js'],outfile:module,bundle:true,format:'esm',platform:'neutral'});
  async function start(enabled) {
    runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:fs.readFileSync(module,'utf8'),
      compatibilityDate:'2026-09-05',d1Databases:{FLEET_DB:'hybrid-test-ledger'},
      resourcePersistencePath:path.join(temp,'d1'),bindings:{
        FLEET_REHEARSAL_ENABLED:enabled?'1':'0',FLEET_PIN_PEPPER:'synthetic-fixture-pepper-value-'.repeat(2),
        FLEET_RECOVERY_CREDENTIAL_SHA256:recoveryHash
      }}));
    return runtime.getD1Database('FLEET_DB');
  }
  let db=await start(false);
  async function call(url,{token=writable,method='GET',body,epoch,headers:extraHeaders}={}) {
    const headers={...extraHeaders};
    if (token) headers.Authorization='Bearer '+token;
    if (epoch) headers['X-Fleet-Epoch']=epoch;
    if (body) headers['Content-Type']='application/json';
    const res=await runtime.dispatchFetch(origin+url,{
      method,headers,body:body?JSON.stringify(body):undefined
    });
    return {status:res.status,data:await res.json(),cookies:res.headers.getSetCookie()};
  }
  function expect(result,status) {
    assert.equal(result.status,status,JSON.stringify(result.data));
    return result.data;
  }
  expect(await call(statePath),404);
  await runtime.dispose();
  db=await start(true);
  const schema=fs.readFileSync('cloudflare-worker/hybrid-fleet/migrations/0001_rehearsal.sql','utf8')
    .replace(/^--.*$/gm,'');
  const trigger=schema.indexOf('CREATE TRIGGER');
  const sql=schema.slice(0,trigger).split(';').filter(statement=>statement.trim()).map(statement=>db.prepare(statement));
  sql.push(db.prepare(schema.slice(trigger)));
  await db.batch(sql);
  const pinSchema=fs.readFileSync('cloudflare-worker/hybrid-fleet/migrations/0002_pin.sql','utf8');
  await db.batch(pinSchema.split(';').filter(statement=>statement.trim()).map(statement=>db.prepare(statement)));
  for (const [credential,scope] of [[writable,'sync-read-write'],[readonly,'sync-read']]) {
    const [id,secret] = credential.split('.');
    await db.prepare('INSERT INTO fleet_sync_credentials(id,secret_sha256,scope,expires_at) VALUES(?,?,?,?)')
      .bind(id,await sha256(secret),scope,Date.now()+600000).run();
  }
  expect(await call(statePath,{token:null}),401);
  expect(await call('/api/payment/payroll',{token:writable}),404);
  expect(await call('/api/admin/employees',{token:writable}),404);
  expect(await call('/api/server/ordexa',{token:writable}),404);
  expect(await call('/api/operations',{token:writable,method:'POST',body:{}}),404);
  const {epoch}=expect(await call(statePath),200);
  const push = (operations, settings={}) => call(mutationsPath,{method:'POST',epoch,body:{operations},...settings});
  const pull = (cursor=0) => call(deltaPath+'?cursor='+cursor,{epoch,token:readonly});
  expect(await pull(1),409);
  expect(await call(deltaPath,{epoch:'former-generation'}),409);
  expect(await push([],{token:readonly}),403);
  assert.deepEqual(expect(await push([]),200).operations,[]);
  assert.deepEqual(expect(await pull(),200).changes,[]);
  let index=0;
  const make = (machineId, overrides={}) => ({
    operationId:'synthetic-operation-'+(++index),kind:'machine',machineId,recordId:machineId,expectedRevision:0,deleted:false,
    data:{name:'Synthetic '+machineId,currentKm:3000},...overrides
  });
  const sources = Array.from({length:40},(_,i)=>make('machine-'+i));
  for (let i=0;i<sources.length;i+=12) {
    const result=expect(await push(sources.slice(i,i+12)),200);
    assert(result.operations.every(operation=>operation.status==='committed'));
  }
  expect(await push([make('private',{data:{name:'Synthetic',employeeId:'fixture'}})]),400);
  expect(await push([make('private',{data:{name:'Synthetic',notes:'x'.repeat(200000)}})]),413);
  const first = sources[0];
  const service=make(first.machineId,{kind:'service',recordId:'service-1',
    data:{km:3030,date:'2026-11-25',notes:'Synthetic Greek note',tasks:['Έλεγχος'],cost:'30,00'}});
  const orphan=make(first.machineId,{kind:'invoice',recordId:'invoice-x',serviceId:'missing-service',
    data:{invoiceNumber:'NO-TARGET'}});
  const invoice=make(first.machineId,{kind:'invoice',recordId:'invoice-1',serviceId:service.recordId,
    data:{invoiceNumber:'INVOICE-1',invoiceDate:'2026-12-02',totalAmount:'37,20',odometerKm:'9524',plate:'EXAMPLE'}});
  const part=expect(await push([orphan,service,invoice]),200).operations;
  assert.deepEqual(part.map(op=>op.status),['conflict','committed','committed']);
  const accepted=part[1];
  const sqlCount=async table=>(await db.prepare('SELECT count(*) AS n FROM '+table).first()).n;
  const after=await sqlCount('fleet_mutations');
  await runtime.dispose(); // Simulate restarting after commit before the client saw the receipt.
  db=await start(true);
  assert.deepEqual(expect(await push([service]),200).operations,[{...accepted,status:'replayed'}]);
  assert.equal(await sqlCount('fleet_mutations'),after);
  assert.equal(expect(await push([{...service,data:{...service.data,km:3001}}]),200).operations[0].status,'operation_id_conflict');
  const corrections=[make(first.machineId,{...service,operationId:'synthetic-correct-a',expectedRevision:1,data:{...service.data,km:3100}}),
    make(first.machineId,{...service,operationId:'synthetic-correct-b',expectedRevision:1,data:{...service.data,km:3200}})];
  const race=(await Promise.all(corrections.map(op=>push([op])))).flatMap(result=>expect(result,200).operations);
  assert.deepEqual(race.map(op=>op.status).sort(),['committed','conflict']);
  const rev=expect(await push([make(first.machineId,{...service,operationId:'synthetic-remove-service',expectedRevision:2,deleted:true,data:null})]),200);
  assert.equal(rev.operations[0].revision,3);
  assert.equal(expect(await push([make(first.machineId,{...service,operationId:'synthetic-stale-service',expectedRevision:2})]),200).operations[0].status,'conflict');
  assert.equal(await sqlCount('fleet_records'),42);
  let page=expect(await pull(),200);
  let events=[...page.changes];
  while (page.hasMore) {
    page=expect(await pull(page.nextCursor),200);
    events=events.concat(page.changes);
  }
  assert.equal(events.length,44);
  assert.equal(events.at(-1).deleted,true);
  assert.equal(events.at(-1).data,null);
  const idle=expect(await pull(page.nextCursor),200);
  assert.deepEqual(idle.changes,[]);
  assert.equal(await sqlCount('fleet_mutations'),events.length);
  await db.prepare('UPDATE fleet_sync_credentials SET revoked_at=? WHERE id=?').bind(Date.now(),writable.split('.')[0]).run();
  expect(await push([make('revoked')]),401);
  assert.equal(await sqlCount('fleet_mutations'),events.length);

  const web='/api/fleet-web/v1';
  const webPost=(action,body,cookie='',headers={})=>call(web+'/'+action,{
    method:'POST',token:null,body,headers:{Origin:origin,Cookie:cookie,...headers}
  });
  const getSession=cookie=>call(web+'/session',{headers:{Cookie:cookie},token:null});
  const findCookie=(response,name)=>{
    const value=response.cookies.find(cookie=>cookie.startsWith(name+'='));
    assert.match(value,/; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
    return value.split(';')[0];
  };
  expect(await webPost('login',{pin:'5812'}),401);
  assert.equal(await sqlCount('fleet_pin_windows'),0,'untrusted requests do not consume the owner allowance');
  expect(await webPost('enroll',{pin:'5812',recoveryCredential:recovery},'',{Origin:'https://other-fixture.invalid'}),403);
  expect(await webPost('enroll',{pin:'5812',recoveryCredential:'A'.repeat(43)}),401);
  const newDevice=async (pin='5812',recover=false)=>{
    const enrolled=await webPost('enroll',{pin,recoveryCredential:recovery,recover});
    expect(enrolled,200);
    return findCookie(enrolled,'__Host-fleetDevice');
  };
  const firstDevice=await newDevice(), secondDevice=await newDevice();
  const signedIn=await webPost('login',{pin:'5812'},firstDevice);
  const csrf=expect(signedIn,200).csrf;
  const firstCookies=firstDevice+'; '+findCookie(signedIn,'__Host-fleetSession');
  expect(await getSession(firstCookies),200);
  expect(await getSession(secondDevice+'; '+findCookie(signedIn,'__Host-fleetSession')),401);
  expect(await webPost('logout',{},firstCookies,{'X-Fleet-CSRF':'unrelated'}),403);
  expect(await webPost('logout',{},firstCookies,{'X-Fleet-CSRF':csrf,Origin:'https://other-fixture.invalid'}),403);
  const secondSession=await webPost('login',{pin:'5812'},secondDevice);
  expect(secondSession,200);
  expect(await webPost('logout',{},firstCookies,{'X-Fleet-CSRF':csrf}),200);
  expect(await getSession(firstCookies),401);
  const secondCookies=secondDevice+'; '+findCookie(secondSession,'__Host-fleetSession');
  expect(await getSession(secondCookies),200);
  expect(await webPost('revoke-device',{},secondCookies,{'X-Fleet-CSRF':secondSession.data.csrf}),200);
  expect(await webPost('login',{pin:'5812'},secondDevice),401);
  const thirdDevice=await newDevice('4321',true);
  expect(await webPost('login',{pin:'5812'},firstDevice),401);
  const wrongAttempts=await Promise.all(Array.from({length:5},()=>webPost('login',{pin:'0001'},thirdDevice)));
  for (const response of wrongAttempts) expect(response,401);
  expect(await webPost('login',{pin:'4321'},thirdDevice),429);
  assert.equal((await db.prepare("SELECT attempts FROM fleet_pin_windows WHERE bucket='global'").first()).attempts,5);
  const newPinHash=(await db.prepare('SELECT pin_hash FROM fleet_pin_owner').first()).pin_hash;
  assert.match(newPinHash,/^[a-f0-9]{64}$/);
  assert.notEqual(newPinHash,await sha256('4321'));
  console.log('PASS Workerd/D1 rehearsal ledger, 40 machines, no-op and bounded indexed delta, CAS, tombstones, restart/replay, parent limits and authorization.');
  console.log('PASS trusted-device enrollment, cookie binding, scoped PIN flow, CSRF, revocation, recovery and atomic rate limit.');
} finally {
  if (runtime) await runtime.dispose();
  fs.rmSync(temp,{recursive:true,force:true});
}
