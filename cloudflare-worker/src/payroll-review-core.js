// Advisory-only review; never edits Ordexa, payable hours, locked payroll or schedules.
const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Athens',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const local=t=>{const p=Object.fromEntries(parts.formatToParts(new Date(t)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return {day:p.year+'-'+p.month+'-'+p.day,h:+p.hour,m:+p.minute};};
const prior=d=>new Date(Date.parse(d+'T12:00:00Z')-86400000).toISOString().slice(0,10);
const epoch=(s,label)=>{if(typeof s!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(s)||!Number.isFinite(Date.parse(s)))throw new TypeError('Invalid offset timestamp '+label);return Date.parse(s);};
export function reviewPayrollAttendance({shifts=[],schedule=[],now=new Date().toISOString()}={}){
 if(!Array.isArray(shifts)||!Array.isArray(schedule))throw new TypeError('Invalid attendance input');
 const present=new Map(),byEmployee=new Map(),alerts=[],slots=new Map(),rightNow=epoch(now,'now');
 const alert=(type,severity,day,employeeId,shiftId=null)=>alerts.push({type,severity,day,employeeId,shiftId});
 const sorted=shifts.map(s=>{
  if(!s||typeof s.id!=='string'||!s.id||typeof s.employeeId!=='string'||!s.employeeId)throw new TypeError('Shift must have stable ID and employee ID');
  const start=epoch(s.startedAt,'start'),end=s.endedAt==null?null:epoch(s.endedAt,'end');
  if(end!==null&&(end<start||end-start>30*3600000))throw new RangeError('Invalid shift interval');
  const d=local(start),day=d.h<8?prior(d.day):d.day;
  if(typeof s.day==='string'&&s.day!==day)alert('shift-day-mismatch','review',day,s.employeeId,s.id);
  const key=day+'|'+s.employeeId;present.set(key,(present.get(key)||0)+1);
  if(!byEmployee.has(s.employeeId))byEmployee.set(s.employeeId,[]);
  byEmployee.get(s.employeeId).push({start,end,id:s.id,day});
  if(end===null){if(rightNow>start+2*3600000)alert('open-clock-out','review',day,s.employeeId,s.id);}
  else{
   const e=local(end);if((e.h>2&&e.h<8)||(e.h===2&&e.m>0))alert('clock-out-after-close','review',day,s.employeeId,s.id);
   if(end>rightNow+60000)alert('future-clock-out','review',day,s.employeeId,s.id);
   // Sample only the two special night windows; this detects capacity excess,
   // not eligibility for higher pay. Existing Server engine retains pay authority.
   for(let t=start;t<end;t+=5*60000){
    const x=local(t);if(x.h!==0&&x.h!==1)continue;
    const bucket=x.day+'|'+x.h+'|'+x.m.toString().padStart(2,'0');
    if(!slots.has(bucket))slots.set(bucket,new Set());slots.get(bucket).add(s.employeeId);
   }
  }
  return {s,start,end,day};
 });
 const scheduled=new Set();for(const row of schedule){if(!row||typeof row.day!=='string'||typeof row.employeeId!=='string')throw new TypeError('Invalid scheduled employee');const k=row.day+'|'+row.employeeId;scheduled.add(k);if(!present.has(k))alert('missing-clock-in','review',row.day,row.employeeId);}
 for(const [key,count] of present){const split=key.indexOf('|'),day=key.slice(0,split),employeeId=key.slice(split+1);if(!scheduled.has(key))alert('not-in-schedule','info',day,employeeId);if(count>1)alert('multiple-clock-pairs','info',day,employeeId);}
 for(const [employeeId,arr] of byEmployee){arr.sort((a,b)=>a.start-b.start);for(let i=1;i<arr.length;i++)if(arr[i-1].end===null||arr[i].start<arr[i-1].end)alert('overlap','review',arr[i].day,employeeId,arr[i].id);}
 const bySlot=new Map();for(const [key,people] of slots){const [date,h]=key.split('|'),limit=h==='0'?3:2;if(people.size>limit){const name=prior(date)+'|'+h;if(!bySlot.has(name)||bySlot.get(name)<people.size)bySlot.set(name,people.size);}}
 for(const [key,count] of bySlot){const idx=key.lastIndexOf('|'),day=key.slice(0,idx),h=key.slice(idx+1);alerts.push({type:h==='0'?'night-capacity-00':'night-capacity-01',severity:'review',day,employeeId:null,shiftId:null,actualCount:count,limit:h==='0'?3:2});}
 return {alerts:alerts.sort((a,b)=>a.day.localeCompare(b.day)||a.type.localeCompare(b.type)),checkedShifts:sorted.length,source:'advisory-only',changesApplied:0};
}
