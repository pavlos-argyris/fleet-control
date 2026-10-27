import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';
import worker from '../cloudflare-worker/src/worker.js';import {createSimulation} from './fixtures/workforce-simulation.mjs';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{chromium}=require('playwright');
const {db,env,call}=createSimulation(),boot=await call('/api/auth/bootstrap',{method:'POST',server:true,body:{fullName:'Browser Owner',username:'browserowner',password:'BrowserExample!7'}});
assert.equal(boot.status,200);const token=boot.data.token,user=boot.data.user;
const publicRoot=path.resolve('cloudflare-worker/public'),output=path.resolve('verification/staff-schedule');fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--allow-file-access-from-files']}),report=[];
try{for(const mode of ['desktop','mobile','client']){
 const context=await browser.newContext({viewport:{width:mode==='desktop'?1440:390,height:900},isMobile:mode!=='desktop',hasTouch:mode!=='desktop',locale:'el-GR',serviceWorkers:'block',acceptDownloads:true}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await context.addInitScript(({token,user})=>{localStorage.setItem('fleet-control-auth-token',token);localStorage.setItem('fleet-control-user-cache',JSON.stringify(user));},{token,user});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.protocol==='file:')return route.continue();
  if(url.pathname.startsWith('/api/')){
   if(url.pathname.startsWith('/api/events/'))return route.fulfill({status:503,json:{error:'Fixture disables realtime socket'},headers:{'Access-Control-Allow-Origin':'*'}});
   const request=route.request(),headers=new Headers(request.headers());headers.delete('origin');headers.set('Authorization','Bearer '+token);
   const response=await worker.fetch(new Request('https://simulation.invalid'+url.pathname+url.search,{method:request.method(),headers,body:['GET','HEAD'].includes(request.method())?undefined:request.postDataBuffer()}),env);
   const outHeaders=Object.fromEntries(response.headers);outHeaders['Access-Control-Allow-Origin']='*';
   return route.fulfill({status:response.status,headers:outHeaders,body:Buffer.from(await response.arrayBuffer())});
  }
  const file=path.resolve(publicRoot,'.'+(url.pathname==='/'?'/portal.html':decodeURIComponent(url.pathname)));
  if(!file.startsWith(publicRoot+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.fulfill({status:404});
  return route.fulfill({path:file,contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'})[path.extname(file)]||'application/octet-stream'});
 });
 const nav=async id=>{const root=mode==='desktop'?page.locator('#sideNav'):page.locator('#bottomNav'),direct=root.locator('[data-go="'+id+'"]');if(await direct.count())await direct.click();else{await root.locator('[data-ui-more]').click();await page.locator('#uiMoreDialog [data-go="'+id+'"]').click();}await page.locator('[data-view="'+id+'"]:not(.is-hidden)').waitFor();await page.waitForFunction(()=>!document.querySelector('#portal').classList.contains('view-loading'));assert.equal(await page.locator('#uiViewError').isVisible(),false,await page.locator('#uiViewErrorText').textContent());};
 const capture=async name=>{assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),mode+' '+name+' no horizontal overflow');await page.screenshot({path:path.join(output,mode+'-'+name+'.png')});};
 try{
  await page.goto(mode==='client'?'file://'+path.resolve('client-android/assets/www/portal.html'):'https://fixture.invalid/portal.html');await page.locator('#sideNav [data-go="employees"]').waitFor({state:'attached'});
  await nav('employees');await page.locator('#newEmployeeButton').click();await page.locator('#employeeDialog[open]').waitFor();
  assert.equal(await page.locator('#employeeLoginEnabled').isChecked(),false);assert.equal(await page.locator('#employeeUsername').isVisible(),false);assert.equal(await page.locator('#employeePassword').isVisible(),false);
  const name='Υπάλληλος '+mode;await page.locator('#employeeName').fill(name);await page.locator('#usesOwnVehicle').check();await capture('new-staff');await page.locator('#employeeForm button[type="submit"]').click();await page.waitForFunction(()=>!document.querySelector('#employeeDialog').open);
  const employee=db.sqlite.prepare('SELECT * FROM app_users WHERE full_name=?').get(name);assert.equal(employee.login_enabled,0);
  const card=page.locator('.employee-card').filter({hasText:name});await card.waitFor();assert.match(await card.textContent(),/Χωρίς λογαριασμό/);
  await card.locator('[data-employee-edit]').click();await page.locator('#employeeLoginEnabled').check();await page.locator('#employeeUsername').fill('enabled-'+mode);await page.locator('#employeePassword').fill('BrowserEnabled!7');await page.locator('#employeeForm button[type="submit"]').click();await page.waitForFunction(()=>!document.querySelector('#employeeDialog').open);assert.equal(db.sqlite.prepare('SELECT login_enabled FROM app_users WHERE id=?').get(employee.id).login_enabled,1);
  await nav('settings');await page.locator('#payrollHoursSource').selectOption('schedule');const savedSettings=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/admin/settings'&&response.request().method()==='PUT');await page.locator('#systemSettingsForm button[type="submit"]').click();assert.equal((await savedSettings).status(),200);await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Οι ρυθμίσεις αποθηκεύτηκαν.');
  await nav('payroll');await page.locator('#payrollSourceInfo').waitFor();assert.match(await page.locator('#payrollSourceInfo').textContent(),/δημοσιευμένο πρόγραμμα/);await capture('payroll-source');
  const seeded=await call('/api/admin/schedule-week',{method:'POST',token,body:{assignments:[{employeeId:employee.id,date:'2026-11-02',templateId:'tpl-0800-1600',withoutVehicle:true}]}});assert.equal(seeded.status,201,JSON.stringify(seeded.data));
  await nav('schedules');await page.locator('#scheduleImportButton').click();await page.locator('#scheduleTemplateFrom').fill('2026-11-02');await page.locator('#scheduleTemplateTo').fill('2026-11-15');
  const file=path.join(output,mode+'-schedule.xlsx');
  if(mode==='client'){
   await page.evaluate(()=>{window.AndroidFleet={exportHistoryExcel:(encoded,name)=>{window.__nativeWorkbook={encoded,name};}};});
   await page.locator('#scheduleDownloadTemplate').click();await page.waitForFunction(()=>window.__nativeWorkbook);
   const exported=await page.evaluate(()=>window.__nativeWorkbook);assert.match(exported.name,/2026-11-02_2026-11-15/);fs.writeFileSync(file,Buffer.from(exported.encoded,'base64'));
  }else{const waiting=page.waitForEvent('download');await page.locator('#scheduleDownloadTemplate').click();const download=await waiting;await download.saveAs(file);assert.match(download.suggestedFilename(),/2026-11-02_2026-11-15/);}
  assert.ok(fs.statSync(file).size>10000);
  await page.locator('#scheduleImportFile').setInputFiles(file);await page.waitForFunction(()=>!document.querySelector('#scheduleImportCommit').disabled||document.querySelector('#scheduleImportError').textContent||document.querySelector('#scheduleImportPreview').textContent.includes('Χρειάζονται διορθώσεις'));assert.equal(await page.locator('#scheduleImportCommit').isDisabled(),false,(await page.locator('#scheduleImportError').textContent())+' '+(await page.locator('#scheduleImportPreview').textContent()));assert.equal(await page.locator('.import-week-summary>span').count(),2);await capture('excel-preview');
  await page.locator('#scheduleImportCommit').click();if(await page.locator('#simpleDialog[open]').count())await page.locator('#simpleSubmit').click();await page.waitForFunction(()=>!document.querySelector('#scheduleImportDialog').open);assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM schedule_week_drafts WHERE week_start BETWEEN '2026-11-02' AND '2026-11-09'").get().n,2);
  await nav('employees');await page.locator('.employee-card').filter({hasText:name}).locator('[data-employee-delete]').click();await page.locator('#employeeDeleteName').fill(name);await page.locator('#employeeDeleteReason').fill('Browser archive verification');await page.locator('#simpleSubmit').click();await page.waitForFunction(()=>!document.querySelector('#simpleDialog').open);await page.locator('.employee-card').filter({hasText:name}).waitFor({state:'detached'});assert.ok(db.sqlite.prepare('SELECT deleted_at FROM app_users WHERE id=?').get(employee.id).deleted_at);
  assert.deepEqual(errors,[]);report.push({mode,accountlessCreation:true,sameIdLoginActivation:true,sourceSelection:true,workbookDownloadAndUpload:true,twoWeeks:true,safeArchive:true,errors});
 }catch(error){console.error(JSON.stringify({mode,fixtureOnly:true,importError:await page.locator('#scheduleImportError').textContent(),preview:await page.locator('#scheduleImportPreview').textContent(),pageErrors:errors}));await page.screenshot({path:path.join(output,mode+'-FAILURE.png')});throw error;}finally{await context.close();}
}
fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({data:'Synthetic SQLite fixture only',report},null,2));console.log('PASS real browser Web desktop/mobile and file Client: accountless employee, same-ID login activation, payroll source, fresh workbook download and multi-week upload, themed confirmation and safe employee archive.');
}finally{await browser.close();}
