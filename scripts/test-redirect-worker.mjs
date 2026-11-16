import assert from 'node:assert/strict';import fs from 'node:fs';
import worker,{FleetEvents,DIRECT_ORIGIN} from '../cloudflare-worker/src/redirect.js';
const poison=new Proxy({},{get(){throw Error('Retired cloud binding accessed');}});
const old=globalThis.fetch;globalThis.fetch=()=>{throw Error('Redirect must not make a subrequest');};
try{
 for(const method of ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']){
  const request=new Request('https://fleet-control.pavlosargyris.workers.dev/api/private?token=private-fixture&redirect=https://wrong.invalid',{method,headers:{Authorization:'Bearer private-fixture',Cookie:'fc_auth=private-fixture'}});
  const result=await worker.fetch(request,poison,poison);assert.equal(result.status,['GET','HEAD'].includes(method)?302:410);
  assert.equal(result.headers.get('location'),['GET','HEAD'].includes(method)?DIRECT_ORIGIN+'/':null);
  assert.equal(result.headers.get('set-cookie'),null);assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(result.headers.get('referrer-policy'),'no-referrer');
  assert.ok(!(await result.text()).includes('private-fixture'));
 }
 const retired=new FleetEvents(poison,poison);await retired.alarm();assert.equal((await retired.fetch()).status,410);let closed=false;retired.webSocketMessage({close(code){closed=code===1000;}});assert.ok(closed);
 const config=JSON.parse(fs.readFileSync('cloudflare-worker/wrangler.example.jsonc','utf8'));
 assert.equal(config.main,'src/redirect.js');for(const key of ['assets','d1_databases','r2_buckets','durable_objects','ai'])assert.equal(config[key],undefined);
 assert.deepEqual(config.triggers,{crons:[]},'empty array removes old schedules; omission would retain them');
 assert.deepEqual(config.migrations,[{tag:'fleet-events-v1',new_sqlite_classes:['FleetEvents']}],'existing namespace identity/history is retained without deletion migration');
 console.log('PASS redirect-only Worker: fixed GET/HEAD destination, stripped query, retired writes, no credentials/subrequests/binding/storage/alarm work and no deletion migration');
}finally{globalThis.fetch=old;}
