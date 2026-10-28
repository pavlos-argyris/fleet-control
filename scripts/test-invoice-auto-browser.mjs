import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';
import worker,{normalizeFleet} from '../cloudflare-worker/src/worker.js';import {createSimulation} from './fixtures/workforce-simulation.mjs';
import {invoiceText} from './fixtures/invoice-layout.mjs';import {enrichInvoiceExtraction} from '../cloudflare-worker/src/invoice-extraction.js';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{chromium}=require('playwright');
const root=path.resolve('cloudflare-worker/public'),output=path.resolve('verification/invoice-auto');fs.mkdirSync(output,{recursive:true});
const {db,env,call}=createSimulation(),boot=await call('/api/auth/bootstrap',{server:true,method:'POST',body:{fullName:'Συνθετική δοκιμή τιμολογίων',username:'invoiceui',password:'SyntheticInvoiceUI!7'}});assert.equal(boot.status,200);const {token,user}=boot.data;
const key=id=>`service-documents/b/${id}/${id}.pdf`,stamp='2026-10-10T10:00:00Z';
const local=id=>({rawText:invoiceText({count:60,number:'INV'+id,km:id==='2'?'9100':'9000'}),supplier:'ΣΥΝΘΕΤΙΚΟ ΣΥΝΕΡΓΕΙΟ',localReadStatus:'confident',ocrConfidence:100});
const api=(url,body,server=false)=>call(url,{token,server,method:body?'POST':'GET',body});
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--allow-file-access-from-files']}),report=[];
try {for(const [mode,width,height] of [['desktop',1440,1000],['mobile',390,844],['client-landscape',1024,768]].filter(([mode])=>!process.env.FLEET_INVOICE_BROWSER_MODE||mode===process.env.FLEET_INVOICE_BROWSER_MODE)) {
 const entries=['1','2','3'].map(id=>({id,type:'service',date:'2026-10-10',km:9000,tasks:['Γενικός έλεγχος'],notes:'Χειρόγραφη σημείωση',updatedAt:stamp,
  attachments:[{id,key:key(id),name:'Συνθετικό '+id+'.pdf',contentType:'application/pdf',uploadedAt:stamp,ocr:id==='3'?{...enrichInvoiceExtraction(local(id)),confirmedAt:stamp,confirmationMethod:'manual',reviewedBy:'Owner',reviewStatus:'confirmed'}:{supplier:'ΣΥΝΘΕΤΙΚΟ ΣΥΝΕΡΓΕΙΟ'}}]}));
 db.sqlite.prepare('UPDATE fleet_snapshot SET data=?,version=version+1 WHERE id=1').run(JSON.stringify(normalizeFleet({bikes:[{id:'b',name:'BTO-756',currentKm:10000,lastServiceKm:9000,intervalKm:3000,updatedAt:stamp,history:entries}]})));
 db.sqlite.prepare('DELETE FROM fleet_settings WHERE key=?').run('service_invoice_reprocess_batch');
 let starts=0;const context=await browser.newContext({viewport:{width,height},locale:'el-GR',serviceWorkers:'block'}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await context.addInitScript(({token,user})=>{localStorage.setItem('fleet-control-auth-token',token);localStorage.setItem('fleet-control-user-cache',JSON.stringify(user));},{token,user});
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.protocol==='file:')return route.continue();
  if(url.pathname.startsWith('/api/')) {
   const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
   if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
   if(url.pathname.startsWith('/api/events/'))return route.fulfill({status:503,headers:cors,json:{error:'Synthetic realtime disabled'}});
   if(url.pathname==='/api/admin/service-documents/reprocess-batch'&&request.method()==='POST'&&request.postDataJSON()?.action==='start')starts++;
   // Preview is independent of confirmation. Keep this fixture focused on
   // the actual UI/Worker data rather than a synthetic PDF renderer.
   if(url.pathname.startsWith('/api/service-documents/service-documents/'))return route.fulfill({status:404,headers:cors,json:{error:'Συνθετικό PDF προεπισκόπησης'}});
   const headers=new Headers(request.headers());headers.delete('origin');headers.set('Authorization','Bearer '+token);
   const response=await worker.fetch(new Request('https://fixture'+url.pathname+url.search,{method:request.method(),headers,body:['GET','HEAD'].includes(request.method())?undefined:request.postDataBuffer()}),env);
   return route.fulfill({status:response.status,headers:{...Object.fromEntries(response.headers),...cors},body:Buffer.from(await response.arrayBuffer())});
  }
  const file=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/portal.html':url.pathname));
  return file.startsWith(root+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()?route.fulfill({path:file,contentType:({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'}):route.fulfill({status:404});
 });
 const shot=async name=>{assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),mode+' horizontal overflow');await page.screenshot({path:path.join(output,mode+'-'+name+'.png')});};
 try {
  await page.goto(mode==='client-landscape'?'file://'+path.resolve('client-android/assets/www/portal.html'):'https://fixture.invalid/portal.html');
  const nav=width>860?page.locator('#sideNav'):page.locator('#bottomNav'),direct=nav.locator('[data-go="invoices"]');if(await direct.count())await direct.click();else{await nav.locator('[data-ui-more]').click();await page.locator('#uiMoreDialog [data-go="invoices"]').click();}
  await page.locator('#invoiceQueueList [data-invoice-review]').first().waitFor();assert.equal(starts,0,'Installation/view alone does not start retrospective work');
  await page.locator('#viewInvoices .ui-toolbar-details summary').click();await page.locator('#reprocessInvoices').click();await page.locator('#invoiceReprocessDialog[open]').waitFor();assert.match(await page.locator('#invoiceReprocessCount').textContent(),/3 τιμολόγια/);await shot('explicit-all-invoices');
  await page.locator('[data-invoice-reprocess-mode="server-first"]').click();await page.waitForFunction(()=>window.FleetInvoiceApi.getBatch().busy);assert.equal(starts,1);
  const batch=(await api('/api/admin/service-documents/reprocess-batch')).data.batch;
  for(const id of ['1','2','3']){const result=await api('/api/server/service-documents/reprocess-batch',{action:'result',batchId:batch.id,key:key(id),localOcr:local(id)},true);assert.equal(result.status,200,JSON.stringify(result.data));}
  await page.waitForFunction(()=>!window.FleetInvoiceApi.getBatch().busy,{},{timeout:20000});await page.evaluate(()=>window.FleetInvoiceApi.refresh());
  assert.match(await page.locator('#invoiceBulkProgress').textContent(),/Αυτόματα επιβεβαιωμένα: 1/);assert.match(await page.locator('#invoiceBulkProgress').textContent(),/Προς έλεγχο: 1/);assert.match(await page.locator('#invoiceBulkProgress').textContent(),/Προηγούμενες επιβεβαιώσεις: 1/);await page.locator('#invoiceBulkProgress').scrollIntoViewIfNeeded();await shot('mixed-summary');
  await page.locator('[data-ui-invoice-queue="confirmed"]').click();await page.locator('[data-invoice-review="'+key('1')+'"]').waitFor();assert.match(await page.locator('#invoiceQueueList').textContent(),/Αυτόματη επιβεβαίωση/);assert.match(await page.locator('#invoiceQueueList').textContent(),/Χειροκίνητη επιβεβαίωση/);assert.match(await page.locator('#invoiceQueueList').textContent(),/60 γραμμές αποθηκευμένες/);await page.locator('#invoiceQueueList [data-invoice-card]').first().scrollIntoViewIfNeeded();await shot('confirmed-preview');
  await page.locator('[data-invoice-review="'+key('1')+'"]').click();await page.locator('#invoiceReviewDialog[open]').waitFor();const tasks=await page.locator('#invoiceReviewTasks').inputValue();assert.equal(tasks.split('\n').filter(t=>t.startsWith('Εργασία')).length,60);assert.match(tasks,/Εργασία 60/);assert.match(await page.locator('#invoiceReviewWarnings').textContent(),/Αυτόματη επιβεβαίωση/);await page.locator('#invoiceReviewTasks').evaluate(n=>{n.scrollTop=n.scrollHeight;});await shot('full-review');await page.locator('#invoiceReviewSave').scrollIntoViewIfNeeded();assert.ok(await page.locator('#invoiceReviewSave').isVisible());await shot('full-review-actions');
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#invoiceReviewDialog').open&&!document.documentElement.classList.contains('fleet-modal-open'));await page.locator('[data-ui-invoice-queue="attention"]').click();await page.waitForFunction(()=>!document.querySelector('#invoiceQueueList').getAnimations().some(a=>a.playState==='running'));await page.mouse.move(width-30,height/2);await page.mouse.wheel(0,600);await page.locator('[data-invoice-review="'+key('2')+'"]').click();await page.locator('#invoiceReviewDialog[open]').waitFor();assert.match(await page.locator('#invoiceReviewWarnings').textContent(),/χιλιόμετρα/);await shot('manual-reason');
  assert.deepEqual(errors,[]);report.push({mode,width,height,explicitStartOnly:true,allOldInvoices:true,mixedSummary:true,automaticAndManualHistory:true,full60LineReview:true,specificMileageReason:true,errors});
 } catch(error){await shot('FAILURE');fs.writeFileSync(path.join(output,mode+'-failure-dom.json'),JSON.stringify(await page.evaluate(()=>{const b=document.querySelector('[data-invoice-review="service-documents/b/2/2.pdf"]'),r=b?.getBoundingClientRect(),a=[];for(let n=b;n;n=n.parentElement){const s=getComputedStyle(n),v=n.getBoundingClientRect();a.push({tag:n.tagName,id:n.id,cls:n.className,rect:{x:v.x,y:v.y,width:v.width,height:v.height},inert:n.inert,overflow:s.overflow,pointer:s.pointerEvents,transform:s.transform,scrollTop:n.scrollTop,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight});}return {dialogs:Array.from(document.querySelectorAll('dialog[open]')).map(n=>n.id),button:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null,hit:r?document.elementFromPoint(r.x+r.width/2,Math.min(innerHeight-1,r.y+r.height/2))?.outerHTML.slice(0,1000):'',ancestors:a};}),null,2));throw error;} finally{await context.close();}
}
fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({data:'Synthetic only; Chromium/file Client, not a physical Android device',report},null,2)+'\n');
console.log('PASS #6 browser desktop/mobile/file Client landscape: explicit retrospective start, mixed completion counts, automatic/manual labels, compact preview/full 60-row review and specific unresolved mileage reason.');
} finally {await browser.close();}
