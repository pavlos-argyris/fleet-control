import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{chromium}=require('playwright');
const publicRoot=path.resolve('cloudflare-worker/public'),output=path.resolve('verification/navigation-motion');fs.mkdirSync(output,{recursive:true});
const user={id:'motion-owner',fullName:'Δοκιμαστικός Owner',username:'owner',role:'owner',permissions:['*']};
const bikes=Array.from({length:35},(_,i)=>({id:'bike-'+i,name:'ΜΗΧ '+String(i).padStart(3,'0'),intervalKm:3000,lastServiceKm:1000,currentKm:1200,lastCheckedAt:'2026-10-18',createdAt:'2026-10-01',updatedAt:'2026-10-01',history:i===15?Array.from({length:15},(_,j)=>({id:'service-'+j,type:'service',date:'2026-09-01',km:1000-j,tasks:['Αλλαγή λαδιών'],notes:'Έλεγχος',oilChanged:true,createdAt:'2026-09-01'})):[]}));
const empty={user,configured:true,bikes,version:1,snapshotVersion:1,serverOnline:true,databaseOk:true,storageOk:true,employees:[],vehicles:[],rules:[],shifts:[],alerts:[],documents:[],days:[],summary:{},today:{vehicles:{}},currentWeek:{payableHours:0,payrollCents:0,kilometers:0,startDate:'2026-10-12',endDate:'2026-10-18'},realtime:[],dailySchedule:[],actionCount:0};
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const report=[];
try{
 for(const mode of ['standalone','embedded','reduced']){
  const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:mode==='reduced'?'reduce':'no-preference',serviceWorkers:'block'}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await context.addInitScript(({user,bikes})=>{
   localStorage.setItem('fleet-control-auth-token','fixture');localStorage.setItem('fleet-control-user-cache',JSON.stringify(user));localStorage.setItem('moto-service-tracker-v1',JSON.stringify(bikes));
   window.__motionReady=0;window.__freezeNext=false;window.__motionFrozen=false;
   const start=document.startViewTransition?.bind(document);
   if(start)document.startViewTransition=function(update){const t=start(update);t.ready.then(()=>requestAnimationFrame(()=>{window.__motionReady++;if(window.__freezeNext){window.__freezeNext=false;for(const a of document.getAnimations()){a.pause();a.currentTime=110;}window.__motionFrozen=true;}})).catch(()=>{});return t;};
  },{user,bikes});
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname.startsWith('/api/'))return route.fulfill({status:url.pathname==='/api/events/ticket'?503:200,json:empty});
   const relative=decodeURIComponent(url.pathname==='/'?'/portal.html':url.pathname),full=path.resolve(publicRoot,'.'+relative);
   if(!full.startsWith(publicRoot+path.sep)||!fs.existsSync(full)||!fs.statSync(full).isFile())return route.fulfill({status:404,body:'Not found'});
   const contentType=({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'})[path.extname(full)]||'application/octet-stream';
   return route.fulfill({status:200,path:full,contentType});
  });
  const embedded=mode==='embedded';
  await page.goto('https://fixture.invalid/'+(embedded?'portal.html':'index.html'));
  if(embedded)await page.locator('#bottomNav [data-go="fleet"]').click();
  const fleet=embedded?page.frameLocator('#fleetModuleFrame'):page;
  await fleet.locator('#bikeList [data-bike-id="bike-15"]').waitFor();
  const card=fleet.locator('#bikeList [data-bike-id="bike-15"]');await card.scrollIntoViewIfNeeded();
  await card.evaluate(node=>node.scrollIntoView({block:'center'}));
  const before=await card.boundingBox();assert.ok(before&&before.y>0);
  if(mode!=='reduced')await page.evaluate(()=>{window.__freezeNext=true;window.__motionFrozen=false;});
  await card.click();
  if(mode!=='reduced'){
   await page.waitForFunction(()=>window.__motionFrozen===true);
   assert.equal(await page.evaluate(()=>document.documentElement.dataset.fleetCardMotion),'open');
   const keyframes=await page.evaluate(()=>document.getAnimations().flatMap(a=>a.effect?.getKeyframes()||[]));assert.ok(keyframes.some(k=>String(k.clipPath||'').includes('inset(')),'Real browser uses the card-shaped reveal');
   assert.deepEqual(await page.evaluate(()=>['::view-transition-old(root)','::view-transition-new(root)'].map(p=>getComputedStyle(document.documentElement,p).opacity)),['1','1'],'No fading during the card transition');
   await page.screenshot({path:path.join(output,mode+'-opening.png')});
   await page.evaluate(()=>document.getAnimations().forEach(a=>a.play()));
   await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-fleet-card-motion'));
  }
  await fleet.locator('#detailName').waitFor();assert.equal(await fleet.locator('#detailName').textContent(),'ΜΗΧ 015');
  if(embedded)assert.equal(await page.locator('#portal').evaluate(node=>node.classList.contains('fleet-detail-mode')),true);
  await page.screenshot({path:path.join(output,mode+'-detail.png')});
  // Explicit Back and browser/Android history share the actual popstate handler.
  await fleet.locator('#detailBackButton').click();
  await fleet.locator('#homeView:not(.is-hidden)').waitFor();
  await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-fleet-card-motion'));
  await page.waitForTimeout(80);
  const after=await card.boundingBox();assert.ok(Math.abs(before.y-after.y)<3,`${mode}: restore ${before.y} -> ${after.y}`);
  await page.screenshot({path:path.join(output,mode+'-restored.png')});
  await card.click();await fleet.locator('#detailView:not(.is-hidden)').waitFor();await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-fleet-card-motion'));
  await page.evaluate(()=>history.back());await fleet.locator('#homeView:not(.is-hidden)').waitFor();await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-fleet-card-motion'));await page.waitForTimeout(80);
  assert.ok(Math.abs(before.y-(await card.boundingBox()).y)<3,mode+': browser Back preserves the anchor');
  if(embedded){
   const nav=page.locator('#bottomNav'),box=await nav.boundingBox();
   await page.locator('#bottomNav [data-go="shifts"]').click();
   const motions=await page.locator('#viewShifts').evaluate(node=>node.getAnimations().map(a=>({frames:a.effect.getKeyframes(),duration:a.effect.getTiming().duration})));assert.ok(motions.some(a=>a.duration===190&&a.frames.some(k=>k.transform.includes('22px'))),'Bottom navigation animates the content');
   assert.ok(Math.abs((await nav.boundingBox()).y-box.y)<1,'Bottom bar stays fixed');
   await page.screenshot({path:path.join(output,'bottom-navigation.png')});
   await page.evaluate(()=>{for(const target of ['employees','dashboard','shifts','employees'])document.querySelector('#bottomNav [data-go="'+target+'"]').click();});
   await page.locator('#viewEmployees:not(.is-hidden)').waitFor();assert.equal(await page.locator('#bottomNav .active').getAttribute('data-go'),'employees');
  }
  assert.deepEqual(errors,[],mode+': no unhandled browser errors');report.push({mode,anchorRestored:true,realCardAnimation:mode!=='reduced',errors});await context.close();
 }
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');console.log('OK real Chromium: card expansion/reverse without fading, exact Back/Android-history scroll in standalone and embedded Portal, reduced motion, fixed bottom navigation and rapid tab changes.');
}finally{await browser.close();}
