import {list,reply,NativeError,actor,audit,text,day,addDay,integer,hash,stamp} from './common.js';
import {ORDEXA_SERVER_VERSION} from '../cloudflare-worker/src/ordexa-server.js';
export const REVIEW_SCHEMA=`
CREATE TABLE IF NOT EXISTS native_payroll_reviews(id TEXT PRIMARY KEY,week_start TEXT NOT NULL,subject_id TEXT NOT NULL,fingerprint TEXT NOT NULL,revision INTEGER NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('keep','reopen')),notes TEXT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(week_start,subject_id,revision));
CREATE TRIGGER IF NOT EXISTS native_payroll_reviews_no_update BEFORE UPDATE ON native_payroll_reviews BEGIN SELECT RAISE(ABORT,'payroll_review_is_versioned'); END;
CREATE TRIGGER IF NOT EXISTS native_payroll_reviews_no_delete BEFORE DELETE ON native_payroll_reviews BEGIN SELECT RAISE(ABORT,'payroll_review_is_versioned'); END;
`;
const monday=value=>{day(value);return addDay(value,-((new Date(value+'T12:00:00Z').getUTCDay()+6)%7));};
export async function payrollQueue(env,week){
  week=monday(week);
  const view=await env.DB.prepare('SELECT payload,input_revision,input_epoch,engine_version,source_synced_at,computed_at FROM ordexa_server_views WHERE week_start=?').bind(week).first();
  if(!view?.payload){await env.DB.prepare('INSERT INTO ordexa_server_views(week_start,requested_at) VALUES(?,?) ON CONFLICT(week_start) DO UPDATE SET requested_at=excluded.requested_at').bind(week,stamp()).run();return{week,rows:[],pending:true,sourceFresh:false};}
  const payload=JSON.parse(view.payload);if(!Array.isArray(payload.shifts))throw new NativeError(503,'Δεν υπάρχει συμβατή προβολή βαρδιών για έλεγχο.');
  const revision=await env.DB.prepare("SELECT value FROM system_settings WHERE key='ordexa_revision'").first(),policy=list(await env.DB.prepare("SELECT key,value FROM system_settings WHERE key IN ('ordexa_policy','ordexa_pay_policy','timezone') ORDER BY key").all());
  const epoch=await env.DB.prepare("SELECT epoch||':'||COALESCE((SELECT value FROM fleet_settings WHERE key='ordexa_server_generation'),'') epoch FROM fleet_mirror_state WHERE id=1").first();
  const fresh=String(revision?.value||'0')===String(view.input_revision)&&epoch?.epoch===view.input_epoch&&view.engine_version===ORDEXA_SERVER_VERSION,blockers=payload.payroll?.blockers||[],rows=[];
  const decisions=list(await env.DB.prepare('SELECT * FROM native_payroll_reviews WHERE week_start=? ORDER BY revision DESC').bind(week).all()),latest=new Map();for(const decision of decisions)if(!latest.has(decision.subject_id))latest.set(decision.subject_id,decision);
  for(const shift of payload.shifts){
    if(shift.payrollLocked)continue;
    const reasons=Array.isArray(shift.reasons)?[...shift.reasons]:[];
    if(shift.outOfSchedule)reasons.push('Εκτός προγράμματος - οι έγκυρες ώρες παραμένουν πληρωτέες.');
    if(shift.sourceSessions?.length>1)reasons.push('Περισσότερα από ένα clock in/out - έλεγξε τα επιμέρους διαστήματα.');
    if(!reasons.length)continue;
    const blocking=blockers.some(b=>b.id===shift.id),fingerprint=await hash({id:shift.id,employeeId:shift.employeeId,source:shift.fingerprint,start:shift.startFingerprint,end:shift.endFingerprint,adjustmentRevision:shift.adjustmentRevision,paidStart:shift.payableClockIn,paidEnd:shift.payableClockOut,night00:shift.night00Mode,night01:shift.night01Mode,reasons,policy,epoch:view.input_epoch});
    const decision=latest.get(shift.id),reviewed=decision?.fingerprint===fingerprint&&decision.decision==='keep';
    rows.push({id:shift.id,employeeId:shift.employeeId,employeeName:shift.employeeName,day:shift.workDate,actualStart:shift.actualClockIn,actualEnd:shift.actualClockOut,schedule:shift.schedule,payableStart:shift.payableClockIn,payableEnd:shift.payableClockOut,payableMinutes:shift.payableMinutes,totalPayCents:shift.totalPayCents,reasons:[...new Set(reasons)],blocking,reviewed,fingerprint,revision:Number(decision?.revision||0),decision:reviewed?{actor:decision.actor_name,at:decision.created_at,notes:decision.notes}:null,canKeep:fresh&&!shift.active&&!shift.sourcePending&&!!shift.employeeId,shift});
  }
  for(const missing of payload.dashboard?.missingClockIns||[]){
    const employeeId=missing.employeeId||missing.employee_id,workDate=missing.workDate||missing.day||week;if(!employeeId)continue;
    const id='missing:'+employeeId+':'+workDate,fingerprint=await hash({id,missing,policy,epoch:view.input_epoch}),decision=latest.get(id),reviewed=decision?.fingerprint===fingerprint&&decision.decision==='keep';
    rows.push({id,employeeId,employeeName:missing.employeeName||missing.fullName||employeeId,day:workDate,reasons:['Δεν έχει καταγραφεί αναμενόμενο clock in. Δεν προστέθηκαν τεχνητές ώρες.'],blocking:false,reviewed,fingerprint,revision:Number(decision?.revision||0),canKeep:fresh,missingClockIn:true,decision:reviewed?{actor:decision.actor_name,at:decision.created_at,notes:decision.notes}:null});
  }
  return{week,pending:false,sourceFresh:fresh,computedAt:view.computed_at,sourceSyncedAt:view.source_synced_at,rows:rows.sort((a,b)=>a.day.localeCompare(b.day)||a.employeeName.localeCompare(b.employeeName)),unreviewed:rows.filter(r=>!r.reviewed).length,blocking:rows.filter(r=>r.blocking).length};
}
export async function routePayrollReview(request,env,dispatch){
  const url=new URL(request.url);if(url.pathname!=='/api/native/payroll-review')return null;
  const user=await actor(request,env,request.method==='GET'?'payroll.view':'payroll.manage');
  if(request.method==='GET'){const result=await payrollQueue(env,url.searchParams.get('week'));return reply({...result,rows:result.rows.map(({shift,...row})=>row)});}
  if(request.method==='POST'){
    const b=await request.json(),week=monday(b.week),queue=await payrollQueue(env,week),row=queue.rows.find(r=>r.id===b.id),notes=text(b.notes,500),expected=integer(b.expectedRevision);
    if(!row||row.fingerprint!==b.fingerprint||row.revision!==expected||!queue.sourceFresh)throw new NativeError(409,'Άλλαξαν οι πηγές, ο κανόνας ή η απόφαση. Το προσχέδιο διατηρήθηκε. Άνοιξε ξανά τον έλεγχο.','review_conflict');
    if(!['keep','reopen'].includes(b.decision)||!notes)throw new NativeError(400,'Επίλεξε απόφαση και γράψε σύντομη αιτιολογία.');
    if(b.decision==='keep'&&!row.canKeep)throw new NativeError(409,'Η παρουσία είναι ενεργή, εκκρεμεί έξοδος ή χρειάζεται αντιστοίχιση εργαζομένου. Χρησιμοποίησε την αντίστοιχη ενέργεια.');
    if(b.decision==='keep'&&row.blocking){
      const s=row.shift,body={id:s.id,weekStart:week,fingerprint:s.fingerprint,revision:s.adjustmentRevision,paidStart:s.payableClockIn,paidEnd:s.payableClockOut,night00Mode:s.night00Mode||'auto',night01Mode:s.night01Mode||'auto',notes:'Ελέγχθηκε / διατηρείται: '+notes};
      const adjusted=await dispatch(new Request(new URL('/api/admin/ordexa-server/adjustment',request.url),{method:'POST',headers:request.headers,body:JSON.stringify(body)}));
      if(!adjusted.ok)return adjusted;
    }
    const id=crypto.randomUUID(),at=stamp();
    await env.DB.prepare('INSERT INTO native_payroll_reviews(id,week_start,subject_id,fingerprint,revision,decision,notes,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,week,row.id,row.fingerprint,expected+1,b.decision,notes,user.user_id,user.full_name||user.username,at).run();
    await audit(env,request,user,'payroll_review_'+b.decision,'payroll_review',row.id,null,{week,fingerprint:row.fingerprint,revision:expected+1,decision:b.decision,paymentDecisionApplied:row.blocking&&b.decision==='keep'},notes);
    return reply({saved:true,revision:expected+1,paymentDecisionApplied:row.blocking&&b.decision==='keep',awaitingServer:row.blocking&&b.decision==='keep'});
  }
  throw new NativeError(405,'Η ενέργεια ελέγχου δεν υποστηρίζεται.');
}
