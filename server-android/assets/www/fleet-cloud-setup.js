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
    awaiting_approval:'Εκκρεμεί η έγκριση της συσκευής.',
    waiting_for_setup:'Ο Server περιμένει έγκριση.',
    epoch_changed:'Άλλαξε το περιβάλλον του Cloudflare. Απαιτείται έλεγχος του αντιγράφου.'
  };
  const migrationMessages={
    preparing_backup:'Δημιουργείται και ελέγχεται το τοπικό backup.',
    backup_verified:'Το τοπικό backup επαληθεύτηκε. Εκκρεμεί η συμφιλίωση της μεταφοράς.',
    copying_baseline:'Μεταφέρονται τα επαληθευμένα δεδομένα των μηχανών στο δοκιμαστικό Cloudflare.',
    baseline_retry:'Η μεταφορά διακόπηκε. Θα συνεχιστεί από την τελευταία επιβεβαιωμένη παρτίδα.',
    baseline_staged:'Η δοκιμαστική μεταφορά της αρχικής απογραφής επαληθεύτηκε.',
    waiting_for_backup_slot:'Η προετοιμασία περιμένει να ολοκληρωθεί το τρέχον backup.',
    backup_verification_failed:'Χρειάζεται νέος έλεγχος του τοπικού backup.'
  };
  const migrationProblems={
    baseline_duplicate_record:'Βρέθηκαν διπλά αναγνωριστικά.',
    baseline_parent_missing:'Λείπει η μηχανή στην οποία ανήκει εγγραφή ιστορικού.',
    baseline_document_missing:'Λείπει συνημμένο από την απογραφή.',
    baseline_document_proof_mismatch:'Το αποτύπωμα ενός συνημμένου δεν συμφωνεί.',
    baseline_working_ledger_not_empty:'Η βάση δοκιμής έχει ήδη δεδομένα.',
    baseline_working_count_mismatch:'Το πλήθος των εγγραφών στη βάση δοκιμής δεν συμφωνεί.',
    baseline_invoice_queue_not_empty:'Βρέθηκαν προϋπάρχουσες εργασίες στην ουρά δοκιμής.',
    invoice_manifest_mismatch:'Το πλήθος ή το αποτύπωμα των εκκρεμοτήτων δεν συμφωνεί.'
  };
  function cloudProgress(progress) {
    if (progress?.archive!=='staged') return '';
    const {projection,ledger,invoiceImport,invoices}=progress;
    const blocked=[projection,ledger,invoiceImport].find(stage=>stage?.state==='blocked');
    if (blocked) return ' '+(migrationProblems[blocked.reason]||'Η προετοιμασία της απογραφής χρειάζεται έλεγχο.');
    if (projection?.state!=='verified') return ' Ελέγχεται η πληρότητα της απογραφής.';
    if (ledger?.state!=='ready') return ' Προετοιμάζεται η βάση δοκιμής.';
    if (invoiceImport?.state!=='ready') return ' Ανακτώνται οι παλιές εκκρεμότητες τιμολογίων.';
    const pending=(Number(invoices?.queued)||0)+(Number(invoices?.running)||0), review=Number(invoices?.review)||0;
    if (!pending&&!review) return ' Η δοκιμαστική ουρά τιμολογίων είναι ενημερωμένη.';
    return ' Τιμολόγια σε αναμονή επεξεργασίας '+pending+', για έλεγχο '+review+'.';
  }
  let pending=false;
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
    const pendingReplica=payload.replicaPending?' Εκκρεμούν αλλαγές στο δοκιμαστικό αντίγραφο.':'';
    const pendingInvoices=Number(payload.replicaPendingInvoices)||0;
    const source=payload.sourceJournal;
    const sourceChanges=source?.verified&&Number.isSafeInteger(source.pending)&&source.pending>0?
      ' Τοπικές εγγραφές σε αναμονή αποστολής '+source.pending+'.':'';
    const lastSource=source?.lastAcknowledgedAt?' Τελευταία επιβεβαιωμένη αποστολή '+new Date(source.lastAcknowledgedAt).toLocaleString('el-GR')+'.':'';
    const sourceProgress=payload.sourceProgress?.state;
    const sourceCheck=sourceProgress==='blocked'?' Οι αλλαγές της δοκιμής χρειάζονται έλεγχο λόγω ασυμφωνίας.':
      source?.retry?' Η αποστολή αλλαγών θα επαναληφθεί.':
      sourceProgress==='indexed'?' Επαληθεύτηκαν οι αλλαγές στο δοκιμαστικό αντίγραφο.':
      sourceProgress?' Ελέγχονται οι αλλαγές στο δοκιμαστικό αντίγραφο.':'';
    migration.textContent=(migrationMessages[payload.migration]||'Μετάβαση δεδομένων σε αναμονή επαλήθευσης.')+
      cloudProgress(payload.baselineProgress)+backupAt+stagedAt+pendingReplica+sourceChanges+lastSource+sourceCheck+
      (pendingInvoices>0?' Επαληθευμένα PDF σε αναμονή δοκιμαστικής καταχώρισης '+pendingInvoices+'.':'');
    minutes.value=String(payload.minutes||15);
    approve.hidden=payload.approved&&!payload.pendingApproval;
    rotate.hidden=!payload.approved||payload.pendingApproval;
    replay.hidden=payload.migration!=='baseline_staged'||payload.connection!=='approved';
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
