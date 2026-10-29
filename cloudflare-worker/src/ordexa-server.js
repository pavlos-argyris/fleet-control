import {ordexaDay} from './ordexa-core.js';
import {addCalendarDays,localDate,zonedLocalToUtc} from './workforce-core.js';

export const ORDEXA_SERVER_VERSION=1;
export const ORDEXA_SERVER_SCHEMA=`
CREATE TABLE IF NOT EXISTS ordexa_shift_adjustments (
 id TEXT PRIMARY KEY,employee_id TEXT NOT NULL,source_fingerprint TEXT NOT NULL,start_fingerprint TEXT NOT NULL DEFAULT '',end_fingerprint TEXT NOT NULL DEFAULT '',
 paid_start TEXT,paid_end TEXT,night_00_mode TEXT NOT NULL DEFAULT 'auto',night_01_mode TEXT NOT NULL DEFAULT 'auto',
 acknowledged INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL,updated_by TEXT NOT NULL,updated_by_name TEXT NOT NULL,notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS ordexa_server_views (
 week_start TEXT PRIMARY KEY,requested_at TEXT NOT NULL,lease_token TEXT,lease_until TEXT,
 input_revision TEXT,input_epoch TEXT,computed_at TEXT,source_synced_at TEXT,
 payload TEXT,payload_hash TEXT,publication_token TEXT,sequence INTEGER NOT NULL DEFAULT 0,engine_version INTEGER NOT NULL DEFAULT 1
);
`;
export const ORDEXA_ADJUSTMENT_COLUMNS=['id','employee_id','source_fingerprint','start_fingerprint','end_fingerprint','paid_start','paid_end','night_00_mode','night_01_mode','acknowledged','revision','updated_at','updated_by','updated_by_name','notes'];
export const ORDEXA_SOURCE_TRIGGERS=[
 ...['schedules','payroll_adjustments'].flatMap(table=>['INSERT','UPDATE','DELETE'].map(event=>`CREATE TRIGGER IF NOT EXISTS ordexa_source_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision'; END;`)),
 ...['INSERT','DELETE'].map(event=>`CREATE TRIGGER IF NOT EXISTS ordexa_source_vehicle_${event.toLowerCase()} AFTER ${event} ON vehicle_registry BEGIN UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision'; END;`),
 `CREATE TRIGGER IF NOT EXISTS ordexa_source_vehicle_update AFTER UPDATE OF name,status ON vehicle_registry WHEN OLD.name IS NOT NEW.name OR OLD.status IS NOT NEW.status BEGIN UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision'; END;`,
 `CREATE TRIGGER IF NOT EXISTS ordexa_source_employee_update AFTER UPDATE OF full_name,active,deleted_at,uses_own_vehicle,assigned_vehicle_id ON app_users WHEN OLD.full_name IS NOT NEW.full_name OR OLD.active IS NOT NEW.active OR OLD.deleted_at IS NOT NEW.deleted_at OR OLD.uses_own_vehicle IS NOT NEW.uses_own_vehicle OR OLD.assigned_vehicle_id IS NOT NEW.assigned_vehicle_id BEGIN UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision'; END;`,
 `CREATE TRIGGER IF NOT EXISTS ordexa_source_employee_insert AFTER INSERT ON app_users BEGIN UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision'; END;`,
 `CREATE TRIGGER IF NOT EXISTS ordexa_source_employee_delete AFTER DELETE ON app_users BEGIN UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision'; END;`,
 `CREATE TRIGGER IF NOT EXISTS ordexa_source_period_update AFTER UPDATE OF status ON payroll_periods WHEN OLD.status<>NEW.status BEGIN UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision'; END;`,
 `CREATE TRIGGER IF NOT EXISTS ordexa_source_snapshot_delete AFTER DELETE ON payroll_snapshots BEGIN UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision'; END;`,
 `CREATE TRIGGER IF NOT EXISTS ordexa_source_settings_update AFTER UPDATE OF value ON system_settings WHEN NEW.key IN ('timezone','ordexa_policy','ordexa_pay_policy') AND OLD.value<>NEW.value BEGIN UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision'; END;`
].join('\n');

