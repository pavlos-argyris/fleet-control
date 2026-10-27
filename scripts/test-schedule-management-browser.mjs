import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import worker from '../cloudflare-worker/src/worker.js';
import {createSimulation} from './fixtures/workforce-simulation.mjs';
import {localDate,addCalendarDays} from '../cloudflare-worker/src/workforce-core.js';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{chromium}=require('playwright');
const root=path.resolve('cloudflare-worker/public'),output=path.resolve('verification/schedule-management');fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const {db,env,call}=createSimulation();
const boot=await call('/api/auth/bootstrap',{method:'POST',server:true,body:{fullName:'UI Owner',username:'uiowner',password:'ExampleUIOwner!123'}});assert.equal(boot.status,200);
const {token,user}=boot.data,request=(url,method='GET',body)=>call(url,{token,method,body});
try{for(const [mode,width,height] of [['desktop',1440,1000],['mobile',390,844],['tablet-landscape',1024,768]]){
 const offset=['desktop','mobile','tablet-landscape'].indexOf(mode)*5;
 const initial='04:'+String(13+offset),updated='04:'+String(14+offset),custom='04:'+String(15+offset),end='05:27',bikeId='ui-bike-'+mode;
 const e=(await request('/api/admin/employees','POST',{fullName:'Διανομέας δοκιμής '+mode,loginEnabled:false})).data.employee;
 db.sqlite.prepare("INSERT INTO vehicle_registry(bike_id,name,odometer,status,updated_at) VALUES(?, 'BTO 123',100,'available',?)").run(bikeId,new Date().toISOString());
 const today=localDate(Date.now(),'Europe/Athens'),day=new Date(today+'T12:00Z').getUTCDay(),week=addCalendarDays(today,day===0?-6:1-day);
 const context=await browser.newContext({viewport:{width,height},locale:'el-GR',serviceWorkers:'block'}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await context.addInitScript(({token,user})=>{localStorage.setItem('fleet-control-auth-token',token);localStorage.setItem('fleet-control-user-cache',JSON.stringify(user));},{token,user});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url()),req=route.request();
  if(url.pathname.startsWith('/api/')){
   if(url.pathname.startsWith('/api/events/'))return route.fulfill({status:503,json:{error:'Fixture disables realtime'}});
   const headers=new Headers(req.headers());headers.delete('origin');headers.set('Authorization','Bearer '+token);
   const response=await worker.fetch(new Request('https://simulation.invalid'+url.pathname+url.search,{method:req.method(),headers,body:['GET','HEAD'].includes(req.method())?undefined:req.postDataBuffer()}),env);
   return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
  }
  const file=path.resolve(root,'.'+(url.pathname==='/'?'/portal.html':decodeURIComponent(url.pathname)));
  return file.startsWith(root+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()?route.fulfill({path:file,contentType:({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'}):route.fulfill({status:404});
 });
 try{
  await page.goto('https://fixture.invalid/portal.html');await page.locator('#sideNav [data-go="schedules"]').waitFor({state:'attached'});
  const nav=width>860?page.locator('#sideNav'):page.locator('#bottomNav');
  const direct=nav.locator('[data-go="schedules"]');if(await direct.count())await direct.click();else{await nav.locator('[data-ui-more]').click();await page.locator('#uiMoreDialog [data-go="schedules"]').click();}
  await page.locator('#newScheduleButton').click();await page.locator('[data-builder-mode="employee"]').click();await page.locator('#weekScheduleEmployee').selectOption(e.id);
  await page.locator('[data-new-day-template="'+week+'"]').click();await page.locator('#quickShiftStart').fill(initial);await page.locator('#quickShiftEnd').fill(end);await page.locator('#simpleSubmit').click();await page.waitForFunction(()=>!document.querySelector('#simpleDialog').open);
  await page.waitForFunction(date=>Boolean(document.querySelector('[data-day-template="'+date+'"]')?.value),week);
  const template=db.sqlite.prepare('SELECT * FROM shift_templates WHERE name=?').get(initial+' - '+end);assert.ok(template);
  assert.equal(await page.locator('[data-day-template="'+week+'"]').inputValue(),template.id);
  await page.locator('#scheduleSubmitButton').click();await page.waitForFunction(()=>!document.querySelector('#scheduleDialog').open);
  await page.locator('.roster-shift-chip').filter({hasText:initial+'-'+end}).waitFor();
  await page.locator('#scheduleAutoVehicles').click();await page.locator('#simpleDialog[open]').waitFor();assert.match(await page.locator('#simpleFields').textContent(),/BTO 123/);await page.locator('#simpleSubmit').click();await page.waitForFunction(()=>!document.querySelector('#simpleDialog').open);
  await page.locator('.roster-shift-chip').filter({hasText:initial+'-'+end}).filter({hasText:'BTO 123'}).waitFor();
  const draft=JSON.parse(db.sqlite.prepare('SELECT assignments FROM schedule_week_drafts WHERE week_start=?').get(week).assignments);assert.equal(draft.find(x=>x.employeeId===e.id).vehicleId,bikeId);
  await page.locator('#scheduleTemplatesButton').click();await page.locator('[data-template-edit="'+template.id+'"]').click();await page.locator('[data-template-start]').fill(updated);assert.equal(await page.locator('#templateName').inputValue(),updated+' - '+end);
  await page.locator('#templateForm button[type="submit"]').click();await page.locator('#simpleDialog[open]').waitFor();assert.match(await page.locator('#simpleFields').textContent(),/Διανομέας δοκιμής/);assert.ok((await page.locator('#simpleFields').textContent()).includes(initial));
  await page.locator('#simpleSubmit').click();await page.waitForFunction(()=>!document.querySelector('#simpleDialog').open);await page.waitForFunction(id=>document.querySelector('#templateId').value===id&&document.querySelector('#templateError').textContent==='',template.id);
  await page.locator('#templateDialog [data-close="templateDialog"]').click();await page.locator('.roster-shift-chip').filter({hasText:updated+'-'+end}).waitFor();
  await page.locator('.roster-shift-chip').filter({hasText:updated+'-'+end}).click();await page.locator('#scheduleEditDialog[open]').waitFor();await page.locator('[data-edit-start]').fill(custom);await page.locator('#scheduleEditForm button[type="submit"]').click();await page.waitForFunction(()=>!document.querySelector('#scheduleEditDialog').open);
  await page.locator('.roster-shift-chip').filter({hasText:custom+'-'+end}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no page overflow '+mode);assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(output,mode+'.png'),fullPage:true});
 }finally{await context.close();}
}
console.log('PASS #10 browser desktop/mobile/tablet: inline template, draft editing, confirmed template propagation, auto vehicle preview and assignment, real hours and layout.');
}finally{await browser.close();}
