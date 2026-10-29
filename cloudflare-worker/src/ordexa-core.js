// No network access in this module. Provider events and payroll interpretation
// remain separate; names are labels, never employee identity.
export const ORDEXA_SCHEMA = `
CREATE TABLE IF NOT EXISTS ordexa_riders (
 id TEXT PRIMARY KEY,city_id TEXT NOT NULL,rider_id TEXT NOT NULL,name TEXT NOT NULL,
 employee_id TEXT,revision INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,
 UNIQUE(city_id,rider_id),FOREIGN KEY(employee_id) REFERENCES app_users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ordexa_mapping_employee ON ordexa_riders(city_id,employee_id) WHERE employee_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS ordexa_imports (
 id TEXT PRIMARY KEY,city_id TEXT NOT NULL,day TEXT NOT NULL,captured_at TEXT NOT NULL,
 received_at TEXT NOT NULL,payload TEXT NOT NULL,accepted INTEGER NOT NULL,commit_nonce TEXT NOT NULL,
 UNIQUE(city_id,day,captured_at)
);
CREATE INDEX IF NOT EXISTS ordexa_imports_window ON ordexa_imports(city_id,day,captured_at DESC);
CREATE TABLE IF NOT EXISTS ordexa_sessions (
 id TEXT PRIMARY KEY,city_id TEXT NOT NULL,rider_id TEXT NOT NULL,provider_day TEXT NOT NULL,
 in_at TEXT NOT NULL,out_at TEXT,source_id TEXT NOT NULL,raw_json TEXT NOT NULL,
 review INTEGER NOT NULL DEFAULT 0,ignored INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 1,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,
 missing_since TEXT,decision_reason TEXT NOT NULL DEFAULT '',review_reason TEXT NOT NULL DEFAULT '',previous_raw_json TEXT
);
CREATE INDEX IF NOT EXISTS ordexa_sessions_period ON ordexa_sessions(in_at,city_id,rider_id);
CREATE INDEX IF NOT EXISTS ordexa_sessions_day ON ordexa_sessions(city_id,provider_day);
CREATE TABLE IF NOT EXISTS ordexa_pay_decisions (
 id TEXT PRIMARY KEY,employee_id TEXT NOT NULL,source_session_id TEXT NOT NULL,
 match_fingerprint TEXT NOT NULL,chosen_schedule_id TEXT NOT NULL DEFAULT '',
 start_fingerprint TEXT NOT NULL,end_fingerprint TEXT NOT NULL,
 start_choice TEXT NOT NULL,end_choice TEXT NOT NULL,
 reason TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,commit_nonce TEXT NOT NULL,
 created_at TEXT NOT NULL,created_by TEXT NOT NULL,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ordexa_pay_decisions_source ON ordexa_pay_decisions(source_session_id);
CREATE TRIGGER IF NOT EXISTS ordexa_pay_schedule_insert AFTER INSERT ON schedules WHEN EXISTS(SELECT 1 FROM system_settings WHERE key='ordexa_pay_policy' AND json_extract(value,'$.enabled')=1) BEGIN UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision'; END;
CREATE TRIGGER IF NOT EXISTS ordexa_pay_schedule_update AFTER UPDATE ON schedules WHEN EXISTS(SELECT 1 FROM system_settings WHERE key='ordexa_pay_policy' AND json_extract(value,'$.enabled')=1) BEGIN UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision'; END;
CREATE TRIGGER IF NOT EXISTS ordexa_pay_schedule_delete AFTER DELETE ON schedules WHEN EXISTS(SELECT 1 FROM system_settings WHERE key='ordexa_pay_policy' AND json_extract(value,'$.enabled')=1) BEGIN UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision'; END;

`;
export const ORDEXA_COLUMNS = {
 ordexa_pay_decisions:['id','employee_id','source_session_id','match_fingerprint','chosen_schedule_id','start_fingerprint','end_fingerprint','start_choice','end_choice','reason','revision','commit_nonce','created_at','created_by','updated_at','updated_by'],
 ordexa_riders:['id','city_id','rider_id','name','employee_id','revision','updated_at'],
 ordexa_imports:['id','city_id','day','captured_at','received_at','payload','accepted','commit_nonce'],
 ordexa_sessions:['id','city_id','rider_id','provider_day','in_at','out_at','source_id','raw_json','review','ignored','revision','first_seen','last_seen','missing_since','decision_reason','review_reason','previous_raw_json']
};
export const ordexaId = (city,rider) => JSON.stringify([String(city),String(rider)]);
const fail = message => {throw new Error(message);};
function identifier(value) {
 if(!['string','number'].includes(typeof value)||(typeof value==='number'&&(!Number.isSafeInteger(value)||value<0))||!String(value).trim()||String(value).length>100)fail('Μη έγκυρο αναγνωριστικό Ordexa.');
 return String(value);
}
export function ordexaDay(value) {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)fail('Μη έγκυρη ημερομηνία Ordexa.');
 return value;
}
function instant(value,nullable=false) {
 if(nullable&&(value===null||value===undefined||value===''))return null;
 if(typeof value!=='string'||value.length>40||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))fail('Η ώρα Ordexa πρέπει να έχει πλήρη ημερομηνία και ζώνη ώρας.');
 ordexaDay(value.slice(0,10));return new Date(value).toISOString();
}
export function normalizeOrdexaReport(input) {
 const city=identifier(input.cityId),day=ordexaDay(input.day),capturedAt=instant(input.capturedAt);
 const riders=input.report?.riders;
 if(!Array.isArray(riders)||riders.length>200)fail('Άγνωστο ή υπερβολικά μεγάλο σχήμα αναφοράς Ordexa.');
 if(input.hasMore===true||input.next||input.report?.hasMore===true||input.report?.next)fail('Η αναφορά Ordexa δεν είναι πλήρης.');
 const names=[],rows=[],seen=new Set(),seenRiders=new Set();
 for(const rider of riders){
  const rid=identifier(rider.riderId),id=ordexaId(city,rid);
  if(seenRiders.has(id))fail('Διπλό αναγνωριστικό διανομέα στην αναφορά.');seenRiders.add(id);
  if(typeof rider.name!=='string'||!rider.name.trim()||rider.name.length>200||!Array.isArray(rider.sessions))fail('Ελλιπή στοιχεία διανομέα Ordexa.');
  names.push({id,city_id:city,rider_id:rid,name:rider.name});
  for(const session of rider.sessions){
   for(const key of ['unclosed','forgotten','long'])if(session[key]!=null&&typeof session[key]!=='boolean')fail('Άγνωστο σχήμα ενδείξεων παρουσίας Ordexa.');
   const start=instant(session.inAt),end=instant(session.outAt,true),providerDay=ordexaDay(session.day);
   if(providerDay!==day)fail('Η ημερήσια αναφορά περιλαμβάνει άλλη ημέρα.');
   if(end&&end<start)fail('Η έξοδος Ordexa προηγείται της εισόδου.');
   const sourceId=session.id==null?'':identifier(session.id),key=JSON.stringify([city,rid,sourceId?'id:'+sourceId:'in:'+start]);
   if(seen.has(key))fail('Διπλή παρουσία στην ίδια αναφορά Ordexa.');seen.add(key);
   const raw={inAt:session.inAt,outAt:session.outAt??null,day:providerDay,id:sourceId||null,
    unclosed:session.unclosed===true,forgotten:session.forgotten===true,long:session.long===true,
    choice:typeof session.choice==='string'?session.choice.slice(0,100):null,shift:typeof session.shift==='string'?session.shift.slice(0,100):null};
   rows.push({id:key,city_id:city,rider_id:rid,provider_day:providerDay,in_at:start,out_at:end,source_id:sourceId,
    raw_json:JSON.stringify(raw),review:raw.unclosed||raw.forgotten||raw.long||(end&&Date.parse(end)-Date.parse(start)>24*3600000)?1:0});
  }
 }
 if(rows.length>2000)fail('Υπέρβαση ημερήσιου ορίου παρουσιών. Δεν αποθηκεύτηκε τμήμα της αναφοράς.');
 return {city,day,capturedAt,riders:names,rows};
}
export function validateOrdexaPolicy(value) {
 if(!value||!Number.isInteger(value.gapMinutes)||value.gapMinutes<0||value.gapMinutes>240||!['exclude','include'].includes(value.gapTreatment))fail('Όρισε όριο κενού 0–240 λεπτά και πώς θα υπολογίζεται το κενό.');
 return {gapMinutes:value.gapMinutes,gapTreatment:value.gapTreatment};
}
export function groupOrdexaSessions(rows,policy) {
 policy=validateOrdexaPolicy(policy);const groups=[],blocked=[];
 const sorted=[...rows].filter(r=>!Number(r.ignored)||Number(r.review)).sort((a,b)=>String(a.employee_id).localeCompare(String(b.employee_id))||a.in_at.localeCompare(b.in_at)||a.id.localeCompare(b.id));
 for(const row of sorted){
  if(!row.employee_id||!row.out_at||Number(row.review)||row.missing_since){blocked.push({id:row.id,reason:!row.employee_id?'Χωρίς αντιστοίχιση':!row.out_at?'Εκκρεμεί έξοδος':'Χρειάζεται έλεγχος καταγραφής'});continue;}
  const last=groups.at(-1),start=Date.parse(row.in_at),end=Date.parse(row.out_at);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start){blocked.push({id:row.id,reason:'Μη έγκυρες ώρες'});continue;}
  const gap=last?(start-Date.parse(last.end))/60000:Infinity;
  if(last&&last.employeeId===row.employee_id&&gap<=0&&end-Date.parse(last.start)>24*3600000){blocked.push({id:row.id,reason:'Επικαλυπτόμενες παρουσίες πάνω από 24 ώρες'});continue;}
  if(last&&last.employeeId===row.employee_id&&gap<=policy.gapMinutes&&end-Date.parse(last.start)<=24*3600000){
   if(gap>0){last.gaps.push([last.end,row.in_at]);}
   last.end=new Date(Math.max(end,Date.parse(last.end))).toISOString();last.sessions.push(row.id);
  }else groups.push({id:'ordexa:'+row.id,employeeId:row.employee_id,employeeName:row.employee_name,start:row.in_at,end:row.out_at,sessions:[row.id],gaps:[]});
 }
 return {groups,blocked};
}

