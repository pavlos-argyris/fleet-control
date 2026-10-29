import {normalizeOrdexaReport,ordexaId,ordexaDay,validateOrdexaPolicy,groupOrdexaSessions,projectOrdexaGroups} from './ordexa-core.js';
import {addCalendarDays} from './workforce-core.js';
import {routeOrdexaPay,resolveOrdexaPayGroups,syncOrdexaPayAlerts,refreshOrdexaPayAlerts} from './ordexa-pay.js';
const now=()=>new Date().toISOString();
const records=r=>r.results||[];
const bad=(D,message,status=400)=>{throw new D.ApiError(status,message);};
const policy=async(env,D)=>JSON.parse(await D.setting(env,'ordexa_policy','{"revision":0,"gapMinutes":null,"gapTreatment":null}'));
const audit=(env,actor,action,id,before,after,reason,stamp,guard='',args=[])=>env.DB.prepare(`INSERT INTO audit_log(id,timestamp,user_id,user_name,role,action,object_type,object_id,old_value,new_value,reason,admin_pin_used)
 SELECT ?,?,?,?,?,?,'ordexa',?,?,?,?,0 ${guard?'WHERE '+guard:''}`).bind(crypto.randomUUID(),stamp,actor.user_id,actor.full_name||actor.username||'',actor.role,action,id,JSON.stringify(before),JSON.stringify(after),reason,...args);
