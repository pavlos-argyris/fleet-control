(function(root){
  'use strict';
  let session=null,advancing=false,opening=false;
  const editable=r=>r&&r.key&&!['processing','delayed','confirmed'].includes(r.status);
  function bar(){const d=document.getElementById('invoiceReviewDialog');if(!d)return;let box=d.querySelector('[data-sequential-bar]');if(!box){box=document.createElement('div');box.dataset.sequentialBar='';box.className='sequential-review-bar';d.querySelector('form').append(box);}box.hidden=!session;if(!session)return;
    box.innerHTML='<strong>Διαδοχικός έλεγχος · '+(session.index+1)+' / '+session.ids.length+'</strong><small style="display:block;margin-top:4px">Τα φίλτρα της λίστας διατηρούνται. Η παράλειψη δεν αποθηκεύει αλλαγές.</small><div class="service-tools-toolbar"><button type="button" data-sequential-save>Αποθήκευση &amp; επόμενο</button><button type="button" class="secondary-button" data-sequential-skip>Παράλειψη</button><button type="button" class="ghost-button" data-sequential-stop>Παύση</button></div>';
    box.querySelector('[data-sequential-save]').onclick=()=>{const save=document.getElementById('invoiceReviewSave');if(save?.disabled||root.FleetInvoiceApi.reviewBusy?.())return;session.advanceOnSave=true;save.click();};
    box.querySelector('[data-sequential-skip]').onclick=()=>{if((document.getElementById('invoiceReviewSave')?.disabled||root.FleetInvoiceApi.reviewBusy?.()))return;move();};
    box.querySelector('[data-sequential-stop]').onclick=()=>{if((document.getElementById('invoiceReviewSave')?.disabled||root.FleetInvoiceApi.reviewBusy?.()))return;stop();d.close();};
  }
  function stop(){session=null;advancing=false;bar();}
  async function current(){
    if(!session||opening)return;opening=true;const active=session;
    try{
      let record;
      while(session===active&&active.index<active.ids.length){record=root.FleetInvoiceApi.getDocuments().find(r=>String(r.id)===active.ids[active.index]);if(editable(record))break;active.index++;record=null;}
      if(session!==active)return;
      if(!record){stop();root.FleetInvoiceApi.toast('Ο διαδοχικός έλεγχος ολοκληρώθηκε. Οι παραλειφθείσες εγγραφές παραμένουν στη λίστα.');return;}
      await root.FleetInvoiceApi.review(record.id);
      if(!document.getElementById('invoiceReviewDialog')?.open){stop();return;}
      bar();
    }catch(error){stop();root.FleetInvoiceApi.toast(error.message||"Δεν άνοιξε ο έλεγχος τιμολογίου.");}finally{opening=false;advancing=false;}
  }
  function move(){if(!session||advancing||opening)return;advancing=true;session.advanceOnSave=false;session.index++;document.getElementById('invoiceReviewDialog')?.close();setTimeout(current,0);}
  function saved(id){if(!session||session.ids[session.index]!==String(id))return;const shouldAdvance=session.advanceOnSave;session.advanceOnSave=false;if(!shouldAdvance){stop();return;}advancing=true;session.index++;setTimeout(current,0);}
  function start(records){if(session||opening)return;const ids=[...new Set(records.filter(editable).map(r=>String(r.id)))];if(!ids.length)return root.FleetInvoiceApi.toast('Δεν υπάρχουν διαθέσιμα τιμολόγια προς έλεγχο με αυτά τα φίλτρα.');session={ids,index:0,advanceOnSave:false};current();}
  root.FleetSequentialReview={start,saved,decorate:bar,stop};
  document.addEventListener('DOMContentLoaded',()=>{const d=document.getElementById('invoiceReviewDialog');d?.addEventListener('close',()=>{if(!advancing)stop();});});
})(window);
