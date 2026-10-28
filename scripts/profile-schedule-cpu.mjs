import fs from 'node:fs';
import {Session} from 'node:inspector';
import {createSimulation} from './fixtures/workforce-simulation.mjs';
import {addCalendarDays} from '../cloudflare-worker/src/workforce-core.js';
const {db,call}=createSimulation();
const b=await call('/api/auth/bootstrap',{method:'POST',server:true,body:{fullName:'CPU owner',username:'cpu-owner',password:'FixturePassword!123'}});const token=b.data.token;
const req=(path,method='GET',body)=>call(path,{token,method,body});
const t=(await req('/api/admin/shift-templates','POST',{segments:[{start:'08:17',end:'16:23'}]})).data.template;
const stamp=new Date().toISOString(),week='2026-10-26';
for(let i=0;i<60;i++)db.sqlite.prepare("INSERT INTO app_users(id,full_name,username,password_hash,password_salt,role,created_at,updated_at,login_enabled) VALUES(?,?,?,'x','x','employee',?,?,0)").run('e'+i,'Employee '+i,'e'+i,stamp,stamp);
const assignments=Array.from({length:60},(_,i)=>Array.from({length:7},(_,d)=>({employeeId:'e'+i,templateId:t.id,date:addCalendarDays(week,d),withoutVehicle:true}))).flat();
let formats=0,constructs=0;const DateTimeFormat=Intl.DateTimeFormat,formatToParts=Intl.DateTimeFormat.prototype.formatToParts;
Intl.DateTimeFormat=function(...args){constructs++;return new DateTimeFormat(...args);};Intl.DateTimeFormat.prototype=DateTimeFormat.prototype;
DateTimeFormat.prototype.formatToParts=function(...args){formats++;return formatToParts.apply(this,args);};
const session=new Session();session.connect();const send=(name,arg={})=>new Promise((resolve,reject)=>session.post(name,arg,(e,r)=>e?reject(e):resolve(r)));
const report=[];await send('Profiler.enable');await send('Profiler.setSamplingInterval',{interval:100});await send('Profiler.start');
for(const [name,path,method,body] of [
 ['save','/api/admin/schedule-week','POST',{draft:true,assignments}],
 ['load','/api/admin/schedule-week?week='+week,'GET'],
 ['replace-one','/api/admin/schedule-week','POST',{draft:true,replaceEmployeeId:'e0',assignments:assignments.filter(a=>a.employeeId==='e0')}],
 ['publish','/api/admin/schedule-week/publish','POST',{weekStart:week,confirm:true}],
 ['published-load','/api/admin/schedule-week?week='+week,'GET']]){
 formats=0;constructs=0;const cpu=process.cpuUsage(),start=performance.now();const r=await req(path,method,body);report.push({name,status:r.status,formats,constructs,cpuMs:process.cpuUsage(cpu).user/1000,wallMs:performance.now()-start,rows:r.data.schedules?.length,error:r.status>=400?r.data:undefined});
}
const {profile}=await send('Profiler.stop');session.disconnect();
const dir='verification/schedule-cpu/'+(process.env.FLEET_CPU_PHASE||'before');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(dir+'/profile.cpuprofile',JSON.stringify(profile));fs.writeFileSync(dir+'/results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
Intl.DateTimeFormat=DateTimeFormat;DateTimeFormat.prototype.formatToParts=formatToParts;
