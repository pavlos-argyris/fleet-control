(function(){
  'use strict';
  const bridge=window.AndroidServer;
  const form=document.getElementById('settingsForm');
  if(!form)return;
  let dialog=null,connection=null;

  const section=document.createElement('section');
  section.className='server-diagnostics-content';
  section.innerHTML='<p>Έλεγξε σύνδεση, συγχρονισμό, κατάσταση Ordexa και καταστημάτων χωρίς πρόσθετα αιτήματα στη D1. Η αναφορά δεν περιέχει κωδικούς, URL, χρήστες ή στοιχεία παραγγελιών.</p><button type="button" class="secondary-action" data-open-diagnostics>Άνοιγμα διάγνωσης</button>';
  const slot=document.querySelector('[data-diagnostics-slot]');
  if(slot)slot.append(section);else form.before(section);

  // Native snapshots are read only on opening, explicit refresh and a native
  // connection event. There is no background polling or new Worker endpoint.
  function read(method){
    try{
      if(typeof bridge?.[method]!=='function')return {};
      const value=JSON.parse(bridge[method]());
      return value&&typeof value==='object'&&!Array.isArray(value)?value:{};
    }catch{return {};}
  }
  const timestamp=value=>typeof value==='string'&&value.trim()&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
  const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
  function freshness(value,at,maxAge){
    const stamp=timestamp(value);
    if(stamp===null||stamp>at)return {state:'unknown',ageMinutes:null};
    const age=Math.floor((at-stamp)/60000);
    return {state:at-stamp>maxAge?'stale':'healthy',ageMinutes:age};
  }
  function health(data,ordexa,stores,at=new Date().toISOString()){
    const now=timestamp(at);
    if(now===null)throw new TypeError('Invalid diagnostics time');
    const service=data.serviceRunning===true?'running':data.serviceRunning===false?'stopped':'unknown';
    const network=data.health?.networkConnected===true?'connected':data.health?.networkConnected===false?'disconnected':'unknown';
    const ordexaAge=freshness(ordexa.lastSuccess,now,15*60000);
    const ordexaState=ordexa.configured===false?'unconfigured':
      ['blocked','credentials_required'].includes(ordexa.authState)||!!ordexa.authError?'credentials-required':
      ordexa.enabled===false?'disabled':ordexa.error?'error':ordexaAge.state;
    const storeAge=freshness(stores.lastSuccess,now,90*60000);
    const pendingDays=count(stores.pendingDays);
    const storeState=stores.error||stores.cloudError?'error':storeAge.state;
    // A readable archive is not evidence of a successful isolated restore.
    const checkedAt=data.backupVerification?.checkedAt;
    const backupAge=freshness(checkedAt,now,48*3600000);
    const backupState=backupAge.state==='unknown'?'unknown':
      data.backupVerification.complete===false?'failed':backupAge.state;
    return {
      checkedAt:at,
      service,
      network,
      ordexa:{state:ordexaState,ageMinutes:ordexaAge.ageMinutes,credentialsNeedAttention:ordexaState==='credentials-required'},
      stores:{state:storeState,ageMinutes:storeAge.ageMinutes,pendingDays},
      backupReadCheck:{state:backupState,ageMinutes:backupAge.ageMinutes,isolatedRestoreVerified:false},
      // This device cannot read a trustworthy D1 account quota from these
      // bridge snapshots. Never treat missing quota data as zero usage.
      d1Quota:{state:'unknown',rowsWritten:null,limit:null}
    };
  }
  // Stable allowlist for export; no native object or error string is serialized.
  function safe(data,remote,ordexa={},stores={},at=new Date().toISOString()){
    return {report:'Fleet Control Server diagnostics',schema:1,checkedAt:at,
      serverVersion:/^\d+(\.\d+){1,3}$/.test(data.serverVersion||'')?data.serverVersion:'unknown',
      serviceRunning:!!data.serviceRunning,networkConnected:!!data.health?.networkConnected,
      serverOnline:remote?!!remote.serverOnline:!!data.serverOnline,
      cloudCheckCompleted:remote!==null,cloudRequestOk:!!remote?.ok,
      databaseOk:!!remote?.databaseOk,storageConfigured:!!remote?.storageOk,
      pendingOperations:count(data.pendingOperations),
      hasSyncError:!!data.connectionError||!!data.lastError,
      hasMirrorError:!!data.syncDiagnostics?.mirrorError,hasInvoiceError:!!data.invoiceQueueError,
      invoiceParallelism:Number(data.invoiceParallelism||0),
      ocrParallelism:Number(data.ocrParallelism||0),
      health:health(data,ordexa,stores,at)
    };
  }
  const labels={
    running:'Ενεργή',stopped:'Σταματημένη',connected:'Συνδεδεμένο',
    disconnected:'Χωρίς δίκτυο',healthy:'Πρόσφατη επιτυχία',
    stale:'Καθυστερεί — χρειάζεται έλεγχος',unknown:'Άγνωστο — δεν υπάρχουν επαρκή στοιχεία',
    unconfigured:'Δεν έχει ρυθμιστεί',disabled:'Απενεργοποιημένο',
    'credentials-required':'Χρειάζεται επανασύνδεση',error:'Καταγράφηκε πρόβλημα',
    failed:'Απέτυχε ο έλεγχος'
  };
  const status=key=>labels[key]||labels.unknown;
  const age=minutes=>minutes===null?'':(' · πριν από '+minutes+' λεπτά');
  function render(){
    if(!dialog?.open)return;
    const data=read('getDashboard'),ordexa=read('getOrdexaStatus'),stores=read('getStoreBillingStatus');
    const r=safe(data,connection,ordexa,stores),h=r.health;
    dialog.querySelector('[data-diagnostics-status]').textContent=
      !r.cloudCheckCompleted?'Ο έλεγχος cloud δεν ολοκληρώθηκε ακόμη.':
      r.cloudRequestOk?'Η επικοινωνία με το cloud ολοκληρώθηκε.':
      'Δεν ολοκληρώθηκε η επικοινωνία. Έλεγξε τη σύνδεση και πάτησε ξανά Έλεγχος.';
    dialog.querySelector('[data-diagnostics-summary]').textContent=
      'Υπηρεσία: '+status(h.service)+' · Δίκτυο: '+status(h.network)+
      ' · Συγχρονισμός: '+(r.hasSyncError?'χρειάζεται έλεγχο':'χωρίς καταγεγραμμένο σφάλμα')+
      ' · Αντίγραφο συστήματος: '+(r.hasMirrorError?'χρειάζεται επανάληψη':'χωρίς καταγεγραμμένο σφάλμα')+'.';
    dialog.querySelector('[data-health-service]').textContent=status(h.service);
    dialog.querySelector('[data-health-ordexa]').textContent=status(h.ordexa.state)+age(h.ordexa.ageMinutes);
    dialog.querySelector('[data-health-stores]').textContent=status(h.stores.state)+age(h.stores.ageMinutes);
    dialog.querySelector('[data-health-outbox]').textContent=h.stores.pendingDays===null?'Άγνωστο':h.stores.pendingDays+' ημέρες σε αναμονή αποστολής';
    dialog.querySelector('[data-health-backup]').textContent=status(h.backupReadCheck.state)+age(h.backupReadCheck.ageMinutes)+' · Δεν έχει επαληθευτεί δοκιμαστική επαναφορά';
    dialog.querySelector('[data-health-d1]').textContent='Άγνωστο — απαιτούνται πραγματικές μετρήσεις Cloudflare';
    dialog.querySelector('textarea').value=JSON.stringify(r,null,2);
  }
  function open(){
    dialog?.close();connection=null;
    dialog=document.createElement('dialog');
    dialog.className='app-dialog operations-diagnostic-dialog';
    dialog.innerHTML='<div class="dialog-head"><h2>Διάγνωση Server</h2><button type="button" class="secondary-action" data-back>← Πίσω</button></div>'+
      '<p>Οι ενδείξεις διαβάζονται από το κινητό μόνο όταν ανοίγεις ή ανανεώνεις αυτή την οθόνη. Δεν αποστέλλεται αυτόματα αναφορά.</p>'+
      '<p data-diagnostics-status role="status"></p><p data-diagnostics-summary></p>'+
      '<section aria-label="Υγεία συστήματος"><h3>Υγεία συστήματος</h3><div class="status-list">'+
      '<div class="status-row"><strong>Τοπικός Server</strong><span data-health-service></span></div>'+
      '<div class="status-row"><strong>Ordexa παρουσίες</strong><span data-health-ordexa></span></div>'+
      '<div class="status-row"><strong>Καταστήματα</strong><span data-health-stores></span></div>'+
      '<div class="status-row"><strong>Αποστολή καταστημάτων</strong><span data-health-outbox></span></div>'+
      '<div class="status-row"><strong>Αναγνωσιμότητα backup</strong><span data-health-backup></span></div>'+
      '<div class="status-row"><strong>Όριο D1</strong><span data-health-d1></span></div>'+
      '</div></section><div class="dialog-buttons"><button type="button" class="secondary-action" data-check>Έλεγχος ξανά</button>'+
      '<button type="button" class="secondary-action" data-sync>Συγχρονισμός τώρα</button>'+
      '<button type="button" class="secondary-action" data-mirror>Επανάληψη αντιγράφου συστήματος</button></div>'+
      '<small>Οι δύο επαναλήψεις χρησιμοποιούν τους υπάρχοντες μηχανισμούς συγχρονισμού· δεν κάνουν επαναφορά δεδομένων. Δεν πραγματοποιείται μέτρηση Cloudflare D1.</small>'+
      '<label class="field"><span>Αναφορά για αποστολή</span><textarea rows="12" readonly></textarea></label>'+
      '<button type="button" class="primary-action inline" data-copy>Αντιγραφή αναφοράς</button>';
    const d=dialog;document.body.append(d);
    d.querySelector('[data-back]').onclick=()=>d.close();
    d.querySelector('[data-check]').onclick=()=>{connection=null;render();bridge?.testConnection?.();};
    d.querySelector('[data-sync]').onclick=()=>{bridge?.retrySync?.();d.querySelector('[data-diagnostics-status]').textContent='Ζητήθηκε νέος συγχρονισμός. Περίμενε λίγο και πάτησε Έλεγχος ξανά.';};
    d.querySelector('[data-mirror]').onclick=()=>{bridge?.retrySystemMirror?.();d.querySelector('[data-diagnostics-status]').textContent='Ζητήθηκε ενημέρωση αντιγράφου συστήματος.';};
    d.querySelector('[data-copy]').onclick=async()=>{
      const value=d.querySelector('textarea').value;
      if(bridge?.copyDiagnosticReport)bridge.copyDiagnosticReport(value);
      else if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(value);
      else{d.querySelector('textarea').select();document.execCommand('copy');}
      d.querySelector('[data-diagnostics-status]').textContent='Η αναφορά αντιγράφηκε. Έλεγξέ την πριν τη στείλεις.';
    };
    d.addEventListener('close',()=>{d.remove();if(dialog===d)dialog=null;},{once:true});
    d.showModal();render();bridge?.testConnection?.();
  }
  section.querySelector('button').onclick=open;
  const original=window.FleetServer?.onNativeEvent;
  if(typeof original==='function')window.FleetServer.onNativeEvent=function(event,payload){
    original.call(this,event,payload);
    if(event==='connection'){
      connection={ok:!!payload?.ok,databaseOk:!!payload?.databaseOk,
        storageOk:!!payload?.storageOk,serverOnline:!!payload?.serverOnline};
      render();
    }
  };
  window.FleetServerDiagnostics={safe,health};
}());
