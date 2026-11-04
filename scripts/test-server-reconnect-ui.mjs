import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{JSDOM}=require('jsdom');
const dom=new JSDOM(fs.readFileSync('server-android/assets/www/index.html','utf8'),{url:'https://server.fixture.invalid',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,d=w.document,timers=[],requests=[];
w.setInterval=(fn,ms)=>{timers.push({fn,ms});return timers.length;};w.HTMLElement.prototype.scrollIntoView=function(){};
let status={configured:true,account:'Synthetic <img>',cityId:'7',cities:[{id:'7',name:'City <one>'},{id:'8',name:'City two'}],enabled:true,autoReconnect:true,reconnectAvailable:true,authState:'connected'},pending;
w.AndroidServer={getDashboard:()=>JSON.stringify({settingsLoaded:true,workerUrl:'https://fixture.invalid',health:{},ota:{}}),getOrdexaStatus:()=>JSON.stringify(status),getStoreBillingStatus:()=>JSON.stringify({pendingDays:3}),loadReleases(){},ordexaLogin:s=>capture('ordexaLogin',s),ordexaConfigure:s=>capture('ordexaConfigure',s),ordexaCheck:s=>capture('ordexaCheck',s),ordexaPreview:s=>capture('ordexaPreview',s),ordexaSync:s=>capture('ordexaSync',s),ordexaStoresRequest:s=>capture('ordexaStoresRequest',s)};
function capture(name,s){pending={name,input:JSON.parse(s)};requests.push(pending);}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function finish(extra={}){const p=pending;w.FleetServer.onNativeEvent(p.name,{requestId:p.input.requestId,ok:true,...extra});}
try{
 for(const file of ['app.js','server-diagnostics.js','ordexa-server.js','server-ui.js'])w.eval(fs.readFileSync('server-android/assets/www/'+file,'utf8'));
 const root=d.getElementById('ordexaServerPanel'),$=s=>root.querySelector(s);
 assert.equal(d.querySelector('script[src="./server-direct.js"]'),null);assert.doesNotMatch(d.body.textContent,/Εφεδρική πρόσβαση χωρίς D1/);assert.equal(d.querySelectorAll('[data-panel]').length,4);
 assert.equal(root.querySelector('img'),null);assert.match($('[data-account]').textContent,/<img>/);assert.match($('[data-auth-title]').textContent,/Συνδεδεμένο/);assert.equal($('[name=autoReconnect]').checked,true);
 $('[name=cityId]').value='8';$('[name=cityId]').dispatchEvent(new w.Event('change',{bubbles:true}));status={...status,authState:'waiting',authError:'Θα επαναληφθεί αυτόματα.'};timers.find(t=>t.ms===15000).fn(); // hidden tab intentionally does no refresh
 d.getElementById('panelSettings').classList.remove('is-hidden');timers.find(t=>t.ms===15000).fn();assert.equal($('[name=cityId]').value,'8','Polling preserves an unsaved city');assert.match($('[data-auth-title]').textContent,/Αναμονή/);assert.equal($('[data-auth]').classList.contains('is-connected'),false);
 $('[data-config]').dispatchEvent(new w.Event('submit',{cancelable:true}));assert.equal(pending.input.cityId,'8');assert.equal(pending.input.autoReconnect,true);assert.equal($('[name=cityId]').disabled,true);
 w.FleetServer.onNativeEvent('ordexaConfigure',{ok:true,requestId:'unrelated'});assert.equal($('[name=cityId]').disabled,true,'Unrelated native event cannot finish pending save');status={...status,cityId:'8'};finish();await tick();assert.equal($('[name=cityId]').disabled,false);
 $('[name=password]').value='synthetic-password';$('[data-login]').dispatchEvent(new w.Event('submit',{cancelable:true}));assert.equal($('[name=password]').value,'');assert.equal(pending.input.autoReconnect,true);assert.equal(pending.input.password,'synthetic-password');finish({ok:false,message:'Synthetic login rejected'});await tick();assert.match($('[data-message]').textContent,/rejected/);assert.equal($('[name=password]').value,'');assert.equal($('[data-config] button[type=submit]').disabled,false);
 $('[data-check]').click();assert.equal(pending.name,'ordexaCheck');finish();await tick();assert.match($('[data-message]').textContent,/επιβεβαιώθηκε/);assert.equal(requests.some(r=>r.name==='ordexaSync'),false,'Connection check does not import business data');
 assert.match($('[data-presence-details]').textContent,/31 ημέρες ανά αίτημα/);assert.match($('[data-stores-details]').textContent,/ανά κατάστημα/);assert.match($('[data-stores-status]').textContent,/3 ημερών/);
 const field=d.getElementById('backupHour'),group=d.getElementById('settingsBackups');assert.equal(group.open,false);field.dispatchEvent(new w.Event('invalid',{cancelable:true}));assert.equal(group.open,true,'Validation reveals collapsed invalid settings');
 assert.equal(d.querySelector('[data-open-diagnostics]').closest('details').id,'settingsDiagnostics');assert.equal(timers.filter(t=>t.ms===5000).length,0,'Removed direct-access panel adds no polling');
 console.log('PASS actual Server UI: all four tabs, escaped account/cities, reconnect states, dirty settings, one correlated save, cleared password, read-only connection check, collapsed validation, diagnostics and no hidden fallback polling.');
}finally{w.close();}
