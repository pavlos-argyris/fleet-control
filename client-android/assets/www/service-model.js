(function (root) {
  'use strict';
  const clone = v => JSON.parse(JSON.stringify(v));
  const fields = ['supplier','invoiceNumber','invoiceDate','plate','odometerKm','totalAmount','netAmount','vatAmount','workPerformed','comments','confirmedAt','reviewStatus','reviewedBy','correctedByUserAt','serviceKmBeforeCorrection','serviceKmAfterCorrection','mileageResolution','mileageResolutionEntryId','mileageResolutionRead','mileageResolutionServiceKm','plateResolution','plateResolutionBikeId','plateResolutionPlate','plateResolutionRead'];
  function cents(value) {
    if (value == null || String(value).trim() === '') return null;
    let s = String(value).replace(/[€\s\u00a0]/g,'');
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
    const invoiceData={};for(const k of fields)if(data?.[k]!=null&&String(data[k]).trim())invoiceData[k]=String(data[k]).slice(0,k==='workPerformed'?2000:500);
    for(const k of ['lineItems','parts'])if(Array.isArray(data?.[k]))invoiceData[k]=data[k].map(v=>String(v).slice(0,500)).slice(0,50);
    return {km:Number(entry.km)||0,tasks:(entry.tasks||[]).map(v=>String(v).trim().slice(0,120)).filter(Boolean).slice(0,30),notes:String(entry.notes||'').slice(0,500),workshop:String(entry.workshop||'').slice(0,120),oilChanged:!!entry.oilChanged,majorService:!!entry.majorService,majorServiceMilestoneKm:Number(entry.majorServiceMilestoneKm)||0,invoiceData};
  }
  function journal(value) {return Array.isArray(value)?value.filter(v=>v&&v.id&&v.key&&v.before&&v.after).slice(-12).map(v=>({id:String(v.id).slice(0,100),key:String(v.key).slice(0,500),actor:String(v.actor||'').slice(0,120),at:String(v.at||'').slice(0,40),afterUpdatedAt:String(v.afterUpdatedAt||'').slice(0,40),before:state(v.before,v.before.invoiceData),after:state(v.after,v.after.invoiceData),transfer:!!v.transfer,undoneAt:String(v.undoneAt||'').slice(0,40),undoneBy:String(v.undoneBy||'').slice(0,120)})):[];}
  function decision(entry,key,before,data,actor,at,transfer) {
    const revision={id:root.crypto?.randomUUID?.()||'review-'+Date.now()+'-'+Math.random().toString(36).slice(2),key,actor:String(actor||'').slice(0,120),at,afterUpdatedAt:at,before,after:state(entry,data),transfer:!!transfer};
    entry.reviewJournal=journal(entry.reviewJournal).concat([revision]).slice(-12);return revision;
  }
  function canUndo(entry,data,r) {return !!r&&!r.undoneAt&&!r.transfer&&entry.updatedAt===r.afterUpdatedAt&&JSON.stringify(state(entry,data))===JSON.stringify(r.after);}
  function undo(entry,data,r) {
    if(!canUndo(entry,data,r))return null;
    const restored=Object.assign({},data);for(const k of fields.concat(['lineItems','parts']))delete restored[k];Object.assign(restored,r.before.invoiceData);
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
  root.FleetServiceModel={cents,euro,date,invoice,amounts,summary,state,journal,decision,canUndo,undo,resolved,plans,maintenance,defaults};
})(globalThis);
