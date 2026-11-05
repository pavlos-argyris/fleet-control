import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url));
const {JSDOM}=require('jsdom');
const dom=new JSDOM(fs.readFileSync('server-android/assets/www/index.html','utf8'),{
  url:'https://server.fixture.invalid',runScripts:'outside-only',pretendToBeVisual:true
});
const w=dom.window,d=w.document,timers=[],calls=[],exports=[];
const at='2026-11-05T08:00:00.000Z';
w.setInterval=(fn,ms)=>{timers.push(ms);return timers.length;};
w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
w.HTMLElement.prototype.scrollIntoView=function(){};
let dashboard={settingsLoaded:true,serviceRunning:true,serverOnline:true,serverVersion:'2.9.0',
  health:{networkConnected:true},backupVerification:{checkedAt:'2026-11-05T07:00:00Z',complete:true},
  account:'secretAccountShouldNeverExport',workerUrl:'https://secret.example',
  connectionError:'confidential example error',invoiceParallelism:2};
let ordexa={configured:true,enabled:true,authState:'connected',lastSuccess:'2026-11-05T07:56:00Z',
  account:'sensitiveOrdexaAccount',credentials:'privateOrdexaCredential'};
let stores={lastSuccess:'2026-11-05T07:30:00Z',pendingDays:3,stage:'secret internal path',
  orders:[{customer:'private order data'}]};
w.AndroidServer={
  getDashboard:()=>JSON.stringify(dashboard),
  getOrdexaStatus:()=>JSON.stringify(ordexa),
  getStoreBillingStatus:()=>JSON.stringify(stores),
  testConnection:()=>calls.push('testConnection'),
  retrySync:()=>calls.push('retrySync'),
  retrySystemMirror:()=>calls.push('retrySystemMirror'),
  copyDiagnosticReport:report=>exports.push(report),
  loadReleases(){}
};
try{
  w.eval(fs.readFileSync('server-android/assets/www/app.js','utf8'));
  w.eval(fs.readFileSync('server-android/assets/www/server-diagnostics.js','utf8'));
  const project=w.FleetServerDiagnostics.health;
  let h=project({}, {}, {}, at);
  assert.equal(h.service,'unknown');
  assert.equal(h.network,'unknown');
  assert.equal(h.ordexa.state,'unknown');
  assert.equal(h.stores.state,'unknown');
  assert.equal(h.stores.pendingDays,null);
  assert.equal(h.backupReadCheck.state,'unknown');
  assert.deepEqual(JSON.parse(JSON.stringify(h.d1Quota)),{state:'unknown',rowsWritten:null,limit:null});

  h=project(dashboard,ordexa,stores,at);
  assert.equal(h.service,'running');
  assert.equal(h.network,'connected');
  assert.equal(h.ordexa.state,'healthy');
  assert.equal(h.ordexa.ageMinutes,4);
  assert.equal(h.stores.state,'healthy');
  assert.equal(h.stores.pendingDays,3);
  assert.equal(h.backupReadCheck.state,'healthy');
  assert.equal(h.backupReadCheck.isolatedRestoreVerified,false,'Readable ZIP never proves restore');

  h=project({...dashboard,serviceRunning:false,health:{networkConnected:false},
    backupVerification:{checkedAt:'2026-11-01T07:00:00Z',complete:true}},
    {...ordexa,authState:'blocked',authError:'SENSITIVE CREDENTIALS',lastSuccess:'2026-11-05T07:40:00Z'},
    {...stores,lastSuccess:'2026-11-05T04:00:00Z',pendingDays:2},at);
  assert.equal(h.service,'stopped');
  assert.equal(h.network,'disconnected');
  assert.equal(h.ordexa.state,'credentials-required');
  assert.equal(h.stores.state,'stale');
  assert.equal(h.backupReadCheck.state,'stale');
  h=project({...dashboard,backupVerification:{checkedAt:'2026-11-05T07:00:00Z',complete:false}},
    {...ordexa,lastSuccess:'2040-01-01T00:00:00Z'}, {...stores,pendingDays:-1},at);
  assert.equal(h.backupReadCheck.state,'failed');
  assert.equal(h.ordexa.state,'unknown','Future provider timestamp is not recent success');
  assert.equal(h.stores.pendingDays,null,'Invalid pending count is unknown');

  const before=timers.length;
  d.querySelector('[data-open-diagnostics]').click();
  const dlg=d.querySelector('.operations-diagnostic-dialog[open]');
  assert(dlg,'Native diagnostics dialog opens');
  assert.equal(calls.filter(s=>s==='testConnection').length,1,'Only existing on-demand connection test is started');
  assert.equal(timers.length,before,'No new polling or refresh interval');
  assert.match(dlg.querySelector('[data-health-d1]').textContent,/Άγνωστο/);
  assert.match(dlg.querySelector('[data-health-backup]').textContent,/Δεν έχει επαληθευτεί δοκιμαστική επαναφορά/);
  assert.equal(dlg.querySelectorAll('[data-health-service],[data-health-ordexa],[data-health-stores],[data-health-outbox],[data-health-backup],[data-health-d1]').length,6);
  const exported=dlg.querySelector('textarea').value;
  for(const secret of ['secretAccountShouldNeverExport','sensitiveOrdexaAccount','privateOrdexaCredential','https://secret.example','private order data','confidential example error','secret internal path'])
    assert(!exported.includes(secret),'Diagnostics export must not leak '+secret);
  assert.deepEqual(JSON.parse(exported).health.d1Quota,{state:'unknown',rowsWritten:null,limit:null});
  assert.equal(JSON.parse(exported).health.backupReadCheck.isolatedRestoreVerified,false);
  w.FleetServer.onNativeEvent('connection',{ok:true,serverOnline:true,databaseOk:true,storageOk:true});
  assert.match(dlg.querySelector('[data-diagnostics-status]').textContent,/ολοκληρώθηκε/);
  dlg.querySelector('[data-copy]').click();
  assert.equal(exports.length,1);
  assert.equal(exports[0],dlg.querySelector('textarea').value);
  dlg.querySelector('[data-check]').click();
  assert.equal(calls.filter(s=>s==='testConnection').length,2);
  assert.equal(calls.includes('retrySync'),false,'A read-only health check never starts a business sync');
  assert.equal(calls.includes('retrySystemMirror'),false);
  console.log('PASS native Server diagnostics: real bridge snapshots, stale/unknown status, credential warning, pending days, no invented D1/restore, secret-free export, no polling or mutation.');
}finally{w.close();}