export async function routeOrdexa(request,env,path,D){
 if(!path.startsWith('/api/admin/ordexa')&&!path.startsWith('/api/server/ordexa'))return null;
 const server=path.startsWith('/api/server/ordexa'),method=request.method;
 if(server&&!await D.serverAuthorized(request,env))bad(D,'Μη έγκυρος Server.',401);
 if(!server&&(path==='/api/admin/ordexa/pay-policy'||path==='/api/admin/ordexa/pay-review'))return routeOrdexaPay(request,env,path,D);
 if(server&&path==='/api/server/ordexa/pay-check'&&method==='POST'){const b=await D.bodyJson(request);let from,to;try{from=ordexaDay(b.from);to=ordexaDay(b.to);}catch(e){bad(D,e.message);}if(to<from||Date.parse(to)-Date.parse(from)>=31*86400000)bad(D,'Επίλεξε έως 31 ημέρες ελέγχου.');const result=await refreshOrdexaPayAlerts(env,from,to);return D.wfJson({checked:true,...result});}
 const actor=server?null:await D.authenticate(request,env,'employees.manage');
 if(!server&&method==='POST')await D.requirePin(request,env,D,actor);
 if(server&&path==='/api/server/ordexa/import'&&method==='POST'){
  const body=await D.bodyJson(request);let data;
  try{data=normalizeOrdexaReport(body);}catch(e){bad(D,e.message);}
  if(Date.parse(data.capturedAt)>Date.now()+300000)bad(D,'Η ώρα του Server προηγείται υπερβολικά. Έλεγξε την αυτόματη ώρα Android.');
  const json=JSON.stringify(data);if(new TextEncoder().encode(json).length>1024*1024)bad(D,'Η ημερήσια αναφορά ξεπερνά το ασφαλές όριο.');
  const stamp=now(),id=JSON.stringify([data.city,data.day,data.capturedAt]),nonce=crypto.randomUUID();
  const prior=await env.DB.prepare('SELECT payload,accepted FROM ordexa_imports WHERE id=?').bind(id).first();
  if(prior){if(prior.payload!==json)bad(D,'Η ίδια εισαγωγή έχει διαφορετικά δεδομένα.',409);return D.wfJson({saved:true,replayed:true,accepted:!!prior.accepted});}
  // A single D1 transaction commits receipt, raw revision, labels and current
  // events. Old/missing events are retained and held for explicit review.
  await env.DB.batch([
   env.DB.prepare(`INSERT OR IGNORE INTO ordexa_imports(id,city_id,day,captured_at,received_at,payload,accepted,commit_nonce)
    SELECT ?,?,?,?,?,?,CASE WHEN EXISTS(SELECT 1 FROM ordexa_imports WHERE city_id=? AND day=? AND captured_at>?) THEN 0 ELSE 1 END,?`)
    .bind(id,data.city,data.day,data.capturedAt,stamp,json,data.city,data.day,data.capturedAt,nonce),
   env.DB.prepare(`INSERT INTO ordexa_riders(id,city_id,rider_id,name,updated_at)
    SELECT json_extract(value,'$.id'),json_extract(value,'$.city_id'),json_extract(value,'$.rider_id'),json_extract(value,'$.name'),?
    FROM json_each(?,'$.riders') WHERE (SELECT accepted FROM ordexa_imports WHERE id=? AND commit_nonce=?)=1
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at`).bind(stamp,json,id,nonce),
   env.DB.prepare(`INSERT INTO ordexa_sessions(id,city_id,rider_id,provider_day,in_at,out_at,source_id,raw_json,review,first_seen,last_seen)
    SELECT json_extract(value,'$.id'),json_extract(value,'$.city_id'),json_extract(value,'$.rider_id'),json_extract(value,'$.provider_day'),json_extract(value,'$.in_at'),json_extract(value,'$.out_at'),json_extract(value,'$.source_id'),json_extract(value,'$.raw_json'),json_extract(value,'$.review'),?,?
    FROM json_each(?,'$.rows') WHERE (SELECT accepted FROM ordexa_imports WHERE id=? AND commit_nonce=?)=1
    ON CONFLICT(id) DO UPDATE SET provider_day=excluded.provider_day,in_at=excluded.in_at,out_at=excluded.out_at,raw_json=excluded.raw_json,
     previous_raw_json=CASE WHEN ordexa_sessions.raw_json<>excluded.raw_json THEN ordexa_sessions.raw_json ELSE ordexa_sessions.previous_raw_json END,
     review_reason=CASE WHEN ordexa_sessions.raw_json=excluded.raw_json THEN ordexa_sessions.review_reason WHEN ordexa_sessions.out_at IS NOT NULL OR ordexa_sessions.ignored=1 THEN 'Αλλαγή παλιότερης παρουσίας ή χειροκίνητης απόφασης — έλεγξε τις δύο καταγραφές και τη μισθοδοσία' ELSE '' END,
     review=CASE WHEN ordexa_sessions.raw_json=excluded.raw_json THEN ordexa_sessions.review WHEN ordexa_sessions.ignored=1 OR ordexa_sessions.out_at IS NOT NULL THEN 1 ELSE excluded.review END,
     revision=ordexa_sessions.revision+CASE WHEN ordexa_sessions.raw_json<>excluded.raw_json OR ordexa_sessions.missing_since IS NOT NULL THEN 1 ELSE 0 END,
     last_seen=excluded.last_seen,missing_since=NULL`).bind(data.capturedAt,data.capturedAt,json,id,nonce),
   env.DB.prepare(`UPDATE ordexa_sessions SET missing_since=COALESCE(missing_since,?),review=1,review_reason='Δεν εμφανίζεται στη νεότερη ημερήσια αναφορά. Πιθανή διόρθωση αρχικής εισόδου.',revision=revision+CASE WHEN missing_since IS NULL THEN 1 ELSE 0 END
    WHERE city_id=? AND provider_day=? AND ignored=0 AND last_seen<? AND (SELECT accepted FROM ordexa_imports WHERE id=? AND commit_nonce=?)=1`).bind(data.capturedAt,data.city,data.day,data.capturedAt,id,nonce),
   env.DB.prepare("UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision' AND EXISTS(SELECT 1 FROM ordexa_imports WHERE id=? AND commit_nonce=? AND accepted=1)").bind(id,nonce)
  ]);
  const saved=await env.DB.prepare('SELECT accepted,payload FROM ordexa_imports WHERE id=?').bind(id).first();
  if(saved?.payload!==json)bad(D,'Η ίδια εισαγωγή έχει διαφορετικά δεδομένα.',409);
  return D.wfJson({saved:true,accepted:!!saved?.accepted,rows:data.rows.length,riders:data.riders.length});
 }
 if(!server&&path==='/api/admin/ordexa'&&method==='GET'){
  const url=new URL(request.url);let from,to;
  for(const key of ['from','to','page'])if(url.searchParams.getAll(key).length>1)bad(D,'Η παράμετρος '+key+' δόθηκε περισσότερες από μία φορές.');
  try{from=ordexaDay(url.searchParams.has('from')?url.searchParams.get('from'):now().slice(0,10));to=ordexaDay(url.searchParams.has('to')?url.searchParams.get('to'):from);}catch(e){bad(D,e.message);}
  if(to<from||Date.parse(to)-Date.parse(from)>=31*86400000)bad(D,'Επίλεξε περίοδο έως 31 ημέρες.');
  const pageValue=url.searchParams.has('page')?url.searchParams.get('page'):'0';
  if(!/^(0|[1-9]\d{0,4})$/.test(pageValue)||Number(pageValue)>10000)bad(D,'Η σελίδα πρέπει να είναι ακέραιος από 0 έως 10000.');
  const page=Number(pageValue);
  const [riders,employees,sessions,latest,p,coverage]=await Promise.all([
   env.DB.prepare(`SELECT r.*,u.full_name AS employee_name,u.active AS employee_active FROM ordexa_riders r LEFT JOIN app_users u ON u.id=r.employee_id ORDER BY r.city_id,r.name`).all(),
   env.DB.prepare(`SELECT id,full_name,active FROM app_users WHERE deleted_at IS NULL ORDER BY full_name`).all(),
   env.DB.prepare(`SELECT s.*,r.name,r.employee_id,u.full_name AS employee_name FROM ordexa_sessions s LEFT JOIN ordexa_riders r ON r.city_id=s.city_id AND r.rider_id=s.rider_id LEFT JOIN app_users u ON u.id=r.employee_id WHERE s.provider_day BETWEEN ? AND ? ORDER BY s.in_at,s.id LIMIT 201 OFFSET ?`).bind(from,to,page*200).all(),
   env.DB.prepare('SELECT city_id,day,captured_at,received_at,accepted FROM ordexa_imports ORDER BY received_at DESC LIMIT 10').all(),policy(env,D),
   env.DB.prepare('SELECT city_id,day,MAX(captured_at) AS captured_at FROM ordexa_imports WHERE accepted=1 AND day BETWEEN ? AND ? GROUP BY city_id,day').bind(from,to).all()
  ]);
  const rows=records(sessions);return D.wfJson({riders:records(riders),employees:records(employees),sessions:rows.slice(0,200),hasMore:rows.length>200,page,latest:records(latest),policy:p,coverage:records(coverage)});
 }
 if(!server&&path==='/api/admin/ordexa/mapping'&&method==='POST'){
  const body=await D.bodyJson(request),id=ordexaId(body.cityId,body.riderId),revision=Number(body.revision),employee=body.employeeId||null;
  const before=await env.DB.prepare('SELECT * FROM ordexa_riders WHERE id=?').bind(id).first();if(!before||before.revision!==revision)bad(D,'Η αντιστοίχιση άλλαξε. Κάνε ανανέωση.',409);
  if(employee&&!await env.DB.prepare('SELECT id FROM app_users WHERE id=? AND deleted_at IS NULL').bind(employee).first())bad(D,'Ο εργαζόμενος Fleet δεν βρέθηκε.');
  if(employee&&await env.DB.prepare('SELECT id FROM ordexa_riders WHERE city_id=? AND employee_id=? AND id<>?').bind(before.city_id,employee,id).first())bad(D,'Ο εργαζόμενος έχει ήδη άλλη αντιστοίχιση σε αυτή την πόλη.',409);
  const reason=String(body.reason||'').trim().slice(0,500);if(!reason)bad(D,'Γράψε αιτιολογία για την αντιστοίχιση.');const stamp=now();
  // Compare-and-swap guard in the transaction; no automatic name matching.
  const result=await env.DB.batch([
   env.DB.prepare(`INSERT INTO audit_log(id,timestamp,user_id,user_name,role,action,object_type,object_id,old_value,new_value,reason,admin_pin_used)
    SELECT ?,?,?,?,?, 'ordexa_mapping','ordexa',?,?,?,?,0 WHERE EXISTS(SELECT 1 FROM ordexa_riders WHERE id=? AND revision=?)`)
    .bind(crypto.randomUUID(),stamp,actor.user_id,actor.full_name||'',actor.role,id,JSON.stringify(before),JSON.stringify({employeeId:employee}),reason,id,revision),
   env.DB.prepare('UPDATE ordexa_riders SET employee_id=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').bind(employee,stamp,id,revision),
   env.DB.prepare("UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision' AND changes()>0")
  ]);if(!Number(result[1]?.meta?.changes))bad(D,'Η αντιστοίχιση άλλαξε. Κάνε ανανέωση.',409);
  return D.wfJson({saved:true});
 }
 if(!server&&path==='/api/admin/ordexa/policy'&&method==='POST'){
  await D.authenticate(request,env,'settings.manage');const body=await D.bodyJson(request);let next;try{next=validateOrdexaPolicy(body);}catch(e){bad(D,e.message);}
  const before=await policy(env,D);if(Number(body.revision)!==before.revision)bad(D,'Οι κανόνες άλλαξαν. Κάνε ανανέωση.',409);
  const reason=String(body.reason||'').trim().slice(0,500);if(!reason)bad(D,'Γράψε αιτιολογία κανόνα.');
  const stamp=now(),value=JSON.stringify({...next,revision:before.revision+1});
  const r=await env.DB.batch([
   audit(env,actor,'ordexa_policy','policy',before,next,reason,stamp,"EXISTS(SELECT 1 FROM system_settings WHERE key='ordexa_policy' AND value=?) OR (?=0 AND NOT EXISTS(SELECT 1 FROM system_settings WHERE key='ordexa_policy'))",[JSON.stringify(before),before.revision]),
   env.DB.prepare(`INSERT INTO system_settings(key,value,updated_at,updated_by) VALUES('ordexa_policy',?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by WHERE system_settings.value=?`).bind(value,stamp,actor.user_id,JSON.stringify(before)),
   env.DB.prepare("UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision' AND changes()>0")
  ]);if(!Number(r[1]?.meta?.changes))bad(D,'Οι κανόνες άλλαξαν. Κάνε ανανέωση.',409);return D.wfJson({saved:true});
 }
 if(!server&&path==='/api/admin/ordexa/review'&&method==='POST'){
  const b=await D.bodyJson(request),row=await env.DB.prepare('SELECT * FROM ordexa_sessions WHERE id=?').bind(String(b.id||'')).first();
  if(!row||row.revision!==Number(b.revision))bad(D,'Η παρουσία άλλαξε. Κάνε ανανέωση.',409);
  if(!['accept','ignore'].includes(b.action)||!String(b.reason||'').trim())bad(D,'Διάλεξε απόφαση και αιτιολογία.');
  if(b.action==='accept'&&(!row.out_at||Date.parse(row.out_at)-Date.parse(row.in_at)>24*3600000))bad(D,'Η παρουσία δεν έχει έγκυρη τελική έξοδο.');
  if(b.action==='accept'&&await env.DB.prepare(`SELECT pp.id FROM payroll_snapshots ps JOIN payroll_periods pp ON pp.id=ps.period_id WHERE pp.status='locked' AND (?<pp.start_date OR ?>pp.end_date) AND EXISTS(SELECT 1 FROM json_each(ps.data,'$.sourceRows') sr,json_each(sr.value,'$.sourceSessionIds') si WHERE si.value=?) LIMIT 1`).bind(row.provider_day,row.provider_day,row.id).first())bad(D,'Αυτή η παρουσία έχει ήδη προσμετρηθεί σε άλλη κλειδωμένη περίοδο. Έλεγξε πρώτα την προηγούμενη μισθοδοσία.',409);
  const stamp=now(),reason=String(b.reason).slice(0,500);
  const r=await env.DB.batch([
   audit(env,actor,'ordexa_review',row.id,row,{action:b.action},reason,stamp,'EXISTS(SELECT 1 FROM ordexa_sessions WHERE id=? AND revision=?)',[row.id,row.revision]),
   env.DB.prepare("UPDATE ordexa_sessions SET review=0,ignored=?,missing_since=NULL,review_reason='',decision_reason=?,revision=revision+1 WHERE id=? AND revision=?").bind(b.action==='ignore'?1:0,reason,row.id,row.revision),
   env.DB.prepare("UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision' AND changes()>0")
  ]);if(!Number(r[1]?.meta?.changes))bad(D,'Η παρουσία άλλαξε. Κάνε ανανέωση.',409);return D.wfJson({saved:true});
 }
 bad(D,'Η ενέργεια Ordexa δεν υποστηρίζεται.',404);
}
export async function readOrdexaPayroll(env,bounds,startDate,endDate,setting){
 const revision=await setting(env,'ordexa_revision','0');
 let p;try{p=validateOrdexaPolicy(JSON.parse(await setting(env,'ordexa_policy','null')));}catch{throw new Error('Ρύθμισε πρώτα τους κανόνες κενών Ordexa.');}
 const contextStart=new Date(Date.parse(bounds.start)-86400000).toISOString(),contextEnd=new Date(Date.parse(bounds.end)+86400000).toISOString();
 const [sessions,coverage,cities]=await Promise.all([
  env.DB.prepare(`SELECT s.*,r.employee_id,u.full_name AS employee_name FROM ordexa_sessions s LEFT JOIN ordexa_riders r ON r.city_id=s.city_id AND r.rider_id=s.rider_id LEFT JOIN app_users u ON u.id=r.employee_id WHERE s.in_at>=? AND s.in_at<? ORDER BY s.in_at,s.id LIMIT 100001`).bind(contextStart,contextEnd).all(),
  env.DB.prepare('SELECT DISTINCT city_id,day FROM ordexa_imports WHERE accepted=1 AND day BETWEEN ? AND ?').bind(startDate,endDate).all(),
  env.DB.prepare('SELECT DISTINCT city_id FROM ordexa_riders WHERE employee_id IS NOT NULL').all()
 ]);
 // Provider dates can be corrected independently of timestamps. A session
 // already included in another locked period must never become payable twice.
 const sourceRows=records(sessions);if(sourceRows.length>100000)throw new Error('Πάρα πολλές παρουσίες Ordexa. Επίλεξε μικρότερη περίοδο μισθοδοσίας.');
 const sourceIdsJson=JSON.stringify(sourceRows.map(row=>row.id));if(new TextEncoder().encode(sourceIdsJson).length>1024*1024)throw new Error('Πάρα πολλές παρουσίες Ordexa. Επίλεξε μικρότερη περίοδο μισθοδοσίας.');
 const paid=sourceRows.length?records(await env.DB.prepare(`SELECT DISTINCT si.value AS session_id FROM payroll_snapshots ps JOIN payroll_periods pp ON pp.id=ps.period_id,json_each(ps.data,'$.sourceRows') sr,json_each(sr.value,'$.sourceSessionIds') si WHERE pp.status='locked' AND (pp.start_date<>? OR pp.end_date<>?) AND si.value IN (SELECT value FROM json_each(?))`).bind(startDate,endDate,sourceIdsJson).all()):[];
 const paidIds=new Set(paid.map(r=>r.session_id));
 // Group complete overnight presences before assigning their start date to a
 // payroll period. Midnight is a calendar boundary, never an artificial out.
 const all=groupOrdexaSessions(sourceRows,p),inPeriod=value=>value>=bounds.start&&value<bounds.end;
 const resolved=await resolveOrdexaPayGroups(env,projectOrdexaGroups(sourceRows,p),{paidIds});
 const allGroups=resolved.policy.enabled?resolved.groups.filter(group=>group.eligible):all.groups;
 const selected=allGroups.filter(group=>inPeriod(group.payrollAnchor||group.start)),byId=new Map(sourceRows.map(row=>[row.id,row]));
 const blocked=all.blocked.filter(item=>{const row=byId.get(item.id);if(inPeriod(row.in_at))return true;
  return selected.some(group=>{if(!row.employee_id||row.employee_id!==group.employeeId)return false;
   const before=(Date.parse(group.start)-Date.parse(row.out_at||row.in_at))/60000,after=(Date.parse(row.in_at)-Date.parse(group.end))/60000;
   return (before>=0&&before<=p.gapMinutes)||(after>=0&&after<=p.gapMinutes)||(row.in_at<group.end&&(!row.out_at||row.out_at>group.start));});});
 const grouped={groups:selected.filter(group=>!group.sessions.some(id=>paidIds.has(id))&&(!group.payResolution||group.payResolution.paidEnd>=group.payResolution.paidStart)),blocked},coverageSet=new Set(records(coverage).map(r=>r.city_id+'|'+r.day));
 const reviews=resolved.reviews.filter(review=>{const group=resolved.groups.find(g=>g.id===review.id);return inPeriod(group.payrollAnchor||group.start);});
 for(const review of reviews)grouped.blocked.push({id:review.id,reason:'Χρειάζεται απόφαση μισθοδοσίας: '+review.reasons.map(r=>r.message).join(' · ')});
 for(const group of selected)for(const id of group.sessions)if(paidIds.has(id))grouped.blocked.push({id,reason:'Η παρουσία έχει ήδη προσμετρηθεί σε άλλη κλειδωμένη μισθοδοσία.'});
 for(const city of records(cities))for(let d=Date.parse(startDate+'T00:00:00Z');d<=Date.parse(endDate+'T00:00:00Z');d+=86400000){const day=new Date(d).toISOString().slice(0,10);if(!coverageSet.has(city.city_id+'|'+day))grouped.blocked.push({id:city.city_id+'|'+day,reason:'Λείπει ημερήσιος συγχρονισμός'});}
 if(!records(cities).length)grouped.blocked.push({reason:'Δεν υπάρχουν αντιστοιχισμένοι εργαζόμενοι Ordexa.'});
 if(revision!==await setting(env,'ordexa_revision','0'))throw new Error('Οι παρουσίες Ordexa άλλαξαν στη διάρκεια του υπολογισμού. Κάνε ανανέωση.');
 if(resolved.policy.enabled)await syncOrdexaPayAlerts(env,resolved.groups);
 return {...grouped,policy:p,payPolicy:resolved.policy,reviews,revision,rows:grouped.groups.map(g=>({id:g.id,employee_id:g.employeeId,full_name:g.employeeName,start_at:g.payResolution?.paidStart||g.start,end_at:g.payResolution?.paidEnd||g.end,raw_start_at:g.start,raw_end_at:g.end,status:'completed',ordexa:g}))};
}

