import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{chromium}=require('playwright');
const out=path.resolve('.build/unified-server-browser');fs.mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.FLEET_CHROMIUM||undefined,args:['--no-sandbox','--allow-file-access-from-files']});
try{for(const width of [320,390,1280]){
  const context=await browser.newContext({viewport:{width,height:900},locale:'el-GR',timezoneId:'Europe/Athens'}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await context.addInitScript(()=>{
    const data={settingsLoaded:true,workerUrl:'https://fleet-control.pavlosargyris.workers.dev',automaticStart:true,automaticBackup:true,backupFrequency:'daily',backupHour:3,backupRetention:30,syncSeconds:30,invoiceParallelism:4,ocrParallelism:1,serverVersion:'2.12.0',serviceRunning:true,serverOnline:false,bikes:27,users:37,health:{},backupFolderSelected:false,ota:{stage:'idle'}};
    window.fixture={mode:{schema:1,revision:0,selectedMode:'cloudflare',activeMode:'cloudflare',listener:'HTTPS listener ανενεργός · θύρα 8443',certificate:'CERT_CHAIN_UNTRUSTED'},changes:[],prepared:0};
    const noop=()=>{};
    window.AndroidServer=new Proxy({getDashboard:()=>JSON.stringify(data),getOrdexaStatus:()=>'{"configured":false}',getStoreBillingStatus:()=>'{"configured":false}',getBackendMode:()=>JSON.stringify(window.fixture.mode),prepareDirect(){window.fixture.prepared++;},backendLogin(){window.FleetServer.onNativeEvent('backendMode',{ok:true,message:'Τοπική σύνδεση ιδιοκτήτη.'});},selectBackend(mode,revision){window.fixture.changes.push({mode,revision});Object.assign(window.fixture.mode,{selectedMode:mode,activeMode:mode,revision:revision+1});window.FleetServer.onNativeEvent('backendMode',{ok:true,message:'Η επιλογή αποθηκεύτηκε.'});}}, {get:(target,name)=>target[name]||noop});
  });
  await page.goto('file://'+path.resolve('server-android/assets/www/index.html'));
  for(const tab of ['status','backup','updates','settings']){await page.locator('[data-tab="'+tab+'"]').click();assert(await page.locator('[data-panel="'+tab+'"]').isVisible(),'original tab preserved: '+tab);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'tab fits '+width);}
  await page.locator('#backendModePanel > summary').click();await page.locator('#backendPrepare').click();assert.equal(await page.evaluate(()=>fixture.prepared),1);
  await page.locator('#backendUsername').fill('synthetic.owner');await page.locator('#backendPassword').fill('synthetic-password');await page.locator('#backendOwnerForm button').click();assert.equal(await page.locator('#backendPassword').inputValue(),'');
  await page.locator('#backendModeToggle').check();assert.deepEqual(await page.evaluate(()=>fixture.changes),[{mode:'direct',revision:0}]);assert.equal(await page.locator('dialog[open]').count(),0,'switch has no additional confirmation');
  await page.locator('#backendModeToggle').uncheck();assert.equal(await page.locator('#backendModeToggle').isDisabled(),false,'switch unlocks after the actual result');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'new controls fit '+width);assert.deepEqual(errors,[]);await page.screenshot({path:path.join(out,'settings-'+width+'.png'),fullPage:true});await context.close();
}}
finally{await browser.close();}
console.log('PASS actual Chromium normal Server UI: four original tabs, 320/390/1280, additive preparation, password clearing, immediate switch/CAS result and no confirmation modal. Native/network outcomes are fixture inputs.');