const records=r=>r.results||[],stamp=()=>new Date().toISOString();
const rawJson=(value,status=200)=>new Response(value,{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const fail=(D,status,message)=>{throw new D.ApiError(status,message);};
const setting=async(env,key,fallback='')=>(await env.DB.prepare('SELECT value FROM system_settings WHERE key=?').bind(key).first())?.value??fallback;
const monday=day=>{ordexaDay(day);return addCalendarDays(day,-((new Date(day+'T12:00:00Z').getUTCDay()+6)%7));};
async function head(env){const [revision,epoch,zone]=await Promise.all([setting(env,'ordexa_revision','0'),env.DB.prepare('SELECT epoch FROM fleet_mirror_state WHERE id=1').first(),setting(env,'timezone','Europe/Athens')]);return {revision:String(revision),epoch:epoch?.epoch||'',timeZone:zone,serverTime:stamp(),engineVersion:ORDEXA_SERVER_VERSION};}
async function demand(env,week){await env.DB.prepare('INSERT INTO ordexa_server_views(week_start,requested_at) VALUES(?,?) ON CONFLICT(week_start) DO UPDATE SET requested_at=excluded.requested_at WHERE ordexa_server_views.requested_at<?').bind(week,stamp(),new Date(Date.now()-30000).toISOString()).run();}
const sourceGuard="EXISTS(SELECT 1 FROM system_settings WHERE key='ordexa_revision' AND value=?) AND EXISTS(SELECT 1 FROM fleet_mirror_state WHERE id=1 AND epoch=?)";
async function view(env,week,section,D){
 await demand(env,week);const meta=await head(env);
 const row=await env.DB.prepare(`SELECT input_revision,input_epoch,computed_at,source_synced_at,sequence,payload_hash,json_extract(payload,?) AS data FROM ordexa_server_views WHERE week_start=?`).bind('$.'+section,week).first();
 const fresh=!!row?.data&&row.input_revision===meta.revision&&row.input_epoch===meta.epoch&&Date.now()-Date.parse(row.computed_at)<180000;
 const sourceFresh=!!row?.source_synced_at&&Date.now()-Date.parse(row.source_synced_at)<180000;
 const info={...meta,computedAt:row?.computed_at||null,sourceSyncedAt:row?.source_synced_at||null,sequence:Number(row?.sequence||0),fresh,sourceFresh,waiting:!fresh,readOnly:!fresh||!sourceFresh,weekStart:week};
 return {row,info,json:row?.data||null};
}
async function inputPage(request,env,url,D){
 const week=monday(url.searchParams.get('week')),table=url.searchParams.get('table')||'',meta=await head(env),cursor=Number(url.searchParams.get('cursor')||0);
 if(!Number.isSafeInteger(cursor)||cursor<0)fail(D,400,'Μη έγκυρη συνέχεια εισόδων.');
 const lease=url.searchParams.get('lease')||'';
 if(!await env.DB.prepare('SELECT 1 ok FROM ordexa_server_views WHERE week_start=? AND lease_token=? AND lease_until>?').bind(week,lease,stamp()).first())fail(D,409,'Η άδεια υπολογισμού έληξε.');
 if(!table)return D.wfJson({...meta,weekStart:week,endDate:addCalendarDays(week,6),tables:['employees','riders','sessions','schedules','settings','adjustments','payrollAdjustments','vehicles','paid','coverage']});
 if(url.searchParams.get('revision')!==meta.revision||url.searchParams.get('epoch')!==meta.epoch)fail(D,409,'Οι είσοδοι άλλαξαν. Επανάλαβε τον υπολογισμό.');
 const lower=zonedLocalToUtc(addCalendarDays(week,-1),'00:00',meta.timeZone),upper=zonedLocalToUtc(addCalendarDays(week,8),'00:00',meta.timeZone);
 const specs={
  employees:["SELECT rowid _cursor,id,full_name,active,deleted_at,uses_own_vehicle,assigned_vehicle_id FROM app_users WHERE rowid>? ORDER BY rowid LIMIT 101",[cursor]],
  riders:["SELECT rowid _cursor,id,city_id,rider_id,name,employee_id,revision FROM ordexa_riders WHERE rowid>? ORDER BY rowid LIMIT 101",[cursor]],
  sessions:["SELECT rowid _cursor,id,city_id,rider_id,in_at,out_at,provider_day,review,ignored,revision,missing_since,review_reason,last_seen FROM ordexa_sessions WHERE rowid>? AND in_at>=? AND in_at<? ORDER BY rowid LIMIT 101",[cursor,lower,upper]],
  schedules:["SELECT rowid _cursor,id,employee_id,vehicle_id,start_at,end_at,status FROM schedules WHERE rowid>? AND start_at<? AND end_at>? AND status<>'cancelled' ORDER BY rowid LIMIT 101",[cursor,upper,lower]],
  settings:["SELECT rowid _cursor,key,value FROM system_settings WHERE rowid>? AND key IN ('timezone','ordexa_policy','ordexa_pay_policy') ORDER BY rowid LIMIT 101",[cursor]],
  adjustments:["SELECT rowid _cursor,* FROM ordexa_shift_adjustments WHERE rowid>? AND id IN(SELECT 'ordexa:'||id FROM ordexa_sessions WHERE in_at>=? AND in_at<?) ORDER BY rowid LIMIT 101",[cursor,lower,upper]],
  payrollAdjustments:["SELECT pa.rowid _cursor,pa.* FROM payroll_adjustments pa JOIN payroll_periods pp ON pp.id=pa.period_id WHERE pa.rowid>? AND pp.start_date=? AND pp.end_date=? ORDER BY pa.rowid LIMIT 101",[cursor,week,addCalendarDays(week,6)]],
  vehicles:["SELECT rowid _cursor,bike_id,name,status FROM vehicle_registry WHERE rowid>? ORDER BY rowid LIMIT 101",[cursor]],
  coverage:["SELECT MIN(rowid) _cursor,city_id,day,MAX(captured_at) captured_at FROM ordexa_imports WHERE accepted=1 AND day BETWEEN ? AND ? GROUP BY city_id,day HAVING MIN(rowid)>? ORDER BY MIN(rowid) LIMIT 101",[week,addCalendarDays(week,6),cursor]],
  paid:[`SELECT * FROM (SELECT ROW_NUMBER() OVER(ORDER BY ps.id,sr.key) _cursor,pp.start_date,pp.end_date,sr.value source_row FROM payroll_snapshots ps JOIN payroll_periods pp ON pp.id=ps.period_id,json_each(ps.data,'$.sourceRows') sr WHERE pp.status='locked' AND EXISTS(SELECT 1 FROM json_each(sr.value,'$.sourceSessionIds') si WHERE si.value IN(SELECT id FROM ordexa_sessions WHERE in_at>=? AND in_at<?))) WHERE _cursor>? ORDER BY _cursor LIMIT 101`,[lower,upper,cursor]]
 };
 const spec=specs[table];if(!spec)fail(D,400,'Άγνωστη κατηγορία εισόδων.');
 const rows=records(await env.DB.prepare(spec[0]).bind(...spec[1]).all());
 const after=await head(env);if(after.revision!==meta.revision||after.epoch!==meta.epoch)fail(D,409,'Οι είσοδοι άλλαξαν κατά την ανάγνωση.');
 return D.wfJson({rows:rows.slice(0,100),hasMore:rows.length>100,nextCursor:rows.length?rows[Math.min(rows.length,100)-1]._cursor:cursor,...meta});
}
async function control(request,env,D){
 const b=await D.bodyJson(request),week=monday(b.week),meta=await head(env);await demand(env,week);
 const jobs=records(await env.DB.prepare(`SELECT week_start,computed_at,input_revision,input_epoch FROM ordexa_server_views WHERE week_start=? OR (requested_at>? AND (payload IS NULL OR input_revision<>? OR input_epoch<>? OR computed_at<? OR source_synced_at<?)) ORDER BY CASE WHEN week_start=? THEN 0 ELSE 1 END,requested_at DESC LIMIT 4`).bind(week,new Date(Date.now()-300000).toISOString(),meta.revision,meta.epoch,new Date(Date.now()-120000).toISOString(),new Date(Date.now()-120000).toISOString(),week).all());
 const result=[];for(const job of jobs){const token=crypto.randomUUID(),until=new Date(Date.now()+240000).toISOString();const saved=await env.DB.prepare('UPDATE ordexa_server_views SET lease_token=?,lease_until=? WHERE week_start=? AND (lease_until IS NULL OR lease_until<?)').bind(token,until,job.week_start,stamp()).run();if(saved.meta?.changes)result.push({weekStart:job.week_start,lease:token});}
 return D.wfJson({...meta,jobs:result});
}
async function publish(request,env,D){
 // Native uploads carry their small envelope separately. The Worker stores
 // the already-serialized result; it never parses/rebuilds the entire week.
 const envelope=request.headers.get('X-Fleet-Projection');if(envelope?.length>2048)fail(D,400,'Μεγάλη κεφαλίδα υπολογισμού.');
 let b;try{b=envelope?JSON.parse(envelope):await D.bodyJson(request);}catch{fail(D,400,'Μη έγκυρη κεφαλίδα υπολογισμού.');}
 const week=monday(b.weekStart),meta=await head(env),computedAt=stamp(),nonce=crypto.randomUUID();
 if(b.revision!==meta.revision||b.epoch!==meta.epoch)fail(D,409,'Οι είσοδοι άλλαξαν πριν από την αποθήκευση.');
 if(!b.lease||Number(b.engineVersion)!==ORDEXA_SERVER_VERSION)fail(D,400,'Μη συμβατή έκδοση υπολογισμού.');
 const synced=Date.parse(b.sourceSyncedAt);if(!Number.isFinite(synced)||synced>Date.now()+120000)fail(D,400,'Μη έγκυρη ώρα συγχρονισμού.');const sourceSyncedAt=new Date(synced).toISOString();
 let payload=envelope?await request.text():b.payload?JSON.stringify(b.payload):null,hash=b.payloadHash;
 if(payload!==null){const bytes=new TextEncoder().encode(payload);if(bytes.length>1048576)fail(D,413,'Η προβολή ξεπερνά το όριο μεγέθους.');hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(n=>n.toString(16).padStart(2,'0')).join('');
 }
 if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))fail(D,400,'Μη έγκυρο αποτύπωμα προβολής.');
 const operations=[env.DB.prepare(`WITH incoming(data) AS (SELECT ?) UPDATE ordexa_server_views SET payload=COALESCE((SELECT data FROM incoming),payload),payload_hash=?,publication_token=?,input_revision=?,input_epoch=?,computed_at=?,source_synced_at=?,sequence=sequence+1,lease_token=NULL,lease_until=NULL WHERE week_start=? AND lease_token=? AND lease_until>? AND ((SELECT data FROM incoming) IS NOT NULL OR payload_hash=?) AND ${sourceGuard} AND (SELECT CASE WHEN data IS NULL THEN 1 WHEN json_valid(data) THEN json_type(data,'$.shifts')='array' AND json_array_length(data,'$.shifts')<=5000 AND json_type(data,'$.reviews')='array' AND json_array_length(data,'$.reviews')<=1000 AND json_type(data,'$.payroll.employees')='array' AND json_array_length(data,'$.payroll.employees')<=1000 AND json_type(data,'$.payroll.blockers')='array' AND json_extract(data,'$.payroll.period.startDate')=? AND json_type(data,'$.dashboard')='object' ELSE 0 END FROM incoming)`).bind(payload,hash,nonce,meta.revision,meta.epoch,computedAt,sourceSyncedAt,week,b.lease,computedAt,hash,meta.revision,meta.epoch,week)];
 if(payload!==null){
  operations.push(env.DB.prepare(`INSERT INTO system_alerts(id,type,severity,title,message,object_type,object_id,dedupe_key,resolved,created_at) SELECT 'ordexa-server:'||v.week_start||':'||json_extract(r.value,'$.id'),'ordexa_server_review','warning','Έλεγχος βάρδιας · '||json_extract(r.value,'$.employeeName'),substr((SELECT group_concat(value,' · ') FROM json_each(r.value,'$.reasons')),1,1000),'ordexa_server_review',json_extract(r.value,'$.id'),'ordexa-server:'||v.week_start||':'||json_extract(r.value,'$.id'),0,? FROM ordexa_server_views v,json_each(v.payload,'$.reviews') r WHERE v.week_start=? AND v.publication_token=? ON CONFLICT(dedupe_key) DO UPDATE SET title=excluded.title,message=excluded.message,resolved=0,resolved_at=NULL WHERE system_alerts.resolved<>0 OR system_alerts.message<>excluded.message OR system_alerts.title<>excluded.title`).bind(computedAt,week,nonce));
  operations.push(env.DB.prepare(`UPDATE system_alerts SET resolved=1,resolved_at=? WHERE type='ordexa_server_review' AND resolved=0 AND dedupe_key LIKE ? AND EXISTS(SELECT 1 FROM ordexa_server_views WHERE week_start=? AND publication_token=?) AND object_id NOT IN(SELECT json_extract(r.value,'$.id') FROM ordexa_server_views v,json_each(v.payload,'$.reviews') r WHERE v.week_start=? AND v.publication_token=?)`).bind(computedAt,'ordexa-server:'+week+':%',week,nonce,week,nonce));
 }
 const saved=await env.DB.batch(operations);if(!saved[0]?.meta?.changes)fail(D,409,'Η προβολή άλλαξε, η άδεια έληξε ή το αποτέλεσμα δεν έχει συμβατό σχήμα.');
 return D.wfJson({saved:true,weekStart:week,payloadHash:hash,computedAt});
}

