import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
function declaration(source,name){const match=new RegExp('(?:async )?function '+name+'\\s*\\(').exec(source);assert.ok(match,name);let start=source.indexOf('{',match.index),depth=1,i=start+1;while(depth&&i<source.length){if(source[i]==='{')depth++;if(source[i]==='}')depth--;i++;}return source.slice(match.index,i);}
const app=fs.readFileSync('cloudflare-worker/public/app.js','utf8'),portal=fs.readFileSync('cloudflare-worker/public/portal.js','utf8');
let hiddenFrame=false;const window={frameElement:{closest:()=>hiddenFrame?{}:null}},document={hidden:false};window.parent={};let context=vm.createContext({window,document});vm.runInContext(declaration(app,'fleetScreenActive'),context);
assert.equal(context.fleetScreenActive(),true);hiddenFrame=true;assert.equal(context.fleetScreenActive(),false);hiddenFrame=false;document.hidden=true;assert.equal(context.fleetScreenActive(),false);document.hidden=false;
let now=60000,calls=0,batches=0;const state={user:{id:'owner'},view:'invoices',invoiceDocuments:[],invoiceReprocessBusy:false};
context=vm.createContext({window,state,document,Date:{now:()=>now},invoiceLiveRefreshRunning:false,api:async()=>{calls++;return {documents:state.invoiceDocuments};},refreshInvoiceReprocessBatch:async()=>{batches++;},renderInvoiceQueue(){}});
vm.runInContext(fs.readFileSync('cloudflare-worker/public/service-model.js','utf8'),context);window.FleetServiceModel=context.FleetServiceModel;
vm.runInContext(['applyInvoiceDocuments','loadInvoices','hasLiveInvoiceJobs','refreshInvoiceProgressLive'].map(name=>declaration(portal,name)).join('\n'),context);
await context.refreshInvoiceProgressLive();assert.equal(calls,1);assert.equal(batches,1);now+=5000;await context.refreshInvoiceProgressLive();assert.equal(calls,1,'Idle screen does not poll every timer tick');now+=55000;await context.refreshInvoiceProgressLive();assert.equal(calls,2);
state.invoiceDocuments=[{status:'processing',jobId:'a'}];now+=5000;await context.refreshInvoiceProgressLive();assert.equal(calls,3,'Active jobs refresh promptly');assert.equal(batches,2);
document.hidden=true;now+=60000;await context.refreshInvoiceProgressLive();assert.equal(calls,3);document.hidden=false;state.view='fleet';await context.refreshInvoiceProgressLive();assert.equal(calls,3);state.view='invoices';state.invoiceReprocessBusy=true;await context.refreshInvoiceProgressLive();assert.equal(calls,3,'Batch polling does not duplicate list polling');
console.log('OK actual polling functions: hidden tab/iframe pauses reads, idle 60s, active 5s, batch refresh discovery and no duplicate bulk polling.');

// A completed review fences requests already in flight. Equal-version older
// requests cannot restore removed rows; a genuine newer snapshot still wins.
state.token='current';state.invoiceListVersion=20;state.invoiceListAcceptedSequence=5;state.invoiceDocuments=[{id:'saved',status:'confirmed'}];
assert.equal(context.applyInvoiceDocuments({serverVersion:19,documents:[{id:'old'}]},6,'current'),false);
assert.equal(context.applyInvoiceDocuments({serverVersion:20,documents:[{id:'old'}]},4,'current'),false);
assert.equal(state.invoiceDocuments[0].status,'confirmed');
assert.equal(context.applyInvoiceDocuments({serverVersion:21,documents:[{id:'fresh'}]},4,'current'),true);
assert.equal(context.applyInvoiceDocuments({serverVersion:22,documents:[{id:'other-session'}]},7,'old-login'),false);
assert.equal(state.invoiceDocuments[0].id,'fresh');
assert.throws(()=>context.applyInvoiceDocuments({serverVersion:22},7,'current'),/δεν φορτώθηκε σωστά/);
assert.equal(state.invoiceDocuments[0].id,'fresh','Invalid responses preserve the last valid list');
console.log('PASS invoice list response ordering, newer snapshot acceptance, login isolation and invalid response retention.');

// Real Fleet live callback coalesces a burst without delaying explicit saves.
let liveNow=10000,liveReads=0;const timers=[];const liveWindow={};liveWindow.parent=liveWindow;
const liveContext=vm.createContext({window:liveWindow,document:{hidden:false},Date:{now:()=>liveNow},webToken:'first',currentUser:{id:'owner'},fleetLastPoll:0,fleetLiveTimer:0,syncNow(){liveReads++;},setTimeout(fn,ms){timers.push({fn,ms});return timers.length;}});
vm.runInContext(['fleetScreenActive','queueFleetLiveChanges'].map(name=>declaration(app,name)).join('\n'),liveContext);
liveContext.queueFleetLiveChanges(['fleet']);assert.equal(timers[0].ms,0);timers[0].fn();assert.equal(liveReads,1);
liveNow=10100;for(let i=0;i<20;i++)liveContext.queueFleetLiveChanges(['fleet','invoices']);assert.equal(timers.length,2);assert.equal(timers[1].ms,4900);liveNow=15000;timers[1].fn();assert.equal(liveReads,2,'twenty live results require one new snapshot read');
liveNow=15100;liveContext.queueFleetLiveChanges(['fleet']);liveContext.document.hidden=true;timers[2].fn();assert.equal(liveReads,2,'hidden tab never flushes a pending live read');liveContext.document.hidden=false;liveNow=20000;liveContext.queueFleetLiveChanges(['fleet']);liveContext.webToken='second';timers[3].fn();assert.equal(liveReads,2,'old login cannot flush into a new session');
console.log('PASS #37 Fleet live burst: twenty results/one read, maximum five-second coalescing, hidden and session fences; direct syncNow mutation path unchanged.');
