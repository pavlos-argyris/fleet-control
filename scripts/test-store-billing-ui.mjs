import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{JSDOM}=require('jsdom');
const dom=new JSDOM('<!doctype html><body><div id="storeBillingRoot"></div></body>',{url:'https://fixture.invalid/portal.html',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new w.Event('close'));};
const state={token:'synthetic-session-a',view:'stores'},calls=[],saves=[];let fail=true,blockRead=null;
const store={id:'store:synthetic',name:'Synthetic <img src=x onerror=bad>',sourceShopId:'7',revision:1,retainOrders:false,pricingState:'ready',newStore:false,orderCount:9,orderChargeCents:1800,minimumTopUpCents:2200,totalChargeCents:4000,coveredDays:7,terms:{supported:true,unitPriceCents:200,dailyMinimumCents:4000,chargeOnZero:false}};
const api=async(path,options={})=>{calls.push({path,options});const u=new URL(path,'https://fixture.invalid');if(path.includes('/selection'))return {rows:[{...store,terms:{...store.terms}}]};
 if(path.endsWith('/bulk')){saves.push(options.body);if(fail)throw Error('Synthetic save failure');store.retainOrders=options.body.patch.retainOrders;store.revision++;return {saved:true,operation:{id:'save',state:'pending'}};}
 if(path.includes('/operations'))return {scope:'scope',inputRevision:1,resultRevision:'1',operations:[]};
 if(path.includes('/days'))return {rows:[{businessDay:'2026-10-26',orderCount:9,unitPriceCents:200,minimumTopUpCents:2200,totalChargeCents:4000}]};
 if(path.includes('/sync'))return {accepted:true,operation:{id:'sync',state:'pending',stage:'Αναμονή Server'}};
 if(blockRead)await blockRead.promise;
 return {scope:'scope',inputRevision:1,resultRevision:'1',from:u.searchParams.get('from'),to:u.searchParams.get('to'),rows:[{...store}],totals:{orderCount:9,totalChargeCents:4000,coveredDays:7,sourceLastSuccessAt:new Date().toISOString()},operations:[],hasMore:false,nextCursor:store.id};};
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
try{
 w.eval(fs.readFileSync('cloudflare-worker/public/store-billing.js','utf8'));const ui=w.FleetStoreBillingUI;ui.mount({state,api,can:()=>true,money:n=>(n/100).toFixed(2)+' €',toast:()=>{}});
 ui.load();await flush();assert.match(w.document.body.textContent,/05:00–05:00/);assert.equal(w.document.querySelectorAll('#storeBillingRoot img').length,0,'source labels are escaped');assert.match(w.document.body.textContent,/Ακολουθεί διαγραφές Ordexa/);
 assert.equal(ui.businessDay(Date.parse('2026-10-26T04:59:59+02:00')),'2026-10-25');assert.equal(ui.businessDay(Date.parse('2026-10-26T05:00:00+02:00')),'2026-10-26');
 w.document.querySelector('[data-stores-edit]').click();await flush();let dialog=w.document.querySelector('dialog'),form=dialog.querySelector('form');assert.ok(dialog.open);assert.equal(form.elements.retain.checked,false,'retention starts OFF');assert.equal(form.elements.changeRetention.checked,false,'unmodified policy is not resent with a price change');
 form.elements.retain.checked=true;form.elements.retain.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(form.elements.changeRetention.checked,true,'single-store toggle explicitly selects the policy change');
 form.dispatchEvent(new w.Event('submit',{cancelable:true,bubbles:true}));await flush();assert.ok(dialog.open,'failed save keeps draft dialog');assert.match(dialog.querySelector('[data-error]').textContent,/Δεν αποθηκεύτηκαν.*Synthetic save failure/);assert.equal(form.elements.retain.checked,true);assert.equal(form.querySelector('[type=submit]').disabled,false);
 fail=false;form.dispatchEvent(new w.Event('submit',{cancelable:true,bubbles:true}));await flush();assert.equal(w.document.querySelector('dialog'),null);assert.equal(saves.length,2);assert.deepEqual(JSON.parse(JSON.stringify(saves[0].patch)),{retainOrders:true});assert.equal(saves[0].operationId,saves[1].operationId,'retry uses the same idempotency key');assert.match(w.document.body.textContent,/Διατήρηση ενεργή/);
 w.document.querySelector('[data-stores-detail]').click();await flush();dialog=w.document.querySelector('dialog');assert.match(dialog.textContent,/Συμπλήρωμα/);dialog.querySelector('[data-close]').click();assert.equal(w.document.querySelector('dialog'),null,'Back returns from detail without leaving app');
 // No hidden-tab progress requests.
 const before=calls.length;Object.defineProperty(w.document,'hidden',{configurable:true,value:true});await ui.changed();assert.equal(calls.length,before);Object.defineProperty(w.document,'hidden',{configurable:true,value:false});
 let release;blockRead={promise:new Promise(r=>release=r)};ui.clear();ui.load();await flush();state.token='synthetic-session-b';ui.clear();release();await flush();assert.equal(w.document.querySelector('#storeBillingRoot').textContent,'','old response cannot repaint another session');
 blockRead=null;ui.load();await flush();const readsBefore=calls.filter(c=>!c.options.method).length;ui.load();ui.load();await flush();assert.equal(calls.filter(c=>!c.options.method).length,readsBefore,'fresh same-range memory cache avoids duplicate reads');
 console.log('PASS shipped store UI/JSDOM:05-day, themed rows/dialog/Back, explicit default-OFF retention, failed-save draft+retry identity, escaped names, hidden-request fence, session reset and same-range read coalescing.');
}finally{dom.window.close();}
