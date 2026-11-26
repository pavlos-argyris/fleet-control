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
    waiting_for_backup_slot:'Η προετοιμασία περιμένει να ολοκληρωθεί το τρέχον backup.',
    backup_verification_failed:'Χρειάζεται νέος έλεγχος του τοπικού backup.'
  };
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
    migration.textContent=(migrationMessages[payload.migration]||'Μετάβαση δεδομένων σε αναμονή επαλήθευσης.')+backupAt;
    minutes.value=String(payload.minutes||15);
    approve.hidden=payload.approved&&!payload.pendingApproval;
    rotate.hidden=!payload.approved||payload.pendingApproval;
  };
  section.addEventListener('toggle',()=>{if(section.open)request('status');});
  approve.addEventListener('click',()=>request('approve'));
  rotate.addEventListener('click',()=>request('rotate'));
  element('fleetCloudPin').addEventListener('click',()=>request('settings'));
  element('fleetCloudRefresh').addEventListener('click',()=>request('status'));
  minutes.addEventListener('change',()=>request('interval',Number(minutes.value)));
  window.addEventListener('focus',()=>{if(section.open)request('status');});
}());
