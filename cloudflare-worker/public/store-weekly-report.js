(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FleetStoreWeeklyReport=api;})(typeof window==='object'?window:globalThis,function(){'use strict';
 const fields={unitPriceCents:'Τιμή / παραγγελία',dailyMinimumCents:'Ημερήσιο ελάχιστο',chargeOnZero:'Χρέωση μηδενικής ημέρας'};
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const plus=(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
 const euro=n=>n==null?'Εκκρεμεί':new Intl.NumberFormat('el-GR',{style:'currency',currency:'EUR'}).format(n/100);
 const date=d=>d?new Intl.DateTimeFormat('el-GR',{dateStyle:'short',...(d.length>10?{timeStyle:'short'}:{}),timeZone:'Europe/Athens'}).format(new Date(d.length===10?d+'T12:00:00Z':d)):'Άγνωστο';
 const weekday=d=>new Intl.DateTimeFormat('el-GR',{weekday:'long',timeZone:'UTC'}).format(new Date(d+'T12:00:00Z'));
 function termFor(terms,id,day){return terms.filter(t=>t.storeId===id&&t.effectiveDay<=day).sort((a,b)=>b.effectiveDay.localeCompare(a.effectiveDay)||(b.version||0)-(a.version||0))[0]||null;}
 function sum(rows){const total={orderCount:0,orderChargeCents:0,minimumTopUpCents:0,totalChargeCents:0,incomplete:0};for(const r of rows){if(r.orderCount!=null)total.orderCount+=r.orderCount;else total.unknownCount=true;if(r.problem)total.incomplete++;for(const key of ['orderChargeCents','minimumTopUpCents','totalChargeCents']){if(r[key]==null)total[key]=null;else if(total[key]!=null){total[key]+=r[key];if(!Number.isSafeInteger(total[key]))throw Error('Το σύνολο υπερβαίνει το ασφαλές όριο.');}}}return total;}
 function build(input){
  const {from,to,stores,days,terms}=input;if(plus(from,6)!==to||new Date(from+'T12:00:00Z').getUTCDay()!==1)throw Error('Μη έγκυρη εβδομάδα.');
  if(!stores.length||new Set(stores.map(s=>s.id)).size!==stores.length)throw Error('Μη έγκυρη επιλογή καταστημάτων.');
  const selected=new Set(stores.map(s=>s.id)),indexed=new Map();for(const d of days){const key=d.storeId+'|'+d.businessDay;if(!selected.has(d.storeId)||d.businessDay<from||d.businessDay>to||indexed.has(key))throw Error('Ασυνεπή ημερήσια αποτελέσματα.');indexed.set(key,d);}
  const rows=[],changes=[],baselines=[];
  for(const store of stores){const base=termFor(terms,store.id,from);baselines.push({store,term:base});
   for(let n=0;n<7;n++){const day=plus(from,n),d=indexed.get(store.id+'|'+day),term=termFor(terms,store.id,day);let problem='';
    if(!d)problem='Δεν έχει ληφθεί πλήρης ημέρα';
    else if(d.cutoffHour!==5||d.timeZone!=='Europe/Athens')problem='Ασυμβίβαστη επιχειρησιακή ημέρα';
    else if(!term||term.supported===false||d.termsId!==term.id||d.currentTermsId!==term.id||d.retentionUsed!==store.retainOrders)problem='Εκκρεμεί υπολογισμός με τους ισχύοντες όρους';
    else if(['orderCount','orderChargeCents','minimumTopUpCents','totalChargeCents'].some(k=>!Number.isSafeInteger(d[k])||d[k]<0)||d.totalChargeCents!==d.orderChargeCents+d.minimumTopUpCents)problem='Ανεπαρκή οικονομικά δεδομένα';
    else if(d.orderCount===0&&(d.minimumTopUpCents!==0||d.totalChargeCents!==0))problem='Ενεργή χωριστή χρέωση μηδενικής ημέρας: απαιτεί έλεγχο, δεν αλλάχθηκε';
    else if(d.reviewCount>0)problem='Υπάρχουν αλλαγές πηγής προς έλεγχο';
    const row={storeId:store.id,name:store.name,day,orderCount:d?.orderCount??null,orderChargeCents:problem?null:d.orderChargeCents,minimumTopUpCents:problem?null:d.minimumTopUpCents,totalChargeCents:problem?null:d.totalChargeCents,problem,sourceAt:d?.sourceLastSuccessAt||'',termId:term?.id};rows.push(row);
   }
  }
  for(const t of terms){if(!selected.has(t.storeId)||!t.audit||t.effectiveDay<from||t.effectiveDay>to)continue;const applies=rows.filter(r=>r.storeId===t.storeId&&r.termId===t.id);if(!applies.length)continue;
   for(const c of t.audit.changes||[]){if(!fields[c.field]||c.oldValue===c.newValue)continue;changes.push({storeId:t.storeId,name:stores.find(s=>s.id===t.storeId).name,...c,recordedAt:t.audit.recordedAt,effectiveDay:t.effectiveDay,actor:t.audit.actor,retroactive:t.effectiveDay<new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Athens',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t.audit.recordedAt)),pending:applies.some(r=>r.problem)});}
  }
  return {...input,rows,changes,baselines,total:sum(rows)};
 }
 function value(field,n){return n==null?'Άγνωστο':field==='chargeOnZero'?(n?'Ναι':'Όχι'):euro(n);}
 function historyRows(records,name){return records.flatMap(t=>(t.audit?.changes||[]).map(c=>({name,...c,...t.audit})));}
 function auditTable(changes){return '<table class="stores-audit-table"><thead><tr><th>Κατάστημα</th><th>Πεδίο · παλιά → νέα</th><th>Καταχώριση / από ποιον</th><th>Ισχύει από</th></tr></thead><tbody>'+changes.map(c=>'<tr><td>'+esc(c.name)+'</td><td>'+esc(fields[c.field]||c.field)+'<br>'+esc(value(c.field,c.oldValue))+' → '+esc(value(c.field,c.newValue))+'</td><td>'+esc(date(c.recordedAt))+'<br>'+esc(c.actor?.name||c.actor?.id)+' · '+esc(c.actor?.role)+'</td><td>'+esc(date(c.effectiveDay))+(c.retroactive?'<br>Αναδρομική ισχύς':'')+(c.pending?'<br>Εκκρεμεί επανυπολογισμός':'')+'</td></tr>').join('')+'</tbody></table>';}
 const headings='<thead><tr><th>Ημέρα</th><th>Κατάστημα</th><th>Παραγγελίες</th><th>Έσοδα παραγγελιών</th><th>Συμπλήρωμα παγίου</th><th>Συνολικά έσοδα</th></tr></thead>';
 function rowHtml(r){return '<tr><td>'+esc(weekday(r.day))+'<br>'+esc(date(r.day))+'</td><td>'+esc(r.name)+(r.problem?'<small class="stores-report-warning">'+esc(r.problem)+'</small>':'')+'</td><td>'+esc(r.orderCount??'—')+'</td>'+['orderChargeCents','minimumTopUpCents','totalChargeCents'].map(k=>'<td>'+esc(euro(r[k]))+'</td>').join('')+'</tr>';}
 function totalHtml(label,rows){const t=sum(rows);return '<tr class="stores-report-total"><th colspan="2">'+esc(label)+(t.incomplete?' · ελλιπές':'')+'</th><td>'+esc(t.unknownCount?'Ελλιπές ('+t.orderCount+' γνωστές)':t.orderCount)+'</td>'+['orderChargeCents','minimumTopUpCents','totalChargeCents'].map(k=>'<td>'+esc(euro(t[k]))+'</td>').join('')+'</tr>';}
 function render(report,mode){
  let body='';if(mode==='combined'){body='<section><h2>Ενιαίος πίνακας</h2><table>'+headings+'<tbody>';for(let n=0;n<7;n++){const day=plus(report.from,n),rows=report.rows.filter(r=>r.day===day);body+=rows.map(rowHtml).join('')+totalHtml('Σύνολο '+weekday(day)+' '+date(day),rows);}body+='</tbody></table></section>';}
  else for(const s of report.stores){const rows=report.rows.filter(r=>r.storeId===s.id);body+='<section><h2>'+esc(s.name)+'</h2><table>'+headings+'<tbody>'+rows.map(rowHtml).join('')+totalHtml('Εβδομαδιαίο σύνολο '+s.name,rows)+'</tbody></table></section>';}
  const known=report.rows.map(r=>r.sourceAt).filter(Boolean).sort()[0];
  return '<article class="stores-weekly-report"><header><span>FLEET CONTROL · ΚΑΤΑΣΤΗΜΑΤΑ</span><h1>Εβδομαδιαία αναφορά καταστημάτων</h1><p>'+esc(date(report.from))+' – '+esc(date(report.to))+' · '+report.stores.length+' επιλεγμένα καταστήματα</p><p>Ημέρα 05:00–05:00 · Europe/Athens · Δευτέρα–Κυριακή</p><p>Αποθηκευμένα αποτελέσματα Server · παλιότερη λήψη: '+esc(date(known))+' · δημιουργία '+esc(date(report.generatedAt))+'</p></header><p class="stores-report-warning">'+(report.total.incomplete?'Ανεπαρκή δεδομένα: '+report.total.incomplete+' ημερήσιες εγγραφές χρειάζονται λήψη ή έλεγχο. Τα ελλιπή σύνολα δεν είναι οριστικά.':'Τα ποσά αντιστοιχούν στις διαθέσιμες αποθηκευμένες λήψεις. Δεν αποτελούν νέα ζωντανή ανάγνωση Ordexa.')+'</p>'+body+'<table>'+headings+'<tbody>'+totalHtml('Γενικό σύνολο εβδομάδας · όλα τα επιλεγμένα',report.rows)+'</tbody></table><section><h2>Ισχύοντες όροι στην αρχή της εβδομάδας</h2><p>Αφετηρία υπολογισμού, όχι αλλαγές της εβδομάδας.</p><ul>'+report.baselines.map(b=>'<li>'+esc(b.store.name)+' · '+(b.term?.supported!==false&&b.term?.unitPriceCents!=null?esc(euro(b.term.unitPriceCents))+' / παραγγελία · ελάχιστο '+esc(euro(b.term.dailyMinimumCents)):'Χρειάζεται ορισμός όρων')+'</li>').join('')+'</ul></section><section id="storesReportChanges"><h2>Αλλαγές τιμολόγησης</h2>'+(report.changes.length?auditTable(report.changes):'<p>Δεν υπάρχουν καταγεγραμμένες οικονομικές αλλαγές με ισχύ σε αυτή την εβδομάδα.</p>')+'<p>Δεν υπάρχει διαθέσιμο παλιότερο ιστορικό πριν την εισαγωγή της αναλυτικής καταγραφής. Οι παλιές αλλαγές δεν ανακατασκευάζονται.</p></section></article>';
 }
 return {build,render,sum,termFor,auditTable,historyRows,plus};
});
