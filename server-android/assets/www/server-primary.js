(function(){
  'use strict';
  const bridge=window.AndroidServer,anchor=document.getElementById('settingsDiagnostics');
  if(!anchor||typeof bridge?.getPrimaryMigrationStatus!=='function')return;
  const old=document.getElementById('settingsAuthority');if(old)old.hidden=true;
  const section=document.createElement('details');section.className='server-group';section.id='settingsPrimary';
  section.innerHTML='<summary><span><strong>Κύρια βάση δεδομένων</strong><small>Μεταφορά δεδομένων και ασφαλής απομακρυσμένη πρόσβαση</small></span></summary><div class="server-group-body">'+
    '<p data-primary-state role="status" aria-live="polite"></p><p data-primary-stage></p><p data-primary-error role="alert"></p>'+
    '<p data-primary-explanation>Μετά τη μεταφορά, οι καταχωρίσεις και η σύνδεση χρηστών εξυπηρετούνται από αυτό το κινητό. Όταν ο Server είναι εκτός σύνδεσης, οι εφαρμογές διατηρούν τα προσχέδια και δείχνουν την τελευταία διαθέσιμη προβολή.</p>'+
    '<form class="settings-form" data-primary-form><p>Η παλιά βάση σταματά προσωρινά να δέχεται αλλαγές όσο μεταφέρονται και ελέγχονται τα δεδομένα. Η ενεργοποίηση γίνεται αφού περάσει και η δοκιμή ανάκτησης του νέου backup.</p>'+
    '<label><span>Όνομα χρήστη ιδιοκτήτη Fleet</span><input name="username" autocomplete="username" maxlength="160"></label><label><span>Κωδικός ιδιοκτήτη Fleet</span><input name="password" type="password" autocomplete="current-password" maxlength="128"></label>'+
    '<p class="muted" data-primary-resume hidden>Αν έχει ήδη επιβεβαιωθεί ο ιδιοκτήτης, η ίδια μεταφορά συνεχίζει χωρίς να χρειάζεται ξανά ο κωδικός.</p>'+
    '<label class="switch-row"><span>Έχω αποθηκεύσει τον φορητό κωδικό ανάκτησης backup εκτός αυτού του κινητού.</span><input name="backupCodeSaved" type="checkbox" required></label>'+
    '<p data-primary-protection></p><button class="primary-action" type="submit" data-primary-start>Μεταφορά και έλεγχος</button></form>'+
    '<div class="dialog-buttons"><button class="secondary-action" type="button" data-primary-refresh>Ανανέωση</button><button class="secondary-action" type="button" data-primary-stop hidden>Παύση μετά το τρέχον βήμα</button><button class="secondary-action" type="button" data-primary-abort hidden>Ακύρωση μεταφοράς</button></div>'+
    '<button class="primary-action" type="button" data-cloud-return hidden>Επιστροφή στο Cloudflare</button><p data-cloud-copy hidden>Θα δημιουργηθεί πλήρες backup και θα ελεγχθούν τα δεδομένα πριν αλλάξει η κύρια βάση. Η παλιά D1 και τα δεδομένα αυτού του κινητού διατηρούνται. Όσο μεταφέρονται τα δεδομένα, οι νέες καταχωρίσεις θα περιμένουν.</p>'+
    '<details class="server-inner" data-primary-identity hidden><summary>Ταυτότητα συσκευής</summary><p>Σύγκρινε αυτό το αποτύπωμα με το Web ή το Client όταν επιβεβαιώνεις σύνδεση ή αλλαγή Server.</p><code data-primary-fingerprint style="overflow-wrap:anywhere"></code></details></div>';
  anchor.before(section);
  const get=s=>section.querySelector(s),form=get('[data-primary-form]'),state=get('[data-primary-state]'),stage=get('[data-primary-stage]'),error=get('[data-primary-error]'),start=get('[data-primary-start]'),stop=get('[data-primary-stop]'),abort=get('[data-primary-abort]');
  let current=null,pending='',timer;
  const phases={cloud:'Η κύρια βάση λειτουργεί ακόμη στο cloud.',preparing:'Η μεταφορά έχει ξεκινήσει.',importing:'Μεταφορά και σύγκριση δεδομένων.',prepared:'Τα δεδομένα μεταφέρθηκαν· απομένει ο τελικός έλεγχος.',active:'Η κύρια βάση λειτουργεί σε αυτόν τον Server.',cloud_return:'Μεταφορά δεδομένων στο Cloudflare · οι νέες καταχωρίσεις περιμένουν.',cloud_remote:'Η κύρια βάση λειτουργεί στο Cloudflare.',needs_recovery:'Χρειάζεται ολοκλήρωση της ανάκτησης Server.',recovering:'Η ανάκτηση Server βρίσκεται σε εξέλιξη.'};
  function render(value){
    const previousPhase=current?.phase;current=value&&typeof value==='object'?value:{};const busy=!!current.busy||!!pending,phase=current.phase||'unknown',resume=['preparing','importing','prepared'].includes(phase);
    state.textContent=phases[phase]||(busy?'Η μεταφορά βρίσκεται σε εξέλιξη.':'Δεν επιβεβαιώθηκε η κατάσταση της κύριας βάσης.');stage.textContent=current.stage||'';if(current.error)error.textContent=current.error;else if(previousPhase!==phase||phase==='active')error.textContent='';
    form.hidden=!['cloud','preparing','importing','prepared'].includes(phase);get('[data-primary-explanation]').textContent=['cloud_return','cloud_remote'].includes(phase)?'Η σύνδεση χρηστών και οι καταχωρίσεις λειτουργούν απευθείας στο Cloudflare. Ο Server συνεχίζει να διαβάζει το Ordexa και στέλνει τις αλλαγές όταν είναι συνδεδεμένος.':'Μετά τη μεταφορά σε αυτό το κινητό, οι καταχωρίσεις και η σύνδεση χρηστών εξυπηρετούνται από τον Server. Όταν είναι εκτός σύνδεσης, διατηρούνται τα προσχέδια και η τελευταία διαθέσιμη προβολή.';for(const input of form.elements)input.disabled=busy;
    start.disabled=busy||current.portableBackupEnabled!==true||!['cloud','preparing','importing','prepared'].includes(phase);start.textContent=resume?'Συνέχεια μεταφοράς':'Μεταφορά και έλεγχος';get('[data-primary-resume]').hidden=!resume;
    form.elements.username.required=!resume;form.elements.password.required=!resume;
    get('[data-primary-protection]').textContent=current.portableBackupEnabled?'Ο φορητός κωδικός backup έχει ρυθμιστεί.':'Ρύθμισε πρώτα τον φορητό κωδικό στην καρτέλα Αντίγραφα.';
    const cloudReturn=get('[data-cloud-return]');cloudReturn.hidden=typeof bridge.startCloudReturn!=='function'||!['active','cloud_return'].includes(phase);cloudReturn.disabled=busy||current.portableBackupEnabled!==true;cloudReturn.textContent=phase==='cloud_return'?'Συνέχεια επιστροφής':'Επιστροφή στο Cloudflare';get('[data-cloud-copy]').hidden=cloudReturn.hidden;
    stop.hidden=!current.busy;abort.hidden=!resume||busy;get('[data-primary-identity]').hidden=!/^[a-f0-9]{64}$/.test(current.fingerprint||'');get('[data-primary-fingerprint]').textContent=current.fingerprint||'';
  }
  function read(){try{render(JSON.parse(bridge.getPrimaryMigrationStatus()));}catch{state.textContent='Δεν διαβάστηκε η κατάσταση. Πάτησε Ανανέωση.';start.disabled=true;get('[data-cloud-return]').disabled=true;}}
  function request(action,body){if(pending)return;pending=globalThis.crypto?.randomUUID?.()||'primary-'+Date.now().toString(36);error.textContent='';render(current);try{bridge[action](JSON.stringify({...body,requestId:pending}));}catch{pending='';read();error.textContent='Δεν ξεκίνησε η ενέργεια. Δοκίμασε ξανά.';}}
  form.onsubmit=event=>{event.preventDefault();if(!form.reportValidity()||start.disabled)return;const body={username:form.elements.username.value.trim(),password:form.elements.password.value,backupCodeSaved:form.elements.backupCodeSaved.checked};request('startPrimaryMigration',body);form.elements.password.value='';};
  get('[data-cloud-return]').onclick=()=>{if(!get('[data-cloud-return]').disabled)request('startCloudReturn',{});};
  stop.onclick=()=>{if(current?.phase==='cloud_return'&&typeof bridge.cancelCloudReturn==='function')bridge.cancelCloudReturn();else bridge.cancelPrimaryMigration();stage.textContent='Θα σταματήσει μόλις ολοκληρωθεί με ασφάλεια το τρέχον βήμα.';};
  abort.onclick=()=>{
    if(pending)return;let dialog=document.getElementById('primaryAbortDialog');if(!dialog){dialog=document.createElement('dialog');dialog.id='primaryAbortDialog';dialog.innerHTML='<form method="dialog"><h2>Ακύρωση μεταφοράς</h2><p>Η παλιά βάση θα δεχτεί ξανά καταχωρίσεις. Το τοπικό αντίγραφο και τα backup διατηρούνται. Η ενεργή κύρια βάση Server δεν μπορεί να ακυρωθεί από εδώ.</p><div class="dialog-buttons"><button class="secondary-action" value="cancel">Πίσω</button><button class="primary-action inline" value="confirm">Ακύρωση μεταφοράς</button></div></form>';document.body.append(dialog);}
    dialog.onclose=()=>{if(dialog.returnValue==='confirm')request('abortPrimaryMigration',{confirmed:true});};dialog.showModal();
  };
  get('[data-primary-refresh]').onclick=read;
  section.addEventListener('toggle',()=>{clearInterval(timer);if(section.open){read();timer=setInterval(read,2000);}});
  const original=window.FleetServer?.onNativeEvent;if(typeof original==='function')window.FleetServer.onNativeEvent=function(event,payload){original.call(this,event,payload);if(!['primaryMigration','primaryMigrationAbort','cloudReturn'].includes(event)||payload?.requestId!==pending)return;pending='';read();if(payload.ok!==true&&!['active','cloud_remote'].includes(current?.phase))error.textContent=typeof payload.message==='string'?payload.message:'Δεν ολοκληρώθηκε η ενέργεια.';};
  read();
}());
