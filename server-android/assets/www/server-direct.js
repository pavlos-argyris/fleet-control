(function(){
  'use strict';
  const bridge=window.AndroidServer;
  const target=document.getElementById('panelSettings');if(!target)return;
  const section=document.createElement('section');section.className='server-section-card';
  const heading=document.createElement('h2');heading.textContent='Εφεδρική πρόσβαση χωρίς D1';
  const description=document.createElement('p');description.textContent='Ενεργοποιεί σύνδεση και προβολή του τοπικού αντιγράφου από άλλο Wi-Fi ή δεδομένα κινητής. Οι καταχωρίσεις και οι εισαγωγές παραμένουν στην κανονική σύνδεση. Απαιτεί αντίγραφο δικαιωμάτων των τελευταίων 24 ωρών.';
  const status=document.createElement('p');status.setAttribute('role','status');
  const label=document.createElement('label'),copy=document.createElement('span'),code=document.createElement('input');copy.textContent='Κωδικός σύζευξης';code.type='text';code.readOnly=true;code.autocomplete='off';code.setAttribute('aria-label','Κωδικός σύζευξης');code.style.width='100%';code.style.fontSize='13px';label.append(copy,code);
  const buttons=document.createElement('div');buttons.className='dialog-buttons';
  const toggle=document.createElement('button');toggle.type='button';toggle.className='secondary-action';
  const share=document.createElement('button');share.type='button';share.className='secondary-action';share.textContent='Κοινοποίηση σύνδεσης';
  buttons.append(toggle,share);section.append(heading,description,status,label,buttons);target.append(section);
  let state={},pending=false;
  function refresh(){if(!bridge||typeof bridge.getDirectAccessState!=='function'){status.textContent='Χρειάζεται νέα έκδοση Server.';toggle.disabled=true;share.disabled=true;return;}try{state=JSON.parse(bridge.getDirectAccessState());toggle.textContent=state.enabled?'Απενεργοποίηση & ανάκληση συνδέσεων':'Ενεργοποίηση εφεδρικής πρόσβασης';toggle.disabled=pending;share.disabled=!state.enabled||pending;label.hidden=!state.enabled;code.value=state.pairingCode||'';status.textContent=(state.enabled?(state.connected?'Συνδεδεμένος Server.':'Αναμονή σύνδεσης Server. ')+(state.error||''):'Απενεργοποιημένη.')+(state.snapshotAt?' Αντίγραφο: '+state.snapshotAt:' Δεν υπάρχει ακόμη αντίγραφο προσωπικού.');}catch{status.textContent='Δεν φορτώθηκε η κατάσταση πρόσβασης.';toggle.disabled=true;share.disabled=true;}}
  toggle.addEventListener('click',()=>{if(pending)return;pending=true;toggle.disabled=true;bridge.configureDirectAccess(!state.enabled);});
  share.addEventListener('click',()=>{if(state.enabled)bridge.shareDirectAccess();});
  if(window.FleetServer){const original=window.FleetServer.onNativeEvent;window.FleetServer.onNativeEvent=function(event,payload){if(original)original.call(this,event,payload);if(event==='directAccess'){pending=false;refresh();if(payload?.ok===false)status.textContent=payload.message||'Δεν αποθηκεύτηκε η ρύθμιση.';}};}
  setInterval(()=>{if(pending)pending=false;if(document.visibilityState!=='hidden')refresh();},5000);refresh();
}());