async function adjustment(request,env,D){
 const actor=await D.authenticate(request,env,'payroll.manage'),pinUsed=await D.requirePin(request,env,D,actor);const b=await D.bodyJson(request),week=monday(b.weekStart),meta=await head(env);
 const stored=await env.DB.prepare(`SELECT v.input_revision,v.input_epoch,v.computed_at,v.source_synced_at,json_extract(g.value,'$.employeeId') employee_id,g.value data FROM ordexa_server_views v,json_each(v.payload,'$.shifts') g WHERE v.week_start=? AND json_extract(g.value,'$.id')=? LIMIT 1`).bind(week,String(b.id||'')).first();
 if(!stored||stored.input_revision!==meta.revision||stored.input_epoch!==meta.epoch||Date.now()-Date.parse(stored.computed_at)>180000||!(Date.now()-Date.parse(stored.source_synced_at)<180000))fail(D,409,'Η βάρδια χρειάζεται ενημέρωση από τον Server.');
 const group=JSON.parse(stored.data),before=await env.DB.prepare('SELECT * FROM ordexa_shift_adjustments WHERE id=?').bind(group.id).first();
 if(b.fingerprint!==group.fingerprint||Number(b.revision)!==Number(before?.revision||0))fail(D,409,'Η βάρδια ή η απόφαση άλλαξε. Άνοιξε ξανά την επεξεργασία.');
 if(!stored.employee_id)fail(D,400,'Αντιστοίχισε πρώτα τον εργαζόμενο Ordexa.');if(group.excluded)fail(D,400,'Η αρχική παρουσία έχει εξαιρεθεί. Απαιτείται πρώτα αποδοχή της στις αρχικές παρουσίες Ordexa.');
 const parse=value=>{if(value==null||value==='')return null;const time=Date.parse(value);if(!Number.isFinite(time)||time%1800000!==0)fail(D,400,'Οι πληρωτέες ώρες πρέπει να είναι σε βαθμίδες μισάωρου.');return new Date(time).toISOString();};
 const start=parse(b.paidStart),end=parse(b.paidEnd);if((start&&end&&end<start)||(start&&end&&Date.parse(end)-Date.parse(start)>36*3600000))fail(D,400,'Μη έγκυρο πληρωτέο διάστημα.');
 const mode=value=>{if(!['auto','normal','special'].includes(value))fail(D,400,'Μη έγκυρη επιλογή ωρομισθίου.');return value;};
 const n0=mode(b.night00Mode||'auto'),n1=mode(b.night01Mode||'auto'),at=stamp(),id=crypto.randomUUID(),notes=String(b.notes||'').slice(0,500),ids=JSON.stringify(group.sourceSessionIds||[]);
 const guard=`${sourceGuard} AND ((?=0 AND NOT EXISTS(SELECT 1 FROM ordexa_shift_adjustments WHERE id=?)) OR EXISTS(SELECT 1 FROM ordexa_shift_adjustments WHERE id=? AND revision=?)) AND NOT EXISTS(SELECT 1 FROM payroll_snapshots ps JOIN payroll_periods pp ON pp.id=ps.period_id,json_each(ps.data,'$.sourceRows') sr,json_each(sr.value,'$.sourceSessionIds') si WHERE pp.status='locked' AND si.value IN(SELECT value FROM json_each(?))) AND NOT EXISTS(SELECT 1 FROM payroll_periods WHERE status='locked' AND ? BETWEEN start_date AND end_date)`;
 const args=[meta.revision,meta.epoch,Number(before?.revision||0),group.id,group.id,Number(before?.revision||0),ids,group.workDate];
 const after={paidStart:start,paidEnd:end,night00Mode:n0,night01Mode:n1,notes};
 const result=await env.DB.batch([
  env.DB.prepare(`INSERT INTO audit_log(id,timestamp,user_id,user_name,role,action,object_type,object_id,old_value,new_value,reason,admin_pin_used) SELECT ?,?,?,?,?, 'ordexa_shift_adjusted','ordexa_shift',?,?,?,?,? WHERE ${guard}`).bind(id,at,actor.user_id,actor.full_name||'',actor.role,group.id,JSON.stringify(before),JSON.stringify(after),notes||'Διόρθωση πληρωτέων από τη συγκεκριμένη βάρδια',pinUsed?1:0,...args),
  env.DB.prepare(`INSERT INTO ordexa_shift_adjustments(id,employee_id,source_fingerprint,start_fingerprint,end_fingerprint,paid_start,paid_end,night_00_mode,night_01_mode,acknowledged,revision,updated_at,updated_by,updated_by_name,notes) SELECT ?,?,?,?,?,?,?,?,?,1,1,?,?,?,? WHERE EXISTS(SELECT 1 FROM audit_log WHERE id=?) ON CONFLICT(id) DO UPDATE SET employee_id=excluded.employee_id,source_fingerprint=excluded.source_fingerprint,start_fingerprint=excluded.start_fingerprint,end_fingerprint=excluded.end_fingerprint,paid_start=excluded.paid_start,paid_end=excluded.paid_end,night_00_mode=excluded.night_00_mode,night_01_mode=excluded.night_01_mode,acknowledged=1,revision=ordexa_shift_adjustments.revision+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by,updated_by_name=excluded.updated_by_name,notes=excluded.notes`).bind(group.id,stored.employee_id,group.fingerprint,group.startFingerprint||'',group.endFingerprint||'',start,end,n0,n1,at,actor.user_id,actor.full_name||'',notes,id),
  env.DB.prepare("UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision' AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)").bind(id)
 ]);
 if(!result[1]?.meta?.changes)fail(D,409,'Η βάρδια άλλαξε ή ανήκει σε κλειδωμένη μισθοδοσία.');
 return D.wfJson({saved:true,awaitingServer:true,message:'Η διόρθωση αποθηκεύτηκε. Ο Server ενημερώνει τη μισθοδοσία.'});
}

