import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {gzipSync} from 'node:zlib';
import '../cloudflare-worker/public/service-model.js';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{JSDOM}=require('jsdom');
const app=fs.readFileSync('cloudflare-worker/public/app.js','utf8'),portal=fs.readFileSync('cloudflare-worker/public/portal.js','utf8');
const direct='https://fleet-control.duckdns.org';
{
  const dom=new JSDOM(fs.readFileSync('cloudflare-worker/public/index.html','utf8'),{url:direct+'/fleet.html',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
  const user={id:'owner-fixture',role:'owner',permissions:['*']};
  w.localStorage.setItem('fleet-control-auth-token','fixture');w.localStorage.setItem('fleet-control-user-cache',JSON.stringify(user));
  w.localStorage.setItem('safe-draft-sentinel','keep');
  w.scrollTo=()=>{};w.matchMedia=()=>({matches:false,addEventListener(){},addListener(){}});w.setInterval=()=>0;w.setTimeout=()=>0;w.requestAnimationFrame=()=>0;
  w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.FLEET_CONFIG={independent:true,apiBase:direct};
  const remote=Array.from({length:29},(_,i)=>({id:'large-bike-'+i,name:'Fixture '+i,intervalKm:3000,currentKm:12000,lastServiceKm:10000,history:Array.from({length:2},(_,j)=>({id:'entry-'+j,type:'service',date:'2026-11-10',km:10000,oilChanged:true,tasks:['Fixture service'],invoiceData:{rawText:'Ω'.repeat(110000),totalAmount:'10,00'}}))}));
  assert(JSON.stringify(remote).length>5_000_000,'historical fixture exceeds the real DOM storage quota');
  w.fetch=async(url)=>Response.json(new URL(url,direct).pathname==='/api/auth/me'?{user}:new URL(url,direct).pathname==='/api/sync'?{bikes:remote,version:123,archivedBikeIds:[]}:{bikes:[]});
  for(const file of ['service-model.js','fleet-operations-model.js','service-tools.js','service-export.js'])w.eval(fs.readFileSync('cloudflare-worker/public/'+file,'utf8'));
  w.eval(app.replace(/\}\(\)\);\s*$/,'window.__fleetReadFixture={syncNow};}());'));
  for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(w.document.getElementById('bikeCount').textContent,'29','large verified server history displays even when its browser read cache cannot fit');
  assert.equal(w.document.querySelectorAll('.bike-card').length,29);
  assert.equal(w.localStorage.getItem('moto-service-tracker-v1'),'[]','cache failure neither truncates the history nor invents a saved copy');
  assert.equal(w.localStorage.getItem('safe-draft-sentinel'),'keep');assert.equal(w.localStorage.getItem('fleet-control-auth-token'),'fixture');
  assert.equal(w.document.getElementById('fleetLoadNotice').hidden,true);w.close();
}
{
  const urls=[],states=[],notices=[];let failMerge=true;
  const remote=Array.from({length:29},(_,i)=>({id:'bike-'+i,name:'Fixture '+i,history:[]}));
  const context={navigator:{onLine:true},syncRunning:false,syncQueued:false,fleetLoaded:false,webToken:'fixture',pendingFleetChange:false,
    cloudSnapshotVersion:null,bikes:[],apiBase:direct,activeBikeId:null,
    window:{},setTimeout,Set,localStorage:{},sessionStorage:{},
    setSyncState:(state)=>states.push(state),fleetLoading:(message,failed)=>notices.push({message,failed}),
    fetchReadWithRetry:async url=>{urls.push(url);return Response.json({version:123,bikes:remote});},
    mergeFleets:(local,value)=>{if(failMerge)throw Error('Synthetic historical record failure');return value;},
    persistBikes:()=>{},persistDirtyBikes:()=>{},renderHome:()=>{}};
  vm.createContext(context);
  vm.runInContext(app.slice(app.indexOf('  async function syncNow('),app.indexOf('  function scheduleSync('))+'\nglobalThis.sync=syncNow;',context);
  await context.sync();assert.equal(context.cloudSnapshotVersion,null,'a failed merge cannot acknowledge a server revision');
  assert.equal(context.fleetLoaded,false);assert.equal(notices.at(-1).failed,true);
  failMerge=false;await context.sync();assert.equal(urls[1],direct+'/api/sync','retry asks for the complete fleet instead of accepting unchanged');
  assert.equal(context.bikes.length,29);assert.equal(context.cloudSnapshotVersion,123);assert.equal(context.fleetLoaded,true);
  context.fleetLoaded=false;context.cloudSnapshotVersion=null;context.bikes=[];
  context.fetchReadWithRetry=async()=>Response.json({version:124,bikes:[{id:'incomplete'}]});
  await context.sync();assert.equal(context.fleetLoaded,false);assert.equal(context.cloudSnapshotVersion,null,'invalid identities cannot become a successful zero');
  assert.match(notices.at(-1).message,/ελλιπή/);
}
{
  let scheduled=0,opened=0;
  const context={window:{FLEET_CONFIG:{independent:true},requestIdleCallback:()=>{scheduled++;return 1;}},fleetPreloadTimer:null,$:()=>({}),can:()=>true,state:{user:{role:'owner'}},ensureFleetModule:()=>{opened++;}};
  vm.createContext(context);
  vm.runInContext(portal.slice(portal.indexOf('  function scheduleFleetPreload('),portal.indexOf('  let fleetHostScroll'))+'\nglobalThis.preload=scheduleFleetPreload;',context);
  context.preload();assert.equal(scheduled,0,'Direct does not start hidden private Fleet reads while another screen loads');assert.equal(opened,0);
  context.window.FLEET_CONFIG.independent=false;context.preload();assert.equal(scheduled,1,'the dormant non-Direct policy retains its behavior');
}
{
  const context={window:{FLEET_CONFIG:{independent:true,apiBase:direct}},location:{origin:direct},SERVER_URL_KEY:'server-url',loadSetting:()=> 'https://old-cloud.invalid'};
  vm.createContext(context);
  vm.runInContext(app.slice(app.indexOf('  const config ='),app.indexOf('  const isAndroidApp =')),context);
  assert.equal(vm.runInContext('apiBase',context),direct,'Direct Fleet ignores an old saved Cloud endpoint before sending any account token');
}
{
  const dom=new JSDOM(fs.readFileSync('cloudflare-worker/public/index.html','utf8'));
  const document=dom.window.document,ids=['homeView','bikeCount','healthyCount','attentionCount','overdueCount','emptyState'];
  let retries=0;
  const context={document,elements:Object.fromEntries(ids.map(id=>[id,document.getElementById(id)])),fleetLoaded:false,bikes:[],syncNow:()=>{retries++;}};
  vm.createContext(context);
  vm.runInContext(app.slice(app.indexOf('  function fleetLoading('),app.indexOf('  function renderAccessState('))+'\nglobalThis.show=fleetLoading;',context);
  context.show('Φορτώνονται τα μηχανάκια…',false);
  assert.equal(document.getElementById('bikeCount').textContent,'—','no false zero before the first successful read');
  assert(document.getElementById('emptyState').classList.contains('is-hidden'));
  context.show('Failure <script>unsafe()</script>',true);
  const notice=document.getElementById('fleetLoadNotice');assert.equal(notice.querySelector('script'),null);assert.equal(notice.hidden,false);
  notice.querySelector('button').click();assert.equal(retries,1,'visible retry invokes the real sync action');
  context.fleetLoaded=true;context.bikes=[{id:'retained'}];document.getElementById('bikeCount').textContent='27';
  context.show('Temporary failure',true);assert.equal(document.getElementById('bikeCount').textContent,'27','a failed refresh preserves the loaded count');
  context.show('',false);assert.equal(notice.hidden,true);dom.window.close();
}
{
  const dom=new JSDOM('<section><div id="invoiceQueueList"></div></section>');
  const document=dom.window.document,old=[{id:'previous'}],state={token:'fixture',view:'invoices',invoiceDocuments:old};
  let calls=0,complete,rendered=0;
  const documents=n=>Array.from({length:n},(_,i)=>({id:'file-'+i,serviceDate:'2026-11-10'}));
  const context={state,document,$:id=>document.getElementById(id),window:{FleetServiceModel:globalThis.FleetServiceModel},renderInvoiceQueue:()=>{rendered++;},
    api:async()=>{calls++;if(calls===1)return {documents:documents(32),serverVersion:5,hasMore:true,nextCursor:'5:32'};return new Promise(resolve=>{complete=()=>resolve({documents:documents(57).slice(32),serverVersion:5,hasMore:false});});}};
  vm.createContext(context);
  vm.runInContext(portal.slice(portal.indexOf('  function applyInvoiceDocuments('),portal.indexOf('  function hasLiveInvoiceJobs('))+'\nglobalThis.load=loadInvoices;',context);
  const first=context.load(),second=context.load();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,2,'concurrent refreshes share one list traversal');
  assert.equal(state.invoiceDocuments,old,'previous complete list is retained until the new one is complete');
  assert.match(document.getElementById('invoiceLoadProgress').textContent,/32/);
  complete();await Promise.all([first,second]);assert.equal(state.invoiceDocuments.length,57);assert.equal(rendered,1);
  assert.equal(document.getElementById('invoiceLoadProgress').hidden,true);dom.window.close();
}
{
  let active=true,calls=0;
  await assert.rejects(globalThis.FleetServiceModel.loadInvoiceDocuments(async()=>{calls++;active=false;return {documents:[{id:'one'}],serverVersion:1,hasMore:true,nextCursor:'1:1'};},{active:()=>active}),{name:'AbortError'});
  assert.equal(calls,1,'leaving Invoices stops additional page requests');
}
{
  const dom=new JSDOM('<main id="portal"><div class="main-shell"><section data-view="dashboard"></section><section data-view="server" class="is-hidden"></section></div></main>',{url:direct+'/',runScripts:'outside-only'}),w=dom.window;
  let requests=[];Object.assign(w,{Headers,Response,setInterval:()=>0,FleetBackend:{directOnly:true},fetch:async(path)=>{requests.push(path);return Response.json({instanceId:'fixture',mode:'primary'});}});
  w.eval(fs.readFileSync('independent-web/owner.js','utf8'));
  assert.equal(requests.length,0,'no duplicate auth request from the diagnostic UI');
  assert.equal(w.document.getElementById('fleetPrimaryStatus').closest('section').dataset.view,'server','technical status lives on the Server screen');
  w.dispatchEvent(new w.CustomEvent('fleet-independent-auth',{detail:{id:'owner',role:'owner'}}));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(requests,['/api/independent/status']);w.close();
}
const bytes=fs.readFileSync('cloudflare-worker/public/portal.js'),compressed=gzipSync(bytes);
assert(compressed.length<bytes.length/2);
console.log('PASS actual Direct Web functions: same-origin Fleet, unknown/loading/error/retry states, preserved loaded rows, complete coalesced invoice traversal, cancellation on leaving and diagnostic controls off the main screens. '+JSON.stringify({portalJsBytes:bytes.length,gzipBytes:compressed.length,savedPercent:Math.round(100*(1-compressed.length/bytes.length)),networkSpeedClaim:false}));
