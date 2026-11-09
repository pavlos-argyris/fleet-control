import assert from 'node:assert/strict';
import {createSimulation} from './fixtures/workforce-simulation.mjs';
import {WORKFORCE_SCHEMA} from '../cloudflare-worker/src/workforce.js';
// Importing shared features into a real Worker must not install Rhino's web shims.
const originals=Object.fromEntries(['Request','Response','URL','crypto','fetch','File'].map(k=>[k,globalThis[k]]));
const {businessContext,businessPort}=await import('../server-runtime/ports.js');
const {routeExports}=await import('../server-runtime/exports.js');
const {storeReport,REPORT_SCHEMA}=await import('../server-runtime/reports.js');
const {cashSourceCatalog,CASH_SOURCE_SCHEMA}=await import('../server-runtime/cash-source.js');
const {healthSnapshot,HEALTH_SCHEMA}=await import('../server-runtime/health.js');
for(const [name,value]of Object.entries(originals))assert.equal(globalThis[name],value,`shared import replaced ${name}`);
assert.equal(typeof routeExports,'function');
const date='2026-11-08',fixtures=[];
try{
 for(const scope of ['scope-a','scope-b']){
  const f=createSimulation();fixtures.push(f);await f.db.exec(WORKFORCE_SCHEMA);await f.db.exec(REPORT_SCHEMA+CASH_SOURCE_SCHEMA+HEALTH_SCHEMA+"CREATE TABLE store_billing_local(id TEXT PRIMARY KEY,kind TEXT,scope TEXT,store_id TEXT,day TEXT,data TEXT,dirty INTEGER DEFAULT 0);");
  f.env.BUSINESS_CONTEXT={configured:true,scope,generation:'generation-'+scope};
  f.env.BUSINESS_PORT=async command=>{assert.equal(command,'health.snapshot');await new Promise(resolve=>setTimeout(resolve,scope==='scope-a'?8:1));return{at:new Date().toISOString(),serverLastSeenAt:new Date().toISOString(),versions:{server:scope,business:'test'}};};
  f.db.sqlite.prepare("INSERT INTO store_billing_local VALUES(?,'store',?,'','',?,0)").run(scope+'-shop',scope,JSON.stringify({name:scope}));
  f.db.sqlite.prepare("INSERT INTO native_cash_rider_links VALUES(?,?,?,'2026-01-01',1,?,?,?,'owner')").run(scope+'-link',scope,scope+'-rider',scope+'-employee',scope+'-name',new Date().toISOString());
 }
 globalThis.FleetHost=()=>{throw Error('cloud request used process-global native host');};
 const reports=await Promise.all(fixtures.map(f=>storeReport(f.env,{scope:f.env.BUSINESS_CONTEXT.scope,from:date,to:date})));
 assert.deepEqual(reports.map(r=>r.stores[0].name),['scope-a','scope-b']);
 const catalogs=await Promise.all(fixtures.map(f=>cashSourceCatalog(f.env)));
 assert.deepEqual(catalogs.map(c=>c.riderLinks[0].employee_id),['scope-a-employee','scope-b-employee']);
 const health=await Promise.all(fixtures.map(f=>healthSnapshot(f.env)));
 assert.deepEqual(health.map(h=>h.versions.server),['scope-a','scope-b']);
 for(const f of fixtures)assert.equal(businessContext(f.env).scope,f.env.BUSINESS_CONTEXT.scope);
 assert.deepEqual(await businessPort({BUSINESS_PORT:async(command,value)=>({command,value})},'files.chunk',{ref:'private-ref'}),{command:'files.chunk',value:{ref:'private-ref'}});
 delete globalThis.FleetHost;
 await assert.rejects(businessPort({},'files.chunk'),/unavailable/);
 globalThis.FleetHost=(command,value)=>({command,value,native:true});
 assert.equal((await businessPort({},'reports.export',{format:'pdf'})).native,true);
 globalThis.FleetHost=()=>({configured:true,scope:'native-scope'});
 assert.equal(businessContext({}).scope,'native-scope');
 console.log('PASS shared feature imports preserve real web globals; concurrent per-request report, mapping and health ports remain isolated; explicit cloud ports override global host; native fallback retained, missing host fails closed. No production activation.');
}finally{delete globalThis.FleetHost;for(const f of fixtures)f.db.sqlite.close();}