async function employeeLinks(request,env,url,D){
 const actor=await D.authenticate(request,env,'employees.manage');
 if(request.method==='GET'){const id=url.searchParams.get('employeeId')||'';return D.wfJson({employeeId:id,riders:records(await env.DB.prepare('SELECT r.id,r.city_id,r.rider_id,r.name,r.employee_id,r.revision,u.full_name employee_name FROM ordexa_riders r LEFT JOIN app_users u ON u.id=r.employee_id ORDER BY r.city_id,r.name').all())});}
 const pinUsed=await D.requirePin(request,env,D,actor);const b=await D.bodyJson(request),employee=String(b.employeeId||''),city=String(b.cityId||'');
 if(!await env.DB.prepare('SELECT id FROM app_users WHERE id=? AND deleted_at IS NULL').bind(employee).first())fail(D,400,'Ο εργαζόμενος δεν υπάρχει.');
 const current=await env.DB.prepare('SELECT * FROM ordexa_riders WHERE city_id=? AND employee_id=?').bind(city,employee).first(),target=b.riderId?await env.DB.prepare('SELECT * FROM ordexa_riders WHERE city_id=? AND rider_id=?').bind(city,String(b.riderId)).first():null;
 if(b.riderId&&!target)fail(D,400,'Ο εργαζόμενος Ordexa δεν βρέθηκε.');
 if(target?.employee_id&&target.employee_id!==employee)fail(D,409,'Η εγγραφή Ordexa αντιστοιχεί ήδη σε άλλον εργαζόμενο.');
 if(String(current?.id||'')!==String(b.currentId||'')||Number(current?.revision||0)!==Number(b.currentRevision||0)||Number(target?.revision||0)!==Number(b.targetRevision||0))fail(D,409,'Η αντιστοίχιση άλλαξε. Άνοιξε ξανά τον εργαζόμενο.');
 if(current?.id===target?.id)return D.wfJson({saved:true,unchanged:true});
 const nonce=crypto.randomUUID(),at=stamp(),conditions=[],args=[];
 if(current){conditions.push('EXISTS(SELECT 1 FROM ordexa_riders WHERE id=? AND revision=? AND employee_id=?)');args.push(current.id,current.revision,employee);}else{conditions.push('NOT EXISTS(SELECT 1 FROM ordexa_riders WHERE city_id=? AND employee_id=?)');args.push(city,employee);}
 if(target){conditions.push('EXISTS(SELECT 1 FROM ordexa_riders WHERE id=? AND revision=? AND employee_id IS NULL)');args.push(target.id,target.revision);}
 const operations=[env.DB.prepare(`INSERT INTO audit_log(id,timestamp,user_id,user_name,role,action,object_type,object_id,old_value,new_value,reason,admin_pin_used) SELECT ?,?,?,?,?, 'ordexa_employee_link','employee',?,?,?,'Αντιστοίχιση Ordexa από Εργαζόμενοι',? WHERE ${conditions.join(' AND ')}`).bind(nonce,at,actor.user_id,actor.full_name||'',actor.role,employee,JSON.stringify(current),JSON.stringify(target),pinUsed?1:0,...args)];
 if(current)operations.push(env.DB.prepare('UPDATE ordexa_riders SET employee_id=NULL,revision=revision+1,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)').bind(at,current.id,nonce));
 if(target)operations.push(env.DB.prepare('UPDATE ordexa_riders SET employee_id=?,revision=revision+1,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)').bind(employee,at,target.id,nonce));
 operations.push(env.DB.prepare("UPDATE system_settings SET value=CAST(value AS INTEGER)+1 WHERE key='ordexa_revision' AND EXISTS(SELECT 1 FROM audit_log WHERE id=?)").bind(nonce));
 const result=await env.DB.batch(operations);if(!result[0]?.meta?.changes)fail(D,409,'Η αντιστοίχιση άλλαξε. Δοκίμασε ξανά.');return D.wfJson({saved:true});
}

