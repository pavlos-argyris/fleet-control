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
const fixtureBikes=Array.from({length:29},(_,i)=>({id:'bike-'+i,name:'Μηχανάκι '+i,currentKm:9000,lastServiceKm:8000,intervalKm:2000,history:Array.from({length:2},(_,j)=>({id:'e-'+j,type:'service',date:'2026-11-10',km:8000,oilChanged:true,tasks:['Fixture service'],invoiceData:{rawText:'Ω'.repeat(110000),totalAmount:'10,00'},attachments:i===28&&j===0?[{id:'fixture-one',key:'fixture/one.pdf',name:'Fixture.pdf',ocr:{invoiceDate:'2026-11-11'}}]:[]})),updatedAt:'2026-11-13T12:00:00Z'}));
const invoices=Array.from({length:57},(_,i)=>({id:'invoice-'+i,key:'service-documents/b/e'+i+'/f.pdf',bikeId:'bike-0',bikeName:'Μηχανάκι 0',entryId:'e'+i,name:'Fixture-'+i+'.pdf',status:'warning',serviceDate:'2026-11-10',invoiceData:{}}));
const browser=await chromium.launch({headless:true,executablePath:process.env.FLEET_CHROMIUM_PATH||undefined});
try{for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900},locale:'el-GR',timezoneId:'Europe/Athens',serviceWorkers:'block'}),page=await context.newPage();
  const bikes=structuredClone(fixtureBikes),mileageReceipts=new Map(),mileageAttempts=[];
  const requests=[],backgroundHistoryRequests=[],errors=[],missing=[],management=managementData();
  let logged=false,invoiceRequests=0,adminAvailable=false,adminPosts=0,fleetRevision=10,writeOffline=false,dropAcknowledgment=false;
  page.on('pageerror',error=>errors.push(error.message));
  await context.addInitScript(selection=>{
    // A fresh Web/Client starts at revision zero, unlike the Server.
    localStorage.removeItem('fleet-backend-selection-v1');
    if(innerWidth===390){let saved='';window.AndroidFleet={getBackendSelection:()=>saved,setBackendSelection:v=>{saved=v;},openBackend:()=>{throw Error('Unexpected native navigation during same-mode bootstrap');},getClientUpdateState:()=>JSON.stringify({stage:'waiting',ready:{version:'99.0.0',notes:'• fixture',sizeBytes:100}}),checkClientUpdate:()=>{window.fixtureUpdateChecked=true;},installClientUpdate:()=>{window.fixtureUpdateInstalled=true;}};}
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
      if(url.pathname==='/api/independent/server-admin'){
        assert.equal(request.headers().authorization,'Bearer unified-fixture-token');
        if(request.method()==='POST'){
          assert.match(request.headers()['x-fleet-operation'],/^[0-9a-f-]{36}$/);
          assert.deepEqual(request.postDataJSON(),{action:'check-update'});
          adminPosts++;
          return route.fulfill({status:202,json:{action:'check-update',state:'queued'}});
        }
        if(!adminAvailable)return route.fulfill({status:503,json:{error:'Διακοπή δοκιμής'}});
        return route.fulfill({json:{observedAt:Date.now(),serverVersion:'2.16.2',https:{listenerActive:true,wifiConnected:true},
          backup:{enabled:false,hour:3,retention:30,frequency:'daily',revision:'false:3:30:daily'},device:{storageFreeBytes:100000000},
          commands:adminPosts?[{action:'check-update',state:'queued',created_at:Date.now()}]:[]}});
      }
      if(url.pathname==='/api/independent/events')return route.fulfill({contentType:'text/event-stream',body:'event: ready\ndata: {}\n\n'});
      if(url.pathname==='/api/sync'){
        const view=url.searchParams.get('view');
        if(url.searchParams.get('sinceVersion')===String(fleetRevision)&&view!=='qr-attention')return route.fulfill({json:{unchanged:true,version:fleetRevision}});
        if(view==='cards')return route.fulfill({json:{view,bikes:bikes.map(({history,...card})=>({...card,nextServiceKm:10000})),version:fleetRevision,archivedBikeIds:[]}});
        if(view==='qr-attention')return route.fulfill({json:{count:2}});
        assert.equal(url.searchParams.get('paged'),'1','normal Direct reads bounded canonical pages');
        const offset=Number((url.searchParams.get('cursor')||'10:0').split(':')[1]),next=Math.min(offset+4,bikes.length);
        return route.fulfill({json:{paged:true,bikes:bikes.slice(offset,next),version:10,totalBikes:bikes.length,offset,hasMore:next<bikes.length,nextCursor:next<bikes.length?'10:'+next:'',archivedBikeIds:[]}});
      }
      if(url.pathname==='/api/sync/bike'){
        if(request.method()==='POST'){
          const body=request.postDataJSON();
          assert.deepEqual(Object.keys(body),['mileage']);
          assert.ok(request.postData().length<200);
          const {bikeId,km,id,date}=body.mileage;
          assert.equal(request.headers()['x-fleet-operation'],id,'the same durable ID is used for the Android and browser receipt');
          mileageAttempts.push({id,bikeId,km,date});
          if(writeOffline)return route.abort('connectionrefused');
          if(mileageReceipts.has(id))return route.fulfill({json:mileageReceipts.get(id)});
          const bike=bikes.find(item=>item.id===bikeId),{history,...card}=bike;
          const entry={id,km,date,type:'check'},nextCard={...card,currentKm:km,nextServiceKm:10000,lastCheckedAt:date};
          Object.assign(bike,nextCard,{history:[entry,...history]});
          const receipt={saved:true,card:nextCard,entry,version:++fleetRevision};
          mileageReceipts.set(id,receipt);
          if(dropAcknowledgment){dropAcknowledgment=false;return route.abort('connectionreset');}
          return route.fulfill({json:receipt});
        }
        const bike=bikes.find(item=>item.id===url.searchParams.get('id'));
        const view=url.searchParams.get('view');
        if(view==='history'||view==='history-preview'){
          if(request.headers()['x-fleet-read-priority']==='background')backgroundHistoryRequests.push(bike.id);
          const preview={...bike,history:bike.history.map(entry=>{
            if(!entry.invoiceData)return entry;
            const {rawText,...invoiceData}=entry.invoiceData;
            return {...entry,invoiceData:{...invoiceData,hasRawText:Boolean(rawText)}};
          })};
          return route.fulfill({json:{bike:view==='history-preview'?preview:bike,version:fleetRevision}});
        }
        if(view==='files')return route.fulfill({json:{files:[{key:'fixture/one.pdf',name:'Fixture.pdf',serviceDate:'2026-11-10',invoiceDate:'2026-11-11'}],version:10}});
        const {history,...card}=bike;
        return route.fulfill({json:{bike:{...card,nextServiceNotes:[]},lastService:{date:'2026-11-10',km:8000,tasks:['Fixture service']},version:fleetRevision}});
      }
      if(url.pathname==='/api/admin/vehicles/archived')return route.fulfill({json:{bikes:[]}});
      if(url.pathname==='/api/workforce/vehicles')return route.fulfill({json:{vehicles:bikes.map(b=>({id:b.id,name:b.name,status:'available',odometer:b.currentKm}))}});
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
    if(width===390){await page.locator('#menuButton').click();await page.locator('.sidebar-foot .client-ota-open').click();await page.locator('#clientOtaCheck').click();assert(await page.evaluate(()=>window.fixtureUpdateChecked));await page.locator('.client-ota-close').click();await page.locator('#sidebarBackdrop').click({position:{x:width-10,y:10}});}
    assert.equal(await page.locator('#fleetBackendStatus').isHidden(),true);assert.equal(await page.locator('#fleetPrimaryStatus').isHidden(),true);
    await page.waitForTimeout(1900);
    const prefetches=requests.filter(p=>p.startsWith('/api/sync'));
    assert.deepEqual(prefetches,['/api/sync?paged=1&view=cards'],'home prefetches only the compact card list');
    assert.equal(await page.locator('#fleetModuleFrame').getAttribute('src'),null);
    const fleet=page.locator('#bottomNav [data-go="fleet"]');if(await fleet.isVisible())await fleet.click();else await page.locator('#sideNav [data-go="fleet"]').click();
    const embedded=page.frameLocator('#fleetModuleFrame');await embedded.locator('#bikeCount').filter({hasText:'29'}).waitFor();
    assert.equal(requests.filter(p=>p.includes('view=cards')).length,1,'Fleet reuses the warm card request');
    assert.ok(!requests.includes('/api/workforce/vehicles') && !requests.includes('/api/admin/vehicles/archived'),'closed fleet tools have not loaded');
    assert.equal(await embedded.locator('#fleetLoadNotice').isHidden(),true,'complete same-origin Fleet read clears the loading state even beyond synchronous browser cache capacity');assert.equal(await embedded.locator('.bike-card').count(),29);assert(JSON.stringify(bikes).length>5_000_000,'real Chromium fixture uses multi-megabyte service history');
    await embedded.locator('#qrAttentionBanner').filter({hasText:'2 τιμολόγια'}).waitFor();
    const backgroundHistory = p => p.startsWith('/api/sync/bike?view=history-preview&');
    if(!requests.some(backgroundHistory))await page.waitForResponse(r=>backgroundHistory(new URL(r.url()).pathname+new URL(r.url()).search));
    assert.ok(requests.findIndex(p=>p.includes('view=qr-attention'))<requests.findIndex(backgroundHistory));
    assert.equal(backgroundHistoryRequests[0],'bike-0','the first history uses the background priority');
    assert.equal(await page.locator('#fleetBackendStatus').isHidden(),true);assert.equal(await page.locator('#fleetPrimaryStatus').isHidden(),true);
    await page.waitForFunction(()=>document.querySelector('#fleetModuleShell').classList.contains('is-loaded')&&document.querySelector('#fleetModuleShell').getAttribute('aria-busy')==='false');
    await page.screenshot({path:path.join(out,'fleet-'+width+'.png'),fullPage:true});
    await embedded.locator('[data-bike-id="bike-0"]').click();
    await embedded.getByRole('button',{name:'Ιστορικό',exact:true}).click();
    await embedded.locator('#historyCount').filter({hasText:'2 εγγραφές'}).waitFor();
    assert.equal(requests.filter(p=>p==='/api/sync/bike?view=history-preview&id=bike-0').length,1,'opening a prepared history reuses the background request');
    await embedded.locator('#detailBackButton').click();
    const until=Date.now()+10000;
    while(new Set(backgroundHistoryRequests).size!==29 && Date.now()<until)await page.waitForTimeout(40);
    assert.equal(new Set(backgroundHistoryRequests).size,29,'all bikes receive a compact background history');
    await embedded.locator('[data-bike-id="bike-28"]').click();
    await embedded.locator('#detailLatestService').getByText('Fixture service').waitFor();
    await embedded.locator('[data-ui-bike-tab="files"]').click();
    await embedded.locator('#uiBikeFiles').getByText('Fixture.pdf').waitFor();
    assert.equal(requests.filter(p=>p==='/api/sync/bike?view=files&id=bike-28').length,0,'prepared history includes file names');
    await embedded.getByRole('button',{name:'Ιστορικό',exact:true}).click();
    await embedded.locator('#historyCount').filter({hasText:'2 εγγραφές'}).waitFor();
    assert.equal(requests.filter(p=>p==='/api/sync/bike?view=history-preview&id=bike-28').length,1);
    assert.equal(requests.filter(p=>p==='/api/sync/bike?view=history&id=bike-28').length,0);
    await embedded.getByRole('button',{name:'Σύνοψη',exact:true}).click();
    await embedded.locator('#detailCheckButton').click();
    await embedded.locator('#quickBikePicker').click();
    const registrationOrder=await embedded.locator('[data-pick-bike]').evaluateAll(buttons=>buttons.slice(0,12).map(button=>button.dataset.pickBike));
    assert.deepEqual(registrationOrder,Array.from({length:12},(_,i)=>'bike-'+i));
    await embedded.locator('[data-pick-bike="bike-28"]').click();
    await embedded.locator('#quickCurrentKm').fill('9500');
    if(width===390)writeOffline=true;
    await embedded.locator('#quickCheckForm button[type="submit"]').click();
    if(width===390){
      await embedded.locator('#quickCheckResult').getByText(/Σε αναμονή επιβεβαίωσης/).waitFor();
      await embedded.locator('#quickBikePicker').click();
      await embedded.locator('[data-pick-bike="bike-27"]').click();
      await embedded.locator('#quickCurrentKm').fill('9600');
      await embedded.locator('#quickCheckForm button[type="submit"]').click();
      await embedded.locator('#quickMileageQueue').getByText('2 σε αναμονή αποστολής').waitFor();
      assert.equal(mileageReceipts.size,0,'selecting and saving the next bike did not wait for the offline server');
      await page.reload();
      await page.locator('#portal').waitFor({state:'visible'});
      await fleet.click();
      await embedded.locator('#bikeCount').filter({hasText:'29'}).waitFor();
      await embedded.locator('[data-bike-id="bike-27"]').click();
      await embedded.locator('#detailCheckButton').click();
      await embedded.locator('#quickMileageQueue').getByText('2 σε αναμονή αποστολής').waitFor();
      dropAcknowledgment=true;
      writeOffline=false;
      await embedded.locator('#quickMileageQueue').waitFor({state:'hidden',timeout:15000});
      assert.equal(mileageReceipts.size,2,'both offline submissions reached the server after reload');
      assert.equal(new Set(mileageAttempts.map(attempt=>attempt.id)).size,2,'failed transport and a lost acknowledgment reuse the original IDs');
      assert.ok(mileageAttempts.length>2);
    }else{
      await embedded.locator('#quickCheckResult').getByText(/Ο έλεγχος αποθηκεύτηκε/).waitFor();
      assert.equal(mileageReceipts.size,1);
    }
    await embedded.locator('#quickCheckBackButton').click();
    await embedded.locator('#detailBackButton').click();
    await embedded.locator('#homeView').waitFor({state:'visible'});
    const documents=page.locator('#bottomNav [data-go="invoices"]');if(await documents.isVisible())await documents.click();else await page.locator('#sideNav [data-go="invoices"]').click();
    await page.locator('[data-invoice-card]').first().waitFor();await page.locator('#invoiceLoadProgress').waitFor({state:'hidden'});
    assert.equal(invoiceRequests,2,'full 57-invoice fixture needs only two requests');
    await page.screenshot({path:path.join(out,'invoices-'+width+'.png'),fullPage:true});
    if(width===390){
      await page.locator('#menuButton').click();
      await page.locator('#sideNav [data-go="server"]').filter({hasText:'Διαχείριση Server'}).click();
      const admin=page.locator('#directServerAdmin');
      await admin.locator('[data-admin-message]').filter({hasText:/Διακοπή δοκιμής|HTTP 503|σύνδεση με τον Server/}).waitFor();
      adminAvailable=true;
      await admin.getByRole('button',{name:'Ανανέωση',exact:true}).click();
      await admin.getByText(/HTTPS ενεργό/).waitFor();
      assert(await admin.getByRole('button',{name:'Άνοιγμα τιμολογίων',exact:true}).isVisible());
      await admin.getByRole('button',{name:'Έλεγχος έκδοσης',exact:true}).click();
      await admin.getByText(/Σε αναμονή/).waitFor();
      assert.equal(adminPosts,1);
    }else{
      assert.equal(await page.locator('#directServerAdmin').count(),0);
      assert.equal(requests.some(p=>p.startsWith('/api/independent/server-admin')),false);
    }

    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.deepEqual(errors,[]);assert.deepEqual(missing,[]);
  }catch(error){fs.writeFileSync(path.join(out,'error-'+width+'.json'),JSON.stringify({requests,errors,missing},null,2));await page.screenshot({path:path.join(out,'error-'+width+'.png'),fullPage:true});throw error;}finally{await context.close();}
}}finally{await browser.close();}
console.log('PASS Direct Portal/Fleet/Invoices at 390/1280: all 29 compact histories before opening, two offline mileage checks survive reload and replay the lost acknowledgment, and all 57 invoices arrive in two reads. Physical Android and network timing are separate.');
