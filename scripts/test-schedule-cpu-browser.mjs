import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';
import worker from '../cloudflare-worker/src/worker.js';import {createSimulation} from './fixtures/workforce-simulation.mjs';import {localDate,addCalendarDays} from '../cloudflare-worker/src/workforce-core.js';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{chromium}=require('playwright');
const root=path.resolve('cloudflare-worker/public'),output=path.resolve('verification/schedule-cpu/browser');fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--allow-file-access-from-files']}),report=[];
 const {db,env,call}=createSimulation();const boot=await call('/api/auth/bootstrap',{method:'POST',server:true,body:{fullName:'UI Owner',username:'uiowner',password:'FixturePassword!123'}});assert.equal(boot.status,200);const {token,user}=boot.data;
 const req=(url,method='GET',body)=>call(url,{token,method,body});
 const template=(await req('/api/admin/shift-templates','POST',{segments:[{start:'08:17',end:'16:23'}]})).data.template;

try{for(const [mode,width,height] of [['desktop',1440,1000],['mobile',390,844],['client-tablet',1024,768]]){
 const employee=(await req('/api/admin/employees','POST',{fullName:'Διανομέας CPU',loginEnabled:false})).data.employee;
 const today=localDate(Date.now(),'Europe/Athens'),dow=new Date(today+'T12:00Z').getUTCDay(),week=addCalendarDays(today,dow===0?-6:1-dow);
 await req('/api/admin/schedule-week','POST',{draft:true,assignments:[{employeeId:employee.id,date:week,templateId:template.id,withoutVehicle:true}]});
 let failReads=true,failPost=false,failAfterSave=false,posts=0,holdWeek='',releaseOld;
 const context=await browser.newContext({viewport:{width,height},locale:'el-GR',serviceWorkers:'block'}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await context.addInitScript(({token,user})=>{localStorage.setItem('fleet-control-auth-token',token);localStorage.setItem('fleet-control-user-cache',JSON.stringify(user));},{token,user});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url()),request=route.request();if(url.protocol==='file:')return route.continue();
  if(url.pathname.startsWith('/api/')){
   const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
   if(request.method()==='OPTIONS')return route.fulfill({status:204,headers});
   if(url.pathname.startsWith('/api/events/'))return route.fulfill({status:503,headers,json:{error:'Fixture disables realtime'}});
   if(url.pathname==='/api/admin/schedule-week'){
    if(request.method()==='GET'&&url.searchParams.get('week')===holdWeek)await new Promise(resolve=>{releaseOld=resolve;});
    if(request.method()==='GET'&&failReads)return route.fulfill({status:503,headers,json:{error:'Fixture exceededCpu'}});
    if(request.method()==='POST'){posts++;if(failPost)return route.fulfill({status:503,headers,json:{error:'Fixture exceededCpu'}});}
   }
   const incoming=new Headers(request.headers());incoming.delete('origin');incoming.set('Authorization','Bearer '+token);
   const response=await worker.fetch(new Request('https://fixture'+url.pathname+url.search,{method:request.method(),headers:incoming,body:['GET','HEAD'].includes(request.method())?undefined:request.postDataBuffer()}),env);
   const bytes=Buffer.from(await response.arrayBuffer());
   if(url.pathname==='/api/admin/schedule-week'&&request.method()==='POST'&&failAfterSave)failReads=true;
   return route.fulfill({status:response.status,headers:{...Object.fromEntries(response.headers),...headers},body:bytes});
  }
  const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));return file.startsWith(root+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()?route.fulfill({path:file,contentType:({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'}):route.fulfill({status:404});
 });
 const shot=async name=>{assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),mode+' page overflow');await page.screenshot({path:path.join(output,mode+'-'+name+'.png')});};
 try{
  await page.goto(mode==='client-tablet'?'file://'+path.resolve('client-android/assets/www/portal.html'):'https://fixture.invalid/portal.html');
  const nav=width>860?page.locator('#sideNav'):page.locator('#bottomNav');const direct=nav.locator('[data-go="schedules"]');if(await direct.count())await direct.click();else{await nav.locator('[data-ui-more]').click();await page.locator('#uiMoreDialog [data-go="schedules"]').click();}
  await page.locator('#scheduleLoadFailure:not(.is-hidden)').waitFor();assert.match(await page.locator('#scheduleLoadMessage').textContent(),/δεν σημαίνει ότι είναι κενό/);assert.ok(await page.locator('#newScheduleButton').isDisabled());await shot('get-503');
  failReads=false;await page.locator('#scheduleLoadRetry').click();await page.locator('#scheduleLoadFailure.is-hidden').waitFor({state:'attached'});await page.locator('#scheduleList .roster-person').first().waitFor();assert.ok(await page.locator('#newScheduleButton').isEnabled());await shot('loaded');
  await page.locator('#newScheduleButton').click();await page.locator('[data-builder-mode="employee"]').click();await page.locator('#weekScheduleEmployee').selectOption(employee.id);await page.locator('[data-day-template="'+week+'"]').selectOption(template.id);
  failPost=true;await page.locator('#scheduleSubmitButton').click();await page.waitForFunction(()=>document.querySelector('#scheduleError').textContent.includes('Δεν επιβεβαιώθηκε'));assert.ok(await page.locator('#scheduleDialog').evaluate(n=>n.open));assert.equal(await page.locator('[data-day-template="'+week+'"]').inputValue(),template.id);assert.equal(posts,1,'no automatic POST replay');await shot('post-503');
  failPost=false;failAfterSave=true;await page.locator('#scheduleSubmitButton').click();await page.waitForFunction(()=>!document.querySelector('#scheduleDialog').open);await page.locator('#scheduleLoadFailure:not(.is-hidden)').waitFor();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Πρόχειρο αποθηκεύτηκε'));assert.equal(posts,2);assert.ok(db.sqlite.prepare('SELECT assignments FROM schedule_week_drafts WHERE week_start=?').get(week));await shot('saved-get-failed');
  failReads=false;failAfterSave=false;await page.locator('#scheduleLoadRetry').click();await page.locator('#scheduleLoadFailure.is-hidden').waitFor({state:'attached'});assert.equal(posts,2,'read retry does not re-save');
  // A late older-week response must never overwrite the newer selected week.
  holdWeek=addCalendarDays(week,7);await page.locator('#scheduleWeekDate').fill(holdWeek);await page.locator('#scheduleWeekDate').dispatchEvent('change');for(let i=0;i<100&&!releaseOld;i++)await page.waitForTimeout(10);assert.ok(releaseOld);
  const newest=addCalendarDays(week,14);await page.locator('#scheduleWeekDate').fill(newest);const loaded=page.waitForResponse(r=>r.url().includes('schedule-week?week='+newest));await page.locator('#scheduleWeekDate').dispatchEvent('change');await loaded;await page.waitForTimeout(150);const range=await page.locator('#scheduleWeekRange').textContent();releaseOld();await page.waitForTimeout(250);assert.equal(await page.locator('#scheduleWeekRange').textContent(),range);assert.equal(await page.locator('#scheduleWeekDate').inputValue(),newest);await shot('newest-week');assert.deepEqual(errors,[]);
  report.push({mode,width,height,getErrorVisible:true,postRetainsForm:true,onePostPerSubmit:true,savedVersusRefreshFailure:true,readRetryOnly:true,oldResponseIgnored:true,errors});
 }catch(error){releaseOld?.();await shot('FAILURE');throw error;}finally{await context.close();}
}
fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({data:'Synthetic fixtures only; Chromium/file Client, not physical Android',report},null,2)+'\n');console.log('PASS #17 browser Web desktop/mobile and file Client tablet: GET failure/retry, POST 503 preserves form, successful save with failed read, no mutation replay and stale response fencing.');
}finally{await browser.close();}
