(function(root){
  'use strict';
  const M=root.FleetServiceModel,copy=v=>JSON.parse(JSON.stringify(v));
  function lifecycle(value){const map=new Map();for(const x of Array.isArray(value)?value:[]){if(!x||!x.id||!/^\d{4}-\d\d-\d\dT/.test(String(x.at||'')))continue;const r={id:String(x.id).slice(0,100),at:String(x.at).slice(0,40)};if(!map.has(r.id)||map.get(r.id).at<r.at)map.set(r.id,r);}return [...map.values()].sort((a,b)=>b.at.localeCompare(a.at)).slice(0,500);}
  const mergeLifecycle=(a,b)=>lifecycle([...(a||[]),...(b||[])]);
  // Each reminder has its own clock. Completed/removed rows are retained so an
  // old Client or restored mirror cannot bring an already handled task back.
  const nextNoteStamp=v=>v.updatedAt+'|'+({pending:0,completed:1,removed:2}[v.status])+'|'+v.text+'|'+v.sourceEntryId+'|'+v.completedEntryId;
  function nextServiceNotes(value){const map=new Map();for(const v of Array.isArray(value)?value:[]){
    if(!v||!v.id||!String(v.text||'').trim()||!['pending','completed','removed'].includes(v.status)||!/^\d{4}-\d\d-\d\dT/.test(String(v.updatedAt||''))||!Number.isFinite(Date.parse(v.updatedAt)))continue;
    const at=new Date(v.updatedAt).toISOString(),r={id:String(v.id).slice(0,100),text:String(v.text).trim().slice(0,240),status:v.status,createdAt:Number.isFinite(Date.parse(v.createdAt))?new Date(v.createdAt).toISOString():at,updatedAt:at,sourceEntryId:String(v.sourceEntryId||'').slice(0,100),completedEntryId:String(v.completedEntryId||'').slice(0,100)};
    if(!map.has(r.id)||nextNoteStamp(map.get(r.id))<nextNoteStamp(r))map.set(r.id,r);
  }return [...map.values()].sort((a,b)=>a.createdAt<b.createdAt?-1:a.createdAt>b.createdAt?1:a.id<b.id?-1:a.id>b.id?1:0);}
  function nextNoteLines(value){return [...new Set(String(value||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean))];}
  function changeNextServiceNotes(value,{text='',completedIds=[],sourceEntryId='',completedEntryId='',now=new Date().toISOString(),uid}){
    const notes=nextServiceNotes(value),lines=nextNoteLines(text),done=new Set(completedIds);
    if(lines.length>20||lines.some(s=>s.length>240))throw new Error('Γράψε έως 20 νέες εργασίες, μία ανά γραμμή και έως 240 χαρακτήρες η καθεμία.');
    const key=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').toLocaleLowerCase('el'),existing=new Set(notes.filter(n=>n.status==='pending'&&!done.has(n.id)).map(n=>key(n.text)));
    const additions=lines.filter(s=>{const k=key(s);if(existing.has(k))return false;existing.add(k);return true;});
    if(notes.filter(n=>n.status==='pending'&&!done.has(n.id)).length+additions.length>50)throw new Error('Υπάρχουν ήδη πολλές εκκρεμείς εργασίες. Ολοκλήρωσε ή αφαίρεσε μερικές ώστε να παραμείνουν έως 50.');
    if(additions.length&&notes.length+additions.length>500)throw new Error('Η λίστα έχει φτάσει τις 500 αποθηκευμένες σημειώσεις. Δεν διαγράφηκε καμία παλιά εργασία.');
    const at=new Date(Math.max(Date.parse(now),...notes.filter(n=>done.has(n.id)).map(n=>Date.parse(n.updatedAt)+1))).toISOString();
    return nextServiceNotes([...notes.map(n=>n.status==='pending'&&done.has(n.id)?{...n,status:'completed',updatedAt:at,completedEntryId}:n),...additions.map(s=>({id:uid(),text:s,status:'pending',createdAt:at,updatedAt:at,sourceEntryId,completedEntryId:''}))]);
  }
  function deletedIds(ids,restores,deletes){const r=new Map(lifecycle(restores).map(x=>[x.id,x.at])),d=new Map(lifecycle(deletes).map(x=>[x.id,x.at]));return [...new Set((ids||[]).map(String))].filter(id=>!r.has(id)||(d.get(id)||'')>r.get(id)).sort((a,b)=>(d.get(b)||'').localeCompare(d.get(a)||'')||a.localeCompare(b)).slice(0,500);}
  function appointments(value){const map=new Map();for(const v of Array.isArray(value)?value:[]){if(!v||!v.id||!M.date(v.date)||!['planned','cancelled','completed'].includes(v.status))continue;const p={id:String(v.id).slice(0,100),date:M.date(v.date),status:v.status,tasks:(Array.isArray(v.tasks)?v.tasks:[]).map(x=>String(x).trim().slice(0,120)).filter(Boolean).slice(0,30),notes:String(v.notes||'').slice(0,500),createdAt:String(v.createdAt||'').slice(0,40),updatedAt:String(v.updatedAt||'').slice(0,40),actor:String(v.actor||'').slice(0,120),completedEntryId:String(v.completedEntryId||'').slice(0,100)};if(!map.has(p.id)||map.get(p.id).updatedAt<=p.updatedAt)map.set(p.id,p);}return [...map.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,200);}
  function metrics(bike,history,preserve){const h=history||bike.history||[],floor=Number(bike.odometerFloorKm)||0;let oil=0,km=floor,major=null;for(const e of h){km=Math.max(km,Number(e.km)||0);if(e.type==='service'&&e.oilChanged)oil=Math.max(oil,Number(e.km)||0);if(e.type==='service'&&e.majorService)major=Math.max(major??0,Number(e.km)||0);}if(preserve){oil=Math.max(oil,Number(bike.lastServiceKm)||0);km=Math.max(km,Number(bike.currentKm)||0);}return {currentKm:Math.max(km,oil),lastServiceKm:oil,nextServiceKm:oil+Number(bike.intervalKm||1),nextMajorServiceKm:major==null?null:major+10000,costCents:M.summary([{...bike,history:h}]).cents};}
  function impact(bike,kind,entry){const h=(bike.history||[]).slice(),before=metrics(bike,h,true);let afterHistory=h;
    if(kind==='create'||kind==='restore')afterHistory=[...h.filter(e=>String(e.id)!==String(entry.id)),copy(entry)];
    else if(kind==='delete')afterHistory=h.filter(e=>String(e.id)!==String(entry.id));
    else afterHistory=h.map(e=>String(e.id)===String(entry.id)?copy(entry):e);
    if(kind!=='create'&&!(h.some(e=>e.type==='service'&&e.oilChanged))&&Number(bike.lastServiceKm)>0)afterHistory.push({id:'preview-legacy-oil',type:'service',km:Number(bike.lastServiceKm),oilChanged:true,date:String(bike.createdAt||'').slice(0,10)});
    const after=metrics(bike,afterHistory,kind==='create'),warnings=[];
    if(kind==='create'&&Number(entry.km)<Number(bike.lastServiceKm))warnings.push('Η ένδειξη είναι μικρότερη από την τελευταία αλλαγή λαδιών. Η καταχώρηση θα μπει στο ιστορικό χωρίς μείωση των τρεχόντων χιλιομέτρων.');
    const latest=h.filter(e=>e.type==='service').map(e=>M.date(e.date)).sort().pop();
    if(kind!=='delete'&&latest&&M.date(entry.date)<latest&&(after.currentKm>before.currentKm||after.lastServiceKm>before.lastServiceKm))warnings.push('Παλαιότερη ημερομηνία με μεγαλύτερη ένδειξη: επηρεάζει τα τρέχοντα χιλιόμετρα ή τον ενεργό κύκλο λαδιών.');
    if(after.currentKm<before.currentKm)warnings.push('Τα τρέχοντα χιλιόμετρα θα μειωθούν με βάση τις καταχωρήσεις που απομένουν. Οι ενδείξεις βαρδιών παραμένουν κατώτατο όριο.');
    return {kind,bikeName:bike.name,entry:copy(entry),previousEntry:h.find(e=>String(e.id)===String(entry.id))?{date:h.find(e=>String(e.id)===String(entry.id)).date,km:h.find(e=>String(e.id)===String(entry.id)).km,oilChanged:!!h.find(e=>String(e.id)===String(entry.id)).oilChanged,majorService:!!h.find(e=>String(e.id)===String(entry.id)).majorService}:null,before,after,warnings,changed:['currentKm','lastServiceKm','nextServiceKm','nextMajorServiceKm','costCents'].some(k=>before[k]!==after[k])};
  }
  function costUsage(bikes,options){options=options||{};const from=M.date(options.from),to=M.date(options.to),sum=M.summary(bikes,{from,to,basis:'service'});return sum.rows.map(row=>{
    const days=new Map();for(const e of row.bike.history||[]){const date=M.date(e.date),n=Number(e.km);if(!date||from&&date<from||to&&date>to||e.km==null||e.km===''||!Number.isSafeInteger(n)||n<0)continue;days.set(date,Math.max(days.get(date)??0,n));}
    const points=[...days].sort((a,b)=>a[0].localeCompare(b[0])),first=points[0],last=points.at(-1);let decrease=false,maxGap=0;
    for(let i=1;i<points.length;i++){if(points[i][1]<points[i-1][1])decrease=true;maxGap=Math.max(maxGap,(Date.parse(points[i][0])-Date.parse(points[i-1][0]))/86400000);}
    const distance=points.length>=2?last[1]-first[1]:null,reasons=[];
    if(points.length<2||!(distance>0))reasons.push('Δεν υπάρχουν δύο αυξανόμενες ενδείξεις διαφορετικών ημερών.');
    if(decrease)reasons.push('Υπάρχει μείωση ένδειξης ή αλλαγή κοντέρ· η πραγματική απόσταση δεν προκύπτει με ασφάλεια.');
    if(first&&from&&first[0]!==from||last&&to&&last[0]!==to)reasons.push('Οι ενδείξεις δεν καλύπτουν ακριβώς τα όρια της περιόδου.');
    if(maxGap>14)reasons.push('Υπάρχει διάστημα άνω των 14 ημερών χωρίς καταγραφή χιλιομέτρων.');
    if(row.missing)reasons.push(row.missing+' τιμολόγια/service χωρίς γνωστό ποσό.');if(row.pending)reasons.push(row.pending+' τιμολόγια δεν έχουν επιβεβαιωθεί.');
    const ratio=!decrease&&distance>0?Math.round(row.cents*1000/distance):null;
    return {bike:row.bike,cents:row.cents,distance:decrease?null:distance,per1000Cents:ratio,complete:reasons.length===0,reasons,firstDate:first?.[0]||'',lastDate:last?.[0]||'',points:points.length};
  });}
  function zipPath(record,index){const clean=s=>String(s||'').normalize('NFC').replace(/[\\/\x00-\x1f\x7f:*?"<>|]/g,'_').replace(/^\.+|\.+$/g,'').trim().slice(0,100)||'Χωρίς_όνομα';const date=M.date(record.invoiceDate||record.invoiceData?.invoiceDate)||'Χωρίς_ημερομηνία';let name=clean(record.name).replace(/\.pdf$/i,'');return clean(record.bikeName)+'/'+date+'_'+name+'_'+String(index+1).padStart(3,'0')+'.pdf';}
  function pdfs(documents,options){options=options||{};const ids=new Set(options.bikeIds||[]),seen=new Set();return (documents||[]).filter(r=>{const date=M.date(r.invoiceDate||r.invoiceData?.invoiceDate);if(!r.key||seen.has(r.key)||ids.size&&!ids.has(String(r.bikeId))||options.from&&(!date||date<options.from)||options.to&&(!date||date>options.to)||!(/pdf/i.test(r.contentType||'')||/\.pdf$/i.test(r.name||'')))return false;seen.add(r.key);return true;}).sort((a,b)=>String(a.bikeName).localeCompare(String(b.bikeName),'el')||M.date(a.invoiceDate||a.invoiceData?.invoiceDate).localeCompare(M.date(b.invoiceDate||b.invoiceData?.invoiceDate))||a.key.localeCompare(b.key)).map((r,i)=>({...r,zipName:zipPath(r,i)}));}
  root.FleetOperationsModel={lifecycle,mergeLifecycle,deletedIds,appointments,metrics,impact,costUsage,zipPath,pdfs,nextServiceNotes,nextNoteLines,nextNoteStamp,changeNextServiceNotes};
})(globalThis);
