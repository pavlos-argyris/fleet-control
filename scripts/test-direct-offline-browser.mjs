import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import {execFileSync} from 'node:child_process';import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{chromium}=require('playwright');
const out=path.resolve('.build/direct-offline-browser');fs.mkdirSync(out,{recursive:true});
execFileSync('python3',['scripts/prepare-unified-direct.py',path.join(out,'src'),path.join(out,'assets')],{stdio:'inherit'});
const www=path.join(out,'assets/independent-www');let writes=0;
const server=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://fixture');
  if(url.pathname.startsWith('/api/')){if(req.method==='POST')writes++;res.writeHead(url.pathname==='/api/fixture'?200:401,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(url.pathname==='/api/fixture'?{synthetic:true}:{error:'Synthetic unauthenticated fixture'}));return;}
  if(url.pathname==='/fleet-mode.json'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"synthetic":true}');return;}
  let name=url.pathname==='/'||url.pathname==='/index.html'?'portal.html':url.pathname==='/fleet.html'?'index.html':url.pathname.slice(1);
  const file=path.resolve(www,name);if(!file.startsWith(www+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
  const ext=path.extname(file),type={'.js':'application/javascript','.mjs':'application/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'}[ext]||'application/octet-stream';
  res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});fs.createReadStream(file).pipe(res);
}catch{res.writeHead(500).end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.FLEET_CHROMIUM||undefined,args:['--no-sandbox']});
try{
  const context=await browser.newContext({viewport:{width:390,height:900},locale:'el-GR'});
  await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  const page=await context.newPage();await page.goto(base+'/portal.html?fleetSetup=1');
  assert(await page.locator('a[href$="direct.html"]').isHidden(),'Direct login has no legacy alternative Server/pairing option');
  await page.evaluate(async()=>{await navigator.serviceWorker.register('/service-worker.js');await navigator.serviceWorker.ready;});
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await page.evaluate(async()=>{await fetch('/api/fixture');await fetch('/api/fixture',{method:'POST',body:'{}'});await fetch('/fleet-mode.json');});
  const cached=await page.evaluate(async()=>{const urls=[];for(const key of await caches.keys())for(const request of await(await caches.open(key)).keys())urls.push(new URL(request.url).pathname);return urls;});
  assert(cached.includes('/portal.html')&&cached.includes('/fleet.html')&&cached.some(x=>x.endsWith('/backend-mode.js')),'actual generated shell precaches both views and recovery module');
  assert(!cached.some(x=>x.startsWith('/api/')||x.startsWith('/download/')||x==='/fleet-mode.json'),'no private API/mode/APK cache');assert.equal(writes,1);
  await context.setOffline(true);await page.reload();await page.getByRole('button',{name:'Επανάληψη σύνδεσης',exact:true}).waitFor();
  const offline=await page.evaluate(async()=>{const result=[];for(const [url,method]of [['/api/fixture','GET'],['/api/fixture','POST'],['/fleet-mode.json','GET']])try{const response=await fetch(url,{method,...(method==='POST'?{body:'{}'}:{})});result.push({status:response.status,code:(await response.json()).code});}catch{result.push({networkFailed:true});}return result;});
  // The shipped Direct transport converts API network failures into explicit
  // 503 errors so existing forms retain their drafts. Discovery stays raw.
  assert.deepEqual(offline,[{status:503,code:'independent_unavailable'},{status:503,code:'independent_unavailable'},{networkFailed:true}],'offline API calls return explicit unconfirmed errors, never cached success');
  await page.evaluate(()=>FleetBackend.apply({...FleetBackend.selection,activeMode:'direct',selectedMode:'direct',revision:5},{navigate:false}));
  await page.getByRole('button',{name:'Επανάληψη σύνδεσης',exact:true}).click();
  await page.waitForFunction(()=>window.FleetBackend?.selection.activeMode==='direct'&&!FleetBackend.selection.localRecovery);
  assert.equal(await page.getByRole('button',{name:'Ανάκτηση Cloudflare',exact:true}).count(),0,'Cloud recovery is inactive in the shipped policy');
  await page.locator('#bootScreen').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Επανάληψη σύνδεσης',exact:true}).click({trial:true});
  assert.equal(writes,1,'offline mutation was not replayed');
  await page.screenshot({path:path.join(out,'offline-recovery-390.png'),fullPage:true});
  await context.setOffline(false);await page.reload();assert.equal(writes,1,'reconnection never replays the failed POST');await context.close();
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
console.log('PASS actual Chromium generated Direct static shell: first visit/cache, offline reload/recovery, both views, no API/mode/APK cache and no POST replay on reconnection. Loopback secure-context fixture only; HTTPS/auth/physical WAN proof are separate gates.');
