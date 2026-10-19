import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{chromium}=require('playwright');
const publicRoot=path.resolve('cloudflare-worker/public'),output=path.resolve('verification/navigation-motion');fs.mkdirSync(output,{recursive:true});
const user={id:'motion-owner',fullName:'Δοκιμαστικός Owner',username:'owner',role:'owner',permissions:['*']};
const bikes=Array.from({length:35},(_,i)=>({id:'bike-'+i,name:'ΜΗΧ '+String(i).padStart(3,'0'),intervalKm:3000,lastServiceKm:1000,currentKm:1200,lastCheckedAt:'2026-10-18',createdAt:'2026-10-01',updatedAt:'2026-10-01',history:i===15?Array.from({length:15},(_,j)=>({id:'service-'+j,type:'service',date:'2026-09-01',km:1000-j,tasks:['Αλλαγή λαδιών'],notes:'Έλεγχος',oilChanged:true,createdAt:'2026-09-01'})):[]}));
const empty={user,configured:true,bikes,version:1,snapshotVersion:1,serverOnline:true,databaseOk:true,storageOk:true,employees:[],vehicles:[],rules:[],shifts:[],alerts:[],documents:[],days:[],summary:{},today:{vehicles:{}},currentWeek:{payableHours:0,payrollCents:0,kilometers:0,startDate:'2026-10-12',endDate:'2026-10-18'},realtime:[],dailySchedule:[],actionCount:0};
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--allow-file-access-from-files']});
const report=[];
try{
 for(const mode of ['standalone','embedded','client','reduced']){
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:mode==='reduced'?'reduce':'no-preference',serviceWorkers:'block'}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await context.addInitScript(({user,bikes})=>{
   localStorage.setItem('fleet-control-auth-token','fixture');localStorage.setItem('fleet-control-user-cache',JSON.stringify(user));localStorage.setItem('moto-service-tracker-v1',JSON.stringify(bikes));
   window.__captures=0;window.__freezeBikeNext=false;window.__bikeFrozen=false;
   const animate=Element.prototype.animate;
   Element.prototype.animate=function(...args){
    const animation=animate.apply(this,args);
    if(this.matches('#detailView,#homeView,#fleetModuleFrame')&&window.__freezeBikeNext){
     window.__freezeBikeNext=false;
     animation.ready.then(()=>{animation.pause();animation.currentTime=95;window.__bikeFrozen=true;});
    }
    return animation;
   };
   const start=document.startViewTransition?.bind(document);
   if(start)document.startViewTransition=function(update){window.__captures++;return start(update);};
  },{user,bikes});
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.protocol==='file:')return route.continue();
   if(url.pathname.startsWith('/api/')){
    const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
    if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers});
    return route.fulfill({status:url.pathname==='/api/events/ticket'?503:200,json:empty,headers});
   }
   const relative=decodeURIComponent(url.pathname==='/'?'/portal.html':url.pathname),full=path.resolve(publicRoot,'.'+relative);
   if(!full.startsWith(publicRoot+path.sep)||!fs.existsSync(full)||!fs.statSync(full).isFile())return route.fulfill({status:404,body:'Not found'});
   const contentType=({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'})[path.extname(full)]||'application/octet-stream';
   return route.fulfill({status:200,path:full,contentType});
  });
  const embedded=mode==='embedded'||mode==='client';
  await page.goto(mode==='client'?'file://'+path.resolve('client-android/assets/www/portal.html'):'https://fixture.invalid/'+(embedded?'portal.html':'index.html'));
  if(embedded)await page.locator('#bottomNav [data-go="fleet"]').click();
  const fleet=embedded?page.frameLocator('#fleetModuleFrame'):page;
  await fleet.locator('#bikeList [data-bike-id="bike-15"]').waitFor();
  const card=fleet.locator('#bikeList [data-bike-id="bike-15"]');await card.scrollIntoViewIfNeeded();
  await card.evaluate(node=>node.scrollIntoView({block:'center'}));
  const before=await card.boundingBox();assert.ok(before&&before.y>0);
  await card.evaluate(node=>{window.__priorCard=node;window.__listMutations=0;new MutationObserver(records=>{window.__listMutations+=records.length;}).observe(node.parentElement,{childList:true});});
  const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');
  let closingLayouts=null;
  const slideTarget=embedded?page.locator('#fleetModuleFrame'):fleet.locator('#detailView');
  if(mode!=='reduced')await page.evaluate(()=>{window.__freezeBikeNext=true;window.__bikeFrozen=false;});
  await card.click();
  if(mode!=='reduced'){
   await page.waitForFunction(()=>window.__bikeFrozen);
   assert.equal(await slideTarget.getAttribute('data-fleet-bike-slide'),'open');
   const motion=await slideTarget.evaluate(node=>node.getAnimations().map(a=>({frames:a.effect.getKeyframes(),timing:a.effect.getTiming()})));
   assert.ok(motion.some(a=>a.timing.duration===190&&a.timing.easing==='cubic-bezier(0.2, 0.7, 0.2, 1)'&&a.frames[0].transform.includes('22px')),'Opening uses the same 22px/190ms easing as bottom tabs');
   assert.equal(await page.evaluate(()=>window.__captures),0);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Bike slide does not add horizontal scrolling');
   await page.screenshot({path:path.join(output,mode+'-opening.png')});
   await slideTarget.evaluate(node=>node.getAnimations().forEach(a=>a.play()));
  }
  await page.waitForFunction(()=>!document.querySelector('[data-fleet-bike-slide]'));
  await fleet.locator('#detailName').waitFor();assert.equal(await fleet.locator('#detailName').textContent(),'ΜΗΧ 015');
  if(embedded)assert.equal(await page.locator('#portal').evaluate(node=>node.classList.contains('fleet-detail-mode')),true);
  await page.screenshot({path:path.join(output,mode+'-detail.png')});
  if(mode!=='reduced')await page.evaluate(()=>{window.__freezeBikeNext=true;window.__bikeFrozen=false;});
  await fleet.locator('#detailBackButton').click();
  await fleet.locator('#homeView:not(.is-hidden)').waitFor();
  const returnTarget=embedded?page.locator('#fleetModuleFrame'):fleet.locator('#homeView');
  if(mode!=='reduced'){
   await page.waitForFunction(()=>window.__bikeFrozen);
   assert.equal(await returnTarget.getAttribute('data-fleet-bike-slide'),'close');
   const motion=await returnTarget.evaluate(node=>node.getAnimations().map(a=>({frames:a.effect.getKeyframes(),timing:a.effect.getTiming()})));
   assert.ok(motion.some(a=>a.timing.duration===190&&a.frames[0].transform.includes('-22px')),'Back slides in the opposite direction');
   assert.ok(motion.every(a=>a.frames.every(f=>!['clipPath','width','height','left','top','opacity'].some(k=>k in f))),'No resize, clipping or fade');
   assert.equal(await page.evaluate(()=>window.__captures),0);
   assert.equal(await page.locator('.fleet-bike-return-surface,[data-fleet-plate-proxy]').count(),0);
   await page.screenshot({path:path.join(output,mode+'-closing.png')});
   const baseline=(await cdp.send('Performance.getMetrics')).metrics.find(m=>m.name==='LayoutCount').value;
   await returnTarget.evaluate(node=>node.getAnimations().forEach(a=>a.play()));
   await page.waitForFunction(()=>!document.querySelector('[data-fleet-bike-slide]'));
   closingLayouts=(await cdp.send('Performance.getMetrics')).metrics.find(m=>m.name==='LayoutCount').value-baseline;
   assert.ok(closingLayouts<=4,mode+': simple slide avoids repeated layout, got '+closingLayouts);
  }
  await page.waitForFunction(()=>!document.querySelector('[data-fleet-bike-slide]'));
  await page.waitForTimeout(80);
  assert.equal(await card.evaluate(node=>node===window.__priorCard),true,'Back reuses the same list card');
  assert.equal(await card.evaluate(()=>window.__listMutations),0,'Unchanged list is not rebuilt during navigation');
  const after=await card.boundingBox();assert.ok(Math.abs(before.y-after.y)<3,`${mode}: restore ${before.y} -> ${after.y}`);
  await page.screenshot({path:path.join(output,mode+'-restored.png')});
  // Repeated real transitions used to retain fill:both WAAPI effects on html.
  // Assert that each cycle fully removes effects and plate proxies, including
  // Back from deep inside the detail's own scrollable iframe.
  for(let cycle=0;cycle<4;cycle++){
   await card.click();await fleet.locator('#detailView:not(.is-hidden)').waitFor();
   await page.waitForFunction(()=>!document.querySelector('[data-fleet-bike-slide]'));
   await fleet.locator('#detailView').evaluate(node=>window.scrollTo(0,node.scrollHeight));
   await fleet.locator('#detailBackButton').click();
   await fleet.locator('#homeView:not(.is-hidden)').waitFor();
   await page.waitForFunction(()=>!document.querySelector('[data-fleet-bike-slide]'));
   await page.waitForTimeout(40);
   assert.ok(Math.abs(before.y-(await card.boundingBox()).y)<3,mode+': repeated/deep Back preserves the anchor');
   assert.equal(await page.locator('[data-fleet-plate-proxy],.fleet-bike-return-surface').count(),0,'No plate proxy or surface remains after returning');
   assert.equal(await page.evaluate(()=>document.getAnimations().filter(a=>a.effect?.target===document.documentElement).length),0,'No retained root animations after a complete cycle');
  }

  await card.click();await fleet.locator('#detailView:not(.is-hidden)').waitFor();await page.waitForFunction(()=>!document.querySelector('[data-fleet-bike-slide]'));
  await page.evaluate(()=>history.back());await fleet.locator('#homeView:not(.is-hidden)').waitFor();await page.waitForFunction(()=>!document.querySelector('[data-fleet-bike-slide]'));await page.waitForTimeout(80);
  assert.ok(Math.abs(before.y-(await card.boundingBox()).y)<3,mode+': browser Back preserves the anchor');
  if(embedded){
   const nav=page.locator('#bottomNav'),box=await nav.boundingBox();
   const shifts=page.locator('#bottomNav [data-go="shifts"]'),touch=await shifts.boundingBox();
   await page.touchscreen.tap(touch.x+touch.width/2,touch.y+touch.height/2);
   const motions=await page.locator('#viewShifts').evaluate(node=>node.getAnimations().map(a=>({frames:a.effect.getKeyframes(),duration:a.effect.getTiming().duration})));assert.ok(motions.some(a=>a.duration===190&&a.frames.some(k=>k.transform.includes('22px'))),'Bottom navigation animates the content');
   const indicator=nav.locator('.bottom-nav-indicator');
   assert.ok(await indicator.evaluate(node=>node.getAnimations().some(a=>a.transitionProperty==='transform'&&a.effect.getTiming().duration===220)),'One green indicator slides between the actual buttons');
   assert.equal(await nav.locator('button.active').getAttribute('aria-current'),'page');
   assert.equal(await shifts.evaluate(node=>getComputedStyle(node).webkitTapHighlightColor),'rgba(0, 0, 0, 0)','Touch feedback never uses the browser blue highlight');
   assert.equal(await shifts.evaluate(node=>getComputedStyle(node).backgroundColor),'rgba(0, 0, 0, 0)','Selected button does not paint a second stationary pill');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Tab animation does not create horizontal scrolling');
   assert.ok(Math.abs((await nav.boundingBox()).y-box.y)<1,'Bottom bar stays fixed');
   await indicator.evaluate(node=>node.getAnimations().forEach(a=>{a.pause();a.currentTime=90;}));
   await page.screenshot({path:path.join(output,mode+'-bottom-navigation.png')});
   await indicator.evaluate(node=>node.getAnimations().forEach(a=>a.play()));
   await page.evaluate(()=>{for(const target of ['employees','dashboard','shifts','employees'])document.querySelector('#bottomNav [data-go="'+target+'"]').click();});
   await page.locator('#viewEmployees:not(.is-hidden)').waitFor();assert.equal(await page.locator('#bottomNav .active').getAttribute('data-go'),'employees');
   await page.waitForTimeout(250);
   const final=await indicator.boundingBox(),selected=await nav.locator('button.active').boundingBox();assert.ok(Math.abs(final.x-selected.x)<1&&Math.abs(final.width-selected.width)<1,'Rapid retargeting ends on the selected button');
   assert.equal(await nav.locator('.bottom-nav-indicator').count(),1);
   await page.setViewportSize({width:430,height:844});await page.waitForTimeout(80);
   const resized=await indicator.boundingBox(),resizedButton=await nav.locator('button.active').boundingBox();assert.ok(Math.abs(resized.x-resizedButton.x)<1&&Math.abs(resized.width-resizedButton.width)<1,'Resize keeps the indicator aligned');
   await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#bottomNav [data-go="dashboard"]').click();assert.equal(await indicator.evaluate(node=>getComputedStyle(node).transitionDuration),'0s','Reduced motion skips indicator travel');
  }
  assert.deepEqual(errors,[],mode+': no unhandled browser errors');report.push({mode,anchorRestored:true,sharedSlide:mode!=='reduced',screenshotsUsed:false,closingLayouts,errors});console.log('OK navigation mode:',mode);await context.close();
 }
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');console.log('OK real Chromium: shared 22px/190ms slide without snapshots or resizing, exact Back/Android-history scroll in standalone and embedded Portal, reduced motion, fixed bottom navigation and rapid tab changes.');
}finally{await browser.close();}