export async function routeOrdexaServer(request,env,path,D){
 const server=path.startsWith('/api/server/ordexa-server/'),admin=path.startsWith('/api/admin/ordexa-server/');if(!server&&!admin)return null;
 const url=new URL(request.url),action=path.split('/').at(-1);
 if(server){if(!await D.serverAuthorized(request,env))fail(D,401,'Μη έγκυρος Server.');
  if(action==='control'&&request.method==='POST')return control(request,env,D);
  if(action==='input'&&request.method==='GET')return inputPage(request,env,url,D);
  if(action==='publish'&&request.method==='POST')return publish(request,env,D);
  if(action==='release'&&request.method==='POST'){const b=await D.bodyJson(request);await env.DB.prepare('UPDATE ordexa_server_views SET lease_token=NULL,lease_until=NULL WHERE week_start=? AND lease_token=?').bind(monday(b.weekStart),String(b.lease||'')).run();return D.wfJson({released:true});}
  fail(D,404,'Άγνωστη ενέργεια υπολογισμού.');
 }
 if(action==='employee-links'&&['GET','POST'].includes(request.method))return employeeLinks(request,env,url,D);
 if(action==='shift'&&request.method==='GET'){
  await D.authenticate(request,env,'payroll.manage');const row=await env.DB.prepare(`SELECT week_start,g.value data FROM ordexa_server_views v,json_each(v.payload,'$.shifts') g WHERE json_extract(g.value,'$.id')=? ORDER BY computed_at DESC LIMIT 1`).bind(String(url.searchParams.get('id')||'')).first();
  if(!row)fail(D,404,'Η βάρδια δεν βρίσκεται σε ενημερωμένη προβολή Server. Άνοιξε την ημέρα της.');const result=await view(env,row.week_start,'shifts',D),group=JSON.parse(row.data);if(await env.DB.prepare("SELECT id FROM payroll_periods WHERE status='locked' AND ? BETWEEN start_date AND end_date LIMIT 1").bind(group.workDate).first())group.payrollLocked=true;return D.wfJson({projection:result.info,shift:group});
 }
 if(action==='adjustment'&&request.method==='POST')return adjustment(request,env,D);
 if(action==='lock'&&request.method==='POST')return lock(request,env,D);
 if(action==='unlock'&&request.method==='POST')return D.unlockPayroll(request,env,D);
 if(request.method!=='GET')fail(D,405,'Μη επιτρεπτή ενέργεια.');
 const actor=await D.authenticate(request,env,action==='shifts'?'shifts.view':action==='dashboard'?'dashboard.view':'payroll.view');const financial=(actor.permissions||[]).some(p=>p==='*'||p==='payroll.view');
 const today=localDate(Date.now(),await setting(env,'timezone','Europe/Athens')),day=url.searchParams.get('day')||today,week=monday(url.searchParams.get('week')||day);
 if(action==='estimate'){const result=await view(env,week,'payroll',D);return rawJson('{"projection":'+JSON.stringify(result.info)+',"data":'+(result.json||'null')+'}');}
 if(action==='payroll'){
  const period=await D.ensurePayrollPeriod(env,week,addCalendarDays(week,6));if(period.status==='locked')return D.payrollSummary(new Request(url.origin+'/api/admin/payroll?start='+week+'&end='+addCalendarDays(week,6),request),env);
  const result=await view(env,week,'payroll',D);return rawJson('{"projection":'+JSON.stringify(result.info)+',"period":'+JSON.stringify(period)+',"data":'+(result.json||'null')+'}');
 }
 if(action==='shifts'){
  const result=await view(env,week,'shifts',D),locked=!!await env.DB.prepare("SELECT id FROM payroll_periods WHERE status='locked' AND ? BETWEEN start_date AND end_date LIMIT 1").bind(ordexaDay(day)).first();let expression='g.value';if(locked)expression="CASE WHEN json_extract(g.value,'$.payrollLocked')=1 THEN g.value ELSE json_set(g.value,'$.payrollLocked',json('true'),'$.payableHours',NULL,'$.payableClockIn',NULL,'$.payableClockOut',NULL) END";if(!financial)expression="json_remove("+expression+",'$.basePayCents','$.specialPayCents','$.totalPayCents')";
  const rows=await env.DB.prepare(`SELECT COALESCE(json_group_array(json(${expression})),'[]') data FROM ordexa_server_views v,json_each(v.payload,'$.shifts') g WHERE v.week_start=? AND json_extract(g.value,'$.workDate')=?`).bind(week,day).first();
  return rawJson('{"projection":'+JSON.stringify(result.info)+',"shifts":'+(rows?.data||'[]')+'}');
 }
 if(action==='dashboard'){const result=await view(env,week,'dashboard',D);let data=result.json;if(data&&!financial){const section=await env.DB.prepare("SELECT json_remove(json_extract(payload,'$.dashboard'),'$.payrollCents','$.payableHours') data FROM ordexa_server_views WHERE week_start=?").bind(week).first();data=section?.data||'null';}
  const alert=await env.DB.prepare("SELECT COUNT(*) total,SUM(CASE WHEN type LIKE '%service%' THEN 1 ELSE 0 END) service FROM system_alerts WHERE resolved=0").first();return rawJson('{"projection":'+JSON.stringify(result.info)+',"alerts":'+JSON.stringify(alert||{total:0,service:0})+',"data":'+(data||'null')+'}');}
 fail(D,404,'Άγνωστη προβολή.');
}

