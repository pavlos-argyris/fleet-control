import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{chromium}=require('playwright');
const root=path.resolve('cloudflare-worker/public'),output=path.resolve('verification/invoice-retry');fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--allow-file-access-from-files']});
const user={id:'retry-owner',username:'owner',fullName:'Retry Fixture',role:'owner',permissions:['*']},at=new Date().toISOString();
try{for(const [mode,width,height] of [['desktop',1440,1000],['mobile',390,844],['client-tablet',1024,768]]){
 const make=(id,plate,extra={})=>({id,key:'service-documents/b/'+id+'/file.pdf',bikeId:'b',entryId:id,bikeName:plate,name:id+'.pdf',status:'error',error:'Reader failed',canRetry:true,invoiceData:{},warnings:[],...extra});
 let docs=[make('stored','BTO-756'),make('qr','BTO-756',{key:'',jobId:'qr-job',canRestart:true,qrUrl:'https://einvoice.impact.gr/p/RETRY'}),make('other','ΤΝΗ-921'),make('ok','BTO-756',{status:'confirmed',error:''})];
 const alert=(id,jobId)=>({id,type:'invoice_processing_failed',object_type:'invoice_job',object_id:jobId,title:'Το τιμολόγιο χρειάζεται επανάληψη',message:'Reader failed',severity:'warning',created_at:at});
 let alerts=[alert('stored-alert','stored-old'),alert('qr-alert','qr-job')],posts=[],failQr=true;
 const context=await browser.newContext({viewport:{width,height},locale:'el-GR',serviceWorkers:'block'}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await context.addInitScript(({user})=>{localStorage.setItem('fleet-control-auth-token','retry-fixture');localStorage.setItem('fleet-control-user-cache',JSON.stringify(user));},{user});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url()),request=route.request();if(url.protocol==='file:')return route.continue();
  if(url.pathname.startsWith('/api/')){
   const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
   if(request.method()==='OPTIONS')return route.fulfill({status:204,headers});
   if(url.pathname.startsWith('/api/events/'))return route.fulfill({status:503,headers,json:{error:'Realtime disabled in fixture'}});
   if(url.pathname==='/api/admin/service-documents/retry-failed'){
    const body=request.postDataJSON();posts.push(body);await new Promise(r=>setTimeout(r,150));
    if(body.jobId==='qr-job'&&failQr)return route.fulfill({status:503,headers,json:{error:'Fixture retry failed HTTP 503'}});
    const row=body.key?docs.find(d=>d.key===body.key):docs.find(d=>d.id==='qr');if(row)row.status='processing';
    const notice=alerts.find(a=>a.id===(body.alertId||'stored-alert'));if(notice)notice.invoice_retry_state='processing';
    return route.fulfill({status:202,headers,json:{ok:true,queued:true,status:'processing',jobId:'new-fixture-job'}});
   }
   const data={configured:true,user,alerts,documents:docs,bikes:[],employees:[],vehicles:[],today:{vehicles:{}},currentWeek:{},realtime:[],dailySchedule:[],actionGroups:{},summary:{}};
   return route.fulfill({headers,json:data});
  }
  const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));return file.startsWith(root+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()?route.fulfill({path:file,contentType:({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'}):route.fulfill({status:404});
 });
 const navigate=async view=>{const nav=width>860?page.locator('#sideNav'):page.locator('#bottomNav'),direct=nav.locator('[data-go="'+view+'"]');if(await direct.count())await direct.click();else{await nav.locator('[data-ui-more]').click();await page.locator('#uiMoreDialog [data-go="'+view+'"]').click();}await page.locator('[data-view="'+view+'"]:not(.is-hidden)').waitFor();};
 const shot=async name=>{assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),mode+' horizontal overflow');await page.screenshot({path:path.join(output,mode+'-'+name+'.png')});};
 try{
  await page.goto(mode==='client-tablet'?'file://'+path.resolve('client-android/assets/www/portal.html'):'https://fixture.invalid/portal.html');await navigate('invoices');
  await page.locator('#uiInvoiceExtraPicker').click();await page.locator('[data-ui-select-value="error"]').click();
  await page.locator('#invoicePlatePicker').click();await page.locator('[data-ui-select-value="BTO756"]').click();
  await page.locator('#retryAllFailedInvoices').waitFor();assert.match(await page.locator('#retryAllFailedInvoices').textContent(),/2/);
  await page.locator('#retryAllFailedInvoices').click();assert.equal(posts.length,0);await page.locator('#simpleDialog[open]').waitFor();await shot('confirmation');await page.locator('#simpleSubmit').click();
  await page.waitForFunction(()=>document.querySelector('#invoiceRetryProgress').getAttribute('aria-busy')==='false');assert.equal(posts.length,2,'One request per selected failed invoice; no replay of HTTP 503');
  assert.equal(posts.some(p=>p.key?.includes('/other/')||p.key?.includes('/ok/')),false);
  assert.match(await page.locator('#invoiceRetryProgressDetail').textContent(),/Σε ουρά Server: 1/);assert.match(await page.locator('#invoiceRetryProgressDetail').textContent(),/Αποτυχίες υποβολής\/ανάγνωσης: 1/);await shot('mixed-submission');
  await navigate('alerts');await page.locator('[data-retry-invoice-alert="qr-alert"]').waitFor();assert.ok(await page.locator('[data-retry-invoice-alert="stored-alert"]').isDisabled());assert.equal(await page.locator('[data-resolve-alert="qr-alert"]').count(),0);
  failQr=false;const before=posts.length;await page.locator('[data-retry-invoice-alert="qr-alert"]').click();await page.waitForFunction(()=>document.querySelector('[data-retry-invoice-alert="qr-alert"]').disabled);await page.waitForTimeout(400);assert.equal(posts.length,before+1);assert.equal(posts.at(-1).alertId,'qr-alert');await shot('waiting-for-server');
  alerts=alerts.filter(a=>a.id!=='stored-alert');
  await page.locator('[data-retry-invoice-alert="stored-alert"]').waitFor({state:'detached',timeout:20000});
  assert.ok(await page.locator('[data-retry-invoice-alert="qr-alert"]').count(),'Only the successfully processed notice disappears');await shot('automatic-completion');
  assert.deepEqual(errors,[]);
 }finally{await context.close();}
 console.log('PASS browser '+mode+': actual themed UI, selected failures only, mixed HTTP 503/queue progress, no replay, retained notification and automatic successful completion.');
}}finally{await browser.close();}
