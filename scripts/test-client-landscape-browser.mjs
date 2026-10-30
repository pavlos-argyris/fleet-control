import {serverProjectionResponse} from './fixtures/server-projection-response.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{chromium}=require('playwright');
const root=path.resolve('cloudflare-worker/public'),output=path.resolve('verification/client-landscape',process.env.FLEET_LANDSCAPE_PHASE||'after');fs.mkdirSync(output,{recursive:true});
const user={id:'ui-owner',username:'owner',fullName:'Ομάδα Fleet Control',role:'owner',permissions:['*']},at='2026-10-01T00:00:00Z';
const bikes=Array.from({length:8},(_,i)=>({id:'bike-'+i,name:'BTO '+(756+i),currentKm:12000+i*400,lastServiceKm:10000,intervalKm:3000,createdAt:at,updatedAt:at,nextServiceNotes:i===0?[{id:'belt',text:'Έλεγχος ιμάντα στο επόμενο service',status:'pending',createdAt:at,updatedAt:at}]:[],history:i===0?[{id:'service-0',type:'service',date:'2026-10-01',km:10000,tasks:['Αλλαγή λαδιών'],attachments:[{id:'pdf-0',contentType:'application/pdf',size:1024,key:'sample.pdf',name:'Invoice_756.pdf',ocr:{totalAmount:'59,00',invoiceDate:'2026-10-02'}}]}]:[]}));
const documents=['needs_review','warning','error','confirmed','processing'].map((status,i)=>({id:'doc-'+i,bikeId:'bike-0',entryId:'service-0',key:status==='processing'?'':'invoice-'+i+'.pdf',name:'Invoice_'+(i+1)+'.pdf',contentType:'application/pdf',bikeName:'BTO 756',serviceDate:'2026-10-01',serviceKm:10000,status,warnings:[],transferOptions:[],invoiceData:{supplier:'Test Workshop',plate:'BTO 756',odometerKm:'10000',invoiceNumber:'INV-'+i,invoiceDate:'2026-10-02',totalAmount:'59,00',workPerformed:'Αλλαγή λαδιών',lineItems:['Αλλαγή λαδιών']}}));
function pdfBytes(){const stream='BT /F1 20 Tf 40 720 Td (FLEET CONTROL - INVOICE) Tj 0 -50 Td (BTO 756 - 10000 km - 59 EUR) Tj ET';const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>','<< /Length '+stream.length+' >>\nstream\n'+stream+'\nendstream','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];let raw='%PDF-1.4\n',offsets=[];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(raw));raw+=(i+1)+' 0 obj\n'+o+'\nendobj\n';});const x=Buffer.byteLength(raw);return Buffer.from(raw+'xref\n0 6\n0000000000 65535 f \n'+offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+x+'\n%%EOF');}
const productionCsp=fs.readFileSync('cloudflare-worker/src/worker.js','utf8').match(/"Content-Security-Policy": "([^"]+)"/)[1];
documents.forEach(row=>{if(row.key){row.sourcePhoto={key:'original-photo.png',name:'Αρχική φωτογραφία.png',contentType:'image/png'};row.qrUrl='https://einvoice.impact.gr/p/FIXTURE';}});
bikes[0].history[0].invoiceData={qrUrl:'https://einvoice.impact.gr/p/ORPHAN',qrJobId:'orphan-fixture',qrProcessingStatus:'completed',qrProcessingProgress:'100',qrProcessingStartedAt:at,qrProcessingUpdatedAt:at};
const generic={user,bikes,version:1,snapshotVersion:1,configured:true,serverOnline:true,databaseOk:true,storageOk:true,employees:[{id:'e',full_name:'Δοκιμαστικός εργαζόμενος',fullName:'Δοκιμαστικός εργαζόμενος',username:'rider',role:'employee',active:1}],vehicles:[],rules:[],shifts:[],alerts:[],documents,days:[],summary:{},today:{vehicles:{available:6,in_use:2},workingNow:2},currentWeek:{payableHours:32,payrollCents:17000,kilometers:480,startDate:'2026-10-19',endDate:'2026-10-25'},realtime:[],dailySchedule:[],actionCount:3,actionGroups:{service:2}};
const week={...generic,weekStart:'2026-10-19',weekEnd:'2026-10-25',scheduleState:'published',publication:{revision:1},schedules:[{id:'s',employee_id:'e',employee_name:'Δοκιμαστικός εργαζόμενος',work_date:'2026-10-19',start_time:'22:00',end_time:'02:00',start_at:'2026-10-19T19:00:00Z',end_at:'2026-10-19T23:00:00Z',status:'planned',vehicle_name:'BTO 756'}]};