// A read-only projection for the ordinary shifts screen. Payroll remains the
// sole authority for payment/locks; nothing is inserted into Fleet shifts.
export async function readOrdexaShiftList(env,bounds,from,to,D){
 const revision=await D.setting(env,'ordexa_revision','0');let p=null;
 try{p=validateOrdexaPolicy(JSON.parse(await D.setting(env,'ordexa_policy','null')));}catch{}
 // A grouped presence lasts at most 24 hours. Read context on both sides so
 // a midnight date filter cannot lose the first/last part of the same shift.
 const contextStart=new Date(Date.parse(bounds.start)-86400000).toISOString(),contextEnd=new Date(Date.parse(bounds.end)+86400000).toISOString();
 const result=await env.DB.prepare(`SELECT s.*,r.name,r.employee_id,u.full_name AS employee_name,u.pay_rule_id,u.employee_group
  FROM ordexa_sessions s LEFT JOIN ordexa_riders r ON r.city_id=s.city_id AND r.rider_id=s.rider_id
  LEFT JOIN app_users u ON u.id=r.employee_id
  WHERE s.in_at>=? AND s.in_at<? ORDER BY s.in_at,s.id LIMIT 10001`).bind(contextStart,contextEnd).all();
 const rows=records(result);if(rows.length>10000)throw new D.ApiError(413,'Πολλές παρουσίες Ordexa. Επίλεξε μικρότερο διάστημα για πλήρη προβολή.');
 const projected=projectOrdexaGroups(rows,p);await resolveOrdexaPayGroups(env,projected);
 const visible=projected.filter(group=>{
  if(D.employeeId&&group.employeeId!==D.employeeId)return false;
  if(D.status&&D.status!==(group.end?'completed':'active'))return false;
  if(group.start>=bounds.end)return false;
  return D.overlap?(!group.end||group.end>bounds.start||(group.end===group.start&&group.start>=bounds.start)):group.start>=bounds.start;
 });
 const ids=visible.flatMap(group=>group.sessions);
 const idsJson=JSON.stringify(ids);if(new TextEncoder().encode(idsJson).length>1024*1024)throw new D.ApiError(413,'Πολλές παρουσίες Ordexa. Επίλεξε μικρότερο διάστημα για πλήρη προβολή.');
 const paid=ids.length?records(await env.DB.prepare(`SELECT DISTINCT si.value AS id FROM payroll_snapshots ps JOIN payroll_periods pp ON pp.id=ps.period_id,
  json_each(ps.data,'$.sourceRows') sr,json_each(sr.value,'$.sourceSessionIds') si
  WHERE pp.status='locked' AND si.value IN (SELECT value FROM json_each(?))`).bind(idsJson).all()):[];
 const paidIds=new Set(paid.map(row=>row.id));
 const candidates=visible.filter(group=>group.eligible&&!group.sessions.some(id=>paidIds.has(id))&&(!group.payResolution||group.payResolution.paidEnd>=group.payResolution.paidStart));
 const calculated=candidates.length?await D.calculate(candidates.map(group=>({id:group.id,employee_id:group.employeeId,full_name:group.employeeName,
  pay_rule_id:group.raw[0].pay_rule_id,employee_group:group.raw[0].employee_group,start_at:group.payResolution?.paidStart||group.start,end_at:group.payResolution?.paidEnd||group.end,raw_start_at:group.start,raw_end_at:group.end,
  excludedIntervals:group.payResolution?[]:p.gapTreatment==='exclude'?group.gaps:[],ordexa:group})),addCalendarDays(from,-1),addCalendarDays(to,1)):[];
 const payById=new Map(calculated.map(row=>[row.id,row]));
 const shifts=visible.map(group=>{
  const raw=group.raw[0],locked=group.sessions.some(id=>paidIds.has(id)),pay=payById.get(group.id),notes=[];
  if(!group.employeeId)notes.push('Χωρίς αντιστοίχιση εργαζομένου');
  if(group.raw.some(row=>Number(row.ignored)))notes.push('Δεν προσμετράται');
  if(group.raw.some(row=>Number(row.review)||row.missing_since))notes.push('Χρειάζεται έλεγχος παρουσίας');
  if(!p)notes.push('Δεν έχουν οριστεί κανόνες κενών');
  if(!group.end)notes.push('Εκκρεμεί τελικό Clock Out');
  if(locked)notes.push('Κλειδωμένη μισθοδοσία — δες την αποθηκευμένη περίοδο');
  if(group.payResolution?.unresolved.length)notes.push('Εκκρεμεί απόφαση μισθοδοσίας');
  return {id:group.id,source:'ordexa',employeeId:group.employeeId||null,employeeName:group.employeeName||raw.name||'Χωρίς αντιστοίχιση',
   providerName:[...new Set(group.raw.map(row=>row.name||row.rider_id))].join(' · '),vehicleId:null,vehicleName:'',ownVehicle:false,
   status:group.end?'completed':'active',actualClockIn:group.start,actualClockOut:group.end||null,
   payableHours:pay?Math.round(pay.payable_minutes/60*100)/100:null,payableClockIn:pay?.payable_clock_in||null,payableClockOut:pay?.payable_clock_out||null,
   payablePreview:!!pay,payrollLocked:locked,payReviewId:group.payResolution?.unresolved.length?group.id:null,sourceSessionIds:group.sessions,sourceSessionCount:group.sessions.length,
   sourceNotes:notes,lastSourceRead:group.raw.map(row=>row.last_seen).sort().at(-1)};
 });
 if(revision!==await D.setting(env,'ordexa_revision','0'))throw new D.ApiError(409,'Οι παρουσίες Ordexa άλλαξαν. Κάνε ανανέωση.');
 return {shifts,info:{policyConfigured:!!p,readOnly:true}};
}
