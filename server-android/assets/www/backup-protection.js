(function(){
  'use strict';
  const d=document,bridge=window.AndroidServer,$=id=>d.getElementById(id);
  if(!$('portableBackupDialog'))return;
  const dialog=$('portableBackupDialog'),form=$('portableBackupForm'),unlock=$('backupPasswordDialog'),section=$('portableBackupSettings');
  let protection=null,pending='',unlockRequest='',sequence=0;
  const supported=()=>typeof bridge?.configureBackupProtection==='function'&&typeof bridge?.newBackupRecoveryCode==='function';
  function read(){
    try{const dashboard=JSON.parse(bridge?.getDashboard?.()||'{}');protection=dashboard.settingsLoaded===true&&dashboard.backupProtection?.available===true?dashboard.backupProtection:null;}catch{protection=null;}
    $('portableBackupState').textContent=!supported()?'Χρειάζεται συμβατή ενημέρωση Server.':!protection?'Δεν επιβεβαιώθηκε η αποθηκευμένη προστασία. Άνοιξε ξανά την ενότητα.':protection.enabled?'Ενεργός φορητός κωδικός για τα νέα αντίγραφα.':'Δεν έχει οριστεί φορητός κωδικός. Τα παλαιά αντίγραφα διατηρούν τη δική τους προστασία.';
    $('configurePortableBackup').disabled=!supported()||!protection||!!pending;
  }
  function clear(){form.reset();$('portableBackupCode').value='';$('portableBackupConfirm').value='';$('portableBackupError').textContent='';}
  function busy(value){form.querySelectorAll('button,input').forEach(el=>{el.disabled=value;});}
  section.addEventListener('toggle',()=>{if(section.isConnected&&section.open)read();});
  $('configurePortableBackup').addEventListener('click',()=>{read();if(!protection||!supported())return;clear();dialog.showModal();});
  $('generatePortableBackupCode').addEventListener('click',()=>{try{$('portableBackupCode').value=bridge.newBackupRecoveryCode();$('portableBackupConfirm').value='';$('portableBackupSaved').checked=false;}catch{$('portableBackupError').textContent='Δεν δημιουργήθηκε κωδικός. Δοκίμασε ξανά.';}});
  $('cancelPortableBackup').addEventListener('click',()=>{if(!pending){dialog.close();clear();}});
  dialog.addEventListener('cancel',event=>{if(pending)event.preventDefault();else clear();});
  dialog.addEventListener('close',clear);
  form.addEventListener('submit',event=>{
    event.preventDefault();if(pending||!protection||!supported())return;
    const password=$('portableBackupCode').value;
    if(password.length<12||password.length>256||password!==$('portableBackupConfirm').value||!$('portableBackupSaved').checked){$('portableBackupError').textContent='Έλεγξε ότι οι δύο κωδικοί είναι ίδιοι και ότι έχεις αποθηκεύσει τον κωδικό εκτός κινητού.';return;}
    pending='protection-'+Date.now()+'-'+(++sequence);busy(true);$('portableBackupError').textContent='Αποθήκευση προστασίας…';
    try{bridge.configureBackupProtection(JSON.stringify({requestId:pending,expectedKeyId:protection.keyId||'',savedCodeAcknowledged:true,password}));$('portableBackupCode').value='';$('portableBackupConfirm').value='';}catch{pending='';busy(false);$('portableBackupError').textContent='Δεν στάλθηκε η ρύθμιση. Δοκίμασε ξανά.';}
  });
  function cancelUnlock(){unlockRequest='';$('backupPasswordValue').value='';unlock.close();bridge?.cancelBackupPassword?.();}
  $('cancelBackupPassword').addEventListener('click',cancelUnlock);
  unlock.addEventListener('cancel',()=>{unlockRequest='';$('backupPasswordValue').value='';bridge?.cancelBackupPassword?.();});
  unlock.addEventListener('close',()=>{$('backupPasswordValue').value='';});
  $('backupPasswordForm').addEventListener('submit',event=>{
    event.preventDefault();if(!unlockRequest||typeof bridge?.submitBackupPassword!=='function')return;
    const password=$('backupPasswordValue').value;const requestId=unlockRequest;unlockRequest='';$('backupPasswordValue').value='';unlock.close();
    try{bridge.submitBackupPassword(JSON.stringify({requestId,password}));}catch{$('backupMessage').textContent='Δεν στάλθηκε ο κωδικός. Επίλεξε ξανά το backup.';}
  });
  const previous=window.FleetServer?.onNativeEvent;
  if(typeof previous==='function')window.FleetServer.onNativeEvent=function(event,payload){
    if(event==='backupProtection'){
      if(!pending||payload?.requestId!==pending)return;pending='';busy(false);
      if(payload.ok){dialog.close();read();$('backupMessage').textContent='Η προστασία αποθηκεύτηκε. Δημιούργησε νέο backup και κράτησέ το εκτός συσκευής.';}
      else{$('portableBackupError').textContent=payload.message||'Δεν αποθηκεύτηκε η προστασία. Πληκτρολόγησε ξανά τον κωδικό.';read();}
      return;
    }
    if(event==='backupPassword'){
      if(payload?.ok&&typeof payload.requestId==='string'){
        unlockRequest=payload.requestId;$('backupPasswordValue').value='';$('backupPasswordError').textContent='';$('backupPasswordMessage').textContent=payload.message||'Πληκτρολόγησε τον κωδικό αυτού του backup.';if(!unlock.open)unlock.showModal();
      }else $('backupPasswordError').textContent=payload?.message||'Άνοιξε ξανά το backup.';
      return;
    }
    return previous.apply(this,arguments);
  };
})();
