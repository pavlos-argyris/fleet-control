import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{JSDOM}=require('jsdom');
const dom=new JSDOM(fs.readFileSync('cloudflare-worker/public/portal.html','utf8'),{url:'https://fixture.invalid',runScripts:'outside-only'}),w=dom.window,d=w.document.getElementById('invoiceReviewDialog'),save=w.document.getElementById('invoiceReviewSave');
// Native close events are deferred, unlike a synchronous close stub. The next
// review must wait for that event and keep its own queue after it arrives.
w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){if(!this.open)return;this.open=false;w.setTimeout(()=>this.dispatchEvent(new w.Event('close')),15);};
const record=(id,status='needs_review')=>({id,key:id+'.pdf',status,bikeId:'bike',entryId:'service-'+id,bikeName:'BTO 756',serviceKm:10000,invoiceData:{odometerKm:'10000',comments:'original'}});
let docs,visible,opened=[],notices=[],requests=[],fail=false,decision=null,afterSave=()=>{},pending=null;
w.state={invoiceReviewTransferChoice:'keep',invoiceDocuments:[]};w.$=id=>w.document.getElementById(id);w.km=String;w.toast=message=>notices.push(message);w.renderInvoiceQueue=()=>{};
w.FleetServiceUI={mileage:async()=>decision};
w.loadInvoices=async()=>{await afterSave();w.state.invoiceDocuments=docs;};
w.api=async(url,options)=>{assert.equal(url,'/api/admin/service-documents/review');requests.push(options.body);if(pending)await pending;if(fail)throw new Error('HTTP 503 — Δοκιμαστική αποτυχία');const original=docs.find(row=>row.key===options.body.key);const document={...original,status:'confirmed',invoiceData:options.body.invoiceData};docs=docs.map(row=>row.id===original.id?document:row);return {document};};
w.FleetInvoiceApi={toast:w.toast,getDocuments:()=>docs,reviewBusy:()=>!!w.state.invoiceReviewSubmitting,review:async id=>{
 const row=docs.find(r=>r.id===String(id));if(!row)return;opened.push(String(id));w.state.invoiceReviewDocument=row;w.state.invoiceDocuments=docs;
 for(const [suffix,value] of Object.entries({Id:row.id,Supplier:'Workshop',Plate:'BTO 756',Odometer:'10000',Number:row.id,Date:'2026-10-02',Total:'59,00',Tasks:'Αλλαγή λαδιών',Comments:row.invoiceData.comments||'',Error:''})){const field=w.$('invoiceReview'+suffix);if('value' in field)field.value=value;else field.textContent=value;}
 save.disabled=false;w.$('invoiceReviewTransfer').classList.add('is-hidden');d.showModal();w.FleetSequentialReview.opened(row.id,visible);
}};
const portal=fs.readFileSync('cloudflare-worker/public/portal.js','utf8'),extract=name=>{const match=portal.match(new RegExp('^  async function '+name+'\\([^]*?^  \\}','m'));assert.ok(match,name);return match[0];};
w.eval(extract('saveAdminInvoiceReview')+'\n'+extract('performAdminInvoiceReview'));
w.eval(fs.readFileSync('cloudflare-worker/public/sequential-review.js','utf8'));w.document.dispatchEvent(new w.Event('DOMContentLoaded'));w.$('invoiceReviewForm').addEventListener('submit',w.saveAdminInvoiceReview);
const tick=()=>new Promise(r=>setTimeout(r,45));
function reset(rows){w.FleetSequentialReview.stop();d.open=false;docs=rows;visible=[...rows];w.state.invoiceDocuments=docs;opened=[];notices=[];requests=[];fail=false;decision=null;pending=null;afterSave=()=>{};}
reset([record('before'),record('current'),record('pending','processing'),record('done','confirmed'),record('broken','error'),record('next'),record('last')]);
w.$('invoicePlateFilter').innerHTML='<option value="BTO756" selected>BTO 756</option>';
await w.FleetInvoiceApi.review('current');w.$('invoiceReviewComments').value='Οι διορθώσεις μου';
fail=true;save.click();await tick();assert.deepEqual(opened,['current']);assert.equal(d.open,true);assert.match(w.$('invoiceReviewError').textContent,/απέτυχε.*HTTP 503/);assert.ok(notices.some(x=>x.includes('Οι διορθώσεις σου παραμένουν')));assert.equal(w.$('invoiceReviewComments').value,'Οι διορθώσεις μου');assert.equal(save.disabled,false);
fail=false;afterSave=()=>{docs=[record('new-upload'),...docs.slice().reverse()];};save.click();await tick();assert.deepEqual(opened,['current','next'],'Ordinary Save follows the original visible order despite polling/reordering, skipping processing/confirmed/error');assert.equal(w.$('invoicePlateFilter').value,'BTO756');assert.equal(requests.at(-1).invoiceData.comments,'Οι διορθώσεις μου');
assert.ok(!w.document.querySelector('[data-sequential-save]'),'One confirmation button, without a second save mode');assert.match(w.document.querySelector('[data-sequential-bar]').textContent,/αυτόματα το επόμενο/);
afterSave=()=>{};save.click();await tick();assert.deepEqual(opened,['current','next','last']);save.click();await tick();assert.equal(d.open,false);assert.deepEqual(opened,['current','next','last'],'Never loops back to the same invoice, earlier rows or new arrivals');assert.ok(notices.some(x=>x.includes('Δεν υπάρχουν άλλα διαθέσιμα')));
// Cancellation of the mileage choice is not a failed save. Keep/apply are
// submitted only after the user chooses, then ordinary Save advances.
reset([record('mileage'),record('after-mileage')]);await w.FleetInvoiceApi.review('mileage');w.$('invoiceReviewOdometer').value='10100';save.click();await tick();assert.equal(requests.length,0);assert.equal(d.open,true);assert.equal(notices.length,0);decision='keep';save.click();await tick();assert.deepEqual(opened,['mileage','after-mileage']);assert.equal(requests[0].mileageDecision,'keep');assert.equal(requests[0].updateServiceKm,false);
// Duplicate submits cannot advance twice. Closing while the request is in
// flight cancels the sequence, including delayed native close callbacks.
reset([record('slow'),record('other')]);await w.FleetInvoiceApi.review('slow');let resolve;pending=new Promise(r=>resolve=r);save.click();w.$('invoiceReviewForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.equal(requests.length,1);w.document.querySelector('[data-sequential-skip]').click();assert.deepEqual(opened,['slow']);d.close();await tick();resolve();await tick();assert.equal(d.open,false);assert.deepEqual(opened,['slow']);
reset([record('skip'),record('finish')]);w.FleetSequentialReview.start(visible);await tick();w.document.querySelector('[data-sequential-skip]').click();await tick();assert.deepEqual(opened,['skip','finish']);assert.equal(requests.length,0);assert.equal(docs[0].status,'needs_review');w.document.querySelector('[data-sequential-stop]').click();await tick();assert.equal(d.open,false);
w.close();console.log('PASS actual confirmation form and sequential review: automatic next from direct opening, stable visible order/filters, no repeats, failed-save inline/toast/edit retention, mileage cancel/keep, deferred close events, double submit, close during save, skip/pause and end of list.');
