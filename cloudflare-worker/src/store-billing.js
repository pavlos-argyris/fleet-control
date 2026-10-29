import {ordexaDay} from './ordexa-core.js';
import {addCalendarDays,localDate} from './workforce-core.js';

export const STORE_BILLING_COLUMNS=['id','scope','kind','store_id','day','revision','data','updated_at'];
export const STORE_BILLING_SCHEMA=`
CREATE TABLE IF NOT EXISTS store_billing_records(id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,store_id TEXT NOT NULL DEFAULT '',day TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 1,data TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS store_billing_lookup ON store_billing_records(scope,kind,day,store_id);
CREATE TABLE IF NOT EXISTS store_billing_guards(id TEXT PRIMARY KEY,ok INTEGER CONSTRAINT store_billing_guard CHECK(ok=1));
`;
const now=()=>new Date().toISOString(),rows=r=>r.results||[],json=r=>r?{...r,...JSON.parse(r.data)}:null;
const invalid=(D,message,status=400)=>{throw new D.ApiError(status,message);};
const ident=(v,D,max=180)=>{if(typeof v!=='string'||!new RegExp('^[A-Za-z0-9_:-]{1,'+max+'}$').test(v))invalid(D,'Μη έγκυρη ταυτότητα καταστημάτων.');return v;};
const number=(n,D,max=100000000)=>{if(!Number.isSafeInteger(n)||n<0||n>max)invalid(D,'Μη έγκυρο ποσό ή πλήθος καταστήματος.');return n;};
function range(from,to,D,max=366){try{ordexaDay(from);ordexaDay(to);}catch{invalid(D,'Επίλεξε έγκυρες ημερομηνίες.');}if(to<from||to>addCalendarDays(from,max-1))invalid(D,'Επίλεξε διάστημα έως '+max+' ημέρες.');return {from,to};}
export function storeBusinessDay(at=Date.now()){
 const d=new Date(at),day=localDate(d.getTime(),'Europe/Athens'),h=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Athens',hour:'2-digit',hourCycle:'h23'}).format(d));return h<5?addCalendarDays(day,-1):day;
}
async function epoch(env){const r=await env.DB.prepare("SELECT epoch||':'||COALESCE((SELECT value FROM fleet_settings WHERE key='ordexa_server_generation'),'') value,EXISTS(SELECT 1 FROM fleet_settings WHERE key='ordexa_restore_active' AND value<>'') restoring FROM fleet_mirror_state WHERE id=1").first();return {epoch:r?.value||'',restoring:!!r?.restoring};}
const scopeId=s=>'connection:'+s;
const record=async(env,id)=>env.DB.prepare('SELECT * FROM store_billing_records WHERE id=?').bind(id).first();
function insert(env,r){return env.DB.prepare('INSERT INTO store_billing_records(id,scope,kind,store_id,day,revision,data,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at').bind(r.id,r.scope,r.kind,r.storeId||'',r.day||'',r.revision||1,JSON.stringify(r.data),now());}
async function active(env){return (await env.DB.prepare("SELECT value FROM fleet_settings WHERE key='store_billing_active_scope'").first())?.value||'';}
async function fence(env,b,D,requireJob=true){
 const e=await epoch(env);if(e.restoring||b.epoch!==e.epoch)invalid(D,'Τα δεδομένα επαναφέρθηκαν. Επανάλαβε από το νέο στιγμιότυπο.',409);
 const c=json(await record(env,scopeId(ident(b.scope,D,100))));if(!c||c.generation!==b.generation)invalid(D,'Η σύνδεση καταστημάτων άλλαξε. Επανάλαβε με τη νέα σύνδεση.',409);
 if(requireJob&&(!b.operationId||!b.lease||!await env.DB.prepare("SELECT 1 ok FROM store_billing_records WHERE id=? AND scope=? AND kind='operation' AND json_extract(data,'$.lease')=? AND json_extract(data,'$.state')='running' AND updated_at>?").bind(b.operationId,b.scope,b.lease,new Date(Date.now()-900000).toISOString()).first()))invalid(D,'Η άδεια εργασίας καταστημάτων έληξε ή άλλαξε.',409);return c;
}
const sqlFence="EXISTS(SELECT 1 FROM store_billing_records WHERE id=? AND json_extract(data,'$.generation')=?) AND EXISTS(SELECT 1 FROM fleet_mirror_state WHERE id=1 AND epoch||':'||COALESCE((SELECT value FROM fleet_settings WHERE key='ordexa_server_generation'),'')=?) AND NOT EXISTS(SELECT 1 FROM fleet_settings WHERE key='ordexa_restore_active' AND value<>'')";
function sqlFenceFor(b,D){ident(b.operationId,D);ident(b.lease,D);return sqlFence+" AND EXISTS(SELECT 1 FROM store_billing_records WHERE id='"+b.operationId+"' AND scope='"+ident(b.scope,D,100)+"' AND kind='operation' AND json_extract(data,'$.lease')='"+b.lease+"' AND json_extract(data,'$.state')='running' AND julianday(updated_at)>julianday('now','-15 minutes'))";}
function guard(env,condition,args){const id=crypto.randomUUID();return [env.DB.prepare('INSERT INTO store_billing_guards(id,ok) SELECT ?,CASE WHEN '+condition+' THEN 1 ELSE 0 END').bind(id,...args),env.DB.prepare('DELETE FROM store_billing_guards WHERE id=?').bind(id)];}
async function transaction(env,statements,g){try{await env.DB.batch([g[0],...statements,g[1]]);}catch(e){if(String(e?.message).includes('store_billing_guard'))throw Object.assign(new Error('Οι σχετικές τιμές ή η σύνδεση άλλαξαν. Ανανέωσε και δοκίμασε ξανά.'),{storeConflict:true});throw e;}}
async function wake(env,id){await env.DB.prepare("INSERT OR IGNORE INTO fleet_operations(id,source,type,payload,status,created_at) VALUES(?,'store-billing','store_billing_wake','{}','pending',?)").bind('store-billing:'+id,now()).run();}
async function hash(v){const bytes=new TextEncoder().encode(JSON.stringify(v)),d=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));return [...d].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function operation(env,scope,from,to,type,requestedBy,id=crypto.randomUUID(),requestHash=''){
 const value={id,scope,from,to,type,state:'pending',stage:type==='reprice'?'Αναμονή υπολογισμού Server':'Αναμονή λήψης Server',requestedBy,requestHash,requestedAt:now()};
 await env.DB.prepare("INSERT OR IGNORE INTO store_billing_records(id,scope,kind,store_id,day,data,updated_at) VALUES(?,?,'operation','','',?,?)").bind(id,scope,JSON.stringify(value),now()).run();return value;
}
async function control(env,b,D){
 const e=await epoch(env);if(e.restoring)invalid(D,'Η επαναφορά βρίσκεται σε εξέλιξη.',409);
 const scope=ident(b.scope,D,100),generation=ident(b.generation,D,100),city=ident(b.cityId,D,100);number(b.generationAt,D,Number.MAX_SAFE_INTEGER);
 const old=json(await record(env,scopeId(scope)));if(old&&Number(old.generationAt)>b.generationAt)invalid(D,'Παλιότερη συνεδρία Ordexa. Δεν εφαρμόστηκε.',409);
 const data={...(old||{}),id:scopeId(scope),generation,generationAt:b.generationAt,cityId:city,bootstrapComplete:!!old?.bootstrapComplete};delete data.data;delete data.kind;delete data.scope;delete data.store_id;delete data.day;delete data.updated_at;delete data.revision;
 const registered=await env.DB.prepare("INSERT INTO store_billing_records(id,scope,kind,store_id,day,data,updated_at) VALUES(?,?,'connection','','',?,?) ON CONFLICT(id) DO UPDATE SET data=json_set(store_billing_records.data,'$.generation',?,'$.generationAt',?,'$.cityId',?),updated_at=excluded.updated_at WHERE COALESCE(json_extract(store_billing_records.data,'$.generationAt'),0)<=?").bind(scopeId(scope),scope,JSON.stringify(data),now(),generation,b.generationAt,city,b.generationAt).run();if(!registered.meta?.changes)invalid(D,'Νεότερη συνεδρία Ordexa έχει ήδη συνδεθεί.',409);
 await env.DB.prepare("INSERT INTO fleet_settings(key,value,updated_at) VALUES('store_billing_active_scope',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(scope,now()).run();
 let job=json(await env.DB.prepare("SELECT * FROM store_billing_records WHERE scope IN (?, '') AND kind='operation' AND (json_extract(data,'$.state')='pending' OR (json_extract(data,'$.state')='running' AND updated_at<?)) ORDER BY updated_at LIMIT 1").bind(scope,new Date(Date.now()-900000).toISOString()).first());
 if(!job&&b.allowAuto===false){const current=await record(env,scopeId(scope));return {epoch:e.epoch,connection:{...data,revision:current.revision},idle:true};}
 if(!job){range(b.from,b.to,D,31);job=await operation(env,scope,b.from,b.to,'sync','server');}
 const lease=crypto.randomUUID();job={id:job.id,scope,from:job.from,to:job.to,type:job.type,state:'running',lease,stage:'Προετοιμασία Server',requestedAt:job.requestedAt};
 const changed=await env.DB.prepare("UPDATE store_billing_records SET scope=?,data=?,updated_at=? WHERE id=? AND (json_extract(data,'$.state')='pending' OR updated_at<?)").bind(scope,JSON.stringify(job),now(),job.id,new Date(Date.now()-900000).toISOString()).run();
 if(!changed.meta?.changes)invalid(D,'Η εργασία εκτελείται ήδη. Περίμενε την ολοκλήρωσή της.',409);
 const current=await record(env,scopeId(scope));return {epoch:e.epoch,connection:{...data,revision:current.revision},job};
}
async function catalogue(env,b,D){
 const c=await fence(env,b,D);if(!Array.isArray(b.stores)||b.stores.length>25||JSON.stringify(b.stores).length>60000)invalid(D,'Μεγάλη σελίδα καταλόγου.');
 if(new Set(b.stores.map(s=>s.id)).size!==b.stores.length)invalid(D,'Διπλό κατάστημα στην ίδια σελίδα.');
 const before=rows(await env.DB.prepare("SELECT * FROM store_billing_records WHERE id IN(SELECT json_extract(value,'$.id') FROM json_each(?))").bind(JSON.stringify(b.stores.map(s=>({id:s.id})))).all()),existing=new Map(before.map(r=>[r.id,r])),out=[],expected=[];let versionCount=0;
 for(const store of b.stores){
  ident(store.id,D);ident(store.sourceShopId,D,100);if(typeof store.name!=='string'||store.name.length>300||typeof store.blocked!=='boolean'||!Array.isArray(store.sourceTerms)||(versionCount+=store.sourceTerms.length)>100)invalid(D,'Μη έγκυρο κατάστημα ή πολλοί όροι.');
  const old=existing.get(store.id);if(old&&(old.scope!==b.scope||old.kind!=='store'||JSON.parse(old.data).sourceShopId!==store.sourceShopId))invalid(D,'Διαφορετική πηγή καταστήματος.',409);
  expected.push({id:store.id,exists:!!old,revision:old?.revision||0,data:old?.data||''});const previous=old?JSON.parse(old.data):{};
  const value={id:store.id,sourceShopId:store.sourceShopId,name:store.name,blocked:store.blocked,sourceTerms:store.sourceTerms,pricingState:previous.pricingState||'needs_terms',newStore:previous.newStore??!!c.bootstrapComplete,retainOrders:previous.retainOrders===true};
  if(!old&&!c.bootstrapComplete)for(const t of store.sourceTerms){
   if(typeof t.effectiveDay!=='string'||typeof t.supported!=='boolean')invalid(D,'Άγνωστο σχήμα αρχικών όρων.');if(t.effectiveDay)try{ordexaDay(t.effectiveDay);}catch{invalid(D,'Άγνωστη ισχύς αρχικών όρων.');}
   if(t.supported){number(t.unitPriceCents,D);number(t.dailyMinimumCents,D);if(typeof t.chargeOnZero!=='boolean')invalid(D,'Άγνωστη πολιτική ελάχιστου.');value.pricingState='ready';}
   const id='terms:'+await hash({store:store.id,from:t.effectiveDay});out.push({id,kind:'terms',storeId:store.id,day:t.effectiveDay,data:{...t,id,storeId:store.id,version:1},revision:1});
  }
  out.push({id:store.id,kind:'store',storeId:'',day:'',data:value,revision:(old?.revision||1)+(old&&JSON.stringify(value)!==old.data?1:0)});
 }
 const statements=[env.DB.prepare("INSERT INTO store_billing_records(id,scope,kind,store_id,day,revision,data,updated_at) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.kind'),json_extract(value,'$.storeId'),json_extract(value,'$.day'),json_extract(value,'$.revision'),json_extract(value,'$.data'),? FROM json_each(?) WHERE 1 ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at").bind(b.scope,now(),JSON.stringify(out))];
 if(b.complete){if(typeof b.catalogueHash!=='string'||!/^([a-f0-9]{64})$/.test(b.catalogueHash))invalid(D,'Άγνωστο αποτύπωμα καταλόγου.');statements.push(env.DB.prepare("UPDATE store_billing_records SET revision=revision+1,data=json_set(data,'$.bootstrapComplete',json('true'),'$.catalogueHash',?),updated_at=? WHERE id=?").bind(b.catalogueHash,now(),scopeId(b.scope)));}
 const condition=sqlFenceFor(b,D)+" AND EXISTS(SELECT 1 FROM store_billing_records WHERE id=? AND revision=?) AND NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN store_billing_records s ON s.id=json_extract(j.value,'$.id') WHERE (json_extract(j.value,'$.exists')=1 AND (s.id IS NULL OR s.revision<>json_extract(j.value,'$.revision') OR s.data<>json_extract(j.value,'$.data'))) OR (json_extract(j.value,'$.exists')=0 AND s.id IS NOT NULL))";
 await transaction(env,statements,guard(env,condition,[scopeId(b.scope),b.generation,b.epoch,scopeId(b.scope),c.revision,JSON.stringify(expected)]));return {saved:true,revision:c.revision+(b.complete?1:0)};
}
async function input(env,url,b,D){
 const c=await fence(env,b,D),cursor=Number(url.searchParams.get('cursor')||0);number(cursor,D,Number.MAX_SAFE_INTEGER);if(Number(url.searchParams.get('revision'))!==c.revision)invalid(D,'Οι όροι άλλαξαν κατά τη λήψη.',409);
 const table=url.searchParams.get('table')||'terms';if(!['terms','archive'].includes(table))invalid(D,'Άγνωστη κατηγορία καταστημάτων.');const kinds=table==='archive'?"'order','observation','publication'":"'store','terms'";
 const out=rows(await env.DB.prepare("SELECT rowid cursor,id,scope,kind,store_id,day,revision,CASE WHEN kind='store' THEN json_remove(data,'$.sourceTerms') ELSE data END data,updated_at FROM store_billing_records WHERE scope=? AND kind IN ("+kinds+") AND rowid>? ORDER BY rowid LIMIT 51").bind(b.scope,cursor).all());if((await record(env,scopeId(b.scope)))?.revision!==c.revision)invalid(D,'Οι όροι άλλαξαν κατά τη λήψη.',409);return {rows:out.slice(0,50),hasMore:out.length>50,nextCursor:out[Math.min(50,out.length)-1]?.cursor||cursor,revision:c.revision};
}
async function archive(env,b,D){
 await fence(env,b,D);if(!Array.isArray(b.records)||b.records.length>32)invalid(D,'Μεγάλη σελίδα αρχείου.');const statements=[];
 for(const r of b.records){ident(r.id,D);ident(r.storeId,D);ordexaDay(r.day);if(!['order','observation'].includes(r.kind)||JSON.stringify(r.data).length>4096||r.data.id!==r.id||r.data.storeId!==r.storeId||r.data.businessDay!==r.day)invalid(D,'Μη έγκυρη εγγραφή παραγγελίας.');
  if(!Number.isFinite(Date.parse(r.data.at))||storeBusinessDay(r.data.at)!==r.day||!r.data.sourceOrderId)invalid(D,'Μη έγκυρος χρόνος παραγγελίας.');
  // Original identity/time stays immutable; active status follows complete native reconciliation.
  statements.push(env.DB.prepare(`INSERT INTO store_billing_records(id,scope,kind,store_id,day,data,updated_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM store_billing_records WHERE id=? AND scope=? AND kind='store') ON CONFLICT(id) DO UPDATE SET data=json_set(store_billing_records.data,'$.active',json(CASE WHEN json_extract(excluded.data,'$.active')=1 THEN 'true' ELSE 'false' END)),revision=store_billing_records.revision+1,updated_at=excluded.updated_at WHERE store_billing_records.scope=excluded.scope AND store_billing_records.kind='order' AND excluded.kind='order' AND store_billing_records.store_id=excluded.store_id AND store_billing_records.day=excluded.day AND json_extract(store_billing_records.data,'$.at')=json_extract(excluded.data,'$.at')`).bind(r.id,b.scope,r.kind,r.storeId,r.day,JSON.stringify(r.data),now(),r.storeId,b.scope));
 }
 await transaction(env,statements,guard(env,sqlFenceFor(b,D),[scopeId(b.scope),b.generation,b.epoch]));return {saved:true};
}
async function stage(env,b,D){
 await fence(env,b,D);ident(b.runId,D);ordexaDay(b.day);if(!Array.isArray(b.rows)||b.rows.length>32)invalid(D,'Μεγάλη σελίδα υπολογισμού.');const statements=[];
 for(const r of b.rows){ident(r.storeId,D);if(r.businessDay!==b.day||r.engineVersion!==1||r.cutoffHour!==5||r.timeZone!=='Europe/Athens')invalid(D,'Ασύμβατος υπολογισμός ημέρας.');number(r.orderCount,D,10000000);number(r.storeRevision,D,Number.MAX_SAFE_INTEGER);for(const k of ['orderChargeCents','minimumTopUpCents','totalChargeCents'])if(r[k]!==null)number(r[k],D,Number.MAX_SAFE_INTEGER);
  if(r.totalChargeCents!==null&&r.totalChargeCents!==r.orderChargeCents+r.minimumTopUpCents)invalid(D,'Μη έγκυρο ημερήσιο αποτέλεσμα.');
  statements.push(insert(env,{id:'day:'+b.runId+':'+r.storeId,scope:b.scope,kind:'day',storeId:r.storeId,day:b.day,data:{...r,runId:b.runId}}));
 }
 if(b.removals!==undefined){if(!Array.isArray(b.removals)||b.removals.length>32)invalid(D,'Μεγάλη σελίδα αφαιρέσεων.');for(const r of b.removals){ident(r.orderId,D);ident(r.storeId,D);statements.push(insert(env,{id:'removal:'+b.runId+':'+r.orderId,scope:b.scope,kind:'removal',storeId:r.storeId,day:b.day,data:{runId:b.runId,orderId:r.orderId,storeId:r.storeId,businessDay:b.day}}));}}
 await transaction(env,statements,guard(env,sqlFenceFor(b,D),[scopeId(b.scope),b.generation,b.epoch]));return {saved:true};
}
async function publish(env,b,D){
 ident(b.runId,D);ordexaDay(b.day);number(b.count,D,2000);number(b.removalCount??0,D,10000000);if(typeof b.sourceAt!=='string'||!Number.isFinite(Date.parse(b.sourceAt)))invalid(D,'Μη έγκυρη κάλυψη πηγής.');
 const removalCount=b.removalCount||0,receiptId='receipt:'+b.runId,receipt=json(await record(env,receiptId));if(receipt){await fence(env,b,D,false);if(receipt.operationId!==b.operationId||receipt.lease!==b.lease||receipt.scope!==b.scope||receipt.sourceAt!==b.sourceAt||receipt.count!==b.count||receipt.removalCount!==removalCount||receipt.businessDay!==b.day||receipt.finalPass!==(b.finalPass||b.runId+':p2'))invalid(D,'Διαφορετικό αποτέλεσμα με ίδια ταυτότητα δημοσίευσης.',409);return {saved:true,complete:true,replayed:true};}
 await fence(env,b,D);
 const condition=sqlFenceFor(b,D)+" AND (SELECT COUNT(*) FROM store_billing_records WHERE scope=? AND kind='day' AND day=? AND json_extract(data,'$.runId')=?)=? AND (SELECT COUNT(*) FROM store_billing_records WHERE scope=? AND kind='store')=? AND NOT EXISTS(SELECT 1 FROM store_billing_records d LEFT JOIN store_billing_records s ON s.id=d.store_id AND s.scope=d.scope AND s.kind='store' WHERE d.scope=? AND d.kind='day' AND d.day=? AND json_extract(d.data,'$.runId')=? AND (s.id IS NULL OR s.revision<>json_extract(d.data,'$.storeRevision'))) AND (SELECT COUNT(*) FROM store_billing_records WHERE scope=? AND kind='removal' AND day=? AND json_extract(data,'$.runId')=?)=? AND NOT EXISTS(SELECT 1 FROM store_billing_records r LEFT JOIN store_billing_records o ON o.id=json_extract(r.data,'$.orderId') AND o.scope=r.scope AND o.kind='order' AND o.store_id=r.store_id AND o.day=r.day LEFT JOIN store_billing_records s ON s.id=r.store_id AND s.scope=r.scope AND s.kind='store' WHERE r.scope=? AND r.kind='removal' AND r.day=? AND json_extract(r.data,'$.runId')=? AND (o.id IS NULL OR s.id IS NULL OR COALESCE(json_extract(s.data,'$.retainOrders'),0)<>0))";
 const data={activeRun:b.runId,sourceLastSuccessAt:b.sourceAt,computedAt:now(),complete:true,cutoffHour:5,sourcePass:b.finalPass||b.runId+':p2'};
 const prior=json(await record(env,'publication:'+b.scope+':'+b.day));if(prior&&prior.sourceLastSuccessAt>b.sourceAt)invalid(D,'Παλιότερη λήψη δεν αντικαθιστά νεότερη.',409);
 await transaction(env,[
  env.DB.prepare("UPDATE store_billing_records SET data=json_set(data,'$.active',json('false')),revision=revision+1,updated_at=? WHERE scope=? AND kind='order' AND id IN(SELECT json_extract(data,'$.orderId') FROM store_billing_records WHERE scope=? AND kind='removal' AND day=? AND json_extract(data,'$.runId')=?)").bind(now(),b.scope,b.scope,b.day,b.runId),
  env.DB.prepare("UPDATE store_billing_records SET kind='deletion_applied',data=json_set(data,'$.appliedAt',?),updated_at=? WHERE scope=? AND kind='removal' AND day=? AND json_extract(data,'$.runId')=?").bind(now(),now(),b.scope,b.day,b.runId),
  insert(env,{id:'publication:'+b.scope+':'+b.day,scope:b.scope,kind:'publication',day:b.day,data}),
  insert(env,{id:receiptId,scope:b.scope,kind:'receipt',day:b.day,data:{count:b.count,removalCount,sourceAt:b.sourceAt,businessDay:b.day,finalPass:b.finalPass||b.runId+':p2',operationId:b.operationId,lease:b.lease}}),
  env.DB.prepare("DELETE FROM store_billing_records WHERE scope=? AND kind='day' AND day=? AND json_extract(data,'$.runId')<>?").bind(b.scope,b.day,b.runId)
 ],guard(env,condition,[scopeId(b.scope),b.generation,b.epoch,b.scope,b.day,b.runId,b.count,b.scope,b.count,b.scope,b.day,b.runId,b.scope,b.day,b.runId,removalCount,b.scope,b.day,b.runId]));return {saved:true,complete:true};
}
async function progress(env,b,D){
 await fence(env,b,D);ident(b.operationId,D);if(!['running','completed','failed','paused'].includes(b.state)||typeof b.stage!=='string'||b.stage.length>350)invalid(D,'Μη έγκυρη πρόοδος.');
 const r=await env.DB.prepare("UPDATE store_billing_records SET data=json_set(data,'$.state',?,'$.stage',?,'$.updatedAt',?),updated_at=? WHERE id=? AND scope=? AND kind='operation' AND json_extract(data,'$.lease')=? AND json_extract(data,'$.state')='running'").bind(b.state,b.stage,now(),now(),b.operationId,b.scope,b.lease).run();if(!r.meta?.changes)invalid(D,'Η εργασία άλλαξε ή η άδεια έληξε.',409);const pending=await env.DB.prepare("SELECT 1 ok FROM store_billing_records WHERE scope IN (?, '') AND kind='operation' AND json_extract(data,'$.state')='pending' LIMIT 1").bind(b.scope).first();return {saved:true,hasPending:!!pending};
}
async function sync(request,env,b,actor,D){
 range(b.from,b.to,D,31);if(b.from>storeBusinessDay())invalid(D,'Δεν υπάρχουν ακόμη παραγγελίες για μελλοντική ημέρα.');b.to=b.to>storeBusinessDay()?storeBusinessDay():b.to;const scope=await active(env),old=await env.DB.prepare("SELECT * FROM store_billing_records WHERE scope IN (?, '') AND kind='operation' AND json_extract(data,'$.type')='sync' AND json_extract(data,'$.state') IN ('pending','running') AND json_extract(data,'$.from')=? AND json_extract(data,'$.to')=? LIMIT 1").bind(scope,b.from,b.to).first();
 const result=old?json(old):await operation(env,scope,b.from,b.to,'sync',actor.user_id);await wake(env,result.id);return D.wfJson({accepted:true,operation:result},202);
}
async function bulk(request,env,b,actor,D){
 ident(b.operationId,D,100);ordexaDay(b.effectiveDay);if(!Array.isArray(b.stores)||!b.stores.length||b.stores.length>50||new Set(b.stores.map(s=>s.id)).size!==b.stores.length)invalid(D,'Επίλεξε από1 έως50 διαφορετικά καταστήματα.');
 const patch=b.patch||{},keys=Object.keys(patch);if(!keys.length||keys.some(k=>!['unitPriceCents','dailyMinimumCents','chargeOnZero','retainOrders'].includes(k)))invalid(D,'Επίλεξε ποια πεδία θα αλλάξουν.');
 for(const k of keys)if(k==='chargeOnZero'||k==='retainOrders'){if(typeof patch[k]!=='boolean')invalid(D,'Μη έγκυρη επιλογή καταστήματος.');}else number(patch[k],D);
 const pricing=keys.some(k=>k!=='retainOrders'),pricePatch={...patch};delete pricePatch.retainOrders;
 for(const s of b.stores){ident(s.id,D);number(s.revision,D,Number.MAX_SAFE_INTEGER);}
 const requestHash=await hash({actor:actor.user_id,body:b}),prior=json(await record(env,b.operationId));if(prior){if(prior.requestHash!==requestHash)invalid(D,'Η ταυτότητα ενέργειας χρησιμοποιήθηκε με άλλα στοιχεία.',409);return D.wfJson({saved:true,operation:prior,replayed:true});}
 const scope=await active(env);if((await epoch(env)).restoring)invalid(D,'Η επαναφορά βρίσκεται σε εξέλιξη.',409);
 const selected=JSON.stringify(b.stores),stores=rows(await env.DB.prepare("SELECT s.*,(SELECT t.data FROM store_billing_records t WHERE t.scope=s.scope AND t.kind='terms' AND t.store_id=s.id AND t.day<=? ORDER BY t.day DESC,CAST(json_extract(t.data,'$.version') AS INTEGER) DESC LIMIT 1) terms FROM store_billing_records s WHERE s.scope=? AND s.kind='store' AND s.id IN(SELECT json_extract(value,'$.id') FROM json_each(?))").bind(b.effectiveDay,scope,selected).all());
 if(stores.length!==b.stores.length)invalid(D,'Κάποιο κατάστημα δεν είναι διαθέσιμο.',409);
 const terms=pricing?stores.map(s=>{let current=s.terms?JSON.parse(s.terms):{};const t={...current,...pricePatch,id:'terms:'+crypto.randomUUID(),storeId:s.id,effectiveDay:b.effectiveDay,origin:'fleet',version:s.revision+1,supported:true,updatedBy:actor.user_id,updatedAt:now()};if(!Number.isSafeInteger(t.unitPriceCents)||!Number.isSafeInteger(t.dailyMinimumCents)||typeof t.chargeOnZero!=='boolean')invalid(D,'Όρισε τιμή και προαιρετικό ελάχιστο για νέο κατάστημα.');return t;}):[];
 const changedStores=stores.map(s=>{const data=JSON.parse(s.data);if('retainOrders' in patch)data.retainOrders=patch.retainOrders;if(pricing){data.pricingState='ready';data.newStore=false;}return {id:s.id,data};});
 const until=storeBusinessDay(),job={id:b.operationId,scope,from:b.effectiveDay,to:b.effectiveDay>until?b.effectiveDay:until,type:'retainOrders' in patch?'sync':'reprice',state:'pending',stage:'Οι επιλογές αποθηκεύτηκαν · αναμονή Server',requestedBy:actor.user_id,requestHash,requestedAt:now()};
 range(job.from,job.to,D,366);const at=now();const cond="NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN store_billing_records s ON s.id=json_extract(j.value,'$.id') AND s.scope=? AND s.kind='store' WHERE s.id IS NULL OR s.revision<>json_extract(j.value,'$.revision')) AND NOT EXISTS(SELECT 1 FROM store_billing_records WHERE id=?) AND NOT EXISTS(SELECT 1 FROM fleet_settings WHERE key='ordexa_restore_active' AND value<>'')";
 const auditId=crypto.randomUUID();await transaction(env,[
  env.DB.prepare("INSERT INTO store_billing_records(id,scope,kind,store_id,day,data,updated_at) SELECT json_extract(value,'$.id'),?,'terms',json_extract(value,'$.storeId'),json_extract(value,'$.effectiveDay'),value,? FROM json_each(?)").bind(scope,at,JSON.stringify(terms)),
  env.DB.prepare("UPDATE store_billing_records SET revision=revision+1,data=(SELECT json_extract(value,'$.data') FROM json_each(?) WHERE json_extract(value,'$.id')=store_billing_records.id),updated_at=? WHERE scope=? AND kind='store' AND id IN(SELECT json_extract(value,'$.id') FROM json_each(?))").bind(JSON.stringify(changedStores),at,scope,selected),
  env.DB.prepare("UPDATE store_billing_records SET revision=revision+1 WHERE id=?").bind(scopeId(scope)),
  insert(env,{id:job.id,scope,kind:'operation',data:job}),
  env.DB.prepare("INSERT INTO audit_log(id,timestamp,user_id,user_name,role,action,object_type,object_id,old_value,new_value,reason,admin_pin_used) VALUES(?,?,?,?,?,'store_billing_terms','store_billing',?,'{}',?,'Αλλαγή όρων καταστημάτων Fleet',0)").bind(auditId,at,actor.user_id,actor.full_name||'',actor.role,job.id,JSON.stringify({effectiveDay:b.effectiveDay,stores:b.stores,patch}))
 ],guard(env,cond,[selected,scope,b.operationId]));await wake(env,job.id);return D.wfJson({saved:true,operation:job});
}
async function listing(env,url,D){
 const {from,to}=range(url.searchParams.get('from'),url.searchParams.get('to'),D),scope=await active(env),cursor=url.searchParams.get('cursor')||'';if(cursor)ident(cursor,D);
 const select="SELECT s.id,s.revision,json_remove(s.data,'$.sourceTerms') data,COUNT(d.id) coveredDays,COALESCE(SUM(json_extract(d.data,'$.orderCount')),0) orderCount,SUM(json_extract(d.data,'$.orderChargeCents')) orderChargeCents,SUM(json_extract(d.data,'$.minimumTopUpCents')) minimumTopUpCents,SUM(json_extract(d.data,'$.totalChargeCents')) totalChargeCents,SUM(CASE WHEN d.id IS NOT NULL AND json_extract(d.data,'$.totalChargeCents') IS NULL THEN 1 ELSE 0 END) missingTerms,SUM(CASE WHEN d.id IS NOT NULL AND (COALESCE(json_extract(d.data,'$.termsId'),'')<>COALESCE((SELECT t.id FROM store_billing_records t WHERE t.scope=s.scope AND t.kind='terms' AND t.store_id=s.id AND t.day<=d.day ORDER BY t.day DESC,CAST(json_extract(t.data,'$.version') AS INTEGER) DESC LIMIT 1),'') OR COALESCE(json_extract(d.data,'$.retentionUsed'),0)<>COALESCE(json_extract(s.data,'$.retainOrders'),0)) THEN 1 ELSE 0 END) pendingDays,COALESCE(SUM(json_extract(d.data,'$.retainedOrders')),0) retainedOrders,COALESCE(SUM(json_extract(d.data,'$.reviewCount')),0) reviewCount FROM store_billing_records s LEFT JOIN store_billing_records p ON p.scope=s.scope AND p.kind='publication' AND p.day BETWEEN ? AND ? LEFT JOIN store_billing_records d ON d.scope=s.scope AND d.kind='day' AND d.store_id=s.id AND d.day=p.day AND json_extract(d.data,'$.runId')=json_extract(p.data,'$.activeRun') WHERE s.scope=? AND s.kind='store'";
 const found=rows(await env.DB.prepare(select+' AND s.id>? GROUP BY s.id ORDER BY s.id LIMIT 51').bind(from,to,scope,cursor).all());
 const totals=await env.DB.prepare("SELECT SUM(json_extract(d.data,'$.orderCount')) orderCount,SUM(json_extract(d.data,'$.totalChargeCents')) totalChargeCents,SUM(CASE WHEN json_extract(d.data,'$.totalChargeCents') IS NULL THEN 1 ELSE 0 END) missingTerms,COUNT(DISTINCT d.day) coveredDays,MIN(json_extract(p.data,'$.sourceLastSuccessAt')) sourceLastSuccessAt FROM store_billing_records p JOIN store_billing_records d ON d.scope=p.scope AND d.kind='day' AND d.day=p.day AND json_extract(d.data,'$.runId')=json_extract(p.data,'$.activeRun') WHERE p.scope=? AND p.kind='publication' AND p.day BETWEEN ? AND ?").bind(scope,from,to).first();
 const jobs=rows(await env.DB.prepare("SELECT data FROM store_billing_records WHERE scope IN (?,'') AND kind='operation' ORDER BY updated_at DESC LIMIT 3").bind(scope).all()).map(r=>{const v=JSON.parse(r.data);delete v.lease;return v;});
 return {scope,inputRevision:(await record(env,scopeId(scope)))?.revision||0,from,to,cutoffHour:5,timeZone:'Europe/Athens',rows:found.slice(0,50).map(r=>({...r,...JSON.parse(r.data),data:undefined})),hasMore:found.length>50,nextCursor:found[Math.min(50,found.length)-1]?.id||cursor,totals,operations:jobs,syncIntervalMs:3600000,resultRevision:(await env.DB.prepare("SELECT MAX(updated_at) revision FROM store_billing_records WHERE scope=? AND kind='publication' AND day BETWEEN ? AND ?").bind(scope,from,to).first())?.revision||''};
}
export async function routeStoreBilling(request,env,path,D){
 if(!path.startsWith('/api/admin/store-billing')&&!path.startsWith('/api/server/store-billing/'))return null;
 try{
  const url=new URL(request.url),server=path.startsWith('/api/server/'),action=path.split('/').at(-1);
  if(server){if(!await D.serverAuthorized(request,env))invalid(D,'Μη έγκυρος Server.',401);
   const b=request.method==='GET'?Object.fromEntries(url.searchParams):await D.bodyJson(request);
   if(request.method==='POST'&&action==='request'){ident(b.scope,D,100);range(b.from,b.to,D,31);if(b.from>storeBusinessDay())invalid(D,'Δεν υπάρχουν ακόμη παραγγελίες για μελλοντική ημέρα.');b.to=b.to>storeBusinessDay()?storeBusinessDay():b.to;const op=await operation(env,b.scope,b.from,b.to,'sync','server');return D.wfJson({accepted:true,operation:op},202);}
   if(request.method==='POST'&&action==='control')return D.wfJson(await control(env,b,D));
   if(request.method==='GET'&&action==='inputs')return D.wfJson(await input(env,url,b,D));
   if(request.method==='POST'&&action==='catalogue')return D.wfJson(await catalogue(env,b,D));
   if(request.method==='POST'&&action==='archive')return D.wfJson(await archive(env,b,D));
   if(request.method==='POST'&&action==='stage')return D.wfJson(await stage(env,b,D));
   if(request.method==='POST'&&action==='publish')return D.wfJson(await publish(env,b,D));
   if(request.method==='POST'&&action==='progress')return D.wfJson(await progress(env,b,D));
   invalid(D,'Άγνωστη ενέργεια καταστημάτων Server.',404);
  }
  const write=request.method!=='GET',actor=await D.authenticate(request,env,write?'stores.manage':'stores.view');
  if(request.method==='POST'&&action==='sync')return await sync(request,env,await D.bodyJson(request),actor,D);
  if(request.method==='POST'&&action==='bulk')return await bulk(request,env,await D.bodyJson(request),actor,D);
  if(request.method==='GET'&&action==='store-billing')return D.wfJson(await listing(env,url,D));
  if(request.method==='GET'&&action==='operations'){
   const scope=await active(env),{from,to}=range(url.searchParams.get('from'),url.searchParams.get('to'),D);const operations=rows(await env.DB.prepare("SELECT data FROM store_billing_records WHERE scope IN (?,'') AND kind='operation' ORDER BY updated_at DESC LIMIT 5").bind(scope).all()).map(r=>{const v=JSON.parse(r.data);delete v.lease;return v;});const version=await env.DB.prepare("SELECT MAX(updated_at) revision FROM store_billing_records WHERE scope=? AND kind='publication' AND day BETWEEN ? AND ?").bind(scope,from,to).first();return D.wfJson({scope,inputRevision:(await record(env,scopeId(scope)))?.revision||0,operations,resultRevision:version?.revision||''});
  }
  if(request.method==='GET'&&action==='selection'){
   let ids;try{ids=JSON.parse(url.searchParams.get('ids'));}catch{invalid(D,'Μη έγκυρη επιλογή καταστημάτων.');}if(!Array.isArray(ids)||!ids.length||ids.length>50)invalid(D,'Επίλεξε έως50 καταστήματα.');for(const id of ids)ident(id,D);const day=ordexaDay(url.searchParams.get('day')),scope=await active(env);const selected=rows(await env.DB.prepare("SELECT s.id,s.revision,json_remove(s.data,'$.sourceTerms') data,(SELECT t.data FROM store_billing_records t WHERE t.scope=s.scope AND t.kind='terms' AND t.store_id=s.id AND t.day<=? ORDER BY t.day DESC,CAST(json_extract(t.data,'$.version') AS INTEGER) DESC LIMIT 1) terms FROM store_billing_records s WHERE s.scope=? AND s.kind='store' AND s.id IN(SELECT value FROM json_each(?))").bind(day,scope,JSON.stringify(ids)).all());return D.wfJson({rows:selected.map(r=>({...JSON.parse(r.data),id:r.id,revision:r.revision,terms:r.terms?JSON.parse(r.terms):null}))});
  }
  if(request.method==='GET'&&action==='days'){
   const {from,to}=range(url.searchParams.get('from'),url.searchParams.get('to'),D),scope=await active(env),id=ident(url.searchParams.get('storeId'),D);
   return D.wfJson({rows:rows(await env.DB.prepare("SELECT d.data FROM store_billing_records d JOIN store_billing_records p ON p.scope=d.scope AND p.kind='publication' AND p.day=d.day AND json_extract(p.data,'$.activeRun')=json_extract(d.data,'$.runId') WHERE d.scope=? AND d.kind='day' AND d.store_id=? AND d.day BETWEEN ? AND ? ORDER BY d.day").bind(scope,id,from,to).all()).map(r=>JSON.parse(r.data))});
  }
  if(request.method==='GET'&&action==='terms'){const scope=await active(env),id=ident(url.searchParams.get('storeId'),D);return D.wfJson({rows:rows(await env.DB.prepare("SELECT data FROM store_billing_records WHERE scope=? AND kind='terms' AND store_id=? ORDER BY day,CAST(json_extract(data,'$.version') AS INTEGER)").bind(scope,id).all()).map(r=>JSON.parse(r.data))});}
  invalid(D,'Άγνωστη ενέργεια καταστημάτων.',404);
 }catch(e){if(e.storeConflict)throw new D.ApiError(409,e.message);throw e;}
}
