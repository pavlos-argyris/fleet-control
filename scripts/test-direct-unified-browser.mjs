import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {managementData} from './fixtures/native-management-browser-data.mjs';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{chromium}=require('playwright');
const origin='https://fleet-control.duckdns.org',out=path.resolve('.build/direct-unified-browser');
fs.mkdirSync(out,{recursive:true});
execFileSync('python3',['scripts/prepare-unified-direct.py',path.join(out,'src'),path.join(out,'assets')],{stdio:'pipe'});
const staged=path.join(out,'assets/independent-www');
const csp=fs.readFileSync('independent-android/src/gr/argyrismitsos/fleetserver/IndependentHttps.java','utf8').match(/Content-Security-Policy: (.*?)\\r\\n/)[1];
const selection={schema:1,revision:7,selectedMode:'direct',activeMode:'direct',directOnly:true,directApproved:true,pending:false,cloudUrl:'https://fleet-control.pavlosargyris.workers.dev',directUrl:origin,updatedAt:1};
const user={id:'fixture-owner',username:'fixture.owner',fullName:'Συνθετικός ιδιοκτήτης',role:'owner',permissions:['*']};
const bikes=Array.from({length:27},(_,i)=>({id:'bike-'+i,name:'Μηχανάκι '+i,currentKm:9000,lastServiceKm:8000,intervalKm:2000,history:[],updatedAt:'2026-11-13T12:00:00Z'}));
const invoices=Array.from({length:57},(_,i)=>({id:'invoice-'+i,key:'service-documents/b/e'+i+'/f.pdf',bikeId:'bike-0',bikeName:'Μηχανάκι 0',entryId:'e'+i,name:'Fixture-'+i+'.pdf',status:'warning',serviceDate:'2026-11-10',invoiceData:{}}));
const browser=await chromium.launch({headless:true,executablePath:process.env.FLEET_CHROMIUM_PATH||undefined});
try{for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900},locale:'el-GR',timezoneId:'Europe/Athens',serviceWorkers:'block'}),page=await context.newPage();
  const requests=[],errors=[],missing=[],management=managementData();let logged=false,invoiceRequests=0;
  page.on('pageerror',error=>errors.push(error.message));
  await context.addInitScript(selection=>{
    localStorage.setItem('fleet-backend-selection-v1',JSON.stringify(selection));
    // Regression: an old saved endpoint must not send Direct account data to it.
    localStorage.setItem('fleet-control-server-url','https://old-cloud.invalid');
  },selection);
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());requests.push(url.pathname+url.search);
    assert.equal(url.origin,origin,'all normal Direct resources and APIs stay on the Android origin');
    if(url.pathname==='/fleet-mode.json')return route.fulfill({json:selection});
    if(url.pathname.startsWith('/api/')){
      const preflight=url.pathname.startsWith('/api/auth/')||url.pathname.startsWith('/api/independent/');
      if(!preflight&&request.headers()['x-fleet-backend-revision']!=='7')return route.fulfill({status:409,json:{error:'Synthetic revision fence rejected the request'}});
      if(url.pathname==='/api/auth/bootstrap-status')return route.fulfill({json:{configured:true}});
      if(url.pathname==='/api/auth/user-login'){logged=true;return route.fulfill({json:{token:'unified-fixture-token',user}});}
      if(url.pathname==='/api/auth/me')return route.fulfill({status:logged?200:401,json:logged?{user}:{error:'Χρειάζεται σύνδεση.'}});
      if(url.pathname==='/api/independent/status'){
        assert.equal(request.headers().authorization,'Bearer unified-fixture-token','fresh login diagnostics use the authenticated session, even before persistent storage completes');
        return route.fulfill({json:{instanceId:'fixture-instance',mode:'primary',ordexaLastSuccessAt:null}});
      }
      if(url.pathname==='/api/independent/events')return route.fulfill({contentType:'text/event-stream',body:'event: ready\ndata: {}\n\n'});
      if(url.pathname==='/api/sync')return route.fulfill({json:{bikes,version:10,archivedBikeIds:[]}});
      if(url.pathname==='/api/admin/vehicles/archived')return route.fulfill({json:{bikes:[]}});
      if(url.pathname==='/api/workforce/vehicles')return route.fulfill({json:{vehicles:bikes.map(b=>({...b,status:'available',odometer:b.currentKm}))}});
      if(url.pathname==='/api/admin/service-documents'){
        invoiceRequests++;const offset=url.searchParams.has('cursor')?32:0;
        return route.fulfill({json:{documents:invoices.slice(offset,offset+32),serverVersion:10,hasMore:offset===0,nextCursor:offset===0?'10:32':''}});
      }
      if(url.pathname==='/api/admin/service-documents/reprocess-batch')return route.fulfill({json:{batch:null}});
      const result=management({url:request.url(),method:request.method(),body:request.postData()||''},{result:(value,code=200)=>({value,code})});
      if(result&&result.code!==404)return route.fulfill({status:result.code,json:result.value});
      return route.fulfill({json:{configured:true,user,serverVersion:1,employees:[],vehicles:[],today:{vehicles:{}},currentWeek:{startDate:'2026-11-09',endDate:'2026-11-15'},realtime:[],dailySchedule:[],actionGroups:{},summary:{},alerts:[]}});
    }
    const name=['/','/index.html'].includes(url.pathname)?'portal.html':url.pathname==='/fleet.html'?'index.html':url.pathname.slice(1),file=path.resolve(staged,name);
    if(!file.startsWith(staged+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){missing.push(url.pathname);return route.fulfill({status:404});}
    return route.fulfill({path:file,headers:{'Content-Security-Policy':csp},contentType:({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.wasm':'application/wasm'})[path.extname(file)]||'application/octet-stream'});
  });
  try{
    await page.goto(origin+'/');await page.locator('#loginForm').waitFor({state:'visible'});
    await page.locator('#loginUsername').fill('fixture.owner');await page.locator('#loginPassword').fill('Fixture-Password');await page.locator('#loginButton').click();await page.locator('#portal').waitFor({state:'visible'});
    assert.equal(await page.locator('#fleetBackendStatus').isHidden(),true);assert.equal(await page.locator('#fleetPrimaryStatus').isHidden(),true);
    await page.waitForTimeout(1900);
    assert.equal(requests.some(p=>p.startsWith('/api/sync')),false,'opening the home page does not secretly read the full Fleet history');
    assert.equal(await page.locator('#fleetModuleFrame').getAttribute('src'),null);
    const fleet=page.locator('#bottomNav [data-go="fleet"]');if(await fleet.isVisible())await fleet.click();else await page.locator('#sideNav [data-go="fleet"]').click();
    const embedded=page.frameLocator('#fleetModuleFrame');await embedded.locator('#bikeCount').filter({hasText:'27'}).waitFor();
    assert.equal(await embedded.locator('#fleetLoadNotice').isHidden(),true,'complete same-origin Fleet read clears the loading state');
    assert.equal(await page.locator('#fleetBackendStatus').isHidden(),true);assert.equal(await page.locator('#fleetPrimaryStatus').isHidden(),true);
    await page.screenshot({path:path.join(out,'fleet-'+width+'.png'),fullPage:true});
    const documents=page.locator('#bottomNav [data-go="invoices"]');if(await documents.isVisible())await documents.click();else await page.locator('#sideNav [data-go="invoices"]').click();
    await page.locator('[data-invoice-card]').first().waitFor();await page.locator('#invoiceLoadProgress').waitFor({state:'hidden'});
    assert.equal(invoiceRequests,2,'full 57-invoice fixture needs only two requests');
    await page.screenshot({path:path.join(out,'invoices-'+width+'.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.deepEqual(errors,[]);assert.deepEqual(missing,[]);
  }catch(error){fs.writeFileSync(path.join(out,'error-'+width+'.json'),JSON.stringify({requests,errors,missing},null,2));await page.screenshot({path:path.join(out,'error-'+width+'.png'),fullPage:true});throw error;}finally{await context.close();}
}}finally{await browser.close();}
console.log('PASS actual normal Direct Portal/Fleet/Invoices at 390/1280: same-origin despite stale URL, revision fence, 27 loaded bikes, no hidden Fleet reads or top technical banners, fresh-login owner session, complete 57 invoices in two reads. Synthetic data/network; physical Note10+/Nova not measured.');
