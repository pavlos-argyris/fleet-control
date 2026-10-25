(function(root){
  'use strict';
  let session=null,advancing=false,opening=false;
  const editable=r=>r&&r.key&&!['processing','delayed','error','confirmed'].includes(r.status);
  const dialog=()=>document.getElementById('invoiceReviewDialog');
  function bar(){
    const d=dialog();if(!d)return;
    let box=d.querySelector('[data-sequential-bar]');
    if(!box){box=document.createElement('div');box.dataset.sequentialBar='';box.className='sequential-review-bar';const actions=d.querySelector('.invoice-review-actions');if(actions)actions.before(box);else d.querySelector('form').append(box);}
    box.hidden=!session;if(!session)return;
    box.innerHTML='<strong>Διαδοχικός έλεγχος · '+(session.index+1)+' / '+session.ids.length+'</strong><small style="display:block;margin-top:4px">Η Αποθήκευση επιβεβαίωσης ανοίγει αυτόματα το επόμενο τιμολόγιο της λίστας. Τα φίλτρα διατηρούνται. Η Παράλειψη και η Παύση δεν αποθηκεύουν αλλαγές.</small><div class="service-tools-toolbar"><button type="button" class="secondary-button" data-sequential-skip>Παράλειψη</button><button type="button" class="ghost-button" data-sequential-stop>Παύση</button></div>';
    const busy=()=>document.getElementById('invoiceReviewSave')?.disabled||root.FleetInvoiceApi.reviewBusy?.();
    box.querySelector('[data-sequential-skip]').onclick=()=>{if(!busy())move();};
    box.querySelector('[data-sequential-stop]').onclick=()=>{if(!busy()){stop();d.close();}};
  }
  function stop(){session=null;advancing=false;bar();}
  async function current(){
    if(!session||opening)return;opening=true;const active=session;
    try{
      let record;
      while(session===active&&active.index<active.ids.length){
        record=root.FleetInvoiceApi.getDocuments().find(r=>String(r.id)===active.ids[active.index]);
        if(editable(record))break;active.index++;record=null;
      }
      if(session!==active)return;
      if(!record){stop();root.FleetInvoiceApi.toast('Δεν υπάρχουν άλλα διαθέσιμα τιμολόγια μετά από αυτό στη συγκεκριμένη λίστα. Οι παραλειφθείσες εγγραφές παραμένουν για έλεγχο.');return;}
      await root.FleetInvoiceApi.review(record.id);
      if(session!==active)return;
      if(!dialog()?.open){stop();return;}
      bar();
    }catch(error){if(session===active)stop();root.FleetInvoiceApi.toast(error.message||'Δεν άνοιξε ο έλεγχος τιμολογίου.');}
    finally{opening=false;advancing=false;}
  }
  function opened(id,records){
    id=String(id);
    // Keep the original queue stable when polling reorders/replaces its rows.
    if(session?.ids[session.index]===id){bar();return;}
    const list=Array.isArray(records)?records:[],index=list.findIndex(r=>String(r.id)===id);
    const rest=index<0?[]:list.slice(index+1).filter(editable).map(r=>String(r.id));
    session={ids:[id,...new Set(rest.filter(next=>next!==id))],index:0};advancing=false;bar();
  }
  function move(){
    if(!session||advancing||opening||!dialog()?.open)return false;
    advancing=true;session.index++;
    // Open the next document only after the real close event. A deferred
    // native close event must never reset the newly opened review session.
    dialog().close();return true;
  }
  function saved(id){
    if(!session||session.ids[session.index]!==String(id))return false;
    return move();
  }
  function start(records){
    if(session||opening)return;
    const ids=[...new Set(records.filter(editable).map(r=>String(r.id)))];
    if(!ids.length)return root.FleetInvoiceApi.toast('Δεν υπάρχουν διαθέσιμα τιμολόγια προς έλεγχο με αυτά τα φίλτρα.');
    session={ids,index:0};current();
  }
  root.FleetSequentialReview={start,opened,saved,decorate:bar,stop};
  document.addEventListener('DOMContentLoaded',()=>{dialog()?.addEventListener('close',()=>{
    if(!advancing){stop();return;}
    const active=session;setTimeout(()=>{if(session===active)current();},0);
  });},{once:true});
})(window);
