import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
import worker from '../cloudflare-worker/src/worker.js';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{Miniflare,convertV4MiniflareOptions}=require('miniflare'),{build}=require('esbuild');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-direct-relay-'));let runtime;
try {
  let reads=0;const env={get DB(){reads++;throw Error('D1 is completely unavailable');},ASSETS:{fetch:()=>new Response('emergency static entry')}};
  assert.equal(await (await worker.fetch(new Request('https://fixture/direct.html'),env)).text(),'emergency static entry');
  assert.equal((await worker.fetch(new Request('https://fixture/api/direct/request',{method:'OPTIONS'}),env)).status,200);
  assert.equal(reads,0,'emergency entry and CORS precede any schema/database access');
  await build({entryPoints:['cloudflare-worker/src/worker.js'],outfile:path.join(folder,'worker.mjs'),bundle:true,format:'esm',platform:'neutral'});
  // No DB binding at all. A hidden schema/auth query would fail the test.
  runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:fs.readFileSync(path.join(folder,'worker.mjs'),'utf8'),compatibilityDate:'2026-10-01',durableObjects:{FLEET_EVENTS:{className:'FleetEvents',useSQLite:true}},bindings:{SERVER_KEY:'synthetic-direct-server-key-123456'}}));
  const pair='a'.repeat(43),pairHash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(pair))).toString('hex');
  const call=(body,key=pair)=>runtime.dispatchFetch('https://fixture/api/direct/request',{method:'POST',headers:{'Content-Type':'application/json','X-Fleet-Direct-Key':key},body:JSON.stringify(body)});
  const request={path:'/api/direct-local/login',method:'POST',headers:{Authorization:'Bearer test','X-Fleet-Server-Key':'must not forward',Cookie:'must not forward'},body:{username:'synthetic',password:'synthetic password'}};
  assert.equal((await call(request)).status,503,'offline Server is explicit');
  assert.equal((await runtime.dispatchFetch('https://fixture/api/direct/connect',{headers:{Upgrade:'websocket','X-Fleet-Server-Key':'wrong','X-Fleet-Direct-Pair':pairHash}})).status,401);
  const connected=await runtime.dispatchFetch('https://fixture/api/direct/connect',{headers:{Upgrade:'websocket','X-Fleet-Server-Key':'synthetic-direct-server-key-123456','X-Fleet-Direct-Pair':pairHash}});
  assert.equal(connected.status,101);const ws=connected.webSocket;ws.accept();let sent=0;
  ws.addEventListener('message',event=>{if(event.data==='pong')return;const data=JSON.parse(event.data);if(data.type!=='request')return;sent++;
    assert.equal(data.request.path,request.path);assert.equal(data.request.headers.Cookie,undefined);assert.equal(data.request.headers['X-Fleet-Server-Key'],undefined);
    ws.send(JSON.stringify({id:data.id,response:{status:200,body:JSON.stringify({token:'local-only-token',source:'Android'}),snapshotAt:'2026-10-30T10:00:00Z',writable:false}}));
  });
  const response=await call(request);assert.equal(response.status,200);const data=await response.json();assert.equal(data.local,true);assert.equal(JSON.parse(data.body).source,'Android');assert.equal(data.writable,false);assert.equal(sent,1);
  assert.equal((await call(request,'b'.repeat(43))).status,401);
  assert.equal(sent,1,'wrong pairing secret never reaches Android');
  assert.equal((await call({...request,path:'https://external.invalid/'})).status,400);
  assert.equal((await call({...request,path:'/api/server/snapshot'})).status,400);
  assert.equal((await call({...request,path:'/api/direct/connect'})).status,400);
  // Exercise the streamed limit without an HTTP client's early-response/socket
  // reset race while it is still uploading a deliberately oversized body.
  const bounded=await worker.fetch(new Request('https://fixture/api/direct/request',{method:'POST',headers:{'X-Fleet-Direct-Key':pair},body:JSON.stringify({...request,body:'x'.repeat(2*1024*1024)})}),{FLEET_EVENTS:{idFromName:()=>0,get:()=>({fetch(){throw Error('Oversized payload reached relay');}})}});
  assert.equal(bounded.status,413);
  assert.equal(sent,1,'invalid/oversized requests are rejected before relay');
  const pong=new Promise(resolve=>ws.addEventListener('message',event=>{if(event.data==='pong')resolve();}));ws.send('ping');await pong;
  ws.close(1000,'test complete');
  console.log('OK actual Workerd/Durable Objects: D1 absent, authenticated private Server WebSocket, pairing, filtered headers, bounded payloads, no request replay, offline status and auto ping.');
} finally {await runtime?.dispose();fs.rmSync(folder,{recursive:true,force:true});}