const payroll={period:{status:'open'},totals:{},employees:[]};

// Chromium/file tests exercise responsive content, not Android's window manager.
// A before capture is deliberately the unchanged browser baseline: the old native
// portrait lock is verified separately and is not faked with a narrow iframe.
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--allow-file-access-from-files']}),report=[];
const sizes=[{name:'phone',portrait:{width:390,height:844},landscape:{width:844,height:390}},
 {name:'small-phone',portrait:{width:320,height:667},landscape:{width:667,height:320}},
 {name:'tablet',portrait:{width:800,height:1280},landscape:{width:1280,height:800}}];
const metrics=new Map();
async function bounds(scope,selector){return scope.locator(selector).evaluate(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,viewport:innerWidth,viewportHeight:innerHeight,scrollWidth:document.documentElement.scrollWidth};});}
async function noOverflow(scope,label){const b=await scope.locator('body').evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(b.scroll<=b.width+1,label+' unwanted page overflow '+JSON.stringify(b));}
async function reachable(scope,selector,label){const element=scope.locator(selector).last();await element.scrollIntoViewIfNeeded();await assert.doesNotReject(()=>element.click({trial:true}),label+' action reachable without submitting');}
try{
 for(const device of sizes)for(const mode of ['web','client']){
  const context=await browser.newContext({viewport:device.portrait,isMobile:true,hasTouch:true,locale:'el-GR',serviceWorkers:'block'}),page=await context.newPage(),errors=[];
  const label=device.name+'-'+mode;
  page.on('pageerror',e=>errors.push(e.message));
  await context.addInitScript(({user,bikes})=>{localStorage.setItem('fleet-control-auth-token','fixture');localStorage.setItem('fleet-control-user-cache',JSON.stringify(user));localStorage.setItem('moto-service-tracker-v1',JSON.stringify(bikes));window.__landscapePage=Date.now()+Math.random();},{user,bikes});
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.protocol==='file:')return route.continue();
   if(url.pathname.startsWith('/api/')){
    const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
    if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers});
    if(url.pathname.startsWith('/api/service-documents/'))return route.fulfill({headers,contentType:'application/pdf',body:pdfBytes()});
    const json=serverProjectionResponse(url.pathname,generic,payroll)||(url.pathname.startsWith('/api/admin/schedule-week')?week:url.pathname==='/api/admin/payroll'?payroll:generic);
    return route.fulfill({status:url.pathname==='/api/events/ticket'?503:200,headers,json});
   }
   const full=path.resolve(root,'.'+decodeURIComponent(url.pathname));
   if(!full.startsWith(root+path.sep)||!fs.existsSync(full)||!fs.statSync(full).isFile())return route.fulfill({status:404});
   return route.fulfill({path:full,headers:path.extname(full)==='.html'?{'Content-Security-Policy':productionCsp}:{},contentType:({'.js':'text/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml','.wasm':'application/wasm'})[path.extname(full)]||'application/octet-stream'});
  });
  const capture=async name=>{await noOverflow(page,label+' '+name);await page.screenshot({path:path.join(output,label+'-'+name+'.png')});};
  const navigate=async id=>{
   const nav=await page.locator('#bottomNav').isVisible()?page.locator('#bottomNav'):page.locator('#sideNav');
   const direct=nav.locator('[data-go="'+id+'"]');
   if(await direct.count())await direct.click();else{await nav.locator('[data-ui-more]').click();await page.locator('#uiMoreDialog [data-go="'+id+'"]').click();}
   await page.locator('[data-view="'+id+'"]:not(.is-hidden)').waitFor();await page.waitForTimeout(250);
  };
  try{
   await page.goto(mode==='client'?'file://'+path.resolve('client-android/assets/www/portal.html'):'https://fixture.invalid/portal.html');
   await page.locator('.ui-priority').first().waitFor();const marker=await page.evaluate(()=>window.__landscapePage);
   await capture('portrait-dashboard');
   await page.setViewportSize(device.landscape);await page.waitForTimeout(300);await capture('landscape-dashboard');
   const shell=await bounds(page,'.main-shell'),side=await bounds(page,'.sidebar'),sidebar=side.x>=0?side.width:0;
   assert.ok(Math.abs(shell.width-(device.landscape.width-sidebar))<=2,label+' uses all width apart from existing desktop sidebar '+JSON.stringify(shell));
   const dimensionSet={shellWidth:shell.width,viewport:device.landscape.width};
   await navigate('shifts');await capture('landscape-shifts');
   await navigate('schedules');await page.locator('#scheduleList .roster-person').waitFor();await capture('landscape-schedule');
   await navigate('employees');await page.locator('.employee-card').first().waitFor();await capture('landscape-employees');
   await navigate('invoices');await page.locator('#invoiceQueueList [data-invoice-review]').first().waitFor();await capture('landscape-invoices');
   await page.locator('#invoiceQueueList [data-invoice-review]').first().click();await page.locator('#invoiceReviewDialog[open]').waitFor();
   await page.locator('#invoiceReviewComments').fill('Αποθηκεύεται μόνο στη δοκιμαστική φόρμα');
   await capture('landscape-invoice-dialog-top');
   await reachable(page,'#invoiceReviewSave',label+' invoice save');await capture('landscape-invoice-dialog');
   await page.setViewportSize(device.portrait);await page.waitForTimeout(250);
   assert.equal(await page.locator('#invoiceReviewComments').inputValue(),'Αποθηκεύεται μόνο στη δοκιμαστική φόρμα');
   assert.ok(await page.locator('#invoiceReviewDialog').evaluate(n=>n.open));await capture('portrait-invoice-dialog');
   await page.locator('#invoiceReviewDialog [data-close]').first().click();
   await navigate('fleet');const fleet=page.frameLocator('#fleetModuleFrame');await fleet.locator('#bikeList [data-bike-id]').first().waitFor();
   await fleet.locator('#bikeList [data-bike-id]').last().scrollIntoViewIfNeeded();await capture('portrait-fleet-bottom');
   await fleet.locator('#bikeList [data-bike-id]').first().click();await fleet.locator('#nextServiceCard').waitFor();
   await fleet.locator('#detailServiceButton').click();await fleet.locator('#serviceDialog[open]').waitFor();
   await fleet.locator('#serviceKm').fill('12567');await fleet.locator('#serviceNotes').fill('Δοκιμή περιστροφής χωρίς αποθήκευση');
   const frameMarker=await fleet.locator('body').evaluate(()=>window.__landscapePage);
   await page.setViewportSize(device.landscape);await page.waitForTimeout(300);
   assert.equal(await fleet.locator('#serviceKm').inputValue(),'12567');assert.equal(await fleet.locator('#serviceNotes').inputValue(),'Δοκιμή περιστροφής χωρίς αποθήκευση');
   assert.ok(await fleet.locator('#serviceDialog').evaluate(n=>n.open));
   assert.equal(await fleet.locator('body').evaluate(()=>window.__landscapePage),frameMarker);
   await noOverflow(fleet,label+' inner Fleet');
   const frame=await bounds(page,'#fleetModuleFrame');dimensionSet.fleetWidth=frame.width;
   assert.ok(Math.abs(frame.width-(await bounds(page,'.main-shell')).width)<=2,label+' Fleet fills workspace');
   await capture('landscape-service-dialog-top');
   await reachable(fleet,'#serviceForm .primary-button[type="submit"]',label+' new service submit');await capture('landscape-service-dialog');
   const dialog=await bounds(fleet,'#serviceDialog');assert.ok(dialog.x>=-1&&dialog.right<=dialog.viewport+1,label+' service dialog within width');
   await fleet.locator('#serviceDialog [data-close-dialog]').first().click();await fleet.locator('#nextServiceCard').waitFor();await capture('landscape-bike');
   await page.setViewportSize(device.portrait);await page.waitForTimeout(250);await capture('portrait-bike-return');
   assert.equal(await page.evaluate(()=>window.__landscapePage),marker,'same live page across rotations');assert.deepEqual(errors,[]);
   if(mode==='web')metrics.set(device.name,dimensionSet);else assert.deepEqual(dimensionSet,metrics.get(device.name),'Client matches Web width '+device.name);
   report.push({device:device.name,mode,portrait:device.portrait,landscape:device.landscape,dimensions:dimensionSet,errors,openDraftRetained:true,bottomActionsReachable:true});
  }catch(error){await page.screenshot({path:path.join(output,label+'-FAILURE.png')});throw error;}finally{await context.close();}
 }
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({environment:'Chromium with synthetic API; file Client is not Android WebView',phase:process.env.FLEET_LANDSCAPE_PHASE||'after',report},null,2)+'\n');
 console.log('PASS #3 Chromium/file Client and Web: phone/short phone/tablet, both orientations, full width, Fleet detail/service, schedule/employees/invoices, reachable dialog actions, live drafts retained.');
}finally{await browser.close();}
// The standalone emergency entry is part of the Client's responsive surface.
await import('./test-direct-browser.mjs');
