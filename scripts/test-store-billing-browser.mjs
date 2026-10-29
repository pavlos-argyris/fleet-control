import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{chromium}=require('playwright'),root=path.resolve('cloudflare-worker/public'),output=path.resolve('verification/store-billing');fs.mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--allow-file-access-from-files']}),user={id:'stores-owner',username:'owner',fullName:'Stores Fixture',role:'owner',permissions:['*']};
try{for(const [mode,width,height]of[['desktop',1440,1000],['mobile',390,844],['client-landscape',1024,768]]){
 const context=await browser.newContext({viewport:{width,height},locale:'el-GR',serviceWorkers:'block'}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));let failed=true;const saves=[];
 const store={id:'store:1',name:'Συνθετικό κατάστημα',sourceShopId:'7',revision:1,retainOrders:false,pricingState:'ready',orderCount:9,orderChargeCents:1800,minimumTopUpCents:2200,totalChargeCents:4000,coveredDays:7,terms:{supported:true,unitPriceCents:200,dailyMinimumCents:4000,chargeOnZero:false}};
 await context.addInitScript(({user})=>{localStorage.setItem('fleet-control-auth-token','stores-fixture');localStorage.setItem('fleet-control-user-cache',JSON.stringify(user));},{user});
 await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.protocol==='file:')return route.continue();if(url.pathname.startsWith('/api/')){
  const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};if(request.method()==='OPTIONS')return route.fulfill({status:204,headers});if(url.pathname.startsWith('/api/events/'))return route.fulfill({status:503,headers,json:{error:'Synthetic live disabled'}});
  let data;
  if(url.pathname==='/api/admin/store-billing')data={scope:'source',inputRevision:store.revision,resultRevision:'1',from:url.searchParams.get('from'),to:url.searchParams.get('to'),rows:[store],totals:{orderCount:9,totalChargeCents:4000,coveredDays:7,sourceLastSuccessAt:new Date().toISOString()},operations:[],hasMore:false};
  else if(url.pathname.endsWith('/store-billing/selection'))data={rows:[store]};
  else if(url.pathname.endsWith('/store-billing/days'))data={rows:[{businessDay:'2026-10-26',orderCount:9,unitPriceCents:200,minimumTopUpCents:2200,totalChargeCents:4000}]};
  else if(url.pathname.endsWith('/store-billing/bulk')){const body=request.postDataJSON();saves.push(body);if(failed)return route.fulfill({status:503,headers,json:{error:'Συνθετική αποτυχία αποθήκευσης'}});store.retainOrders=body.patch.retainOrders;store.revision++;data={saved:true,operation:{id:'save',state:'pending'}};}
  else if(url.pathname.endsWith('/store-billing/operations'))data={scope:'source',inputRevision:store.revision,resultRevision:'1',operations:[]};
  else data={configured:true,user,serverVersion:1,bikes:[],employees:[],vehicles:[],today:{vehicles:{}},currentWeek:{},realtime:[],dailySchedule:[],actionGroups:{},summary:{},alerts:[]};
  return route.fulfill({headers,json:data});
 }const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));return file.startsWith(root+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()?route.fulfill({path:file,contentType:({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'}):route.fulfill({status:404});});
 try{
  await page.goto(mode==='client-landscape'?'file://'+path.resolve('client-android/assets/www/portal.html'):'https://fixture.invalid/portal.html');
  await page.locator('#sideNav [data-go="stores"]').waitFor({state:'attached'});
  if(await page.locator('#sideNav [data-go="stores"]').isVisible())await page.locator('#sideNav [data-go="stores"]').click();else{await page.locator('[data-ui-more]').click();await page.locator('#uiMoreItems [data-go="stores"]').click();}
  await page.locator('[data-stores-edit]').waitFor();assert.match(await page.locator('#storeBillingRoot').textContent(),/05:00–05:00/);await page.screenshot({path:path.join(output,mode+'-list.png')});
  await page.locator('[data-stores-edit]').click();const dialog=page.locator('.stores-dialog[open]');await dialog.waitFor();assert.equal(await dialog.locator('[name=retain]').isChecked(),false);await dialog.locator('[name=retain]').check();await dialog.locator('[type=submit]').click();await dialog.locator('[data-error]').filter({hasText:'Δεν αποθηκεύτηκαν'}).waitFor();assert.equal(await dialog.locator('[name=retain]').isChecked(),true);assert.equal(saves.length,1);await page.screenshot({path:path.join(output,mode+'-retention-retry.png')});
  failed=false;await dialog.locator('[type=submit]').click();await dialog.waitFor({state:'detached'});assert.equal(saves.length,2);assert.equal(saves[0].operationId,saves[1].operationId);assert.deepEqual(saves[1].patch,{retainOrders:true});await page.locator('.stores-badge.is-retained').waitFor();
  await page.locator('[data-stores-detail]').click();await dialog.locator('.stores-days').waitFor();await dialog.locator('[data-close]').click();await dialog.waitFor({state:'detached'});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');assert.deepEqual(errors,[]);
  console.log('PASS stores browser '+mode+': real Portal navigation, themed list/editor, default-OFF exception, failed save/retry, same request identity, detail/Back and responsive layout.');
 }finally{await context.close();}
}}finally{await browser.close();}
