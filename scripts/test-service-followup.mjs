import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import '../cloudflare-worker/public/service-model.js';
const M=globalThis.FleetServiceModel,require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{JSDOM}=require('jsdom');
const bike={id:'b',name:'ΒΤΟ 756',history:[
 {id:'old',type:'service',date:'2026-09-01',km:10000,tasks:['Λάδια'],updatedAt:'before'},
 {id:'same',type:'service',date:'2026-09-01',km:8000,updatedAt:'before'},
 {id:'new',type:'service',date:'2026-10-01',km:9000,updatedAt:'before'},
 {id:'after',type:'check',date:'2026-10-02',km:9100,updatedAt:'before'},
 {id:'pdf',type:'service',date:'2026-10-03',km:9200,attachments:[{key:'pdf'}]},
 {id:'queued',type:'service',date:'2026-10-04',km:9400},
 {id:'reading',type:'service',date:'2026-10-05',km:9500,invoiceData:{qrUrl:'https://fixture.invalid/i',qrProcessingStatus:'processing'}}
]};
let warnings=M.chronology(bike);assert.equal(warnings.length,1);assert.equal(warnings[0].entry.id,'new');assert.equal(warnings[0].previous.id,'old');
const signature=warnings[0].signature;bike.history[2].kmAcknowledgments=[{signature,reason:'Αλλαγή κοντέρ',at:'now',actor:'Owner'}];assert.ok(M.chronology(bike)[0].acknowledgment);
bike.history[2].km=8999;assert.equal(M.chronology(bike)[0].acknowledgment,null,'Changing either mileage invalidates a previous acknowledgement');bike.history[2].km=9000;
bike.history[0].date='2026-09-02';assert.equal(M.chronology(bike)[0].acknowledgment,null,'Changing either date invalidates the acknowledgement');bike.history[0].date='2026-09-01';
assert.deepEqual(M.missingInvoices([bike],{queuedEntryIds:['queued']}).map(r=>r.entry.id),['new','old','same']);
bike.history[2].invoiceExpectation={status:'not_expected',reason:'Χωρίς χρέωση',at:'now',actor:'Owner'};
assert.equal(M.missingInvoices([bike],{from:'2026-10-01',queuedEntryIds:['queued']}).length,0);
assert.equal(M.missingInvoices([bike],{from:'2026-10-01',queuedEntryIds:['queued'],includeExempt:true})[0].exempt,true);
assert.equal(M.missingInvoices([bike],{bikeId:'other'}).length,0);
const dom=new JSDOM('<button data-open-followup="missing">Άνοιγμα</button>',{url:'https://fixture.invalid',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
for(const f of ['service-model.js','service-tools.js'])w.eval(fs.readFileSync('cloudflare-worker/public/'+f,'utf8'));
const data=JSON.parse(JSON.stringify(bike));let writes=0,actionBodies=[];
w.FleetFollowupAdapter={canManage:()=>true,toast(){},getBikes:()=>[data],getOutbox:async()=>[{data:{bikeId:'b',entryId:'queued',items:[{done:false,qr:'qr'}],error:'Αναμονή σύνδεσης'}}],
 api:async(path,options)=>{if(path==='/api/snapshot')return {bikes:[data]};if(path.startsWith('/api/admin/service-documents?paged=1'))return {documents:[{id:'doc',bikeId:'b',bikeName:data.name,entryId:'pdf',serviceDate:'2026-10-03',name:'test.pdf',key:'pdf',status:'needs_review'}]};if(path==='/api/admin/service-documents/reprocess-batch')return {batch:null};assert.equal(path,'/api/admin/service-followup');writes++;actionBodies.push(options.body);const e=data.history.find(e=>e.id===options.body.entryId);e.invoiceExpectation={status:options.body.status,reason:options.body.reason,at:'now',actor:'Owner'};return {bike:data};},applyBike(){},edit(){},review(){},retryOutbox:async()=>{}};
w.eval(fs.readFileSync('cloudflare-worker/public/service-followup.js','utf8'));await w.FleetFollowup.open('missing');
const d=w.document.querySelector('.followup-dialog');assert.equal(d.dataset.count,'2','Local upload and active analysis are not falsely listed as missing PDF');
d.querySelector('[data-followup-action=expectation]').click();const textarea=w.document.querySelector('[data-reason]');assert.ok(textarea);textarea.value='Δωρεάν εργασία <script>alert(1)</script>';textarea.closest('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await new Promise(r=>setImmediate(r));assert.equal(writes,1);assert.equal(actionBodies[0].expectedEntryUpdatedAt,'before');assert.equal(d.dataset.count,'1');
d.querySelector('[data-exempt]').checked=true;d.querySelector('[data-exempt]').dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(d.dataset.count,'3');assert.equal(d.querySelector('script'),null,'Stored explanations are escaped');
d.querySelector('[data-followup-tab=pending]').click();assert.equal(d.dataset.count,'2');assert.match(d.textContent,/Τοπική ουρά|Αποτυχία αποστολής/);assert.match(d.textContent,/Έλεγχος \/ διόρθωση/);
const oldApi=w.FleetFollowupAdapter.api;let reportReady=true;
w.FleetFollowupAdapter.api=async(path,options)=>path==='/api/admin/server-report'?{ready:reportReady,message:'Περιμένει τον Server',report:{costCents:5900,services:1,documents:2,unknownCosts:0,bikes:[{name:'<img src=x onerror=alert(1)>',costCents:5900,services:1,missingInvoices:0,unknownCosts:0}],issues:[{bike:'BTO 756',date:'2026-10-01',detail:'<script>unsafe</script>',kind:'invoice-km'}]}}:oldApi(path,options);
d.querySelector('[data-server-report-open]').click();await new Promise(r=>setImmediate(r));let reportNode=w.document.querySelector('[data-server-report]');assert.match(reportNode.textContent,/59,00/);assert.equal(reportNode.querySelector('img,script'),null);assert.match(reportNode.textContent,/unsafe/);
reportReady=false;w.document.querySelector('[data-server-report-refresh]').click();await new Promise(r=>setImmediate(r));assert.equal(reportNode.textContent,'Περιμένει τον Server','Stale reports never display old totals');w.document.querySelector('[data-server-report-back]').click();assert.ok(d.open,'Back returns to previous dialog');
d.querySelector('[data-followup-close]').click();assert.equal(w.document.querySelector('.followup-dialog'),null);w.close();
console.log('OK service follow-up: same-day ambiguity excluded, bound chronology acknowledgements, date/plate filters, explicit invoice exemptions, queued/processing exclusions, actual unified DOM actions and escaping.');