async function lock(request,env,D){
 const actor=await D.authenticate(request,env,'payroll.lock'),pinUsed=await D.requirePin(request,env,D,actor);const b=await D.bodyJson(request),week=monday(b.startDate),end=addCalendarDays(week,6),period=await D.ensurePayrollPeriod(env,week,end);
 if(period.status==='locked')return D.wfJson({locked:true,unchanged:true});
 const meta=await head(env),freshAfter=new Date(Date.now()-180000).toISOString(),at=stamp();
 const guard=`${sourceGuard} AND EXISTS(SELECT 1 FROM ordexa_server_views WHERE week_start=? AND input_revision=? AND input_epoch=? AND computed_at>? AND source_synced_at>? AND json_array_length(payload,'$.payroll.blockers')=0) AND EXISTS(SELECT 1 FROM payroll_periods WHERE id=? AND status='open')`;
 const args=[meta.revision,meta.epoch,week,meta.revision,meta.epoch,freshAfter,freshAfter,period.id];
 const result=await env.DB.batch([
  env.DB.prepare(`INSERT INTO payroll_snapshots(id,period_id,employee_id,data,created_at) SELECT lower(hex(randomblob(16))),?,json_extract(e.value,'$.employeeId'),e.value,? FROM ordexa_server_views v,json_each(v.payload,'$.payroll.employees') e WHERE v.week_start=? AND ${guard}`).bind(period.id,at,week,...args),
  env.DB.prepare(`UPDATE payroll_periods SET status='locked',locked_at=?,locked_by=?,hours_source='ordexa',updated_at=? WHERE id=? AND ${guard}`).bind(at,actor.user_id,at,period.id,...args),
  env.DB.prepare(`INSERT INTO audit_log(id,timestamp,user_id,user_name,role,action,object_type,object_id,old_value,new_value,reason,admin_pin_used) SELECT ?,?,?,?,?, 'ordexa_server_payroll_locked','payroll_period',?,'{"status":"open"}','{"status":"locked","source":"ordexa-server"}',?,? WHERE changes()>0 AND EXISTS(SELECT 1 FROM payroll_periods WHERE id=? AND status='locked' AND locked_at=? AND locked_by=?)`).bind(crypto.randomUUID(),at,actor.user_id,actor.full_name||'',actor.role,period.id,String(b.reason||'Κλείδωμα μισθοδοσίας Ordexa').slice(0,500),pinUsed?1:0,period.id,at,actor.user_id)
 ]);
 if(!result[1]?.meta?.changes)fail(D,409,'Χρειάζεται ενημερωμένη προβολή Server χωρίς εκκρεμότητες πριν το κλείδωμα.');
 return D.wfJson({locked:true,periodId:period.id,source:'ordexa-server'});
}
