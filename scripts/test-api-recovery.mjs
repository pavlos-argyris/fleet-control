import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('cloudflare-worker/public/portal.js','utf8');
const api=source.slice(source.indexOf('  async function api('),source.indexOf('  function escapeHtml('));
const state={token:'fixture-token',invoiceDocuments:[{id:'already-loaded'}]};
let replies=[],calls=0,cleared=0;
const context={state,navigator:{onLine:true},apiBase:'https://fixture.invalid',Headers,performance,
  recordApiTiming(){},clearSession(){cleared++;},showAuth(){},setTimeout(fn){fn();},
  async fetch(url,options){calls++;const next=replies.shift();if(next instanceof Error)throw next;return next;}};
vm.createContext(context);vm.runInContext(api+'\nglobalThis.invoke=api;',context);
const response=(status,data)=>new Response(typeof data==='string'?data:JSON.stringify(data),{status,headers:{'CF-Ray':'fixture-ATH'}});
replies=[response(503,'<html>Worker exceeded resources</html>'),response(503,'gateway'),response(200,{documents:[{id:'fresh'}]})];calls=0;
assert.equal((await context.invoke('/api/admin/service-documents')).documents[0].id,'fresh');assert.equal(calls,3);assert.equal(cleared,0);
replies=[response(503,'gateway')];calls=0;
await assert.rejects(context.invoke('/api/service-documents/jobs/job/retry',{method:'POST',body:{}}),e=>e.status===503 && /HTTP 503/.test(e.message));assert.equal(calls,1,'mutations must not be replayed automatically');
replies=[response(503,'gateway'),response(503,'gateway'),response(503,'gateway')];calls=0;
await assert.rejects(context.invoke('/api/admin/service-documents'),e=>e.status===503);assert.equal(calls,3);assert.equal(state.invoiceDocuments[0].id,'already-loaded');assert.equal(cleared,0);
replies=[new Error('offline'),response(200,{documents:[]})];calls=0;
assert.equal((await context.invoke('/api/admin/service-documents')).documents.length,0);assert.equal(calls,2);
replies=[response(200,'<html>invalid JSON</html>')];calls=0;
await assert.rejects(context.invoke('/api/admin/service-documents'),/έγκυρα δεδομένα/);assert.equal(state.invoiceDocuments[0].id,'already-loaded');
replies=[response(401,{error:'Session expired'})];calls=0;
await assert.rejects(context.invoke('/api/admin/service-documents'),e=>e.status===401);assert.equal(calls,1);assert.equal(cleared,1);
const fleet=fs.readFileSync('cloudflare-worker/public/app.js','utf8');
const helper=fleet.slice(fleet.indexOf('  async function fetchReadWithRetry('),fleet.indexOf('  async function syncNow('));
vm.runInContext(helper+'\nglobalThis.readFleet=fetchReadWithRetry;',context);
replies=[response(503,'gateway'),response(200,{bikes:[{id:'bike-1'}]})];calls=0;
assert.equal((await (await context.readFleet('/api/sync',{method:'GET'})).json()).bikes.length,1);assert.equal(calls,2);
replies=[response(503,'gateway')];calls=0;
assert.equal((await context.readFleet('/api/sync',{method:'POST',body:'{}'})).status,503);assert.equal(calls,1);
console.log('OK actual Portal/Fleet functions: bounded read retries, explicit gateway/invalid JSON errors, session retention, no automatic mutation replay.');
// Exercise the actual dirty tracking and sync function, including an edit made
// while an earlier upload is awaiting confirmation.
const values=new Map();
const storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
const bike1={id:'one',currentKm:10,history:[]},bike2={id:'two',currentKm:20,history:[]};
let seen=[];let editDuringUpload=false;let failPost=false;
const syncContext={bikes:[bike1,bike2],dirtyBikeIds:new Set(),pendingFleetChange:false,syncRunning:false,syncQueued:false,cloudSnapshotVersion:null,
 webToken:'fixture-token',apiBase:'https://fixture.invalid',navigator:{onLine:true},activeBikeId:null,localStorage:storage,
 STORAGE_KEY:'bikes',DIRTY_KEY:'dirty',DIRTY_BIKE_KEY:'dirty-ids',setSyncState(){},scheduleSync(){},renderHome(){},renderDetail(){},
 requestHeaders(){return {'Authorization':'Bearer fixture-token','Content-Type':'application/json'};},
 mergeFleets(local){return local;},setTimeout(fn){fn();},
 async fetch(url,options){
  seen.push({url,method:options.method,body:options.body});
  if(options.method==='POST'){
   if(failPost)return response(503,{error:'gateway'});
   if(editDuringUpload){syncContext.bikes[0].currentKm=12;vm.runInContext('saveBikes();',syncContext);editDuringUpload=false;}
   return response(200,{saved:true,bike:JSON.parse(options.body).bike});
  }
  return response(200,{bikes:syncContext.bikes,archivedBikeIds:[]});
 }};
vm.createContext(syncContext);
const save=fleet.slice(fleet.indexOf('  function persistBikes('),fleet.indexOf('  function mergeBikeRecords('));
const sync=fleet.slice(fleet.indexOf('  async function fetchReadWithRetry('),fleet.indexOf('  function scheduleSync('));
vm.runInContext(save+sync,syncContext);
storage.setItem('bikes',JSON.stringify(syncContext.bikes));syncContext.bikes[0].currentKm=11;
vm.runInContext('saveBikes();',syncContext);assert.deepEqual([...syncContext.dirtyBikeIds],['one']);
editDuringUpload=true;await vm.runInContext('syncNow()',syncContext);
assert.equal(seen.filter(r=>r.method==='POST').length,1);assert.equal(JSON.parse(seen[0].body).bike.id,'one');
assert.equal(syncContext.pendingFleetChange,true);assert.equal(syncContext.dirtyBikeIds.has('one'),true,'new edit lost during upload');
seen=[];await vm.runInContext('syncNow()',syncContext);assert.equal(syncContext.pendingFleetChange,false);assert.equal(seen.filter(r=>r.method==='POST').length,1);
syncContext.bikes[1].currentKm=21;vm.runInContext('saveBikes();',syncContext);seen=[];failPost=true;
await vm.runInContext('syncNow()',syncContext);assert.equal(seen.length,1);assert.equal(syncContext.dirtyBikeIds.has('two'),true);assert.ok(values.get('dirty-ids').includes('two'));
console.log('OK actual Client sync: only changed bikes uploaded, edits during a request remain pending, 503 retains durable dirty IDs.');

// Unchanged replies preserve both loaded rows and pending edits.
failPost=false;syncContext.dirtyBikeIds.clear();syncContext.pendingFleetChange=false;
syncContext.cloudSnapshotVersion=42;const existingRows=syncContext.bikes;
syncContext.fetch=async(url,opts)=>{assert.match(url,/sinceVersion=42/);return response(200,{unchanged:true,version:42});};
await vm.runInContext('syncNow()',syncContext);assert.equal(syncContext.bikes,existingRows);
console.log('OK actual Client conditional read preserves loaded fleet.');
