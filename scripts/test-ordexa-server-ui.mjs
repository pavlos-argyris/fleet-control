import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url));
const {JSDOM}=require('jsdom');
const dom=new JSDOM('<section id="panelSettings"><section id="ordexaServerPanel"></section></section>',{url:'file:///android_asset/www/index.html',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,events=[],state={configured:false,cities:[],cityId:'',enabled:false};
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
w.FleetServer={onNativeEvent(name){events.push({forwarded:name});}};
w.AndroidServer={getOrdexaStatus:()=>JSON.stringify(state)};
for(const name of ['ordexaLogin','ordexaConfigure','ordexaPreview','ordexaSync'])w.AndroidServer[name]=value=>events.push({name,input:JSON.parse(value)});
try{
 w.eval(fs.readFileSync('server-android/assets/www/ordexa-server.js','utf8'));
 const root=w.document.getElementById('ordexaServerPanel'),$=selector=>root.querySelector(selector);
 assert.equal($('[name=password]').type,'password');assert.equal($('[name=enabled]').checked,false);
 $('[name=username]').value='synthetic-user';$('[name=password]').value='synthetic-password';$('[data-login]').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 const login=events.at(-1);assert.equal(login.name,'ordexaLogin');assert.equal(login.input.username,'synthetic-user');assert.equal(login.input.password,'synthetic-password');assert.ok(login.input.requestId);assert.equal($('[name=password]').value,'');assert.ok($('[data-login] button').disabled);
 w.FleetServer.onNativeEvent('ordexaLogin',{ok:true,requestId:'stale-response'});await tick();assert.ok($('[data-login] button').disabled,'A callback from another page/request must not complete this login');
 Object.assign(state,{configured:true,account:'synthetic-user',cities:[{id:'7',name:'Synthetic city'}]});w.FleetServer.onNativeEvent('ordexaLogin',{ok:true,requestId:login.input.requestId});await tick();assert.equal($('[data-login] button').disabled,false);assert.match($('[data-message]').textContent,/επιβεβαιώθηκε/);assert.match($('[data-status]').textContent,/synthetic-user/);assert.equal($('[name=cityId]').options.length,2);
 $('[name=cityId]').value='7';$('[name=enabled]').checked=true;$('[data-config]').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));const configure=events.at(-1);assert.equal(configure.input.cityId,'7');assert.equal(configure.input.enabled,true);Object.assign(state,{cityId:'7',enabled:true});w.FleetServer.onNativeEvent('ordexaConfigure',{ok:true,requestId:configure.input.requestId});await tick();
 $('[name=from]').value='2026-10-19';$('[data-preview]').click();const preview=events.at(-1);assert.equal(preview.input.day,'2026-10-19');w.FleetServer.onNativeEvent('ordexaPreview',{ok:true,requestId:preview.input.requestId,sessions:2,riders:[{name:'Synthetic rider',sessions:2}]});await tick();assert.match($('[data-message]').textContent,/Δεν έγινε αποθήκευση/);
 $('[name=to]').value='2026-10-20';$('[data-sync]').click();const sync=events.at(-1);assert.equal(sync.input.from,'2026-10-19');assert.equal(sync.input.to,'2026-10-20');w.FleetServer.onNativeEvent('ordexaSync',{ok:false,requestId:sync.input.requestId,message:'Synthetic failed save'});await tick();assert.match($('[data-message]').textContent,/Synthetic failed save/);assert.doesNotMatch($('[data-message]').textContent,/Ολοκληρώθηκε/);assert.equal($('[data-sync]').disabled,false);
 assert.ok(!root.innerHTML.includes('synthetic-password'),'Password must not remain in the rendered page');
 w.FleetServer.onNativeEvent('connection',{ok:true});assert.equal(events.at(-1).forwarded,'connection');
 console.log('PASS shipped Server Ordexa UI: local username/password input, immediate password clearing, correlated native events, city/automatic settings, preview without import and explicit failed sync.');
}finally{w.close();}
