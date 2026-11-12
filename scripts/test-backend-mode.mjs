import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{JSDOM}=require('jsdom');
const CLOUD='https://fleet-control.pavlosargyris.workers.dev',DIRECT='https://fleet-control.duckdns.org';
const source=fs.readFileSync('cloudflare-worker/public/backend-mode.js','utf8');
const descriptor=(mode,revision)=>({schema:1,revision,selectedMode:mode,activeMode:mode,cloudUrl:CLOUD,directUrl:DIRECT,updatedAt:Date.now()});
function fixture({mode='cloudflare',revision=0,url=CLOUD+'/',outage=503,fresh=false}={}){
  const dom=new JSDOM('<!doctype html><html><body><main>Fleet</main></body></html>',{url,runScripts:'outside-only'}),w=dom.window,calls=[],navigation=[];
  Object.assign(w,{Headers,Response,AbortController,Request:class extends Request{constructor(input,init){super(typeof input==='string'?new URL(input,w.location.href):input,init);}}});
  let saved=JSON.stringify(descriptor(mode,revision)),current=descriptor(mode,revision),pending=null;
  w.AndroidFleet={getBackendSelection:()=>fresh?'':saved,setBackendSelection:value=>{saved=value;},openBackend:value=>navigation.push(value)};
  w.localStorage.setItem('fleet-control-auth-token','cloud-session-only');
  w.fetch=async(input,init)=>{const request=new Request(input,init);calls.push(request);const parsed=new URL(request.url);if(parsed.pathname==='/fleet-mode.json')return Response.json(current);if(parsed.pathname==='/api/deferred')return new Promise(resolve=>{pending=()=>resolve(Response.json({saved:true}));});if(parsed.origin===CLOUD){if(outage==='timeout')throw new TypeError('synthetic timeout');return Response.json({error:'quota exceeded'},{status:outage});}return Response.json({saved:true});};
  w.eval(source);
  return {w,dom,calls,navigation,get saved(){return JSON.parse(saved);},set current(v){current=v;},finish:()=>pending?.(),close:()=>dom.window.close()};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
for(const outage of [500,429,503,'timeout']){
  const f=fixture({outage});try{
    await tick();f.current=descriptor('direct',1);await f.w.FleetBackend.discover();
    assert.equal(f.saved.activeMode,'direct');assert.equal(f.navigation.at(-1),'direct');
    assert(f.calls.every(r=>new URL(r.url).origin===DIRECT),'mode selection needs zero successful or attempted Cloudflare requests');
    const restarted=fixture({mode:'direct',revision:1,url:DIRECT+'/',outage});try{
      await tick();restarted.w.FleetBackend.recoverCloud();assert.equal(restarted.saved.activeMode,'cloudflare');assert.equal(restarted.saved.localRecovery,true);assert.equal(restarted.navigation.at(-1),'cloudflare');
      assert(restarted.calls.every(r=>new URL(r.url).origin===DIRECT),'manual recovery is local even with both business backends unavailable');
      await restarted.w.FleetBackend.discover();assert.equal(restarted.saved.localRecovery,true,'old discovery cannot silently undo a manual recovery');
    }finally{restarted.close();}
  }finally{f.close();}
}
{
  const f=fixture();try{await tick();const pending=f.w.fetch(CLOUD+'/api/deferred',{method:'POST',headers:{Authorization:'Bearer cloud-session-only'},body:'{"amount":600}'}).then(()=>false,()=>true);f.w.FleetBackend.apply(descriptor('direct',1),{navigate:false});f.finish();assert.equal(await pending,true,'old response rejected after mode change');assert.equal(f.calls.filter(r=>new URL(r.url).origin===DIRECT&&new URL(r.url).pathname!=='/fleet-mode.json').length,0,'old financial operation never replayed at the other backend');}finally{f.close();}
}
{
  const f=fixture({mode:'direct',revision:9,url:DIRECT+'/'});try{await tick();await f.w.fetch(DIRECT+'/api/status');assert.equal(f.calls.at(-1).headers.get('X-Fleet-Backend-Revision'),'9');assert.equal(f.w.FleetBackend.apply(descriptor('cloudflare',8),{navigate:false}),false,'reject stale control revision');assert.throws(()=>f.w.FleetBackend.apply({...descriptor('direct',10),directUrl:'https://attacker.invalid'}));}finally{f.close();}
}
{
  const f=fixture({url:DIRECT+'/?fleetSetup=1'});try{await tick();assert.equal(f.navigation.length,0,'owner can perform the external preflight before Direct activation');}finally{f.close();}
}
console.log('PASS actual browser mode module: Cloudflare 500/429/503/timeouts, persistent routing/restart, local recovery, stale revisions, fixed origins, abort/fence, zero cross-mode financial replay and preflight access.');

{const f=fixture({fresh:true,url:DIRECT+'/'});try{await tick();assert.equal(f.navigation.at(-1),'cloudflare','fresh explicit Direct origin obtains the server selection rather than borrowing another origin storage');assert(f.calls.every(r=>new URL(r.url).origin===DIRECT));}finally{f.close();}}
