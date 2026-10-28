import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createSimulation} from './fixtures/workforce-simulation.mjs';
import {addCalendarDays,zonedLocalToUtc,localDate,localMinutes} from '../cloudflare-worker/src/workforce-core.js';
// Independent reference: keep the original four-iteration conversion, including
// its deterministic choices for ambiguous/nonexistent wall-clock times.
const refs=new Map();
function reference(date,time,zone='Europe/Athens'){
 let f=refs.get(zone);if(!f){f=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',weekday:'short'});refs.set(zone,f);}
 const [y,m,d]=date.split('-').map(Number),[h,min,sec=0]=time.split(':').map(Number),desired=Date.UTC(y,m-1,d,h,min,sec);let guess=desired;
 for(let i=0;i<4;i++){const p=Object.fromEntries(f.formatToParts(new Date(guess)).map(p=>[p.type,p.value]));guess+=desired-Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);}
 return new Date(guess).toISOString();
}
let parity=0;
for(const zone of ['Europe/Athens','UTC','America/New_York','Australia/Lord_Howe','Asia/Kathmandu','Pacific/Apia']){
 for(const date of ['2011-12-29','2011-12-30','2026-03-08','2026-03-29','2026-04-05','2026-10-04','2026-10-25','2026-11-01','2026-12-31'])for(const time of ['00:00','01:30','02:15','03:30','08:17','23:59','12:34:56']){
  assert.equal(zonedLocalToUtc(date,time,zone),reference(date,time,zone),zone+' '+date+' '+time);parity++;
 }
}
// Exercise eviction and exact zone separation; a pure conversion cache must not
// affect source data or vary the DST/offset result after capacity is reached.
for(let d=0;d<1100;d++)assert.equal(zonedLocalToUtc(addCalendarDays('2020-01-01',d),'06:17','UTC'),reference(addCalendarDays('2020-01-01',d),'06:17','UTC'));
assert.equal(zonedLocalToUtc('2026-10-25','03:30'),reference('2026-10-25','03:30'));
assert.notEqual(localMinutes('2026-10-26T08:00:00Z','UTC'),localMinutes('2026-10-26T08:00:00Z','Europe/Athens'));
assert.equal(localDate('2026-10-25T22:30:00Z','Europe/Athens'),'2026-10-26');
assert.throws(()=>zonedLocalToUtc('bad','08:00'));assert.throws(()=>zonedLocalToUtc('2026-10-26','bad'));assert.throws(()=>zonedLocalToUtc('2026-10-26','08:00','invalid/zone'));
const {db,env,call}=createSimulation();
const boot=await call('/api/auth/bootstrap',{method:'POST',server:true,body:{fullName:'CPU Owner',username:'cpu-owner',password:'FixturePassword!123'}});assert.equal(boot.status,200);const token=boot.data.token;
const req=(path,method='GET',body)=>call(path,{token,method,body});
const t=await req('/api/admin/shift-templates','POST',{segments:[{start:'08:17',end:'16:23'}]});assert.equal(t.status,201);
const stamp=new Date().toISOString(),week='2026-10-26';
for(let i=0;i<60;i++)db.sqlite.prepare("INSERT INTO app_users(id,full_name,username,password_hash,password_salt,role,created_at,updated_at,login_enabled) VALUES(?,?,?,'x','x','employee',?,?,0)").run('cpu-e'+i,'CPU Employee '+i,'cpu-e'+i,stamp,stamp);
const assignments=Array.from({length:60},(_,i)=>Array.from({length:7},(_,d)=>({employeeId:'cpu-e'+i,templateId:t.data.template.id,date:addCalendarDays(week,d),withoutVehicle:true}))).flat();
let formats=0,constructs=0;const Original=Intl.DateTimeFormat,parts=Original.prototype.formatToParts;
Intl.DateTimeFormat=function(...args){constructs++;return new Original(...args);};Intl.DateTimeFormat.prototype=Original.prototype;
Original.prototype.formatToParts=function(...args){if(++formats>500)throw Error('Fixture CPU work budget: repeated ICU conversion');return parts.apply(this,args);};
const results=[];
try{
 for(const [name,path,method,body] of [
  ['save','/api/admin/schedule-week','POST',{draft:true,assignments}],
  ['load','/api/admin/schedule-week?week='+week,'GET'],
  ['replace-one','/api/admin/schedule-week','POST',{draft:true,replaceEmployeeId:'cpu-e0',assignments:assignments.filter(a=>a.employeeId==='cpu-e0')}],
  ['publish','/api/admin/schedule-week/publish','POST',{weekStart:week,confirm:true}],
  ['published-load','/api/admin/schedule-week?week='+week,'GET']]){
  formats=0;constructs=0;const r=await req(path,method,body);assert.ok([200,201].includes(r.status),name+' '+JSON.stringify(r.data));assert.ok(constructs<=3,name+' creates formatters per row');
  if(method==='GET'){assert.equal(r.data.schedules.length,420);assert.ok(r.data.schedules.every(s=>s.start_time==='08:17'&&s.end_time==='16:23'));}
  results.push({name,status:r.status,icuCalls:formats,formatterConstructions:constructs});
 }
}finally{Intl.DateTimeFormat=Original;Original.prototype.formatToParts=parts;}
// Restore a draft and ensure replacing one rider preserves everyone else's days.
assert.equal((await req('/api/admin/schedule-week','POST',{draft:true,assignments})).status,201);
const readDraft=()=>db.sqlite.prepare('SELECT assignments FROM schedule_week_drafts WHERE week_start=?').get(week).assignments;
const before=readDraft(),baseAudit=db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='schedule_draft_saved'").get().n;
const batch=env.DB.batch.bind(env.DB);
env.DB.batch=statements=>batch(statements.map(s=>s.sql.includes('INSERT INTO audit_log')?env.DB.prepare('INSERT INTO missing_audit_fixture VALUES(1)'):s));
const failed=await req('/api/admin/schedule-week','POST',{draft:true,replaceEmployeeId:'cpu-e0',assignments:assignments.filter(a=>a.employeeId==='cpu-e0').map(a=>({...a,notes:'must roll back'}))});
assert.equal(failed.status,500);assert.equal(readDraft(),before,'audit failure rolls back draft write');assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='schedule_draft_saved'").get().n,baseAudit);
let raced=false;
env.DB.batch=statements=>{
 if(!raced&&statements.some(s=>s.sql.includes('UPDATE schedule_week_drafts SET assignments='))){raced=true;const concurrent=JSON.parse(readDraft());concurrent.find(a=>a.employeeId==='cpu-e1').notes='Other editor';db.sqlite.prepare('UPDATE schedule_week_drafts SET assignments=? WHERE week_start=?').run(JSON.stringify(concurrent),week);}
 return batch(statements);
};
const stale=await req('/api/admin/schedule-week','POST',{draft:true,replaceEmployeeId:'cpu-e0',assignments:assignments.filter(a=>a.employeeId==='cpu-e0')});assert.equal(stale.status,409);assert.equal(stale.data.code,'schedule_draft_stale');assert.equal(JSON.parse(readDraft()).find(a=>a.employeeId==='cpu-e1').notes,'Other editor');assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='schedule_draft_saved'").get().n,baseAudit);
env.DB.batch=batch;
const edit=await req('/api/admin/schedule-week','POST',{draft:true,replaceEmployeeId:'cpu-e0',assignments:assignments.filter(a=>a.employeeId==='cpu-e0').map(a=>({...a,notes:'new rider notes'}))});assert.equal(edit.status,201);assert.equal(JSON.parse(readDraft()).length,420);assert.equal(JSON.parse(readDraft()).find(a=>a.employeeId==='cpu-e1').notes,'Other editor');
// Authentication and invalid requests remain strict; failure never erases a week.
assert.equal((await call('/api/admin/schedule-week?week='+week)).status,401);
const preserved=readDraft();assert.equal((await req('/api/admin/schedule-week','POST',{draft:true,assignments:[{...assignments[0],templateId:'missing'}]})).status,422);assert.equal(readDraft(),preserved);
fs.mkdirSync('verification/schedule-cpu',{recursive:true});fs.writeFileSync('verification/schedule-cpu/regressions.json',JSON.stringify({parityCases:parity,evictionCases:1100,rows:420,results,auditRollback:true,concurrentEditPreserved:true,environment:'Synthetic full Worker + SQLite; ICU operation budget is not a production CPU measurement'},null,2)+'\n');
console.log('PASS #17: '+parity+' timezone/DST parity cases + eviction, bounded ICU work for 420 assignments, full Worker GET/POST, rollback and stale-write guards. Production CPU still requires live confirmation.');
