import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{chromium}=require('playwright');
const out=path.resolve('.build/unified-server-browser');fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.FLEET_CHROMIUM||undefined,args:['--no-sandbox','--allow-file-access-from-files']});
try{for(const directOnly of [true,false])for(const mode of ['cloudflare','direct'])for(const width of [320,390,1280]){
  if(directOnly&&mode==='cloudflare')continue;
  const context=await browser.newContext({viewport:{width,height:900},locale:'el-GR',timezoneId:'Europe/Athens'}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await context.addInitScript(({mode,directOnly})=>{
    const data={settingsLoaded:true,workerUrl:'https://fleet-control.pavlosargyris.workers.dev',automaticStart:true,automaticBackup:true,backupFrequency:'daily',backupHour:3,backupRetention:30,syncSeconds:30,invoiceParallelism:4,ocrParallelism:1,serverVersion:'2.13.0',serviceRunning:true,serverOnline:false,bikes:27,users:37,health:{},backupFolderSelected:false,ota:{stage:'idle'}};
    if(mode==='direct')Object.assign(data,{workerUrl:'https://fleet-control.duckdns.org',dataSource:'Direct · ανεξάρτητα δεδομένα'});
    window.fixture={mode:{schema:1,revision:0,selectedMode:mode,activeMode:mode,directOnly,listener:'HTTPS listener ανενεργός · θύρα 8443',certificate:'CERT_CHAIN_UNTRUSTED'},changes:[],prepared:0};
    if(mode==='direct'){
      let minutes=15;
      window.fixture.fleetCalls=[];
      window.fixture.fleetCloud=(action,value)=>{
        fixture.fleetCalls.push({action,value});
        if(action==='interval') minutes=value;
        window.FleetServer.onNativeEvent('fleetCloud',{ok:true,connection:'approved',approved:true,minutes,migration:'baseline_staged',replicaPendingInvoices:2,
          sourceJournal:{verified:true,cursor:17,pending:2,acknowledgedCursor:13,lastAcknowledgedAt:1795798800000},
          sourceProgress:{cursor:13,state:'indexed',indexedCursor:13,rows:3},
          baselineProgress:{archive:'staged',projection:{state:'verified'},ledger:{state:'ready'},invoiceImport:{state:'ready'},
            invoices:{queued:1,running:2,review:4}}});
      };
    }
    const noop=()=>{};
    window.AndroidServer=new Proxy({getDashboard:()=>JSON.stringify(data),getOrdexaStatus:()=>'{"configured":false}',getStoreBillingStatus:()=>'{"configured":false}',getDirectAccessState:()=>JSON.stringify(mode==='direct'?{direct:true,enabled:true,online:false,realm:'https://fleet-control.duckdns.org',message:'Σύνδεση με όνομα χρήστη και κωδικό.'}:{enabled:false}),getBackendMode:()=>JSON.stringify(window.fixture.mode),fleetCloud:fixture.fleetCloud,prepareDirect(){window.fixture.prepared++;},backendLogin(){window.FleetServer.onNativeEvent('backendMode',{ok:true,message:'Τοπική σύνδεση ιδιοκτήτη.'});},selectBackend(mode,revision){window.fixture.changes.push({mode,revision});Object.assign(window.fixture.mode,{selectedMode:mode,activeMode:mode,revision:revision+1});window.FleetServer.onNativeEvent('backendMode',{ok:true,message:'Η επιλογή αποθηκεύτηκε.'});}}, {get:(target,name)=>target[name]||noop});
  },{mode,directOnly});
  await page.goto('file://'+path.resolve('server-android/assets/www/index.html'));
  for(const tab of ['status','backup','updates','settings']){await page.locator('[data-tab="'+tab+'"]').click();assert(await page.locator('[data-panel="'+tab+'"]').isVisible(),'original tab preserved: '+tab);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'tab fits '+width);}
  await page.locator('#backendModePanel > summary').click();await page.locator('#backendPrepare').click();assert.equal(await page.evaluate(()=>fixture.prepared),1);
  if(directOnly){
    assert(await page.locator('#backendModeControls').isHidden(),'Server switch retained but inactive');
    assert(await page.locator('#backendModeToggle').isDisabled(),'no visible or enabled Cloud option');
    assert.equal(await page.locator('#backendPolicyTitle').innerText(),'Direct Android Server');
    assert.equal(await page.locator('#backendOwnerForm').isVisible(),false,'no repeated switch-owner form');
    assert.equal(await page.evaluate(()=>fixture.changes.length),0,'opening preparation never selects Cloud');
  }else{
  for(const id of ['backendUsername','backendPassword']){
    const bounds=await page.locator('#'+id).evaluate(input=>{const r=input.getBoundingClientRect(),label=input.closest('label'),text=label.querySelector('span').getBoundingClientRect();return {width:r.width,labelWidth:label.getBoundingClientRect().width,top:r.top,textBottom:text.bottom};});
    assert(bounds.top>=bounds.textBottom&&bounds.width>=bounds.labelWidth-1,'owner field has its own full-width row at '+width+': '+JSON.stringify(bounds));
  }
  await page.locator('#backendUsername').fill('synthetic.owner');await page.locator('#backendPassword').fill('synthetic-password');await page.locator('#backendOwnerForm button').click();assert.equal(await page.locator('#backendPassword').inputValue(),'');
  await page.locator('#backendModeToggle').setChecked(mode!=='direct');assert.deepEqual(await page.evaluate(()=>fixture.changes),[{mode:mode==='direct'?'cloudflare':'direct',revision:0}]);assert.equal(await page.locator('dialog[open]').count(),0,'switch has no additional confirmation');
  await page.locator('#backendModeToggle').setChecked(mode==='direct');assert.equal(await page.locator('#backendModeToggle').isDisabled(),false,'switch unlocks after the actual result');
  }
  if(mode==='direct'){
    assert(await page.getByLabel('Κωδικός σύζευξης').isHidden(),'Direct login does not require a pairing key');
    assert.equal(await page.locator('#settingsPrimary').count(),0,'Independent mode does not offer data synchronization');
    await page.locator('#settingsFleetCloud > summary').click();
    await page.locator('#fleetCloudMigration').filter({hasText:/σε αναμονή επεξεργασίας 3, για έλεγχο 4/}).waitFor();
    assert.match(await page.locator('#fleetCloudMigration').innerText(),/Επαληθευμένα PDF σε αναμονή δοκιμαστικής καταχώρισης 2/);
    const migration=await page.locator('#fleetCloudMigration').innerText();
    assert.match(migration,/Τοπικές εγγραφές σε αναμονή αποστολής 2/);
    assert.match(migration,/Τελευταία επιβεβαιωμένη αποστολή/);
    assert.match(migration,/Επαληθεύτηκαν οι αλλαγές στο δοκιμαστικό αντίγραφο/);
    assert.equal(await page.locator('#fleetCloudMinutes').inputValue(),'15');
    await page.locator('#fleetCloudMinutes').selectOption('1440');
    assert.deepEqual(await page.evaluate(()=>fixture.fleetCalls.at(-1)),{action:'interval',value:1440});
    await page.evaluate(()=>FleetServer.onNativeEvent('fleetCloud',{ok:true,connection:'approved',approved:true,minutes:1440,
      migration:'baseline_staged',baselineProgress:{archive:'staged',projection:{state:'blocked',reason:'baseline_document_missing'}},
      sourceProgress:{cursor:17,state:'blocked',indexedCursor:13,reason:'source_delta_record_conflict'}}));
    assert.match(await page.locator('#fleetCloudMigration').innerText(),/Λείπει συνημμένο από την απογραφή/);
    assert.match(await page.locator('#fleetCloudMigration').innerText(),/χρειάζονται έλεγχο λόγω ασυμφωνίας/);
  }
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'new controls fit '+width);assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(out,(directOnly?'direct-only':mode)+'-settings-'+width+'.png'),fullPage:true});await context.close();
}}
finally{await browser.close();}
console.log('PASS actual Chromium normal Server UI, shipped Direct-only and dormant switch: four original tabs, 320/390/1280, additive preparation, password clearing, immediate switch/CAS result and no confirmation modal. Native/network outcomes are fixture inputs.');
