(function (root) {
  'use strict';
  const clone = v => JSON.parse(JSON.stringify(v));
  async function loadInvoiceDocuments(api){
    for(let attempt=0;attempt<2;attempt++){
      const documents=new Map();let cursor='',version=null;
      try{
        for(let page=0;page<2000;page++){
          const data=await api('/api/admin/service-documents?paged=1'+(cursor?'&cursor='+encodeURIComponent(cursor):''),{forceRead:true});
          if(!Array.isArray(data.documents))throw new Error('Δεν φορτώθηκε πλήρης λίστα τιμολογίων. Τα προηγούμενα δεδομένα διατηρούνται.');
          if(version!==null&&Number(data.serverVersion)!==version)throw Object.assign(new Error('Τα τιμολόγια άλλαξαν κατά την ανάγνωση.'),{status:409});
          version=Number(data.serverVersion);for(const item of data.documents)documents.set(String(item.id),item);
          if(!data.hasMore)return {...data,documents:[...documents.values()].sort((a,b)=>String(b.uploadedAt||b.serviceDate||'').localeCompare(String(a.uploadedAt||a.serviceDate||'')))};
          if(!data.nextCursor||data.nextCursor===cursor)throw new Error('Η λίστα δεν προχώρησε στην επόμενη σελίδα. Δοκίμασε Ανανέωση.');
          cursor=data.nextCursor;
        }
        throw new Error('Η λίστα υπερβαίνει το υποστηριζόμενο όριο σελίδων.');
      }catch(error){if(Number(error.status)!==409||attempt)throw error;}
    }
  }
  function isOilTask(value) {
    const text=String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ');
    // A filter containing oil is a separate part, never an oil-change cycle.
    if(/(?:φιλτρ\S*\s+(?:λαδι|oil)|\boil\s+filter\b)/u.test(text))return false;
    return /\b(?:ladi|oil|yamalube)\b|λαδι|λιπαντικ/u.test(text);
  }
  const fields = ['supplier','invoiceNumber','invoiceDate','plate','odometerKm','totalAmount','netAmount','vatAmount','workPerformed','comments','confirmedAt','reviewStatus','reviewedBy','correctedByUserAt','serviceKmBeforeCorrection','serviceKmAfterCorrection','mileageResolution','mileageResolutionEntryId','mileageResolutionRead','mileageResolutionServiceKm','plateResolution','plateResolutionBikeId','plateResolutionPlate','plateResolutionRead','confirmationMethod','confirmationRuleVersion','confirmationReason','lastReadFingerprint','acknowledgedReadFingerprint','lastReadCanonicalFingerprint','acknowledgedReadCanonicalFingerprint','lastReadFields','acknowledgedReadFields','reviewDocumentKey'];
  function cents(value) {
    if (value == null || String(value).trim() === '') return null;
    let s = String(value).replace(/EUR|ευρώ|[€\s\u00a0]/gi,'');
    if (!/^-?\d+(?:[.,]\d+)*$/.test(s)) return null;
    const comma=s.lastIndexOf(','), dot=s.lastIndexOf('.'), pos=Math.max(comma,dot);
    if (comma>=0 && dot>=0) {
      if (s.length-pos-1 !== 2) return null;
      const sep=s[pos], other=sep===','?'.':',';
      if (!new RegExp('^-?\\d{1,3}(?:\\'+other+'\\d{3})*\\'+sep+'\\d{2}$').test(s)) return null;
      s=s.split(other).join('').replace(sep,'.');
    } else if (pos>=0) {
      const sep=s[pos], tail=s.length-pos-1;
      if (tail===3 && new RegExp('^-?\\d{1,3}(?:\\'+sep+'\\d{3})+$').test(s)) s=s.split(sep).join('');
      else if ((tail===1 || tail===2) && s.indexOf(sep)===pos) s=s.replace(sep,'.');
      else return null;
    }
    const n=Math.round(Number(s)*100); return Number.isSafeInteger(n)?n:null;
  }
  const euro = n => n==null?'Χωρίς ποσό':(n/100).toLocaleString('el-GR',{style:'currency',currency:'EUR'});
  function date(value) {
    let s=String(value||'').trim(), m=s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
    if(m)s=m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return '';
    const d=new Date(s+'T12:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s?s:'';
  }
  const invoice = f => Object.assign({},f?.qrData||{},f?.ocr||{});
  function sourcePhoto(value) {
    if(!value||typeof value!=='object'||!String(value.key||'').startsWith('service-documents/')||String(value.key).includes('..')||!/^image\/(jpeg|png|webp|heic|heif)$/.test(String(value.contentType||'')))return null;
    return {id:String(value.id||String(value.key).split('/').pop()).slice(0,160),key:String(value.key).slice(0,500),name:String(value.name||'φωτογραφία.jpg').slice(0,120),contentType:String(value.contentType),size:Math.max(0,Math.min(15728640,Number(value.size)||0)),uploadedAt:String(value.uploadedAt||'').slice(0,40)};
  }
  function preserveInvoiceFiles(primary,previous) {
    primary=Array.isArray(primary)?primary.filter(file=>file&&typeof file==='object'):[];previous=Array.isArray(previous)?previous.filter(file=>file&&typeof file==='object'):[];
    return primary.map(file=>{
      const same=(previous||[]).find(old=>old.key===file.key),bundle=(previous||[]).find(old=>old.sourcePhoto?.key===file.key);
      if(bundle)return {...bundle};
      return {...file,sourcePhoto:sourcePhoto(file.sourcePhoto)||sourcePhoto(same?.sourcePhoto)};
    }).filter((file,i,all)=>all.findIndex(other=>other.key===file.key)===i&&!all.some(other=>other.sourcePhoto?.key===file.key));
  }
  function amounts(data) {
    const net=cents(data?.netAmount),vat=cents(data?.vatAmount),gross=cents(data?.totalAmount);
    return {net,vat,gross,mismatch:net!=null&&vat!=null&&gross!=null&&Math.abs(net+vat-gross)>1};
  }
  function summary(bikes, options) {
    options=options||{};const seen=new Set();let total=0,missing=0,pending=0,duplicates=0;
    const rows=(bikes||[]).map(bike=>{let sum=0,unknown=0,waiting=0;const entries=[];
      for(const entry of bike.history||[]) {
        if(entry.type==='check')continue;
        const files=entry.attachments||[],accepted=[];let value=0,hasAmount=false;
        const serviceDate=date(entry.date);
        const inRange=d=>(!options.from||d>=options.from)&&(!options.to||d<=options.to)&&(!(options.from||options.to)||!!d);
        if(options.basis!=='invoice'&&!inRange(serviceDate))continue;
        for(const f of files){const data=invoice(f);if(options.basis==='invoice'&&!inRange(date(data.invoiceDate)))continue;
          if(f.key&&seen.has(f.key)){duplicates++;continue;}if(f.key)seen.add(f.key);
          const n=cents(data.totalAmount);if(n==null){unknown++;missing++;}else{value+=n;hasAmount=true;}
          if(!data.confirmedAt){waiting++;pending++;}accepted.push(f);
        }
        if(!files.length){if(options.basis==='invoice')continue;const n=cents(entry.cost);if(n==null){unknown++;missing++;}else{value+=n;hasAmount=true;}}
        if(options.basis==='invoice'&&!accepted.length)continue;
        sum+=value;entries.push({entry,cents:value,hasAmount,files:accepted});
      }
      total+=sum;return {bike,cents:sum,missing:unknown,pending:waiting,entries};
    });return {rows,cents:total,missing,pending,duplicates};
  }
  function state(entry,data) {
    const invoiceData={};for(const k of fields)if(data?.[k]!=null&&String(data[k]).trim())invoiceData[k]=String(data[k]).slice(0,k==='workPerformed'?128000:500);
    for(const k of ['lineItems','parts'])if(Array.isArray(data?.[k]))invoiceData[k]=data[k].map(v=>String(v).slice(0,500)).slice(0,512);
    if(Array.isArray(data?.reviewIssues))invoiceData.reviewIssues=clone(data.reviewIssues).slice(0,40);
    return {km:Number(entry.km)||0,tasks:(entry.tasks||[]).map(v=>String(v).trim().slice(0,500)).filter(Boolean).slice(0,5120),notes:String(entry.notes||'').slice(0,128000),workshop:String(entry.workshop||'').slice(0,120),oilChanged:!!entry.oilChanged,majorService:!!entry.majorService,majorServiceMilestoneKm:Number(entry.majorServiceMilestoneKm)||0,invoiceData};
  }
  function journal(value) {return Array.isArray(value)?value.filter(v=>v&&v.id&&v.key&&v.before&&v.after).slice(-12).map(v=>({id:String(v.id).slice(0,100),key:String(v.key).slice(0,500),actor:String(v.actor||'').slice(0,120),at:String(v.at||'').slice(0,40),afterUpdatedAt:String(v.afterUpdatedAt||'').slice(0,40),before:state(v.before,v.before.invoiceData),after:state(v.after,v.after.invoiceData),transfer:!!v.transfer,undoneAt:String(v.undoneAt||'').slice(0,40),undoneBy:String(v.undoneBy||'').slice(0,120)})):[];}
  function decision(entry,key,before,data,actor,at,transfer) {
    const revision={id:root.crypto?.randomUUID?.()||'review-'+Date.now()+'-'+Math.random().toString(36).slice(2),key,actor:String(actor||'').slice(0,120),at,afterUpdatedAt:at,before,after:state(entry,data),transfer:!!transfer};
    entry.reviewJournal=journal(entry.reviewJournal).concat([revision]).slice(-12);return revision;
  }
  function canUndo(entry,data,r) {return !!r&&!r.undoneAt&&!r.transfer&&entry.updatedAt===r.afterUpdatedAt&&JSON.stringify(state(entry,data))===JSON.stringify(r.after);}
  function undo(entry,data,r) {
    if(!canUndo(entry,data,r))return null;
    const restored=Object.assign({},data);for(const k of fields.concat(['lineItems','parts','reviewIssues']))delete restored[k];Object.assign(restored,r.before.invoiceData);
    for(const k of ['km','tasks','notes','workshop','oilChanged','majorService','majorServiceMilestoneKm'])entry[k]=clone(r.before[k]);
    return restored;
  }
  function resolved(entry,data) {return !!data?.confirmedAt&&['keep','apply'].includes(data.mileageResolution)&&data.mileageResolutionEntryId===String(entry.id)&&Number(data.mileageResolutionRead)===Number(String(data.odometerKm||'').replace(/\D/g,''))&&Number(data.mileageResolutionServiceKm)===Number(entry.km);}
  function plans(value) {return (Array.isArray(value)?value:[]).filter(p=>p&&p.id&&Array.isArray(p.terms)).slice(0,12).map(p=>({id:String(p.id).slice(0,60),name:String(p.name||'').slice(0,80),terms:p.terms.map(String).slice(0,8),km:Math.min(2000000,Math.max(0,Math.round(Number(p.km)||0))),days:Math.min(3650,Math.max(0,Math.round(Number(p.days)||0)))}));}
  const defaults=[['oil','Λάδια',['λάδι','λαδι','oil']],['filter','Φίλτρο',['φίλτρ','φιλτρ']],['brakes','Φρένα',['τακάκ','τακακ','σιαγ','φρέν','φρεν']],['tyres','Ελαστικά',['ελαστ','λάστιχ','λαστιχ']],['spark','Μπουζί',['μπουζ']],['major','Μεγάλο service',['μεγάλο service','μεγαλο service']]].map(p=>({id:p[0],name:p[1],terms:p[2],km:0,days:0}));
  function maintenance(bike,today) {return (plans(bike.maintenancePlans).length?plans(bike.maintenancePlans):defaults).map(p=>{
    const entries=(bike.history||[]).filter(e=>e.type!=='check'&&date(e.date)&&((p.id==='oil'&&e.oilChanged)||(p.id==='major'&&e.majorService)||(e.tasks||[]).some(t=>p.terms.some(x=>String(t).toLowerCase().includes(x.toLowerCase()))))).sort((a,b)=>date(b.date).localeCompare(date(a.date))||String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    const e=entries[0]||null;const days=e?Math.floor((new Date(date(today)+'T12:00:00Z')-new Date(date(e.date)+'T12:00:00Z'))/86400000):null;
    const remainingKm=e&&p.km?Number(e.km)+p.km-Number(bike.currentKm):null,remainingDays=e&&p.days?p.days-days:null;
    return {plan:p,entry:e,remainingKm,remainingDays,due:(remainingKm!=null&&remainingKm<=0)||(remainingDays!=null&&remainingDays<=0)};
  });}
  function expectation(value) {
    if (!value || !['expected','not_expected'].includes(value.status)) return null;
    return {status:value.status,reason:String(value.reason||'').trim().slice(0,500),at:String(value.at||'').slice(0,40),actor:String(value.actor||'').slice(0,120)};
  }
  function kmAcknowledgments(value) {
    return (Array.isArray(value)?value:[]).filter(v=>v&&typeof v.signature==='string'&&v.reason&&v.at).slice(-20)
      .map(v=>({signature:v.signature.slice(0,700),reason:String(v.reason).trim().slice(0,500),at:String(v.at).slice(0,40),actor:String(v.actor||'').slice(0,120)}));
  }
  function chronology(bike) {
    const days=new Map(),result=[];
    for(const e of bike.history||[]) {
      const d=date(e.date),n=Number(e.km);
      if(!d||e.km==null||e.km===''||!Number.isSafeInteger(n)||n<0||n>2000000000)continue;
      if(!days.has(d))days.set(d,[]);days.get(d).push(e);
    }
    let previous=null;
    for(const d of [...days.keys()].sort()) {
      const entries=days.get(d).sort((a,b)=>Number(b.km)-Number(a.km)||String(a.id).localeCompare(String(b.id)));
      if(previous)for(const entry of entries)if(Number(entry.km)<Number(previous.km)) {
        const signature=JSON.stringify([String(previous.id),date(previous.date),Number(previous.km),String(entry.id),d,Number(entry.km)]);
        const acknowledgment=kmAcknowledgments(entry.kmAcknowledgments).find(a=>a.signature===signature)||null;
        result.push({bike,entry,previous,signature,acknowledgment});
      }
      previous=entries[0];
    }
    return result;
  }
  function qrDocumentState(entry, now) {
    const original=entry?.invoiceData||{};
    if(entry?.type==='check'||(!original.qrUrl&&!original.qrJobId))return null;
    const data={...original},job=String(data.qrJobId||''),url=String(data.qrUrl||'');
    const attachment=(entry.attachments||[]).find(file=>file.key&&(
      (job&&[file.renderJobId,file.ocr?.qrJobId,file.qrData?.qrJobId].some(id=>String(id||'')===job))||
      (url&&[file.qrUrl,file.qrValue,file.ocr?.qrUrl,file.qrData?.qrUrl].some(value=>String(value||'')===url))));
    const rawStatus=String(data.qrProcessingStatus||'processing');
    const needsVerification=rawStatus==='completed'&&!attachment;
    if(needsVerification){
      data.qrProcessingStatus='delayed';
      data.qrProcessingStage='Το PDF δεν έχει συνδεθεί με το service · χρειάζεται έλεγχος';
      data.qrProcessingError='Η παλιά ένδειξη ολοκλήρωσης δεν επιβεβαιώνεται από συνημμένο PDF.';
    }else if(rawStatus==='processing'){
      const last=Date.parse(data.qrProcessingUpdatedAt||data.qrProcessingStartedAt||entry.updatedAt||'');
      if(Number.isFinite(last)&&(now??Date.now())-last>=90000){data.qrProcessingStatus='delayed';data.qrProcessingStage='Δεν υπάρχει πρόσφατη ενημέρωση από τον Server';}
    }
    const status=String(data.qrProcessingStatus||'processing');
    data.qrProcessingProgress=String(status==='completed'&&attachment?100:Math.max(0,Math.min(95,Number(data.qrProcessingProgress)||5)));
    return {data,status,attachment,needsVerification,attention:['error','delayed','cancelled'].includes(status),visible:status!=='completed'||!attachment};
  }
  function pendingInvoice(entry) {
    const data=entry.invoiceData||{};
    return !!data.qrUrl && !['completed','failed','error','cancelled','superseded'].includes(data.qrProcessingStatus||'');
  }
  function missingInvoices(bikes,options) {
    options=options||{};const queued=new Set(options.queuedEntryIds||[]),rows=[];
    for(const bike of bikes||[])for(const entry of bike.history||[]) {
      if(entry.type==='check'||(entry.attachments||[]).some(f=>f.key)||pendingInvoice(entry)||queued.has(String(entry.id)))continue;
      if(options.bikeId&&String(bike.id)!==String(options.bikeId))continue;
      const d=date(entry.date);if((options.from||options.to)&&(!d||(options.from&&d<options.from)||(options.to&&d>options.to)))continue;
      const exempt=expectation(entry.invoiceExpectation)?.status==='not_expected';
      if(exempt&&!options.includeExempt)continue;
      rows.push({bike,entry,exempt});
    }
    return rows.sort((a,b)=>date(b.entry.date).localeCompare(date(a.entry.date))||String(a.bike.name).localeCompare(String(b.bike.name),'el')||String(a.entry.id).localeCompare(String(b.entry.id)));
  }
  root.FleetServiceModel={loadInvoiceDocuments,isOilTask,cents,euro,date,invoice,sourcePhoto,preserveInvoiceFiles,amounts,summary,state,journal,decision,canUndo,undo,resolved,plans,maintenance,defaults,expectation,kmAcknowledgments,chronology,qrDocumentState,pendingInvoice,missingInvoices};
})(globalThis);
