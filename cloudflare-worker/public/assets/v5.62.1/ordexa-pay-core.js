(function(root){'use strict';
 const defaults=Object.freeze({enabled:false,revision:0,startCutoff:15,endMiddleFrom:21,endNextFrom:47,lateStartMinutes:20,earlyStartMinutes:15,endDeviationMinutes:30,lateStartMode:'up',continuityGapTreatment:'include'});
 function policy(input){
  if(!input||typeof input.enabled!=='boolean')throw Error('Διάλεξε αν ενεργοποιείται ο κανόνας μισάωρου.');
  const p={...defaults,...input};
  for(const [key,min,max] of [['startCutoff',1,29],['endMiddleFrom',1,29],['endNextFrom',31,59],['lateStartMinutes',1,120],['earlyStartMinutes',1,120],['endDeviationMinutes',1,240]])if(!Number.isInteger(p[key])||p[key]<min||p[key]>max)throw Error('Μη έγκυρο όριο κανόνα: '+key);
  if(p.continuityGapTreatment!=='include')throw Error('Στο προφίλ μισάωρου τα μικρά κενά είναι συνέχεια εργασίας.');
  if(!['up','nearest'].includes(p.lateStartMode))throw Error('Μη έγκυρος τρόπος καθυστερημένης έναρξης.');
  return Object.fromEntries(Object.keys(defaults).map(key=>[key,p[key]]));
 }
 const formatters=new Map();
 function minuteInHour(time,zone){let f=formatters.get(zone);if(!f){f=new Intl.DateTimeFormat('en-GB',{timeZone:zone,minute:'2-digit',second:'2-digit'});formatters.set(zone,f);}const parts=f.formatToParts(new Date(time));return Number(parts.find(x=>x.type==='minute').value)+Number(parts.find(x=>x.type==='second').value)/60+(time%1000)/60000;}
 function targetMinute(minute,kind,p){if(kind==='up')return Math.ceil(minute/30)*30;if(kind==='start')return minute<p.startCutoff?0:minute<30+p.startCutoff?30:60;if(kind==='end')return minute<p.endMiddleFrom?0:minute<p.endNextFrom?30:60;throw Error('Άγνωστη στρογγυλοποίηση.');}
 function round(value,kind,p,zone='Europe/Athens'){const time=Date.parse(value);if(!Number.isFinite(time))throw Error('Μη έγκυρη ώρα παρουσίας.');const minute=minuteInHour(time,zone);return new Date(Math.round(time+(targetMinute(minute,kind,p)-minute)*60000)).toISOString();}
 function clockLabel(hour,minute,kind,p){const target=targetMinute(minute,kind,p);return String((hour+(target===60?1:0))%24).padStart(2,'0')+':'+String(target%60).padStart(2,'0');}
 function resolve(group,schedule,p,choice={},zone='Europe/Athens'){
  const start=Date.parse(group.start),end=group.end?Date.parse(group.end):null,warnings=[];
  if(!Number.isFinite(start)||(end!==null&&(!Number.isFinite(end)||end<start)))throw Error('Μη έγκυρες ώρες παρουσίας.');
  let clockStart=round(group.start,'start',p,zone),clockEnd=group.end?round(group.end,'end',p,zone):null;
  let recommendedStart=clockStart,recommendedEnd=clockEnd;
  if(schedule){
   const planStart=Date.parse(schedule.start_at),planEnd=Date.parse(schedule.end_at),late=(start-planStart)/60000,early=-late;
   recommendedStart=schedule.start_at;recommendedEnd=group.end?schedule.end_at:null;
   if(late>=p.lateStartMinutes){clockStart=round(group.start,p.lateStartMode==='up'?'up':'start',p,zone);recommendedStart=clockStart;warnings.push({key:'late_start',message:'Καθυστερημένο Clock In '+Math.floor(late)+' λεπτά',side:'start'});}
   else if(early>=p.earlyStartMinutes)warnings.push({key:'early_start',message:'Πρόωρο Clock In '+Math.floor(early)+' λεπτά',side:'start'});
   if(end!==null&&Math.abs(end-planEnd)>=p.endDeviationMinutes*60000)warnings.push({key:'end_deviation',message:(end>=planEnd?'Μεταγενέστερο':'Νωρίτερο')+' Clock Out '+Math.floor(Math.abs(end-planEnd)/60000)+' λεπτά',side:'end'});
  }
  const paidStart=schedule&&choice.start==='program'?schedule.start_at:choice.start==='clock'?clockStart:recommendedStart;
  let paidEnd=group.end?(schedule&&choice.end==='program'?schedule.end_at:choice.end==='clock'?clockEnd:recommendedEnd):null;
  if(!schedule&&paidEnd&&paidEnd<paidStart)paidEnd=paidStart;
  const unresolved=warnings.filter(w=>!choice[w.side]);
  if(paidEnd&&paidEnd<paidStart)unresolved.push({key:'invalid_paid_interval',side:'both',message:'Η επιλεγμένη πληρωτέα λήξη προηγείται της έναρξης.'});
  return {paidStart,paidEnd,clockStart,clockEnd,recommendedStart,recommendedEnd,warnings,unresolved};
 }
 root.FleetOrdexaPayCore=Object.freeze({defaults,policy,round,clockLabel,resolve});
})(typeof globalThis!=='undefined'?globalThis:this);
