import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url)),{JSDOM}=require('jsdom');
const html=fs.readFileSync('cloudflare-worker/public/portal.html','utf8'),dom=new JSDOM(html,{url:'https://fixture.invalid/portal.html',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
w.matchMedia=()=>({matches:false});w.scrollTo=()=>{};w.setInterval=()=>1;w.TextEncoder=TextEncoder;w.Headers=Headers;w.Response=Response;w.HTMLCanvasElement.prototype.getContext=()=>null;
w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
const user={id:'retry-owner',role:'owner',permissions:['*']};w.localStorage.setItem('fleet-control-auth-token','fixture-token');w.localStorage.setItem('fleet-control-user-cache',JSON.stringify(user));
let documents=[],alerts=[],requests=[],fail=false,hold=null;
w.fetch=async(url,options={})=>{const path=new URL(url).pathname;
 if(path==='/api/admin/service-documents/retry-failed'){const body=JSON.parse(options.body);requests.push(body);if(hold)await hold;if(fail)return new Response(JSON.stringify({error:'Fixture HTTP 503'}),{status:503,headers:{'content-type':'application/json'}});const row=body.key?documents.find(r=>r.key===body.key):documents.find(r=>r.jobId===body.jobId);if(row)row.status='processing';const alert=alerts.find(a=>a.id===body.alertId);if(alert)alert.invoice_retry_state='processing';return new Response(JSON.stringify({ok:true,queued:true,status:'processing'}),{headers:{'content-type':'application/json'}});}
 return new Response(JSON.stringify({user,alerts,documents,employees:[],vehicles:[],today:{vehicles:{}},currentWeek:{},dailySchedule:[],realtime:[],actionGroups:{}}),{headers:{'content-type':'application/json'}});
};
for(const file of ['service-model.js','fleet-navigation.js','fleet-motion.js','invoice-retry.js'])w.eval(fs.readFileSync('cloudflare-worker/public/'+file,'utf8'));
let code=fs.readFileSync('cloudflare-worker/public/portal.js','utf8');code=code.replace('  initialize();','');const end=code.lastIndexOf('})();');code=code.slice(0,end)+'window.fixture={state,renderInvoiceQueue,retryAllFailedInvoices,retryInvoiceDocument,retryInvoiceAlert,loadAlerts,bulkResolvableAlerts,invoiceRetryController};'+code.slice(end);w.eval(code);
const f=w.fixture,$=id=>w.document.getElementById(id),tick=()=>new Promise(r=>setTimeout(r,10));f.state.user=user;f.state.token='fixture-token';
const row=(id,plate,extra={})=>({id,key:'fixture-'+id,name:id+'.pdf',bikeName:plate,bikeId:'b',entryId:id,status:'error',error:'Reader failed',canRetry:true,invoiceData:{},...extra});
documents=[row('one','BTO-756'),row('two','ΤΝΗ-921'),row('orphan','BTO-756',{key:'',jobId:'qr-job'}),row('ok','BTO-756',{status:'confirmed',error:''})];f.state.invoiceDocuments=documents;
$('invoiceStatusFilter').value='attention';f.renderInvoiceQueue();assert.equal($('retryAllFailedInvoices').hidden,true);
$('invoiceStatusFilter').value='error';f.renderInvoiceQueue();assert.equal($('retryAllFailedInvoices').hidden,false);assert.match($('retryAllFailedInvoices').textContent,/3/);
$('invoicePlateFilter').value='BTO756';f.renderInvoiceQueue();assert.match($('retryAllFailedInvoices').textContent,/2/);
let release;hold=new Promise(r=>release=r);const batch=f.retryAllFailedInvoices(),double=f.retryAllFailedInvoices();await double;
assert.equal($('simpleDialog').open,true);assert.match($('simpleFields').textContent,/διαδοχικά/);assert.equal(requests.length,0);
$('simpleForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await tick();assert.equal(requests.length,1);assert.equal($('retryAllFailedInvoices').disabled,true);
release();await batch;hold=null;
assert.equal(requests.length,2);assert.ok(requests.some(r=>r.key==='fixture-one'));assert.ok(requests.some(r=>r.jobId==='qr-job'));assert.equal(requests.some(r=>r.key==='fixture-two'||r.key==='fixture-ok'),false);
assert.equal($('invoiceRetryProgress').hidden,false);assert.match($('invoiceRetryProgressDetail').textContent,/Σε ουρά Server: 2/);assert.match($('invoiceRetryProgressStage').textContent,/δεν σημαίνει ολοκλήρωση/);
f.state.invoiceView='files';f.renderInvoiceQueue();assert.equal($('retryAllFailedInvoices').hidden,true);
f.state.invoiceView='review';f.state.invoiceDocuments=[];f.renderInvoiceQueue();assert.equal($('retryAllFailedInvoices').hidden,true);

alerts=[{id:'invoice',type:'invoice_processing_failed',object_type:'invoice_job',object_id:'qr-job',title:'Τιμολόγιο',message:'Reader failed',created_at:'2026-10-28'},
 {id:'ordinary',type:'server_offline',title:'Server',message:'Offline',created_at:'2026-10-28'}];await f.loadAlerts();
assert.ok($('alertList').querySelector('[data-retry-invoice-alert="invoice"]'));assert.equal($('alertList').querySelector('[data-resolve-alert="invoice"]'),null);
assert.deepEqual(Array.from(f.bulkResolvableAlerts(),a=>a.id),['ordinary']);assert.ok($('alertList').querySelector('[data-resolve-alert="ordinary"]'));
fail=true;await f.retryInvoiceAlert('invoice');assert.equal(f.state.alerts.length,2);assert.match($('toast').textContent,/503/);assert.equal($('alertList').querySelector('[data-retry-invoice-alert]').disabled,false);
fail=false;await f.retryInvoiceAlert('invoice');assert.equal(f.state.alerts.length,2);assert.equal($('alertList').querySelector('[data-retry-invoice-alert]').disabled,true);assert.match($('alertList').textContent,/μετά την επιτυχία/);
alerts=alerts.filter(a=>a.id!=='invoice');await f.loadAlerts();assert.equal($('alertList').querySelector('[data-retry-invoice-alert]'),null);
f.state.user={id:'viewer',role:'fleet_manager',permissions:['fleet.view','alerts.view']};alerts=[{id:'invoice',type:'invoice_processing_failed',object_type:'invoice_job',object_id:'qr-job',message:'failed'}];await f.loadAlerts();assert.equal($('alertList').querySelector('button'),null);
assert.equal(html.indexOf('invoice-retry.js')<html.indexOf('/portal.js'),true,'Retry dependency loads before Portal');
dom.window.close();console.log('PASS actual Portal DOM: plate/error filters, QR + PDF batch, themed confirmation/double click, queue-vs-completion progress, empty/files views, retry alert failure/retention/success, protected bulk resolution and permission-aware buttons.');
