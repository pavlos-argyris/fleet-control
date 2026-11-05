(function(){
  'use strict';
  const anchor=document.getElementById('settingsDiagnostics'),bridge=window.AndroidServer;
  if(!anchor)return;
  const section=document.createElement('details');
  section.className='server-group';section.id='settingsAuthority';
  section.innerHTML='<summary><span><strong>Μεταφορά βάσης στον Server</strong><small>Προετοιμασία και σύγκριση πριν από την ενεργοποίηση</small></span></summary>'+
    '<div class="server-group-body"><p>Δημιουργεί ξεχωριστό τοπικό αντίγραφο προσωπικού, προγράμματος και ιστορικού και συγκρίνει όλα τα στοιχεία. Η κύρια βάση και τα δικαιώματα παραμένουν όπως είναι.</p>'+
    '<p data-authority-status role="status" aria-live="polite">Άνοιξε την ενότητα για να ελέγξεις την κατάσταση.</p><p data-authority-detail></p><p data-authority-message role="status" aria-live="polite"></p>'+
    '<div class="dialog-buttons"><button type="button" class="secondary-action" data-authority-refresh>Ανανέωση κατάστασης</button><button type="button" class="primary-action inline" data-authority-prepare disabled>Προετοιμασία και σύγκριση</button></div>'+
    '<p class="muted">Η προετοιμασία μπορεί να διαρκέσει ανάλογα με το ιστορικό. Η μεταφορά των καταχωρίσεων στον Server θα ενεργοποιηθεί σε επόμενο βήμα, μετά τον έλεγχο πηγής και δικαιωμάτων.</p></div>';
  anchor.before(section);
  const status=section.querySelector('[data-authority-status]'),detail=section.querySelector('[data-authority-detail]'),message=section.querySelector('[data-authority-message]'),prepare=section.querySelector('[data-authority-prepare]'),refresh=section.querySelector('[data-authority-refresh]');
  let state=null,pending='',sequence=0;
  const supported=()=>typeof bridge?.getAuthorityStageStatus==='function'&&typeof bridge?.prepareAuthorityStage==='function';
  const valid=value=>value&&value.businessWritesEnabled===false&&(
    value.state==='not_prepared'&&value.stageId===''||
    ['prepared','source_changed'].includes(value.state)&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.stageId||'')&&value.contentCompared===true&&Number.isSafeInteger(value.tables)&&value.tables>0&&Number.isSafeInteger(value.rows)&&value.rows>=0&&Number.isSafeInteger(value.preparedAt)&&value.preparedAt>0&&value.preparedAt<=Date.now());
  const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('el-GR'):'μη διαθέσιμος χρόνος';
  function render(value){
    state=valid(value)?value:null;prepare.disabled=!!pending||!supported()||!state;refresh.disabled=!!pending;
    prepare.textContent=state&&state.state!=='not_prepared'?'Επανάληψη προετοιμασίας':'Προετοιμασία και σύγκριση';
    detail.textContent='';
    if(pending){status.textContent='Γίνεται τοπική αντιγραφή και σύγκριση. Περίμενε το αποτέλεσμα.';return;}
    if(!supported()){status.textContent='Χρειάζεται νεότερη έκδοση του Server για την προετοιμασία μεταφοράς.';return;}
    if(!state){status.textContent='Δεν επιβεβαιώθηκε η κατάσταση. Πάτησε Ανανέωση κατάστασης.';return;}
    status.textContent=state.state==='not_prepared'?'Δεν έχει δημιουργηθεί αντίγραφο προετοιμασίας.':state.state==='source_changed'?'Η πηγή ή η σύνδεση άλλαξε. Χρειάζεται νέα προετοιμασία.':'Η αντιγραφή και η σύγκριση ολοκληρώθηκαν. Οι καταχωρίσεις εξακολουθούν να χρησιμοποιούν την υπάρχουσα κύρια βάση.';
    if(state.state!=='not_prepared')detail.textContent=state.tables+' πίνακες · '+state.rows.toLocaleString('el-GR')+' εγγραφές · Προετοιμασία: '+new Date(state.preparedAt).toLocaleString('el-GR')+' · Αντίγραφο πηγής: '+date(state.sourceUpdatedAt);
  }
  function read(){let value={};try{if(supported())value=JSON.parse(bridge.getAuthorityStageStatus());}catch{}render(value);}
  section.addEventListener('toggle',()=>{if(section.open&&!pending){message.textContent='';read();}});
  refresh.onclick=()=>{message.textContent='';read();};
  prepare.onclick=()=>{
    if(pending||!state||!supported())return;
    pending='authority-'+Date.now().toString(36)+'-'+(++sequence);message.textContent='';
    const expectedStageId=state.stageId;render(state);
    try{bridge.prepareAuthorityStage(JSON.stringify({expectedStageId,requestId:pending}));}
    catch{pending='';read();message.textContent='Δεν ξεκίνησε η προετοιμασία. Πάτησε ξανά όταν ο Server είναι διαθέσιμος.';}
  };
  const original=window.FleetServer?.onNativeEvent;
  if(typeof original==='function')window.FleetServer.onNativeEvent=function(event,payload){
    original.call(this,event,payload);
    if(event!=='authorityStage'||!pending||payload?.requestId!==pending)return;
    pending='';read();
    if(payload.ok!==true)message.textContent=typeof payload.message==='string'?payload.message:'Η προετοιμασία δεν ολοκληρώθηκε. Το προηγούμενο αντίγραφο διατηρείται.';
    else if(!state||state.stageId!==payload.stageId||state.state!=='prepared')message.textContent='Η ενέργεια ολοκληρώθηκε, αλλά χρειάζεται νέα επιβεβαίωση της κατάστασης.';
  };
}());
