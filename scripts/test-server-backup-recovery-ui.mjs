import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url));
const {JSDOM}=require('jsdom');
const dom=new JSDOM(fs.readFileSync('server-android/assets/www/index.html','utf8'),{url:'https://server.fixture.invalid',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window,d=w.document,calls=[];
let dashboard={settingsLoaded:true,canVerifyLastBackup:true,backupRecoveryTest:{}};
w.setInterval=()=>0;
w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
w.HTMLElement.prototype.scrollIntoView=function(){};
w.AndroidServer={getDashboard:()=>JSON.stringify(dashboard),loadReleases(){},testLastBackupRestore(){calls.push('last');},chooseBackupRecoveryTest(){calls.push('choose');},chooseBackupFile(){throw Error('Production restore must never run from a test button');},confirmBackupRestore(){throw Error('Production confirmation must never run from a test button');}};
try {
  w.eval(fs.readFileSync('server-android/assets/www/app.js','utf8'));
  assert.match(d.querySelector('#backupRecoveryStatus').textContent,/Δεν έχει γίνει/);
  assert.equal(d.querySelector('#testLastBackupRestore').disabled,false);
  d.querySelector('#testLastBackupRestore').click();d.querySelector('#testBackupRestoreFile').click();
  assert.deepEqual(calls,['last','choose']);
  dashboard.backupRecoveryTest={checkedAt:'2026-11-05T08:00:00Z',fileName:'selected.fcbackup',isolated:true,restoreVerified:true,sqliteIntegrity:true,contentMatches:true};
  w.FleetServer.onNativeEvent('backupRecoveryTest',{ok:true,message:'Επιτυχής δοκιμή',bikes:2,workforceRecords:4,documents:1});
  assert.match(d.querySelector('#backupRecoveryStatus').textContent,/selected.fcbackup/);
  assert.match(d.querySelector('#backupRecoveryStatus').textContent,/επαληθεύτηκε σε ξεχωριστή βάση/);
  assert.equal(d.querySelector('#backupRecoveryStatus').classList.contains('backup-health-warning'),false);
  for(const missing of ['isolated','restoreVerified','sqliteIntegrity','contentMatches']){
    const value={...dashboard.backupRecoveryTest,[missing]:false};dashboard.backupRecoveryTest=value;
    w.FleetServer.onNativeEvent('backupRecoveryTest',{ok:false,message:'Η δοκιμή απέτυχε'});
    assert.equal(d.querySelector('#backupRecoveryStatus').classList.contains('backup-health-warning'),true,missing+' cannot count as verified recovery');
    assert.doesNotMatch(d.querySelector('#backupRecoveryStatus').textContent,/επαληθεύτηκε σε ξεχωριστή βάση/);
    dashboard.backupRecoveryTest={...value,[missing]:true};
  }
  dashboard.backupRecoveryTest.fileName='<img src=x onerror=alert(1)>';
  dashboard.canVerifyLastBackup=false;
  w.FleetServer.onNativeEvent('backupRecoveryTest',{ok:true,message:'fixture'});
  assert.equal(d.querySelector('#backupRecoveryStatus img'),null);
  assert.equal(d.querySelector('#testLastBackupRestore').disabled,true);
  for(const invalidTime of ['not-a-date','2040-01-01T00:00:00Z']){
    dashboard.backupRecoveryTest.checkedAt=invalidTime;
    w.FleetServer.onNativeEvent('backupRecoveryTest',{ok:true,message:'fixture'});
    assert.match(d.querySelector('#backupRecoveryStatus').textContent,/Δεν υπάρχει έγκυρη χρονική ένδειξη/);
    assert.doesNotMatch(d.querySelector('#backupRecoveryStatus').textContent,/επαληθεύτηκε σε ξεχωριστή βάση/);
  }
  delete w.AndroidServer.chooseBackupRecoveryTest;
  d.querySelector('#testBackupRestoreFile').click();
  assert.match(d.querySelector('#backupMessage').textContent,/Χρειάζεται συμβατή ενημέρωση/);
  console.log('PASS Server recovery UI: distinct native test actions, selected-artifact evidence, all proof flags required, safe filenames, absent/old native fallback and no production restore.');
} finally {w.close();}
