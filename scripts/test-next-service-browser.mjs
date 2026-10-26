import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{chromium}=require('playwright');
const root=path.resolve('cloudflare-worker/public'),output=path.resolve('verification/next-service');fs.mkdirSync(output,{recursive:true});
const user={id:'notes-owner',username:'owner',role:'owner',permissions:['*']},at='2026-10-01T00:00:00.000Z';
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--allow-file-access-from-files']}),report=[];
try{for(const mode of ['web','client','client','client']){
 let bikes=[{id:'bike-0',name:'ΒΤΟ 756',intervalKm:3000,lastServiceKm:1000,currentKm:1200,createdAt:at,updatedAt:at,history:[]},{id:'bike-1',name:'ΒΤΟ 757',intervalKm:3000,lastServiceKm:1000,currentKm:1200,createdAt:at,updatedAt:at,history:[]}];
 const context=await browser.newContext({viewport:{width:mode==='web'?1100:390,height:844},isMobile:mode==='client',hasTouch:mode==='client',serviceWorkers:'block'}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await context.addInitScript(({user,bikes})=>{localStorage.setItem('fleet-control-auth-token','fixture');localStorage.setItem('fleet-control-user-cache',JSON.stringify(user));localStorage.setItem('moto-service-tracker-v1',JSON.stringify(bikes));},{user,bikes});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.protocol==='file:')return route.continue();
  if(url.pathname.startsWith('/api/')){
   const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
   if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers});
   let bike;if(route.request().method()==='POST'&&url.pathname==='/api/sync/bike'){bike=route.request().postDataJSON().bike;bikes=bikes.map(b=>b.id===bike.id?bike:b);}
   return route.fulfill({status:url.pathname==='/api/events/ticket'?503:200,headers,json:{saved:!!bike,user,bike,bikes,version:1,configured:true,serverOnline:true,employees:[],vehicles:[],rules:[],shifts:[],alerts:[],documents:[],days:[],summary:{},today:{vehicles:{}},currentWeek:{payableHours:0,payrollCents:0,kilometers:0},realtime:[],dailySchedule:[],actionCount:0}});
  }
  const full=path.resolve(root,'.'+decodeURIComponent(url.pathname));if(!full.startsWith(root+path.sep)||!fs.existsSync(full)||!fs.statSync(full).isFile())return route.fulfill({status:404,body:'Not found'});
  return route.fulfill({status:200,path:full,contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'})[path.extname(full)]||'application/octet-stream'});
 });
 await page.goto(mode==='client'?'file://'+path.resolve('client-android/assets/www/portal.html'):'https://fixture.invalid/index.html');
 if(mode==='client')await page.locator('#bottomNav [data-go="fleet"]').click();
 const fleet=mode==='client'?page.frameLocator('#fleetModuleFrame'):page;
 await fleet.locator('#bikeList [data-bike-id="bike-0"]').click();await fleet.locator('#nextServiceCard').waitFor();
 await fleet.locator('#detailCheckButton').click();await fleet.locator('#quickCurrentKm').fill('1300');await fleet.locator('#quickCheckForm button[type=submit]').click();await fleet.locator('#quickCheckResult').waitFor({state:'visible'});assert.match(await fleet.locator('#quickCheckResult').textContent(),/2[.\s]?700/);assert.match(await fleet.locator('#quickCheckResult').textContent(),/αποθηκεύτηκε/);await fleet.locator('#quickCheckBackButton').click();await fleet.locator('#nextServiceCard').waitFor();
 
 await fleet.locator('#nextServiceAdd').fill('Έλεγχος ιμάντα\nΑλλαγή πίσω ελαστικού');await fleet.locator('#nextServiceSave').click();
 assert.match(await fleet.locator('#nextServiceList').textContent(),/Έλεγχος ιμάντα/);assert.equal(await fleet.locator('#nextServiceList .next-service-row').count(),2);
 await fleet.locator('#nextServiceCard').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,mode+'-bike-notes.png')});
 await fleet.locator('#detailServiceButton').click();assert.equal(await fleet.locator('[data-next-note-done]').count(),2);
 await fleet.locator('.next-service-check').filter({hasText:'Έλεγχος ιμάντα'}).locator('input').check();await fleet.locator('#serviceNextNotes').fill('Έλεγχος μπαταρίας');await fleet.locator('#serviceNextTitle').scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(output,mode+'-new-service.png')});
 await fleet.locator('#serviceForm button.primary-button[type=submit]').click();
 const result=await fleet.locator('#serviceDialog').evaluate(async dialog=>{for(let i=0;i<200;i++){if(!dialog.open)return 'closed';if(document.querySelector('[data-impact-confirm]'))return 'confirm';const error=document.getElementById('serviceFormError').textContent.trim();if(error)return 'error: '+error;await new Promise(r=>setTimeout(r,25));}return 'timeout: '+[...document.querySelectorAll('dialog[open]')].map(d=>d.querySelector('h2')?.textContent||d.id).join(' | ');});
 if(result==='confirm')await fleet.locator('[data-impact-confirm]').click();
 if(!['closed','confirm'].includes(result)){await page.screenshot({path:path.join(output,mode+'-failure.png')});throw new Error(mode+' service save '+result);}
 await fleet.locator('#serviceDialog').waitFor({state:'hidden'});
 assert.equal(await fleet.locator('#nextServiceList .next-service-row').count(),2);assert.ok(!(await fleet.locator('#nextServiceList').textContent()).includes('Έλεγχος ιμάντα'));
 await fleet.locator('#nextServicePast summary').click();assert.match(await fleet.locator('#nextServicePastList').textContent(),/Ολοκληρώθηκε/);
 await fleet.locator('#detailServiceButton').click();assert.equal(await fleet.locator('[data-next-note-done]:checked').count(),0);assert.match(await fleet.locator('#serviceReminders').textContent(),/Έλεγχος μπαταρίας/);await fleet.locator('#serviceDialog .service-back-button').click();
 await fleet.locator('#nextServiceCard').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(output,mode+'-saved.png')});
 assert.ok(await fleet.locator('#detailView').evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow at mobile width');
 await fleet.locator('#detailBackButton').click();await fleet.locator('#bikeList [data-bike-id="bike-1"]').click();assert.equal(await fleet.locator('#nextServiceList .next-service-row').count(),0,'Notes do not leak to another bike');
 assert.deepEqual(errors,[]);report.push({mode,add:true,serviceCompletion:true,carryForward:true,bikeIsolation:true,pageErrors:errors});await context.close();
}}finally{await browser.close();}
fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');console.log('PASS actual Chromium Web/Client note cards, service completion/carry-forward, isolation and mobile layout.');
