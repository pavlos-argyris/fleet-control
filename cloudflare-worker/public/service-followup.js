(function(root){
  'use strict';
  const M=root.FleetServiceModel,U=root.FleetServiceUI;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const km=n=>Number(n).toLocaleString('el-GR')+' χλμ.';
  const date=d=>M.date(d)?M.date(d).split('-').reverse().join('/'):'Χωρίς ημερομηνία';
  const A=()=>root.FleetFollowupAdapter;
  let dialog=null,bikes=[],documents=[],outbox=[],tab='pending',filter={bikeId:'',from:'',to:'',includeExempt:false},request=0,recoveryTimer=0,recoveryActive=false;
  const pathApi=(path,options)=>A().api(path,options);
  async function load(){
    const revision=++request,context=A().context?.();
    if(dialog?.open)dialog.querySelector("[data-followup-message]").textContent="Φόρτωση ιστορικού και καταστάσεων…";
    const result=await Promise.allSettled([tab==='pending'?Promise.resolve({bikes:A().getBikes?.()||bikes}):A().api('/api/snapshot'),M.loadInvoiceDocuments(pathApi),A().getOutbox()]);
    if(revision!==request||!dialog?.open)return;
    if(!A().canManage()||context!==A().context?.()){dialog.close();return;}
    const messages=[];
    if(result[0].status==='fulfilled'){const archived=new Set(result[0].value.archivedBikeIds||[]);bikes=(result[0].value.bikes||[]).filter(b=>!archived.has(b.id));}else {bikes=A().getBikes?.()||[];messages.push('Δεν ανανεώθηκε το ιστορικό: '+result[0].reason.message);}
    if(result[1].status==='fulfilled')documents=result[1].value.documents||[];else{documents=[];messages.push('Δεν φορτώθηκε η κατάσταση τιμολογίων: '+result[1].reason.message);}
    if(result[2].status==='fulfilled')outbox=result[2].value;else {outbox=[];messages.push('Δεν διαβάστηκε η τοπική ουρά: '+result[2].reason.message);}
    if(tab==='pending'&&!bikes.length)bikes=[...new Map(documents.map(d=>[d.bikeId,{id:d.bikeId,name:d.bikeName,history:[]}])).values()];
    dialog.querySelector('[data-followup-message]').textContent=messages.join(' · ');render();
  }
  function filtered(bike,entry){const d=M.date(entry.date);return (!filter.bikeId||String(bike.id)===filter.bikeId)&&(!(filter.from||filter.to)||(!!d&&(!filter.from||d>=filter.from)&&(!filter.to||d<=filter.to)));}
  function localRows(){return outbox.filter(row=>(row.data.items||[]).some(i=>!i.done)).map(row=>{const job=row.data,bike=bikes.find(b=>String(b.id)===String(job.bikeId)),entry=bike?.history?.find(e=>String(e.id)===String(job.entryId));return {row,bike,entry};});}
  function classify(){
    const local=localRows(),queued=new Set(local.map(v=>String(v.row.data.entryId)));
    const missing=M.missingInvoices(bikes,{...filter,queuedEntryIds:[...queued]});
    const mileage=bikes.flatMap(b=>M.chronology(b)).filter(r=>filtered(r.bike,r.entry)&&(!r.acknowledgment||filter.includeExempt));
    const invoices=documents.filter(r=>r.status!=='confirmed'&&(!filter.bikeId||String(r.bikeId)===filter.bikeId)&&(!(filter.from||filter.to)||(M.date(r.serviceDate)&&(!filter.from||M.date(r.serviceDate)>=filter.from)&&(!filter.to||M.date(r.serviceDate)<=filter.to))));
    return {missing,mileage,invoices,local:local.filter(r=>r.bike&&r.entry?filtered(r.bike,r.entry):!filter.bikeId&&!filter.from&&!filter.to)};
  }
  function card(title,context,body,buttons,badge){return '<article class="followup-card"><header><div><strong>'+esc(title)+'</strong><small>'+esc(context)+'</small></div><span class="followup-badge">'+esc(badge||'Εκκρεμεί')+'</span></header><p>'+esc(body)+'</p><div class="service-tools-toolbar">'+buttons+'</div></article>';}
  const button=(name,label,index)=>'<button type="button" class="secondary-button" data-followup-action="'+name+'" data-index="'+index+'">'+label+'</button>';
  function render(){
    if(!dialog?.open)return;
    const data=classify(),counts={missing:data.missing.filter(r=>!r.exempt).length,mileage:data.mileage.filter(r=>!r.acknowledgment).length,pending:data.invoices.length+data.local.length};
    dialog.querySelector('[data-followup-tabs]').innerHTML=[['pending','Εκκρεμότητες'],['missing','Service χωρίς τιμολόγιο'],['mileage','Έλεγχος χιλιομέτρων']].map(([id,label])=>'<button type="button" class="secondary-button '+(tab===id?'active':'')+'" data-followup-tab="'+id+'" aria-pressed="'+(tab===id)+'">'+label+' <b>'+counts[id]+'</b></button>').join('');
    const rows=[];
    if(tab==='missing')data.missing.forEach((r,i)=>rows.push(card(r.bike.name,date(r.entry.date)+' · '+km(r.entry.km),r.exempt?'Δεν αναμένεται τιμολόγιο: '+r.entry.invoiceExpectation.reason+' · '+r.entry.invoiceExpectation.actor:'Δεν υπάρχει συνδεδεμένο PDF ούτε ενεργή ανάγνωση ή τοπική αποστολή.',button('edit-missing','Προσθήκη QR / αρχείου',i)+button('expectation',r.exempt?'Αναμένεται ξανά τιμολόγιο':'Δεν αναμένεται τιμολόγιο',i),r.exempt?'Εξαιρέθηκε':'Χωρίς τιμολόγιο')));
    if(tab==='mileage')data.mileage.forEach((r,i)=>rows.push(card(r.bike.name,date(r.entry.date)+' · '+km(r.entry.km),'Προηγούμενη ημέρα καταγραφής: '+date(r.previous.date)+' · '+km(r.previous.km)+(r.acknowledgment?' · Επιβεβαιώθηκε: '+r.acknowledgment.reason+' · '+r.acknowledgment.actor:''),button('edit-mileage','Έλεγχος καταχώρησης',i)+(r.acknowledgment?'':button('acknowledge','Είναι σωστό',i)),r.acknowledgment?'Ελέγχθηκε':'Μικρότερη ένδειξη')));
    if(tab==='pending'){
      data.local.forEach((r,i)=>{const remaining=r.row.data.items.filter(v=>!v.done);rows.push(card(r.bike?.name||'Καταχώρηση στη συσκευή',r.entry?date(r.entry.date):'Το service δεν βρέθηκε στην τρέχουσα λίστα',r.row.data.error||'Περιμένουν αποστολή '+remaining.length+' PDF/QR. Τα αρχεία είναι αποθηκευμένα σε αυτή τη συσκευή.',button('outbox','Νέα προσπάθεια αποστολής',i),r.row.data.error?'Αποτυχία αποστολής':'Τοπική ουρά'));});
      data.invoices.forEach((r,i)=>{const busy=['processing','delayed'].includes(r.status),failed=r.status==='error'||r.status==='delayed';let text=r.error||(r.warnings||[]).map(w=>w.message||w.label).join(' · ');
        if(!text)text=busy?(r.progressStage||r.progress?.stage||r.invoiceData?.qrProcessingStage||'Ο Server διαβάζει το τιμολόγιο. Περιμένουμε ολοκλήρωση.'):'Έλεγξε τα στοιχεία που διαβάστηκαν και επιβεβαίωσέ τα.';
        let actions=r.key&&!busy?button('review','Έλεγχος / διόρθωση',i):'';if(failed&&(r.canRestart||r.canRetry))actions+=button('retry','Νέα προσπάθεια ανάλυσης',i);if(r.key)actions+=button('open','Άνοιγμα PDF',i);
        rows.push(card(r.bikeName||'Τιμολόγιο',r.name+' · '+date(r.serviceDate),text,actions,busy?'Σε επεξεργασία':failed?'Σφάλμα':'Προς έλεγχο'));
      });
    }
    dialog.querySelector('[data-followup-list]').innerHTML=rows.join('')||'<p class="followup-empty">Δεν υπάρχουν εγγραφές με αυτά τα φίλτρα.</p>';
    dialog.querySelector('h2').textContent=tab==='missing'?'Service χωρίς τιμολόγιο':tab==='mileage'?'Έλεγχος ιστορικού χιλιομέτρων':'Εκκρεμότητες στόλου';
    dialog.querySelector('[data-followup-explanation]').textContent=tab==='missing'?'Εδώ βρίσκεις service χωρίς συνδεδεμένο PDF. Πρόσθεσε QR ή αρχείο στην υπάρχουσα καταχώρηση. Αν δεν πρόκειται να έχει τιμολόγιο, δήλωσέ το με εξήγηση· το service δεν διαγράφεται.':tab==='mileage'?'Εδώ εμφανίζονται καταγραφές με λιγότερα χιλιόμετρα από προηγούμενη ημερομηνία. Με «Έλεγχος καταχώρησης» διορθώνεις τα στοιχεία. Με «Είναι σωστό» κρατάς την ένδειξη και εξηγείς τη διαφορά.':'Εδώ συγκεντρώνονται τιμολόγια προς έλεγχο, αναγνώσεις που καθυστερούν ή απέτυχαν και αρχεία που περιμένουν αποστολή από αυτή τη συσκευή. Η ενέργεια σε κάθε κάρτα δείχνει το επόμενο βήμα.';
    dialog.querySelector('[data-followup-caption]').textContent=tab==='pending'?'Οι τοπικές αποστολές αφορούν αυτή τη συσκευή και τον λογαριασμό σου. Service χωρίς τιμολόγιο και έλεγχοι χιλιομέτρων εμφανίζονται στις διπλανές καρτέλες.':tab==='mileage'?'Συγκρίνονται καταγραφές διαφορετικών ημερών. Η επιβεβαίωση ισχύει μόνο για αυτές τις δύο ημερομηνίες και ενδείξεις. Δεν αλλάζει χιλιόμετρα ή κύκλους service.':'Η περίοδος αφορά την ημερομηνία service. Η εξαίρεση καταγράφει ποιος την έκανε και γιατί.';
    const bulk=dialog.querySelector('[data-followup-recover]');if(bulk){const count=recoverable(data.invoices).length;bulk.hidden=tab!=='pending'||!count;bulk.disabled=recoveryActive;bulk.textContent='Επανάληψη όλων ('+count+')';}
    dialog.dataset.count=String(rows.length);dialog.followupData=data;
  }
  function recoverable(records){const seen=new Set();return records.filter(r=>!['confirmed','processing'].includes(r.status)&&(r.key||r.jobId||r.qrUrl)&&!seen.has(r.key||r.jobId||r.id)&&seen.add(r.key||r.jobId||r.id));}
  async function watchRecovery(resume=false){
    clearTimeout(recoveryTimer);const d=dialog,context=A().context?.();if(!d?.open)return;
    try{
      let data=await pathApi('/api/admin/service-documents/reprocess-batch',{forceRead:true});
      if(!d.open||context!==A().context?.())return;
      if(resume&&data.batch)data=await pathApi('/api/admin/service-documents/reprocess-batch',{method:'POST',body:{action:'resume',batchId:data.batch.id}});
      if(!d.open||context!==A().context?.())return;
      const wasActive=recoveryActive,b=data.batch,active=b&&['processing','paused'].includes(b.status);recoveryActive=!!active;
      d.querySelector('[data-recovery-resume]').hidden=!b||!['error','paused'].includes(b.status)||Number(b.completed)>=Number(b.total);
      const node=d.querySelector('[data-recovery-status]');
      node.textContent=b?'Ουρά Server: '+Number(b.completed||0)+' / '+Number(b.total||0)+' · '+Number(b.progress||0)+'% · '+(b.currentName||'')+' · Αποτυχίες: '+Number(b.failed||0)+(b.queued?' · QR που υποβλήθηκαν στην ουρά: '+b.queued:'')+(b.error?' · '+b.error:'')+(active?' · Μπορείς να κλείσεις την καρτέλα. Η ουρά συνεχίζει στον Server.':' · Η νέα ανάγνωση δεν επιβεβαιώνει αυτόματα ανεπίλυτες διαφορές.')+(b.results||[]).filter(r=>r.status==='error').map(r=>' · '+r.name+': '+r.error).join(''):'';
      render();if(wasActive&&!active)await load();if(active)recoveryTimer=setTimeout(()=>{if(!document.hidden)watchRecovery();else recoveryTimer=setTimeout(()=>watchRecovery(),15000);},15000);
    }catch(error){if(d.open&&context===A().context?.())d.querySelector('[data-recovery-status]').textContent='Δεν ανανεώθηκε η πρόοδος: '+error.message+' Η αποθηκευμένη ουρά διατηρείται.';}
  }
  async function recoverAll(entryIds){
    const d=dialog,context=A().context?.();if(!d?.open||!A().canManage()||recoveryActive)return;
    const ids=entryIds?new Set(entryIds):null,records=recoverable(classify().invoices).filter(r=>!ids||ids.has(String(r.bikeId)+':'+String(r.entryId)));
    if(!records.length)return A().toast('Δεν υπάρχουν διαθέσιμα τιμολόγια για νέα προσπάθεια με αυτά τα φίλτρα.');
    const mode=await new Promise(resolve=>{
      const choose=U.dialog('Επανάληψη '+records.length+' τιμολογίων','<p>Η λίστα αποθηκεύεται στον Server και διαβάζεται σε μικρές ομάδες, ακόμη κι αν κλείσεις την εφαρμογή. Οι επιβεβαιωμένες διορθώσεις διατηρούνται. Νέες διαφορές παραμένουν προς έλεγχο.</p><div class="service-tools-toolbar"><button class="primary-button" data-recovery-mode="server-first">Server πρώτα</button><button class="secondary-button" data-recovery-mode="workers-ai">Αναγκαστικά Workers AI</button><button class="ghost-button" data-recovery-back>Πίσω</button></div><p class="service-action-help">Server πρώτα: τοπική ανάγνωση και AI μόνο αν χρειαστεί. Workers AI: απαιτεί πρόσβαση στην υπηρεσία AI. QR χωρίς PDF ανακτώνται πρώτα στον Server.</p>');
      let value=null;choose.onclick=e=>{const button=e.target.closest('[data-recovery-mode]');if(button){value=button.dataset.recoveryMode;choose.close();}else if(e.target.closest('[data-recovery-back]'))choose.close();};choose.addEventListener('close',()=>resolve(value),{once:true});
    });
    if(!mode||!d.open||context!==A().context?.()||!A().canManage())return;
    recoveryActive=true;render();
    try{
      await pathApi('/api/admin/service-documents/reprocess-batch',{method:'POST',body:{action:'start',recovery:true,mode,batchId:crypto.randomUUID(),items:records.map(r=>({id:r.id,key:r.key,name:r.name,jobId:r.jobId||r.invoiceData?.qrJobId,bikeId:r.bikeId,entryId:r.entryId,qrUrl:r.qrUrl||r.invoiceData?.qrUrl}))}});
      if(context===A().context?.()&&d.open){A().toast('Η ουρά αποθηκεύτηκε. Η επεξεργασία συνεχίζεται στον Server.');await watchRecovery();}
    }catch(error){recoveryActive=false;if(context===A().context?.()&&d.open)d.querySelector('[data-recovery-status]').textContent='Δεν επιβεβαιώθηκε η αποθήκευση της ουράς: '+error.message+' Πάτησε Ανανέωση για έλεγχο πριν επαναλάβεις.';}
    finally{if(d.open)render();}
  }
  async function reason(title,explanation){
    return new Promise(resolve=>{const d=U.dialog(title,'<p>'+esc(explanation)+'</p><form data-reason-form><label class="field"><span>Εξήγηση</span><textarea data-reason required minlength="3" maxlength="500" rows="3"></textarea></label><p data-reason-error role="alert"></p><div class="service-tools-toolbar"><button type="button" class="ghost-button" data-reason-cancel>Ακύρωση</button><button type="submit" class="primary-button">Επιβεβαίωση</button></div></form>');let value=null;d.querySelector('[data-reason-cancel]').onclick=()=>d.close();d.querySelector('form').onsubmit=e=>{e.preventDefault();const text=d.querySelector('textarea').value.trim();if(text.length<3){d.querySelector('[data-reason-error]').textContent='Γράψε μια σύντομη εξήγηση.';return;}value=text;d.close();};d.addEventListener('close',()=>resolve(value),{once:true});});
  }
  async function action(target){
    const name=target.dataset.followupAction,index=Number(target.dataset.index),data=dialog.followupData;
    const context=A().context?.();
    if(!A().canManage())return A().toast("Χρειάζεται πρόσβαση διαχείρισης στόλου.");
    target.disabled=true;
    try{
      if(name==='outbox'){await A().retryOutbox();await load();return;}
      if(['review','retry','open'].includes(name)){const r=data.invoices[index];if(name==='review'){dialog.close();await A().review(r);}else if(name==='retry'){await A().retry(r);await load();}else await A().openDocument(r);return;}
      const r=name==='expectation'||name==='edit-missing'?data.missing[index]:data.mileage[index];
      if(name.startsWith('edit-')){dialog.close();await A().edit(r.bike.id,r.entry.id,name==='edit-missing'?'invoice':'mileage');return;}
      let text='',body={bikeId:r.bike.id,entryId:r.entry.id,expectedEntryUpdatedAt:String(r.entry.updatedAt||'')};
      if(name==='expectation'){if(!r.exempt){text=await reason('Δεν αναμένεται τιμολόγιο','Το service θα βγει από τις εκκρεμότητες τιμολογίων. Η καταχώρηση και οι εργασίες του διατηρούνται.');if(text==null)return;}Object.assign(body,{action:'invoice-expectation',status:r.exempt?'expected':'not_expected',reason:text});}
      else{ text=await reason('Η ένδειξη είναι σωστή','Επιβεβαιώνεις '+km(r.entry.km)+' στις '+date(r.entry.date)+', μετά από '+km(r.previous.km)+' στις '+date(r.previous.date)+'. Εξήγησε π.χ. αλλαγή κοντέρ.');if(text==null)return;Object.assign(body,{action:'acknowledge-km',signature:r.signature,reason:text});}
      if(context!==A().context?.()||!A().canManage())return;
      const result=await A().api('/api/admin/service-followup',{method:'POST',body});if(context!==A().context?.())return;A().applyBike?.(result.bike);bikes=bikes.map(b=>b.id===result.bike.id?result.bike:b);render();A().toast('Η απόφαση αποθηκεύτηκε και καταγράφηκε.');
    }catch(error){if(dialog?.open)dialog.querySelector('[data-followup-message]').textContent=error.message;A().toast(error.message);}finally{target.disabled=false;}
  }
  async function serverReport(){
    const context=A().context?.();
    const d=U.dialog('Συνολικός έλεγχος από Server','<p class="service-section-help">Ο Server συγκεντρώνει τα κόστη, τα service χωρίς τιμολόγιο, πιθανές διπλοεγγραφές και διαφορές χιλιομέτρων. Ο έλεγχος είναι μόνο ενημερωτικός· δεν αλλάζει τις καταχωρήσεις σου.</p><div data-server-report role="status"></div><div class="service-tools-toolbar"><button type="button" class="secondary-button" data-server-report-refresh>Ανανέωση</button><button type="button" class="ghost-button" data-server-report-back>Πίσω</button></div>');
    const target=d.querySelector('[data-server-report]'),refresh=d.querySelector('[data-server-report-refresh]');
    d.querySelector('[data-server-report-back]').onclick=()=>d.close();
    async function read(){refresh.disabled=true;target.textContent='Φόρτωση συνολικού ελέγχου…';
      try{const data=await A().api('/api/admin/server-report');if(!d.open)return;if(context!==A().context?.()||!A().canManage()){d.close();return;}
        if(!data.ready||!data.report){target.textContent=data.message||'Ο Server ετοιμάζει τον τρέχοντα έλεγχο. Δοκίμασε Ανανέωση σε λίγο.';return;}
        const r=data.report,labels={missing:'Χωρίς τιμολόγιο',mileage:'Έλεγχος ιστορικού χιλιομέτρων',duplicate:'Πιθανό διπλό τιμολόγιο','invoice-km':'Χιλιόμετρα service / τιμολογίου'};
        target.innerHTML=card('Σύνολο καταγεγραμμένου κόστους',M.euro(r.costCents),r.services+' service · '+r.documents+' τιμολόγια · '+r.unknownCosts+' ποσά δεν έχουν διαβαστεί. Τα ποσά που λείπουν δεν υπολογίζονται ως μηδενικό κόστος.','','Τρέχον ιστορικό')+
          (r.bikes||[]).map(b=>card(b.name,M.euro(b.costCents),b.services+' service · '+b.missingInvoices+' χωρίς τιμολόγιο · '+b.unknownCosts+' ποσά άγνωστα','','Σύνολο οχήματος')).join('')+
          '<p>Οι διαφορές service / τιμολογίου εμφανίζονται και όταν έχεις επιλέξει να κρατήσεις τη δική σου ένδειξη, με σχετική επισήμανση.</p>'+
          (r.issues||[]).map(i=>card(i.bike,date(i.date),i.detail,'',labels[i.kind]||'Έλεγχος')).join('')+
          (r.truncated?'<p>Εμφανίζονται οι πρώτες 500 επισημάνσεις. Τα σύνολα περιλαμβάνουν όλο τον στόλο.</p>':'');
      }catch(e){if(d.open)target.textContent=e.message;}finally{refresh.disabled=false;}}
    refresh.onclick=read;await read();
  }
  async function open(selected,options){
    if(!A()?.canManage())return A()?.toast('Χρειάζεται πρόσβαση διαχείρισης στόλου.');
    if(dialog?.open){tab=selected||tab;render();if(options?.recover)await recoverAll(options.entryIds);return;}
    tab=selected||'pending';bikes=A().getBikes?.()||[];documents=[];outbox=[];
    dialog=U.dialog('Εκκρεμότητες στόλου','<p class="service-section-help" data-followup-explanation></p><div class="service-tools-toolbar" data-followup-tabs></div><div class="followup-filters"><label>Μηχανάκι<select data-bike><option value="">Όλα</option></select></label><label>Από<input type="date" data-from></label><label>Έως<input type="date" data-to></label><label class="followup-check"><input type="checkbox" data-exempt> Εμφάνιση εξαιρέσεων / ελεγμένων</label></div><p data-followup-caption></p><p data-followup-message role="alert"></p><section class="service-section-help" data-recovery-status role="status" aria-live="polite"></section><div class="service-tools-toolbar"><button type="button" class="primary-button" data-followup-recover hidden>Επανάληψη όλων</button><button type="button" class="secondary-button" data-recovery-resume hidden>Συνέχιση ουράς</button></div><div data-followup-list></div><div class="service-tools-toolbar"><button type="button" class="secondary-button" data-server-report-open>Συνολικός έλεγχος από Server</button><button type="button" class="secondary-button" data-followup-refresh>Ανανέωση</button><button type="button" class="ghost-button" data-followup-close>Πίσω</button></div>');dialog.classList.add('followup-dialog');
    const d=dialog;const select=d.querySelector('[data-bike]');
    function populate(){const val=filter.bikeId;select.innerHTML='<option value="">Όλα</option>'+bikes.map(b=>'<option value="'+esc(b.id)+'">'+esc(b.name)+'</option>').join('');select.value=val;}
    populate();d.querySelector('[data-from]').value=filter.from;d.querySelector('[data-to]').value=filter.to;d.querySelector('[data-exempt]').checked=filter.includeExempt;
    d.querySelector('.followup-filters').onchange=()=>{filter={bikeId:select.value,from:d.querySelector('[data-from]').value,to:d.querySelector('[data-to]').value,includeExempt:d.querySelector('[data-exempt]').checked};if(filter.from&&filter.to&&filter.from>filter.to){d.querySelector('[data-followup-message]').textContent='Η ημερομηνία «Από» πρέπει να προηγείται της «Έως».';return;}render();};
    d.querySelector('[data-server-report-open]').onclick=serverReport;
    d.querySelector('[data-followup-recover]').onclick=()=>recoverAll();
    d.querySelector('[data-recovery-resume]').onclick=()=>watchRecovery(true);
    d.querySelector('[data-followup-refresh]').onclick=()=>load().then(populate).catch(e=>A().toast(e.message));d.querySelector('[data-followup-close]').onclick=()=>d.close();
    d.onclick=e=>{const t=e.target.closest('[data-followup-tab]');if(t){tab=t.dataset.followupTab;render();load().catch(e=>A().toast(e.message));}const b=e.target.closest('[data-followup-action]');if(b)action(b);};
    d.addEventListener('close',()=>{clearTimeout(recoveryTimer);request++;if(dialog===d)dialog=null;},{once:true});render();await load();if(dialog===d){populate();await watchRecovery();if(options?.recover)await recoverAll(options.entryIds);}
  }
  root.FleetFollowup={open,reset(){request++;dialog?.close();dialog=null;bikes=[];documents=[];outbox=[];filter={bikeId:"",from:"",to:"",includeExempt:false};document.querySelectorAll(".service-tools-dialog").forEach(d=>{if(d.open)d.close();});}};
  function mount(){for(const b of document.querySelectorAll('[data-open-followup]'))b.onclick=()=>open(b.dataset.openFollowup);}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})(window);
