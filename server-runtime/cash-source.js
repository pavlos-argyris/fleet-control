import {CASH_ORDER_CONTRACT,cashContext} from './cash-contract.js';
import {queueAutomaticDays} from './cash-auto.js';
import {list,reply,NativeError,day,addDay,integer,actor,audit,stamp,hash} from './common.js';

export const CASH_SOURCE_SCHEMA=`
CREATE TABLE IF NOT EXISTS native_cash_rider_links(id TEXT PRIMARY KEY,scope TEXT NOT NULL,rider_id TEXT NOT NULL,effective_day TEXT NOT NULL,revision INTEGER NOT NULL,employee_id TEXT,employee_name TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,created_by TEXT NOT NULL,UNIQUE(scope,rider_id,effective_day,revision));
CREATE INDEX IF NOT EXISTS native_cash_rider_link_lookup ON native_cash_rider_links(scope,rider_id,effective_day DESC,revision DESC);
CREATE TRIGGER IF NOT EXISTS native_cash_links_immutable_update BEFORE UPDATE ON native_cash_rider_links BEGIN SELECT RAISE(ABORT,'cash_links_are_versioned'); END;
CREATE TRIGGER IF NOT EXISTS native_cash_links_immutable_delete BEFORE DELETE ON native_cash_rider_links BEGIN SELECT RAISE(ABORT,'cash_links_are_versioned'); END;
`;
export const ORDER_IDENTITY_CONTRACT={...CASH_ORDER_CONTRACT,automaticWritesEnabled:false};
function context(env){return cashContext(env);}
function currentScope(env,required=false){const value=context(env);if(required&&(!value.configured||!value.scope))throw new NativeError(409,'Σύνδεσε πρώτα το Ordexa στον Server.','ordexa_not_configured');return value;}
export async function cashSourceCatalog(env){
  const source=currentScope(env);if(!source.configured||!source.scope)return{sourceScope:null,riders:[],riderLinks:[],identityContract:ORDER_IDENTITY_CONTRACT};
  if(env.CLOUD_PRIMARY){const row=await env.DB.prepare("SELECT data FROM store_billing_local WHERE scope=? AND kind='cash_catalog' LIMIT 1").bind(source.scope).first(),prepared=row&&JSON.parse(row.data);
    if(prepared?.version===1&&prepared.generation===source.generation&&Array.isArray(prepared.riders)){
      const riderLinks=list(await env.DB.prepare('SELECT * FROM native_cash_rider_links WHERE scope=? ORDER BY effective_day DESC,revision DESC,id').bind(source.scope).all());
      return{sourceScope:source.scope,historicalOnly:!!source.historicalOnly,riders:prepared.riders.slice().sort((a,b)=>(a.nickname||a.riderId).localeCompare(b.nickname||b.riderId)),riderLinks,identityContract:ORDER_IDENTITY_CONTRACT,catalogSource:'server-prepared'};
    }
  }
  const aliases=list(await env.DB.prepare("SELECT data FROM store_billing_local WHERE scope=? AND kind='cash_rider_alias' ORDER BY json_extract(data,'$.observedAt') DESC,id").bind(source.scope).all());
  const current=list(await env.DB.prepare("SELECT json_extract(n.data,'$.sourceRiderId') riderId,json_extract(n.data,'$.nickname') nickname,MAX(json_extract(c.data,'$.observedAt')) observedAt FROM store_billing_local n JOIN store_billing_local c ON c.scope=n.scope AND c.kind='cash_source_coverage' AND c.day=n.day AND json_extract(c.data,'$.runId')=json_extract(n.data,'$.runId') WHERE n.scope=? AND n.kind='cash_snapshot_order' AND json_extract(n.data,'$.sourceRiderId') IS NOT NULL GROUP BY riderId,nickname ORDER BY observedAt DESC,riderId,nickname").bind(source.scope).all());
  const riders=new Map();
  for(const item of aliases){const value=JSON.parse(item.data),id=String(value.riderId);if(!riders.has(id))riders.set(id,{riderId:id,nickname:value.nickname,aliases:[]});riders.get(id).aliases.push({nickname:value.nickname,observedAt:value.observedAt});}
  const selected=new Set();for(const row of current){const id=String(row.riderId);if(!riders.has(id))riders.set(id,{riderId:id,nickname:row.nickname,aliases:[]});if(!selected.has(id)){riders.get(id).nickname=row.nickname;selected.add(id);}}
  const riderLinks=list(await env.DB.prepare('SELECT * FROM native_cash_rider_links WHERE scope=? ORDER BY effective_day DESC,revision DESC,id').bind(source.scope).all());
  return{sourceScope:source.scope,historicalOnly:!!source.historicalOnly,riders:[...riders.values()].sort((a,b)=>(a.nickname||a.riderId).localeCompare(b.nickname||b.riderId)),riderLinks,identityContract:ORDER_IDENTITY_CONTRACT};
}
async function catalogRevision(env,source,coverage){
  const prepared=await env.DB.prepare("SELECT data FROM store_billing_local WHERE scope=? AND kind='cash_catalog' LIMIT 1").bind(source.scope).first(),value=prepared&&JSON.parse(prepared.data);
  const identity=value?.generation===source.generation&&value.version===1?{riders:value.riders}: {
    coverage:coverage.map(row=>[row.day,JSON.parse(row.data).sourceDigest||'']).sort((a,b)=>a[0].localeCompare(b[0])),
    aliases:list(await env.DB.prepare("SELECT id,data FROM store_billing_local WHERE scope=? AND kind='cash_rider_alias' ORDER BY id").bind(source.scope).all())
  };
  // Authentication still runs for each request. This is a UI content revision,
  // not a cache of permissions, source freshness or financial completion.
  return hash({scope:source.scope,generation:source.generation,identity,
    rules:list(await env.DB.prepare('SELECT id FROM native_cash_rules ORDER BY id').all()),
    links:list(await env.DB.prepare('SELECT id FROM native_cash_rider_links WHERE scope=? ORDER BY id').bind(source.scope).all()),
    employees:list(await env.DB.prepare('SELECT id,full_name,active,deleted_at FROM app_users ORDER BY id').all()),
    stores:list(await env.DB.prepare("SELECT id,json_extract(data,'$.name') name FROM store_billing_records WHERE kind='store' ORDER BY id").all())});
}
export async function saveCashRiderLink(request,env,user){
  await actor(request,env,'employees.manage');
  const b=await request.json(),source=currentScope(env,true);
  if(b.scope!==source.scope)throw new NativeError(409,'Άλλαξε η σύνδεση Ordexa. Το προσχέδιο διατηρήθηκε.','source_conflict');
  const rider=String(b.riderId??''),employee=b.employeeId===null||b.employeeId===''?null:b.employeeId,effective=day(b.effectiveDay),expected=integer(b.expectedRevision);
  if(!/^\d{1,16}$/.test(rider)||!Number.isSafeInteger(Number(rider))||employee!==null&&(typeof employee!=='string'||employee.length>100))throw new NativeError(400,'Επίλεξε έγκυρο διανομέα και εργαζόμενο.');
  const catalog=await cashSourceCatalog(env);if(!catalog.riders.some(row=>row.riderId===rider))throw new NativeError(409,'Ο διανομέας δεν έχει επιβεβαιωθεί στην ενεργή πηγή παραγγελιών.');
  let employeeName='';if(employee){const value=await env.DB.prepare('SELECT id,full_name,active,deleted_at FROM app_users WHERE id=?').bind(employee).first();if(!value||!value.active||value.deleted_at)throw new NativeError(409,'Επίλεξε ενεργό εργαζόμενο.');employeeName=value.full_name;}
  const previous=await env.DB.prepare('SELECT * FROM native_cash_rider_links WHERE scope=? AND rider_id=? AND effective_day=? ORDER BY revision DESC LIMIT 1').bind(source.scope,rider,effective).first();
  if(Number(previous?.revision||0)!==expected)throw new NativeError(409,'Η αντιστοίχιση άλλαξε. Έλεγξε τα νέα στοιχεία.','link_conflict');
  const id=crypto.randomUUID(),at=stamp();
  const saved=await env.DB.prepare('INSERT INTO native_cash_rider_links(id,scope,rider_id,effective_day,revision,employee_id,employee_name,created_at,created_by) SELECT ?,?,?,?,?,?,?,?,? WHERE COALESCE((SELECT MAX(revision) FROM native_cash_rider_links WHERE scope=? AND rider_id=? AND effective_day=?),0)=?').bind(id,source.scope,rider,effective,expected+1,employee,employeeName,at,user.user_id,source.scope,rider,effective,expected).run();
  if(Number(saved?.meta?.changes)!==1)throw new NativeError(409,'Η αντιστοίχιση άλλαξε πριν αποθηκευτεί.','link_conflict');
  await audit(env,request,user,'cash_rider_link_version','cash_rider_link',id,previous,{scope:source.scope,riderId:rider,employeeId:employee,effectiveDay:effective,revision:expected+1},'Ρητή αντιστοίχιση σταθερού Ordexa ID· χωρίς αντιστοίχιση ονόματος ή αλλαγή μισθοδοσίας');
  await queueAutomaticDays(env,source.scope,effective);
  return reply({saved:true,id,revision:expected+1},201);
}
export async function queueCashSourceRefresh(request,env,user){
  const source=currentScope(env,true);if(!env.LOCAL_PRIMARY||source.historicalOnly||!source.generation)throw new NativeError(409,'Χρειάζεται ενεργή σύνδεση Ordexa στον κύριο Server.');
  const b=await request.json(),from=day(b.from),to=day(b.to);if(to<from||to>addDay(from,30))throw new NativeError(400,'Επίλεξε έως31 ημέρες για τη λήψη παραγγελιών.');
  // Native 4xx responses may commit auth/security bookkeeping. Validate capacity before
  // writing any queue cells; all request handlers already share the same SQLite transaction.
  const pending=await env.DB.prepare("SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN day BETWEEN ? AND ? THEN 1 ELSE 0 END),0) selected FROM store_billing_local WHERE scope=? AND kind='cash_refresh_request'").bind(from,to,source.scope).first();
  const requestedDays=Math.round((Date.parse(to+'T12:00:00Z')-Date.parse(from+'T12:00:00Z'))/86400000)+1;
  if(Number(pending.total)+requestedDays-Number(pending.selected)>93)throw new NativeError(409,'Η ουρά λήψης είναι γεμάτη. Περίμενε τις προηγούμενες ημέρες.','refresh_queue_full');
  const at=stamp(),nonce=crypto.randomUUID();let queuedDays=0;
  for(let date=from;date<=to;date=addDay(date,1)){
    const key='cash-refresh:'+await hash({scope:source.scope,id:date}),data=JSON.stringify({from:date,to:date,generation:source.generation,requestedAt:at,requestId:nonce});
    await env.DB.prepare("INSERT INTO store_billing_local(id,kind,scope,store_id,day,data,dirty) VALUES(?,'cash_refresh_request',?,'',?,?,0) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,scope=excluded.scope,day=excluded.day,data=excluded.data,dirty=0").bind(key,source.scope,date,data).run();queuedDays++;
  }
  await audit(env,request,user,'cash_source_refresh','cash_source',source.scope,null,{from,to,queuedDays},'Χειροκίνητη λήψη από τον κοινό reader· χωρίς οικονομική εφαρμογή');
  return reply({queued:true,state:'pending',source:'shared-orders-reader',queuedDays,automaticWritesEnabled:false},202);
}
export async function cashSourceStatus(env,from,to){
  const source=currentScope(env),base={state:'awaiting-source',protocolVerified:true,identityFieldsVerified:true,coverageVerified:false,lastCompleteAt:null,lastAttemptAt:null,automaticPollingEnabled:false,proposedPilotIntervalSeconds:120,timeSemanticsVerified:true,cancellationSemanticsVerified:true,
    reason:'Παράδοση βάσει ώρας Ordexa. Ακύρωση μόνο μετά από πλήρη συνεπή επαναληπτική λήψη.'};
  if(!source.configured||!source.scope)return{...base,state:'source-not-configured',reason:'Σύνδεσε πρώτα το Ordexa στον Server. Οι καταγεγραμμένες κινήσεις παραμένουν διαθέσιμες.'};
  const rows=list(await env.DB.prepare("SELECT day,data FROM store_billing_local WHERE scope=? AND kind='cash_source_coverage' AND day BETWEEN ? AND ?").bind(source.scope,from,to).all());
  const pending=await env.DB.prepare("SELECT COUNT(*) n FROM store_billing_local WHERE scope=? AND kind='cash_refresh_request' AND day BETWEEN ? AND ?").bind(source.scope,from,to).first();
  const coverage=rows.map(row=>JSON.parse(row.data)),complete=coverage.filter(row=>row.identityVerified&&row.ordersCoverageComplete&&!row.needsSourceRefresh);
  const identityRevision=await hash({scope:source.scope,coverage:rows.sort((a,b)=>a.day.localeCompare(b.day)).map(row=>[row.day,JSON.parse(row.data).runId||'',JSON.parse(row.data).observedAt||'',JSON.parse(row.data).needsSourceRefresh===true])});
  const times=coverage.map(row=>row.lastCompleteAt).filter(at=>Number.isFinite(Date.parse(at))).sort();
  const readerRow=await env.DB.prepare("SELECT data FROM store_billing_local WHERE id='meta:store-billing'").first(),reader=readerRow?JSON.parse(readerRow.data):{},sameReader=(reader.activeScope||reader.control?.scope)===source.scope&&(reader.activeGeneration||reader.control?.generation)===source.generation;
  const backoff=sameReader&&!!reader.error&&Number(reader.nextDue)>Date.now();
  const pilotRow=await env.DB.prepare("SELECT data FROM store_billing_local WHERE id='meta:cash-sync'").first(),pilot=pilotRow?JSON.parse(pilotRow.data):{};
  const pilotSeenAt=env.CLOUD_PRIMARY?Date.parse(env.BUSINESS_HEALTH?.serverLastSeenAt||''):Number(pilot.lastTick);
  const expected=Math.round((Date.parse(to+'T12:00:00Z')-Date.parse(from+'T12:00:00Z'))/86400000)+1;
  return{...base,state:backoff?'backoff':Number(pending.n)>0?'pending':coverage.some(row=>!row.identityVerified||!row.ordersCoverageComplete||row.needsSourceRefresh)?'partial':base.state,
    sourceScope:source.scope,identityRevision,catalogRevision:await catalogRevision(env,source,rows),financialJobError:pilot.scope===source.scope&&pilot.generation===source.generation&&pilot.error?pilot.error:null,retryAt:backoff?new Date(reader.nextDue).toISOString():null,automaticPollingEnabled:pilot.scope===source.scope&&pilot.generation===source.generation&&pilot.automaticPollingEnabled===true&&!pilot.error&&Date.now()>=pilotSeenAt&&Date.now()-pilotSeenAt<300000,pilotIntervalSeconds:120,pendingDays:Number(pending.n),identityDaysComplete:complete.length,identityDaysExpected:expected,
    orderSnapshotCoverageComplete:complete.length===expected,lastOrderSnapshotAt:times.length?times[times.length-1]:null};
}