export function projectOrdexaGroups(rows,policy){
 const byId=new Map(rows.map(row=>[row.id,row])),consumed=new Set(),projected=[];
 for(const group of policy?groupOrdexaSessions(rows,policy).groups:[]){group.sessions.forEach(id=>consumed.add(id));projected.push({...group,raw:group.sessions.map(id=>byId.get(id)),eligible:true});}
 if(policy)for(const row of rows)if(!consumed.has(row.id)&&row.employee_id&&!row.out_at&&!Number(row.ignored)&&!row.missing_since&&!row.review_reason){
  const previous=projected.findLast(group=>group.employeeId===row.employee_id&&group.end&&Date.parse(row.in_at)-Date.parse(group.end)>=0&&Date.parse(row.in_at)-Date.parse(group.end)<=policy.gapMinutes*60000&&Date.parse(row.in_at)-Date.parse(group.start)<=86400000);
  if(previous){if(row.in_at>previous.end)previous.gaps.push([previous.end,row.in_at]);previous.end=null;previous.sessions.push(row.id);previous.raw.push(row);previous.eligible=false;consumed.add(row.id);}
 }
 for(const row of rows)if(!consumed.has(row.id))projected.push({id:'ordexa:'+row.id,employeeId:row.employee_id,employeeName:row.employee_name,start:row.in_at,end:row.out_at,sessions:[row.id],gaps:[],raw:[row],eligible:false});
 return projected;
}
