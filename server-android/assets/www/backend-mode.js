(function(){
  'use strict';const bridge=window.AndroidServer,panel=document.getElementById('backendModePanel');if(!panel)return;
  let revision=0,busy=false;
  const status=document.getElementById('backendModeStatus'),toggle=document.getElementById('backendModeToggle'),message=document.getElementById('backendModeMessage');
  function render(){if(!bridge){toggle.disabled=true;return;}try{const state=JSON.parse(bridge.getBackendMode());if(state.error)throw Error(state.error);revision=state.revision;const badge=document.getElementById('backendCurrentMode');if(badge)badge.textContent=(state.activeMode==='direct'?'Direct Android Server':'Cloudflare')+' · χωριστά δεδομένα';toggle.checked=state.selectedMode==='direct';toggle.disabled=busy;status.textContent='Ενεργό: '+(state.activeMode==='direct'?'Direct Android Server':'Cloudflare')+(state.pending?' · Προετοιμασία Direct: '+state.reason:'')+'\n'+(state.listener||'HTTPS listener ανενεργός · θύρα 8443')+'\n'+(state.certificate||'Πιστοποιητικό: εκκρεμεί έλεγχος')+'\n'+(state.network||'Πρόσβαση Internet: δεν έχει επαληθευτεί.');}catch(e){toggle.disabled=true;status.textContent=e.message;}}
  toggle.onchange=()=>{busy=true;toggle.disabled=true;message.textContent='Εφαρμογή επιλογής…';bridge.selectBackend(toggle.checked?'direct':'cloudflare',revision);};
  document.getElementById('backendPrepare').onclick=()=>bridge?.prepareDirect();
  document.getElementById('backendOwnerForm').onsubmit=event=>{event.preventDefault();const user=document.getElementById('backendUsername'),password=document.getElementById('backendPassword');bridge?.backendLogin(user.value,password.value);password.value='';message.textContent='Έλεγχος τοπικού λογαριασμού…';};
  window.addEventListener('fleet-server-event',event=>{if(event.detail?.event!=='backendMode')return;busy=false;message.textContent=event.detail.payload?.message||'Η ενέργεια δεν επιβεβαιώθηκε.';render();});
  render();setInterval(()=>{if(!document.hidden&&!busy)render();},5000);
})();
