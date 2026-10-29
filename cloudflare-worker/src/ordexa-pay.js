import '../public/ordexa-pay-core.js';
import {localDate,addCalendarDays,zonedLocalToUtc} from './workforce-core.js';
import {projectOrdexaGroups,validateOrdexaPolicy} from './ordexa-core.js';
const C=globalThis.FleetOrdexaPayCore,rows=r=>r.results||[],now=()=>new Date().toISOString();
const setting=async(env,key,fallback)=>{const r=await env.DB.prepare('SELECT value FROM system_settings WHERE key=?').bind(key).first();return r?.value??fallback;};
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(v=>v.toString(16).padStart(2,'0')).join('');
export async function readOrdexaPayPolicy(env){let value;try{value=JSON.parse(await setting(env,'ordexa_pay_policy','null'));}catch{}return value?C.policy(value):{...C.defaults};}
const planValue=s=>s?{id:s.id,start_at:s.start_at,end_at:s.end_at}:null;

export async function resolveOrdexaPayGroups(env,groups,options={}){
 const policy=await readOrdexaPayPolicy(env);if(!policy.enabled||!groups.length)return {groups,reviews:[],policy};
 const valid=groups.filter(g=>g.employeeId&&!g.raw.some(r=>Number(r.ignored)||r.missing_since)),ids=valid.map(g=>g.id);
 if(!valid.length)return {groups,reviews:[],policy};
 const starts=valid.map(g=>Date.parse(g.start)),lower=new Date(Math.min(...starts)-86400000).toISOString(),upper=new Date(Math.max(...starts)+2*86400000).toISOString();
 const [plans,decisions,zone]=await Promise.all([
  env.DB.prepare("SELECT id,employee_id,start_at,end_at,status FROM schedules WHERE start_at<? AND end_at>? AND status<>'cancelled' ORDER BY start_at,id").bind(upper,lower).all(),
  env.DB.prepare('SELECT * FROM ordexa_pay_decisions WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all(),
  setting(env,'timezone','Europe/Athens')
 ]);
 const byEmployee=new Map(),byDecision=new Map(rows(decisions).map(d=>[d.id,d]));for(const plan of rows(plans)){if(!byEmployee.has(plan.employee_id))byEmployee.set(plan.employee_id,[]);byEmployee.get(plan.employee_id).push(plan);}
 let paidIds=options.paidIds;if(!paidIds){const rawIds=JSON.stringify(valid.flatMap(g=>g.sessions));if(new TextEncoder().encode(rawIds).length>1048576)throw Error('Πολλές παρουσίες Ordexa. Μίκρυνε την περίοδο ελέγχου.');paidIds=new Set(rows(await env.DB.prepare("SELECT DISTINCT si.value AS id FROM payroll_snapshots ps JOIN payroll_periods pp ON pp.id=ps.period_id,json_each(ps.data,'$.sourceRows') sr,json_each(sr.value,'$.sourceSessionIds') si WHERE pp.status='locked' AND si.value IN (SELECT value FROM json_each(?))").bind(rawIds).all()).map(r=>r.id));}
 const planIds=rows(plans).map(s=>s.id),paidPlans=new Set(planIds.length?rows(await env.DB.prepare("SELECT DISTINCT json_extract(sr.value,'$.sourceScheduleId') AS id FROM payroll_snapshots ps JOIN payroll_periods pp ON pp.id=ps.period_id,json_each(ps.data,'$.sourceRows') sr WHERE pp.status='locked' AND json_extract(sr.value,'$.sourceScheduleId') IN (SELECT value FROM json_each(?))").bind(JSON.stringify(planIds)).all()).map(r=>r.id):[]);
 const reviews=[];
 for(const group of valid){
  if(group.sessions.some(id=>paidIds.has(id)))continue;
  const candidates=(byEmployee.get(group.employeeId)||[]).filter(s=>Math.abs(Date.parse(s.start_at)-Date.parse(group.start))<=12*3600000);
  const matchFingerprint=JSON.stringify([group.id,group.employeeId,group.start,candidates.map(planValue),policy]);
  const saved=byDecision.get(group.id),manual=saved?.match_fingerprint===matchFingerprint?saved.chosen_schedule_id:'';
  const scored=candidates.map(s=>({s,score:Math.abs(Date.parse(group.start)-Date.parse(s.start_at))+(group.end?Math.abs(Date.parse(group.end)-Date.parse(s.end_at))/4:0)})).sort((a,b)=>a.score-b.score||a.s.id.localeCompare(b.s.id));
  const nearest=scored[0]?.s;
  const overlap=nearest&&((group.end&&group.start<nearest.end_at&&group.end>nearest.start_at)||Math.abs(Date.parse(group.start)-Date.parse(nearest.start_at))<=4*3600000);
  const ambiguous=scored.length>1&&Math.abs(scored[0].score-scored[1].score)<30*60000;
  const schedule=manual==='none'?null:manual?candidates.find(s=>s.id===manual)||null:overlap?nearest:null;
  const matchWarning=!manual&&(ambiguous||(!schedule&&candidates.some(s=>localDate(s.start_at,zone)===localDate(group.start,zone))));
  const startFingerprint=JSON.stringify([group.id,group.employeeId,group.start,schedule?.id,schedule?.start_at,policy]);
  const endFingerprint=JSON.stringify([group.id,group.employeeId,group.end,schedule?.id,schedule?.end_at,policy]);
  const choices={start:saved?.start_fingerprint===startFingerprint?saved.start_choice||undefined:undefined,end:saved?.end_fingerprint===endFingerprint?saved.end_choice||undefined:undefined};
  const resolution=C.resolve(group,schedule,policy,choices,zone);
  if(saved?.start_choice&&saved.start_fingerprint!==startFingerprint&&!resolution.unresolved.some(w=>w.side==='start'))resolution.unresolved.push({key:'stale_start_decision',side:'start',message:'Η προηγούμενη απόφαση έναρξης χρειάζεται επανέλεγχο με τα νέα δεδομένα.'});
  if(group.end&&saved?.end_choice&&saved.end_fingerprint!==endFingerprint&&!resolution.unresolved.some(w=>w.side==='end'))resolution.unresolved.push({key:'stale_end_decision',side:'end',message:'Η προηγούμενη απόφαση λήξης χρειάζεται επανέλεγχο με τα νέα δεδομένα.'});
  if(schedule&&paidPlans.has(schedule.id)){resolution.unresolved.push({key:'paid_schedule',side:'match',message:'Αυτή η προγραμματισμένη βάρδια έχει ήδη πληρωθεί σε κλειδωμένη μισθοδοσία.'});group.eligible=false;}
  if(matchWarning)resolution.unresolved.push({key:'schedule_match',side:'match',message:'Επιβεβαίωσε ποια δημοσιευμένη βάρδια αντιστοιχεί στην παρουσία.'});
  const fingerprint=await digest([matchFingerprint,group.end,group.raw.map(r=>[r.id,r.revision,r.in_at,r.out_at,r.review,r.ignored,r.missing_since]),startFingerprint,endFingerprint]);
  group.payResolution={...resolution,schedule:planValue(schedule),policy,matchFingerprint,startFingerprint,endFingerprint,fingerprint,chosenScheduleId:manual,decisionRevision:saved?.revision||0,decisionReason:saved?.reason||'',appliedStartChoice:choices.start||'',appliedEndChoice:choices.end||'',candidates:candidates.map(planValue),zone};
  group.payrollAnchor=schedule?.start_at||group.start;
  if(resolution.unresolved.length)reviews.push(publicReview(group));
 }
 // One planned shift can never produce two full program-based payments.
 const claims=new Map();for(const group of valid){const id=group.payResolution?.schedule?.id;if(!id)continue;if(!claims.has(id))claims.set(id,[]);claims.get(id).push(group);}
 for(const same of claims.values())if(same.length>1)for(const group of same){group.payResolution.unresolved.push({key:'schedule_collision',side:'match',message:'Η ίδια δημοσιευμένη βάρδια αντιστοιχεί σε περισσότερες παρουσίες. Επίλεξε διαφορετική αντιστοίχιση ή χωρίς πρόγραμμα.'});if(!reviews.some(r=>r.id===group.id))reviews.push(publicReview(group));else Object.assign(reviews.find(r=>r.id===group.id),publicReview(group));}
 return {groups,reviews,policy};
}

function publicReview(group){const p=group.payResolution;return {id:group.id,employeeId:group.employeeId,employeeName:group.employeeName||group.raw[0].name,actualStart:group.start,actualEnd:group.end,schedule:p.schedule,candidates:p.candidates,chosenScheduleId:p.chosenScheduleId,proposedStart:p.paidStart,proposedEnd:p.paidEnd,clockStart:p.clockStart,clockEnd:p.clockEnd,reasons:p.unresolved,revision:p.decisionRevision,fingerprint:p.fingerprint,startChoice:p.appliedStartChoice,endChoice:p.appliedEndChoice,sourcePending:!group.eligible,policy:p.policy,timeZone:p.zone,anchorDate:localDate(group.payrollAnchor,p.zone)};}

export async function syncOrdexaPayAlerts(env,groups){
 const considered=groups,stamp=now();if(!considered.length)return;const pendingIds=new Set(considered.filter(g=>g.payResolution?.unresolved.length).map(g=>g.id));const clearIds=[...new Set(considered.flatMap(g=>[...(!g.payResolution?.unresolved.length?[g.id]:[]),...g.sessions.map(id=>'ordexa:'+id).filter(id=>id!==g.id)]).filter(id=>!pendingIds.has(id)))];
 const values=await Promise.all(considered.filter(g=>g.payResolution?.unresolved.length).map(async group=>({id:'ordexa-pay-'+(await digest(group.id)).slice(0,32),object_id:group.id,pending:group.payResolution.unresolved.length?1:0,title:'Έλεγχος μισθοδοσίας · '+(group.employeeName||group.raw[0].name),message:group.payResolution.unresolved.map(r=>r.message).join(' · ')})));
 await env.DB.batch([
  env.DB.prepare(`INSERT INTO system_alerts(id,type,severity,title,message,object_type,object_id,dedupe_key,resolved,created_at)
   SELECT json_extract(value,'$.id'),'ordexa_pay_review','warning',json_extract(value,'$.title'),json_extract(value,'$.message'),'ordexa_pay_review',json_extract(value,'$.object_id'),json_extract(value,'$.id'),0,? FROM json_each(?) WHERE json_extract(value,'$.pending')=1
   ON CONFLICT(dedupe_key) DO UPDATE SET title=excluded.title,message=excluded.message,resolved=0,resolved_at=NULL,resolved_by=NULL WHERE system_alerts.resolved<>0 OR system_alerts.message<>excluded.message OR system_alerts.title<>excluded.title`).bind(stamp,JSON.stringify(values)),
  env.DB.prepare(`UPDATE system_alerts SET resolved=1,resolved_at=? WHERE type='ordexa_pay_review' AND resolved=0 AND object_id IN (SELECT value FROM json_each(?))`).bind(stamp,JSON.stringify(clearIds))
 ]);
}

export async function readOrdexaReviewContext(env,id){
 const first=await env.DB.prepare('SELECT * FROM ordexa_sessions WHERE id=?').bind(String(id).replace(/^ordexa:/,'')).first();if(!first)return null;
 const lower=new Date(Date.parse(first.in_at)-86400000).toISOString(),upper=new Date(Date.parse(first.in_at)+2*86400000).toISOString();
 const raw=rows(await env.DB.prepare(`SELECT s.*,r.employee_id,r.name,u.full_name AS employee_name FROM ordexa_sessions s LEFT JOIN ordexa_riders r ON r.city_id=s.city_id AND r.rider_id=s.rider_id LEFT JOIN app_users u ON u.id=r.employee_id WHERE s.in_at>=? AND s.in_at<? ORDER BY s.in_at,s.id LIMIT 10001`).bind(lower,upper).all());if(raw.length>10000)throw Error('Πολλές παρουσίες Ordexa στην περίοδο ελέγχου.');
 let gap;try{gap=validateOrdexaPolicy(JSON.parse(await setting(env,'ordexa_policy','null')));}catch{throw Error('Ρύθμισε πρώτα τους κανόνες συνέχειας Ordexa.');}
 const groups=projectOrdexaGroups(raw,gap);await resolveOrdexaPayGroups(env,groups);return {groups,group:groups.find(g=>g.id===id)||null};
}

export async function refreshOrdexaPayAlerts(env,day,to=day){
 if(!(await readOrdexaPayPolicy(env)).enabled)return {enabled:false,pending:0};
 const zone=await setting(env,'timezone','Europe/Athens'),lower=zonedLocalToUtc(addCalendarDays(day,-1),'00:00',zone),upper=zonedLocalToUtc(addCalendarDays(to,2),'00:00',zone);
 const raw=rows(await env.DB.prepare(`SELECT s.*,r.employee_id,r.name,u.full_name AS employee_name FROM ordexa_sessions s LEFT JOIN ordexa_riders r ON r.city_id=s.city_id AND r.rider_id=s.rider_id LEFT JOIN app_users u ON u.id=r.employee_id WHERE s.in_at>=? AND s.in_at<? ORDER BY s.in_at,s.id LIMIT 10001`).bind(lower,upper).all());if(raw.length>10000)throw Error('Πολλές παρουσίες Ordexa για αυτόματο έλεγχο μισθοδοσίας.');
 let gap;try{gap=validateOrdexaPolicy(JSON.parse(await setting(env,'ordexa_policy','null')));}catch{return {enabled:true,pending:0,needsGapPolicy:true};}
 const groups=projectOrdexaGroups(raw,gap),result=await resolveOrdexaPayGroups(env,groups);await syncOrdexaPayAlerts(env,groups);return {enabled:true,pending:result.reviews.length};
}

export async function routeOrdexaPay(request,env,path,D){
 const policyRoute=path==='/api/admin/ordexa/pay-policy',reviewRoute=path==='/api/admin/ordexa/pay-review';if(!policyRoute&&!reviewRoute)return null;
 const method=request.method,actor=await D.authenticate(request,env,method==='GET'?'payroll.view':policyRoute?'settings.manage':'payroll.manage');
 if(method==='GET'&&policyRoute)return D.wfJson({policy:await readOrdexaPayPolicy(env)});
 if(method==='GET'&&reviewRoute){const context=await readOrdexaReviewContext(env,new URL(request.url).searchParams.get('id'));if(!context?.group?.payResolution)throw new D.ApiError(404,'Δεν υπάρχει ενεργός έλεγχος για αυτή την παρουσία.');return D.wfJson({review:publicReview(context.group)});}
 if(method!=='POST')throw new D.ApiError(405,'Μη επιτρεπτή ενέργεια.');
 const pinUsed=await D.requirePin(request,env,D,actor);const b=await D.bodyJson(request),stamp=now(),reason=String(b.reason||'').trim().slice(0,500);if(!reason)throw new D.ApiError(400,'Γράψε αιτιολογία απόφασης μισθοδοσίας.');
 const audit=(action,id,before,after,guard,args)=>env.DB.prepare(`INSERT INTO audit_log(id,timestamp,user_id,user_name,role,action,object_type,object_id,old_value,new_value,reason,admin_pin_used) SELECT ?,?,?,?,?,?,'ordexa_pay',?,?,?,?,? WHERE ${guard}`).bind(crypto.randomUUID(),stamp,actor.user_id,actor.full_name||'',actor.role,action,id,JSON.stringify(before),JSON.stringify(after),reason,pinUsed?1:0,...args);
 if(policyRoute){
  let next;try{next=C.policy(b.policy);}catch(e){throw new D.ApiError(400,e.message);}
  const before=await readOrdexaPayPolicy(env);if(Number(b.revision)!==before.revision)throw new D.ApiError(409,'Ο κανόνας άλλαξε. Άνοιξε ξανά τις ρυθμίσεις.');next.revision=before.revision+1;
  const previous=await setting(env,'ordexa_pay_policy',''),guard="EXISTS(SELECT 1 FROM system_settings WHERE key='ordexa_pay_policy' AND value=?) OR (?='' AND NOT EXISTS(SELECT 1 FROM system_settings WHERE key='ordexa_pay_policy'))";
  const result=await env.DB.batch([audit('ordexa_pay_policy','policy',before,next,guard,[previous,previous]),env.DB.prepare(`INSERT INTO system_settings(key,value,updated_at,updated_by) VALUES('ordexa_pay_policy',?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by WHERE system_settings.value=?`).bind(JSON.stringify(next),stamp,actor.user_id,previous),env.DB.prepare("UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision' AND changes()>0")]);
  if(!result[1]?.meta?.changes)throw new D.ApiError(409,'Ο κανόνας άλλαξε. Κάνε ανανέωση.');
  if(!next.enabled)await env.DB.prepare("UPDATE system_alerts SET resolved=1,resolved_at=?,resolved_by=? WHERE type='ordexa_pay_review' AND resolved=0").bind(stamp,actor.user_id).run().catch(()=>{});
  return D.wfJson({saved:true,policy:next});
 }
 const revision=await setting(env,'ordexa_revision','0'),context=await readOrdexaReviewContext(env,String(b.id||'')),group=context?.group,p=group?.payResolution;
 if(!p||b.fingerprint!==p.fingerprint||Number(b.revision)!==p.decisionRevision)throw new D.ApiError(409,'Η παρουσία ή το πρόγραμμα άλλαξε. Άνοιξε ξανά τον έλεγχο.');
 if(!['program','clock'].includes(b.startChoice)||!['program','clock',''].includes(b.endChoice))throw new D.ApiError(400,'Διάλεξε βάση πληρωμής για έναρξη και λήξη.');
 const scheduleChoice=String(b.chosenScheduleId??p.chosenScheduleId??'');if(scheduleChoice&&scheduleChoice!=='none'&&!p.candidates.some(s=>s.id===scheduleChoice))throw new D.ApiError(400,'Μη έγκυρη αντιστοίχιση προγράμματος.');
 if(p.unresolved.some(w=>w.side==='match')&&!scheduleChoice)throw new D.ApiError(400,'Επίλεξε ρητά δημοσιευμένη βάρδια ή χωρίς πρόγραμμα.');
 const saved=await env.DB.prepare('SELECT * FROM ordexa_pay_decisions WHERE id=?').bind(group.id).first(),nonce=crypto.randomUUID();
 // Recompute selected schedule/rounded bounds on the server; the client sends
 // only choices, never payment timestamps or amounts.
 const targetSchedule=scheduleChoice==='none'?null:scheduleChoice?p.candidates.find(s=>s.id===scheduleChoice):p.schedule;
 const startFingerprint=JSON.stringify([group.id,group.employeeId,group.start,targetSchedule?.id,targetSchedule?.start_at,p.policy]),endFingerprint=JSON.stringify([group.id,group.employeeId,group.end,targetSchedule?.id,targetSchedule?.end_at,p.policy]);
 if(!targetSchedule&&(b.startChoice==='program'||b.endChoice==='program'))throw new D.ApiError(400,'Δεν έχει επιλεγεί πρόγραμμα για αυτή την απόφαση.');
 const resultBounds=C.resolve(group,targetSchedule,p.policy,{start:b.startChoice,end:b.endChoice||undefined},p.zone);if(resultBounds.paidEnd&&resultBounds.paidEnd<resultBounds.paidStart)throw new D.ApiError(400,'Η επιλεγμένη λήξη προηγείται της έναρξης.');
 const ids=JSON.stringify(group.sessions),guard="EXISTS(SELECT 1 FROM system_settings WHERE key='ordexa_revision' AND value=?) AND ((?=0 AND NOT EXISTS(SELECT 1 FROM ordexa_pay_decisions WHERE id=?)) OR EXISTS(SELECT 1 FROM ordexa_pay_decisions WHERE id=? AND revision=?)) AND NOT EXISTS(SELECT 1 FROM payroll_snapshots ps JOIN payroll_periods pp ON pp.id=ps.period_id,json_each(ps.data,'$.sourceRows') sr,json_each(sr.value,'$.sourceSessionIds') si WHERE pp.status='locked' AND si.value IN (SELECT value FROM json_each(?)))";
 const args=[revision,p.decisionRevision,group.id,group.id,p.decisionRevision,ids],after={startChoice:b.startChoice,endChoice:b.endChoice,chosenScheduleId:scheduleChoice,paidStart:resultBounds.paidStart,paidEnd:resultBounds.paidEnd};
 const result=await env.DB.batch([audit('ordexa_pay_decision',group.id,saved,after,guard,args),env.DB.prepare(`INSERT INTO ordexa_pay_decisions(id,employee_id,source_session_id,match_fingerprint,chosen_schedule_id,start_fingerprint,end_fingerprint,start_choice,end_choice,reason,revision,commit_nonce,created_at,created_by,updated_at,updated_by)
  SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(id) DO UPDATE SET employee_id=excluded.employee_id,source_session_id=excluded.source_session_id,match_fingerprint=excluded.match_fingerprint,chosen_schedule_id=excluded.chosen_schedule_id,start_fingerprint=excluded.start_fingerprint,end_fingerprint=excluded.end_fingerprint,start_choice=excluded.start_choice,end_choice=excluded.end_choice,reason=excluded.reason,revision=ordexa_pay_decisions.revision+1,commit_nonce=excluded.commit_nonce,updated_at=excluded.updated_at,updated_by=excluded.updated_by`).bind(group.id,group.employeeId,group.sessions[0],p.matchFingerprint,scheduleChoice,startFingerprint,endFingerprint,b.startChoice,b.endChoice||'',reason,1,nonce,stamp,actor.user_id,stamp,actor.user_id,...args),env.DB.prepare("UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision' AND changes()>0")]);
 if(!result[1]?.meta?.changes)throw new D.ApiError(409,'Η βάρδια άλλαξε ή πληρώθηκε σε κλειδωμένη περίοδο. Άνοιξε ξανά τον έλεγχο.');
 try{const updated=await readOrdexaReviewContext(env,group.id);await syncOrdexaPayAlerts(env,updated.groups);return D.wfJson({saved:true,review:publicReview(updated.group)});}catch{return D.wfJson({saved:true,refreshRequired:true,message:'Η απόφαση αποθηκεύτηκε. Πάτησε Ανανέωση για επιβεβαίωση του νέου υπολογισμού.'});}
}
