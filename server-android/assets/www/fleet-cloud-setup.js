(function () {
  'use strict';
  const bridge=window.AndroidServer,element=id=>document.getElementById(id);
  if (typeof bridge?.fleetCloud!=='function') return;
  try { if (JSON.parse(bridge.getBackendMode()).activeMode!=='direct') return; }
  catch { return; }
  const section=element('settingsFleetCloud'),controls=element('fleetCloudControls');
  section.hidden=false;
  const status=element('fleetCloudStatus'),migration=element('fleetCloudMigration'),minutes=element('fleetCloudMinutes');
  const approve=element('fleetCloudApprove'),rotate=element('fleetCloudRotate');
  const replay=element('fleetCloudReplay');
  const connectionMessages={
    approved:'Επιβεβαιώθηκε η σύνδεση του Server.',
    offline:'Εκκρεμεί επικοινωνία με το Cloudflare.',
    revoked:'Η πρόσβαση του Server χρειάζεται νέα έγκριση.',
    awaiting_approval:'Εκκρεμεί η έγκριση της συσκευής στο Cloudflare.',
    waiting_for_setup:'Έτοιμο για προετοιμασία της αρχικής μεταφοράς.',
    epoch_changed:'Άλλαξε το περιβάλλον του Cloudflare. Απαιτείται έλεγχος του αντιγράφου.'
  };
  const migrationMessages={
    preparing_backup:'Δημιουργείται και ελέγχεται το τοπικό backup.',
    backup_verified:'Το τοπικό backup επαληθεύτηκε.',
    copying_baseline:'Μεταφέρονται τα επαληθευμένα δεδομένα των μηχανών στο Cloudflare.',
    baseline_retry:'Η μεταφορά διακόπηκε. Θα συνεχιστεί από την τελευταία επιβεβαιωμένη παρτίδα.',
    baseline_capacity:'Η μεταφορά περιμένει επαλήθευση της διαθέσιμης χωρητικότητας στο Cloudflare.',
    baseline_staged:'Η αποστολή της αρχικής απογραφής επιβεβαιώθηκε.',
    waiting_for_backup_slot:'Η προετοιμασία περιμένει να ολοκληρωθεί το τρέχον backup.',
    backup_verification_failed:'Χρειάζεται νέος έλεγχος του τοπικού backup.'
  };
  const migrationProblems={
    baseline_duplicate_record:'Βρέθηκαν διπλά αναγνωριστικά.',
    baseline_parent_missing:'Λείπει η μηχανή στην οποία ανήκει εγγραφή ιστορικού.',
    baseline_document_missing:'Λείπει συνημμένο από την απογραφή.',
    baseline_document_proof_mismatch:'Το αποτύπωμα ενός συνημμένου δεν συμφωνεί.',
    baseline_working_ledger_not_empty:'Ο προορισμός έχει ήδη δεδομένα.',
    baseline_working_count_mismatch:'Το πλήθος των εγγραφών στον προορισμό δεν συμφωνεί.'
  };
  function cloudProgress(progress) {
    if (progress?.archive!=='staged') return '';
    const {projection,ledger}=progress;
    const blocked=[projection,ledger].find(stage=>stage?.state==='blocked');
    if (blocked) return ' '+(migrationProblems[blocked.reason]||'Η προετοιμασία της απογραφής χρειάζεται έλεγχο.');
    if (projection?.state!=='verified') return ' Ελέγχεται η πληρότητα της απογραφής.';
    if (ledger?.state!=='ready') return ' Επαληθεύονται οι μεταφερμένες εγγραφές.';
    return ' Η επεξεργασία των τιμολογίων περιμένει την ολοκλήρωση της μετάβασης.';
  }
  let pending=false,backupTimer;
  const request=(action,value=0)=>{
    if (pending) return;
    pending=true;
    status.textContent='Έλεγχος…';
    try { bridge.fleetCloud(action,value); }
    catch { pending=false; status.textContent='Δεν ξεκίνησε ο έλεγχος.'; }
  };
  const previous=window.FleetServer.onNativeEvent;
  window.FleetServer.onNativeEvent=function(event,payload){
    previous.call(this,event,payload);
    if (event!=='fleetCloud') return;
    pending=false;
    clearTimeout(backupTimer);
    if (!payload?.ok) {
      status.textContent=payload?.message||'Η σύνδεση χρειάζεται έλεγχο από τον ιδιοκτήτη.';
      return;
    }
    controls.hidden=false;
    const last=payload.lastContactAt?'\nΤελευταία επικοινωνία '+new Date(payload.lastContactAt).toLocaleString('el-GR'):'';
    status.textContent=(connectionMessages[payload.connection]||'Εκκρεμεί έλεγχος σύνδεσης.')+last;
    const backupAt=payload.migration==='backup_verified'&&payload.backupVerifiedAt?
      ' Έλεγχος '+new Date(payload.backupVerifiedAt).toLocaleString('el-GR')+'.':'';
    const stagedAt=payload.migration==='baseline_staged'&&payload.lastReplicaAt?
      ' Τελευταία ενημέρωση αντιγράφου '+new Date(payload.lastReplicaAt).toLocaleString('el-GR')+'.':'';
    const pendingReplica=payload.replicaPending?' Εκκρεμούν αλλαγές στο αντίγραφο.':'';
    const source=payload.sourceJournal;
    const sourceChanges=source?.verified&&Number.isSafeInteger(source.pending)&&source.pending>0?
      ' Τοπικές εγγραφές σε αναμονή αποστολής '+source.pending+'.':'';
    const lastSource=source?.lastAcknowledgedAt?' Τελευταία επιβεβαιωμένη αποστολή '+new Date(source.lastAcknowledgedAt).toLocaleString('el-GR')+'.':'';
    const sourceProgress=payload.sourceProgress?.state;
    const sourceCheck=sourceProgress==='blocked'?' Οι αλλαγές χρειάζονται έλεγχο λόγω ασυμφωνίας.':
      source?.capacity?' Η αποστολή αλλαγών περιμένει επαλήθευση χωρητικότητας.':
      source?.retry?' Η αποστολή αλλαγών θα επαναληφθεί.':
      sourceProgress==='indexed'?' Επαληθεύτηκαν οι αλλαγές στο αντίγραφο.':
      sourceProgress?' Ελέγχονται οι αλλαγές στο αντίγραφο.':'';
    migration.textContent=(migrationMessages[payload.migration]||'Μετάβαση δεδομένων σε αναμονή επαλήθευσης.')+
      cloudProgress(payload.baselineProgress)+backupAt+stagedAt+pendingReplica+sourceChanges+lastSource+sourceCheck;
    minutes.value=String(payload.minutes||15);
    approve.hidden=payload.approved&&!payload.pendingApproval;
    approve.textContent=payload.pendingApproval&&!payload.approved?
      (payload.backupVerifiedAt?'Κωδικός έγκρισης Server':'Έλεγχος προετοιμασίας'):'Προετοιμασία μεταφοράς';
    rotate.hidden=!payload.approved||payload.pendingApproval;
    replay.hidden=payload.migration!=='baseline_staged'||payload.connection!=='approved';
    if (payload.pendingApproval&&!payload.approved&&!payload.backupVerifiedAt&&section.open&&
        payload.migration!=='backup_verification_failed') {
      backupTimer=setTimeout(()=>{if(section.open)request('status');},5000);
    }
  };
  section.addEventListener('toggle',()=>{if(section.open)request('status');});
  approve.addEventListener('click',()=>request('approve'));
  rotate.addEventListener('click',()=>request('rotate'));
  element('fleetCloudPin').addEventListener('click',()=>request('settings'));
  element('fleetCloudRefresh').addEventListener('click',()=>request('status'));
  replay.addEventListener('click',()=>request('replay'));
  minutes.addEventListener('change',()=>request('interval',Number(minutes.value)));
  window.addEventListener('focus',()=>{if(section.open)request('status');});
}());
