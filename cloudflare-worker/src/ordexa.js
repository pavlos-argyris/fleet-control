import {normalizeOrdexaReport,ordexaId,ordexaDay,validateOrdexaPolicy,groupOrdexaSessions} from './ordexa-core.js';
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
  const url=new URL(request.url),from=ordexaDay(url.searchParams.get('from')||now().slice(0,10)),to=ordexaDay(url.searchParams.get('to')||from);
  if(to<from||Date.parse(to)-Date.parse(from)>31*86400000)bad(D,'Επίλεξε περίοδο έως 31 ημέρες.');
  const page=Math.max(0,Math.min(10000,Number(url.searchParams.get('page'))||0));
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
 const [sessions,coverage,cities]=await Promise.all([
  env.DB.prepare(`SELECT s.*,r.employee_id,u.full_name AS employee_name FROM ordexa_sessions s LEFT JOIN ordexa_riders r ON r.city_id=s.city_id AND r.rider_id=s.rider_id LEFT JOIN app_users u ON u.id=r.employee_id WHERE s.in_at>=? AND s.in_at<? ORDER BY s.in_at,s.id`).bind(bounds.start,bounds.end).all(),
  env.DB.prepare('SELECT DISTINCT city_id,day FROM ordexa_imports WHERE accepted=1 AND day BETWEEN ? AND ?').bind(startDate,endDate).all(),
  env.DB.prepare('SELECT DISTINCT city_id FROM ordexa_riders WHERE employee_id IS NOT NULL').all()
 ]);
 const grouped=groupOrdexaSessions(records(sessions),p),coverageSet=new Set(records(coverage).map(r=>r.city_id+'|'+r.day));
 for(const city of records(cities))for(let d=Date.parse(startDate+'T00:00:00Z');d<=Date.parse(endDate+'T00:00:00Z');d+=86400000){const day=new Date(d).toISOString().slice(0,10);if(!coverageSet.has(city.city_id+'|'+day))grouped.blocked.push({id:city.city_id+'|'+day,reason:'Λείπει ημερήσιος συγχρονισμός'});}
 if(!records(cities).length)grouped.blocked.push({reason:'Δεν υπάρχουν αντιστοιχισμένοι εργαζόμενοι Ordexa.'});
 if(revision!==await setting(env,'ordexa_revision','0'))throw new Error('Οι παρουσίες Ordexa άλλαξαν στη διάρκεια του υπολογισμού. Κάνε ανανέωση.');
 return {...grouped,policy:p,revision,rows:grouped.groups.map(g=>({id:g.id,employee_id:g.employeeId,full_name:g.employeeName,start_at:g.start,end_at:g.end,status:'completed',ordexa:g}))};
}
