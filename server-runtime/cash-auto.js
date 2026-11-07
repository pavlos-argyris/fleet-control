import {list,hash,stamp,day,NativeError,audit,reply,integer} from './common.js';
import {CASH_ORDER_CONTRACT as CONTRACT,cashContext} from './cash-contract.js';

export const CASH_AUTO_SCHEMA=`
CREATE TABLE IF NOT EXISTS native_cash_auto_days(scope TEXT NOT NULL,day TEXT NOT NULL,state TEXT NOT NULL,proof TEXT NOT NULL DEFAULT '',source_digest TEXT NOT NULL DEFAULT '',cursor TEXT NOT NULL DEFAULT '',source_at TEXT NOT NULL DEFAULT '',source_complete_at TEXT,applied_at TEXT,issues TEXT NOT NULL DEFAULT '[]',PRIMARY KEY(scope,day));
CREATE TABLE IF NOT EXISTS native_cash_auto_orders(scope TEXT NOT NULL,order_id TEXT NOT NULL,revision INTEGER NOT NULL,business_day TEXT NOT NULL,store_id TEXT NOT NULL,employee_id TEXT,financial_fingerprint TEXT NOT NULL,event_id TEXT,data TEXT NOT NULL,source_at TEXT NOT NULL,PRIMARY KEY(scope,order_id));
CREATE INDEX IF NOT EXISTS native_cash_auto_order_day ON native_cash_auto_orders(scope,business_day,order_id);
CREATE TABLE IF NOT EXISTS native_cash_auto_history(id TEXT PRIMARY KEY,scope TEXT NOT NULL,order_id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(scope,order_id,revision));
CREATE TABLE IF NOT EXISTS native_cash_auto_exclusions(id TEXT PRIMARY KEY,scope TEXT NOT NULL,order_id TEXT NOT NULL,revision INTEGER NOT NULL,excluded INTEGER NOT NULL CHECK(excluded IN(0,1)),notes TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(scope,order_id,revision));
CREATE TABLE IF NOT EXISTS native_cash_manual_reconciliations(id TEXT PRIMARY KEY,scope TEXT NOT NULL,day TEXT NOT NULL,proof TEXT NOT NULL,manual_ids TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS native_cash_auto_history_no_update BEFORE UPDATE ON native_cash_auto_history BEGIN SELECT RAISE(ABORT,'cash_auto_history_immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_cash_auto_history_no_delete BEFORE DELETE ON native_cash_auto_history BEGIN SELECT RAISE(ABORT,'cash_auto_history_immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_cash_exclusions_no_update BEFORE UPDATE ON native_cash_auto_exclusions BEGIN SELECT RAISE(ABORT,'cash_exclusions_versioned'); END;
CREATE TRIGGER IF NOT EXISTS native_cash_exclusions_no_delete BEFORE DELETE ON native_cash_auto_exclusions BEGIN SELECT RAISE(ABORT,'cash_exclusions_versioned'); END;
CREATE TRIGGER IF NOT EXISTS native_cash_reconcile_no_update BEFORE UPDATE ON native_cash_manual_reconciliations BEGIN SELECT RAISE(ABORT,'cash_reconcile_immutable'); END;
CREATE TRIGGER IF NOT EXISTS native_cash_reconcile_no_delete BEFORE DELETE ON native_cash_manual_reconciliations BEGIN SELECT RAISE(ABORT,'cash_reconcile_immutable'); END;
`;
const SYSTEM={user_id:'native-ordexa-cash',full_name:'Αυτόματο Ταμείο Ordexa',role:'server'};
const ACTIVE="c.kind='cash_source_coverage' AND json_extract(c.data,'$.runId')=json_extract(n.data,'$.runId') AND json_extract(c.data,'$.ordersCoverageComplete')=1 AND COALESCE(json_extract(c.data,'$.needsSourceRefresh'),0)=0 AND json_extract(c.data,'$.revision')=?";
const EVENT_INSERT='INSERT INTO native_cash_events(id,kind,business_day,courier_id,courier_name,store_id,category,quantity,rate_cents,amount_cents,rule_id,reverses_id,source_key,notes,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
const decode=value=>typeof value==='string'?JSON.parse(value):value;
function requireSource(env){const source=cashContext();if(!env.LOCAL_PRIMARY||!source.configured||source.historicalOnly||!source.scope||!source.generation)throw new NativeError(409,'Χρειάζεται ενεργό Ordexa στην κύρια βάση Server.');return source;}
async function requestKey(scope,date){return 'cash-apply:'+await hash({scope,id:date});}
export async function queueAutomaticDay(env,scope,date,reason='source'){
  const key=await requestKey(scope,date),data=JSON.stringify({day:date,reason,requestId:crypto.randomUUID(),requestedAt:stamp()});
  await env.DB.prepare("INSERT INTO store_billing_local(id,kind,scope,store_id,day,data,dirty) VALUES(?,'cash_apply_request',?,'',?,?,0) ON CONFLICT(id) DO UPDATE SET data=excluded.data,kind=excluded.kind,dirty=0").bind(key,scope,date,data).run();
}
export async function queueAutomaticDays(env,scope,from,to='9999-12-31'){
  // Native-only cells. The coverage-key suffix is the same canonical scope/day SHA.
  await env.DB.prepare("INSERT INTO store_billing_local(id,kind,scope,store_id,day,data,dirty) SELECT replace(id,'cash-coverage:','cash-apply:'),'cash_apply_request',scope,'',day,json_object('day',day,'requestId',?,'requestedAt',?,'reason','configuration'),0 FROM store_billing_local WHERE scope=? AND kind='cash_source_coverage' AND id LIKE 'cash-coverage:%' AND day BETWEEN ? AND ? ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,data=excluded.data,dirty=0").bind(crypto.randomUUID(),stamp(),scope,from,to).run();
}
async function configuration(env,scope,date){
  const rules=list(await env.DB.prepare("SELECT r.* FROM native_cash_rules r WHERE r.effective_day<=? AND r.id=(SELECT x.id FROM native_cash_rules x WHERE x.store_id=r.store_id AND x.category=r.category AND x.effective_day<=? ORDER BY x.effective_day DESC,x.revision DESC LIMIT 1) AND EXISTS(SELECT 1 FROM store_billing_local s WHERE s.scope=? AND s.kind='store' AND s.id=r.store_id) ORDER BY r.store_id,r.category").bind(date,date,scope).all());
  const links=list(await env.DB.prepare('SELECT l.*,u.full_name current_name FROM native_cash_rider_links l LEFT JOIN app_users u ON u.id=l.employee_id WHERE l.scope=? AND l.effective_day<=? AND l.id=(SELECT x.id FROM native_cash_rider_links x WHERE x.scope=l.scope AND x.rider_id=l.rider_id AND x.effective_day<=? ORDER BY x.effective_day DESC,x.revision DESC LIMIT 1) ORDER BY l.rider_id').bind(scope,date,date).all());
  const exclusions=list(await env.DB.prepare('SELECT e.* FROM native_cash_auto_exclusions e WHERE e.scope=? AND e.id=(SELECT x.id FROM native_cash_auto_exclusions x WHERE x.scope=e.scope AND x.order_id=e.order_id ORDER BY x.revision DESC LIMIT 1) ORDER BY e.order_id').bind(scope).all());
  const byStore=new Map();for(const rule of rules)if(rule.rate_cents>0){if(!byStore.has(rule.store_id))byStore.set(rule.store_id,[]);byStore.get(rule.store_id).push(rule);}
  return{rules,links,exclusions,byStore,byRider:new Map(links.map(row=>[row.rider_id,row])),excluded:new Set(exclusions.filter(row=>row.excluded).map(row=>row.order_id))};
}
function selectRule(cfg,store,pin){if(pin)return pin;const candidates=cfg.byStore.get(store)||[];return candidates.length===1?candidates[0]:null;}
async function sourceCoverage(env,scope,date){const row=await env.DB.prepare("SELECT data FROM store_billing_local WHERE scope=? AND kind='cash_source_coverage' AND day=?").bind(scope,date).first();return row?decode(row.data):null;}
function complete(source){return source?.revision===CONTRACT.revision&&source.identityVerified===true&&source.ordersCoverageComplete===true&&!source.needsSourceRefresh&&source.timeSemanticsVerified===true&&source.cancellationSemanticsVerified===true&&/^[a-f0-9]{64}$/.test(source.sourceDigest||'')&&Number.isFinite(Date.parse(source.lastCompleteAt));}
export async function cashAutomaticPreview(env,date){
  const source=requireSource(env);return publicPlan(await plan(env,source,day(date)));
}
function publicPlan(p){return{day:p.day,scope:p.scope,state:p.state,proof:p.proof||null,issues:p.issues,manualEvents:p.manual||[],forecast:p.forecast||[],sourceCompleteAt:p.coverage?.lastCompleteAt||null};}
async function plan(env,source,date){
  const coverage=await sourceCoverage(env,source.scope,date),base={scope:source.scope,day:date,coverage,state:'partial',issues:[]};
  if(!complete(coverage))return{...base,issues:[{code:'source-incomplete',message:'Χρειάζεται νέα πλήρης συνεπής λήψη παραγγελιών.'}]};
  const cfg=await configuration(env,source.scope,date);if(!cfg.byStore.size&&!await env.DB.prepare('SELECT 1 found FROM native_cash_auto_orders WHERE scope=? AND business_day=? LIMIT 1').bind(source.scope,date).first())return{...base,cfg,state:'not-configured',issues:[{code:'no-participating-stores',message:'Επίλεξε καταστήματα και κανόνες απόδοσης.'}]};
  const inputProof=await hash({contract:CONTRACT.revision,scope:source.scope,day:date,source:coverage.sourceDigest,rules:cfg.rules.map(r=>r.id),links:cfg.links.map(r=>r.id),exclusions:cfg.exclusions.map(r=>r.id)});
  const groups=list(await env.DB.prepare("SELECT n.store_id storeId,json_extract(n.data,'$.sourceRiderId') riderId,CASE WHEN json_extract(s.data,'$.pinnedDay')=n.day AND json_extract(s.data,'$.pinnedRule.store_id')=n.store_id AND (json_extract(s.data,'$.pinFinal')=1 OR json_extract(s.data,'$.pinProof')=?) THEN json_extract(s.data,'$.pinnedRule') ELSE NULL END pinnedRule,COUNT(*) quantity FROM store_billing_local n LEFT JOIN native_cash_auto_orders s ON s.scope=n.scope AND s.order_id=json_extract(n.data,'$.sourceOrderId') WHERE n.scope=? AND n.kind='cash_snapshot_order' AND n.day=? AND json_extract(n.data,'$.runId')=? AND json_extract(n.data,'$.sourceOrderId') NOT IN(SELECT value FROM json_each(?)) GROUP BY n.store_id,riderId,pinnedRule").bind(inputProof,source.scope,date,coverage.runId,JSON.stringify([...cfg.excluded])).all());
  const issues=[],forecast=[],participating=new Set(cfg.byStore.keys());
  for(const group of groups){
    const pin=group.pinnedRule?decode(group.pinnedRule):null,candidates=cfg.byStore.get(group.storeId)||[];if(!pin&&!candidates.length)continue;participating.add(group.storeId);
    const rule=selectRule(cfg,group.storeId,pin),link=cfg.byRider.get(group.riderId);
    if(rule&&(!Number.isSafeInteger(rule.rate_cents)||rule.rate_cents<1||rule.rate_cents>100000000))issues.push({code:'invalid-tariff',storeId:group.storeId,message:'Η ιστορική τιμή χρειάζεται έλεγχο.'});
    if(!rule)issues.push({code:'ambiguous-category',storeId:group.storeId,message:'Υπάρχουν πολλαπλές ενεργές κατηγορίες για το κατάστημα.'});
    if(!link?.employee_id||!link.current_name)issues.push({code:'unmapped',riderId:group.riderId,storeId:group.storeId,quantity:group.quantity,message:'Επίλεξε εργαζόμενο για τον διανομέα Ordexa.'});
    if(rule&&link?.employee_id&&link.current_name)forecast.push({storeId:group.storeId,courierId:link.employee_id,courierName:link.current_name,category:rule.category,rateCents:rule.rate_cents,quantity:group.quantity,amountCents:group.quantity*rule.rate_cents});
  }
  const manual=list(await env.DB.prepare("SELECT e.* FROM native_cash_events e WHERE e.business_day=? AND e.kind='assessment' AND (e.source_key IS NULL OR e.source_key NOT LIKE 'ordexa:%') AND e.store_id IN(SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM native_cash_events r WHERE r.reverses_id=e.id) ORDER BY e.id").bind(date,JSON.stringify([...participating])).all());
  const proof=await hash({inputProof,manual:manual.map(r=>r.id)});
  return{...base,cfg,inputProof,proof,manual,forecast,issues:issues.slice(0,40),state:issues.length?(issues.some(i=>i.code==='unmapped')?'unmapped':'review'):manual.length?'manual-review':'ready'};
}
async function reverse(env,original,sourceKey,actor,notes){
  if(await env.DB.prepare('SELECT 1 found FROM native_cash_events WHERE reverses_id=?').bind(original.id).first())return false;
  await env.DB.prepare(EVENT_INSERT).bind(crypto.randomUUID(),'reversal',original.business_day,original.courier_id,original.courier_name,original.store_id,original.category,original.quantity,original.rate_cents,original.amount_cents,original.rule_id,original.id,sourceKey,notes,actor.user_id,actor.full_name||actor.username,stamp()).run();return true;
}
export async function reconcileManualCash(request,env,user){
  const b=await request.json(),source=requireSource(env),date=day(b.day);if(b.scope!==source.scope||b.decision!=='replace-manual-with-ordexa')throw new NativeError(409,'Έλεγξε ξανά την πηγή και την απόφαση συμφιλίωσης.');
  const p=await plan(env,source,date);if(!p.proof||p.proof!==b.proof||p.issues.length||!p.manual?.length)throw new NativeError(409,'Η πηγή, οι κανόνες ή οι κινήσεις άλλαξαν. Ανανέωσε την προεπισκόπηση.','reconciliation_conflict');
  const id=crypto.randomUUID();for(const item of p.manual)await reverse(env,item,'reconcile:'+id+':'+item.id,user,'Ρητή συμφιλίωση χειροκίνητων ποσοτήτων με Ordexa· οι παραλαβές διατηρούνται.');
  await env.DB.prepare('INSERT INTO native_cash_manual_reconciliations(id,scope,day,proof,manual_ids,actor_id,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,source.scope,date,p.proof,JSON.stringify(p.manual.map(r=>r.id)),user.user_id,stamp()).run();
  await queueAutomaticDay(env,source.scope,date,'manual-reconciled');await audit(env,request,user,'cash_manual_reconciliation','cash_day',date,null,{id,scope:source.scope,manualIds:p.manual.map(r=>r.id),proof:p.proof},'Αντικατάσταση χειροκίνητων ποσοτήτων με Ordexa χωρίς μεταβολή παραλαβών ή μισθοδοσίας.');return reply({saved:true,queued:true,id});
}
async function saveDay(env,p,state,cursor,issues=[]){
  const before=await env.DB.prepare('SELECT * FROM native_cash_auto_days WHERE scope=? AND day=?').bind(p.scope,p.day).first(),encoded=JSON.stringify(issues),at=stamp();
  const changed=!before||before.state!==state||before.proof!==(p.proof||'')||before.cursor!==cursor||before.issues!==encoded||state==='ready'&&before.source_complete_at!==p.coverage.lastCompleteAt;
  if(changed)await env.DB.prepare('INSERT INTO native_cash_auto_days(scope,day,state,proof,source_digest,cursor,source_at,source_complete_at,applied_at,issues) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,day) DO UPDATE SET state=excluded.state,proof=excluded.proof,source_digest=excluded.source_digest,cursor=excluded.cursor,source_at=excluded.source_at,source_complete_at=excluded.source_complete_at,applied_at=excluded.applied_at,issues=excluded.issues').bind(p.scope,p.day,state,p.proof||'',p.coverage?.sourceDigest||'',cursor,p.coverage?.sourceAt||'',state==='ready'?p.coverage.lastCompleteAt:before?.source_complete_at||null,state==='ready'?at:before?.applied_at||null,encoded).run();
  return changed;
}
async function acknowledge(env,request){await env.DB.prepare("DELETE FROM store_billing_local WHERE id=? AND kind='cash_apply_request' AND data=?").bind(request.id,request.data).run();}
async function latestSourceRows(env,scope,ids){
  return list(await env.DB.prepare(`SELECT n.data,n.store_id,c.day,json_extract(c.data,'$.sourceAt') sourceAt,json_extract(c.data,'$.lastCompleteAt') completeAt FROM store_billing_local n JOIN store_billing_local c ON c.scope=n.scope AND c.day=n.day AND ${ACTIVE} WHERE n.scope=? AND n.kind='cash_snapshot_order' AND json_extract(n.data,'$.sourceOrderId') IN(SELECT value FROM json_each(?)) ORDER BY c.day,n.id`).bind(CONTRACT.revision,scope,JSON.stringify(ids)).all());
}
async function persistOrder(env,previous,value){
  const revision=(previous?.revision||0)+1,id=crypto.randomUUID(),data=JSON.stringify(value.data);
  await env.DB.prepare('INSERT INTO native_cash_auto_history(id,scope,order_id,revision,data,created_at) VALUES(?,?,?,?,?,?)').bind(id,value.scope,value.orderId,revision,JSON.stringify({...value,revision}),stamp()).run();
  const saved=await env.DB.prepare('INSERT INTO native_cash_auto_orders(scope,order_id,revision,business_day,store_id,employee_id,financial_fingerprint,event_id,data,source_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,order_id) DO UPDATE SET revision=excluded.revision,business_day=excluded.business_day,store_id=excluded.store_id,employee_id=excluded.employee_id,financial_fingerprint=excluded.financial_fingerprint,event_id=excluded.event_id,data=excluded.data,source_at=excluded.source_at WHERE native_cash_auto_orders.revision=?').bind(value.scope,value.orderId,revision,value.day,value.storeId,value.employeeId,value.fingerprint,value.eventId,data,value.sourceAt,previous?.revision||0).run();
  if(Number(saved?.meta?.changes)!==1)throw Error('Automatic cash state changed before commit');
}
async function askSourceRefresh(env,source,date){
  const key='cash-refresh:'+await hash({scope:source.scope,id:date});await env.DB.prepare("INSERT OR IGNORE INTO store_billing_local(id,kind,scope,store_id,day,data,dirty) VALUES(?,'cash_refresh_request',?,'',?,?,0)").bind(key,source.scope,date,JSON.stringify({from:date,to:date,generation:source.generation,requestId:crypto.randomUUID(),requestedAt:stamp()})).run();
}
export async function applyAutomaticCashBatch(env){
  const source=requireSource(env),request=await env.DB.prepare("SELECT id,day,data FROM store_billing_local WHERE scope=? AND kind='cash_apply_request' ORDER BY day DESC LIMIT 1").bind(source.scope).first();
  if(!request)return{changed:false,idle:true};const p=await plan(env,source,request.day);
  if(p.state!=='ready'){const changed=await saveDay(env,p,p.state,'',p.issues);await acknowledge(env,request);return{changed,state:p.state,day:p.day};}
  const before=await env.DB.prepare('SELECT * FROM native_cash_auto_days WHERE scope=? AND day=?').bind(source.scope,p.day).first();
  if(before?.state==='ready'&&before.proof===p.proof){const changed=await saveDay(env,p,'ready','');await acknowledge(env,request);return{changed,state:'ready',day:p.day};}
  const cursor=before?.proof===p.proof&&before.state==='applying'?before.cursor:'',ids=list(await env.DB.prepare("SELECT order_id FROM(SELECT json_extract(data,'$.sourceOrderId') order_id FROM store_billing_local WHERE scope=? AND kind='cash_snapshot_order' AND day=? AND json_extract(data,'$.runId')=? AND (store_id IN(SELECT value FROM json_each(?)) OR EXISTS(SELECT 1 FROM native_cash_auto_orders s WHERE s.scope=store_billing_local.scope AND s.order_id=json_extract(store_billing_local.data,'$.sourceOrderId'))) UNION SELECT order_id FROM native_cash_auto_orders WHERE scope=? AND business_day=?) WHERE order_id>? ORDER BY order_id LIMIT 200").bind(source.scope,p.day,p.coverage.runId,JSON.stringify([...p.cfg.byStore.keys()]),source.scope,p.day,cursor).all()).map(row=>row.order_id);
  const rows=await latestSourceRows(env,source.scope,ids),grouped=new Map();for(const row of rows){const data=decode(row.data),id=data.sourceOrderId;if(!grouped.has(id))grouped.set(id,[]);grouped.get(id).push({...row,value:data});}
  const states=list(await env.DB.prepare('SELECT * FROM native_cash_auto_orders WHERE scope=? AND order_id IN(SELECT value FROM json_each(?))').bind(source.scope,JSON.stringify(ids)).all()),stateById=new Map(states.map(row=>[row.order_id,row])),plans=new Map([[p.day,p]]);let movements=0;
  for(const id of ids){
    const previous=stateById.get(id),matches=grouped.get(id)||[];
    if(new Set(matches.map(row=>row.value.fingerprint)).size>1){const oldest=[...matches].sort((a,b)=>a.sourceAt.localeCompare(b.sourceAt))[0];await askSourceRefresh(env,source,oldest.day);const changed=await saveDay(env,p,'partial','',[{code:'cross-day-source',orderId:id,message:'Η μεταφορά παραγγελίας μεταξύ ημερών χρειάζεται πλήρη επανέλεγχο.'}]);await acknowledge(env,request);return{changed:changed||movements>0,state:'partial',day:p.day};}
    const candidate=matches[0]||null,sourceAt=candidate?.sourceAt||p.coverage.sourceAt;
    if(previous&&sourceAt<previous.source_at){await askSourceRefresh(env,source,p.day);const changed=await saveDay(env,p,'partial','',[{code:'older-source',message:'Διατηρήθηκε η νεότερη θέση παραγγελίας· εκκρεμεί επανέλεγχος.'}]);await acknowledge(env,request);return{changed:changed||movements>0,state:'partial',day:p.day};}
    const date=candidate?.day||previous?.business_day||p.day,store=candidate?.store_id||previous?.store_id||'';if(!plans.has(date))plans.set(date,await plan(env,source,date));const targetPlan=plans.get(date);
    if(candidate&&!['ready','not-configured'].includes(targetPlan.state)){await queueAutomaticDay(env,source.scope,date,'other-day-review');const changed=await saveDay(env,p,'partial','',[{code:'other-day-review',day:date,message:'Χρειάζεται έλεγχος στην ημέρα '+date+' πριν μεταφερθεί η χρέωση.'}]);await acknowledge(env,request);return{changed:changed||movements>0,state:'partial',day:p.day};}
    const cfg=targetPlan.cfg||p.cfg,oldData=previous?decode(previous.data):{},pin=oldData.pinnedDay===date&&oldData.pinnedRule?.store_id===store&&(oldData.pinFinal===true||oldData.pinProof===targetPlan.inputProof)?oldData.pinnedRule:null;
    const rule=candidate?selectRule(cfg,store,pin):null,participates=!!candidate&&(!!pin||cfg.byStore.has(store)),link=candidate?cfg.byRider.get(candidate.value.sourceRiderId):null,excluded=cfg.excluded.has(id);
    if(!previous&&!participates)continue;
    if(participates&&!excluded&&(!rule||!Number.isSafeInteger(rule.rate_cents)||rule.rate_cents<1||rule.rate_cents>100000000||!link?.employee_id||!link.current_name)){
      const changed=await saveDay(env,p,'unmapped','',[{code:rule?'unmapped':'ambiguous-category',orderId:id,riderId:candidate.value.sourceRiderId,message:'Χρειάζεται αντιστοίχιση ή επιλογή μοναδικής κατηγορίας.'}]);await acknowledge(env,request);return{changed:changed||movements>0,state:'unmapped',day:p.day};
    }
    const target=participates&&!excluded?{day:date,storeId:store,employeeId:link.employee_id,employeeName:link.current_name,rule}:null;
    const fingerprint=await hash(target?{day:date,storeId:store,employeeId:target.employeeId,category:rule.category,rateCents:rule.rate_cents,ruleId:rule.id}:{state:excluded?'excluded':'absent'});
    if(previous?.financial_fingerprint===fingerprint){if(target&&oldData.pinFinal!==true&&oldData.pinProof!==targetPlan.inputProof)await env.DB.prepare("UPDATE native_cash_auto_orders SET data=json_set(data,'$.pinProof',?) WHERE scope=? AND order_id=?").bind(targetPlan.inputProof,source.scope,id).run();continue;}
    const revision=(previous?.revision||0)+1,key='ordexa:'+await hash({scope:source.scope,id,revision});
    if(previous?.event_id){const original=await env.DB.prepare('SELECT * FROM native_cash_events WHERE id=?').bind(previous.event_id).first();if(!original)throw Error('Missing automatic cash event');if(await reverse(env,original,key+':reverse',SYSTEM,'Αντιλογισμός μετά από πλήρη πηγή Ordexa / ρητή αλλαγή αντιστοίχισης.'))movements++;}
    let eventId=null;
    if(target){eventId=crypto.randomUUID();await env.DB.prepare(EVENT_INSERT).bind(eventId,'assessment',date,target.employeeId,target.employeeName,store,rule.category,1,rule.rate_cents,rule.rate_cents,rule.id,null,key+':assessment','Παράδοση Ordexa · πλήρης συνεπής λήψη · ανεξάρτητη ιστορική τιμή.',SYSTEM.user_id,SYSTEM.full_name,stamp()).run();movements++;}
    await persistOrder(env,previous,{scope:source.scope,orderId:id,day:date,storeId:store,employeeId:target?.employeeId||previous?.employee_id||null,eventId,fingerprint,sourceAt,data:{pinnedRule:target?.rule||pin||oldData.pinnedRule||null,pinnedDay:target?date:oldData.pinnedDay||previous?.business_day||null,pinProof:target?targetPlan.inputProof:oldData.pinProof||null,pinFinal:target?!!pin&&oldData.pinFinal===true:oldData.pinFinal===true,sourceFingerprint:candidate?.value.fingerprint||null,excluded,reason:target?'delivered':excluded?'manual-exclusion':'absent'}});
    for(const movedDay of new Set([previous?.business_day,date]))if(movedDay&&movedDay!==p.day)await queueAutomaticDay(env,source.scope,movedDay,'order-moved');
  }
  const done=ids.length<200;if(done)await env.DB.prepare("UPDATE native_cash_auto_orders SET data=json_set(data,'$.pinFinal',json('true')) WHERE scope=? AND business_day=? AND json_extract(data,'$.pinProof')=? AND COALESCE(json_extract(data,'$.pinFinal'),0)=0").bind(source.scope,p.day,p.inputProof).run();const changed=await saveDay(env,p,done?'ready':'applying',done?'':ids[ids.length-1]);if(done)await acknowledge(env,request);
  if(movements||done&&changed)await audit(env,new Request((source.worker||'https://native.invalid')+'/api/server/cash/apply'),SYSTEM,'cash_ordexa_apply','cash_day',p.day,null,{scope:source.scope,proof:p.proof,movements,done},'Αυτόματη εφαρμογή επαληθευμένων παραδόσεων, χωρίς μισθοδοσία.');
  return{changed:changed||movements>0,state:done?'ready':'applying',day:p.day,processed:ids.length,movements};
}
export async function preserveAutomaticReversal(env,original,user,notes){
  const state=await env.DB.prepare('SELECT * FROM native_cash_auto_orders WHERE event_id=?').bind(original.id).first();if(!state)return;
  const previous=await env.DB.prepare('SELECT revision FROM native_cash_auto_exclusions WHERE scope=? AND order_id=? ORDER BY revision DESC LIMIT 1').bind(state.scope,state.order_id).first();
  await env.DB.prepare('INSERT INTO native_cash_auto_exclusions(id,scope,order_id,revision,excluded,notes,actor_id,created_at) VALUES(?,?,?,?,1,?,?,?)').bind(crypto.randomUUID(),state.scope,state.order_id,(previous?.revision||0)+1,notes,user.user_id,stamp()).run();await queueAutomaticDay(env,state.scope,state.business_day,'explicit-exclusion');
}
export async function resumeAutomaticOrder(request,env,user){
  const b=await request.json(),source=requireSource(env),expected=integer(b.expectedRevision),notes=String(b.notes||'').trim();if(b.scope!==source.scope||!notes||notes.length>500)throw new NativeError(400,'Γράψε αιτιολογία και έλεγξε την ενεργή πηγή.');
  const previous=await env.DB.prepare('SELECT * FROM native_cash_auto_exclusions WHERE scope=? AND order_id=? ORDER BY revision DESC LIMIT 1').bind(source.scope,String(b.orderId)).first(),state=await env.DB.prepare('SELECT business_day FROM native_cash_auto_orders WHERE scope=? AND order_id=?').bind(source.scope,String(b.orderId)).first();
  if(!previous?.excluded||previous.revision!==expected||!state)throw new NativeError(409,'Η εξαίρεση άλλαξε. Ανανέωσε τη λίστα.');
  const id=crypto.randomUUID();await env.DB.prepare('INSERT INTO native_cash_auto_exclusions(id,scope,order_id,revision,excluded,notes,actor_id,created_at) VALUES(?,?,?,?,0,?,?,?)').bind(id,source.scope,String(b.orderId),expected+1,notes,user.user_id,stamp()).run();await queueAutomaticDay(env,source.scope,state.business_day,'resume');await audit(env,request,user,'cash_auto_resume','cash_order',String(b.orderId),previous,{revision:expected+1},notes);return reply({saved:true,queued:true});
}
export async function automaticCashStatus(env,sourceStatus,from,to){
  const source=cashContext();if(!source.configured||!source.scope)return sourceStatus;if(source.historicalOnly)return{...sourceStatus,state:'stale',coverageVerified:false};
  const days=list(await env.DB.prepare("SELECT d.*,c.data coverage,EXISTS(SELECT 1 FROM store_billing_local q WHERE q.scope=d.scope AND q.day=d.day AND q.kind='cash_apply_request') pending FROM native_cash_auto_days d JOIN store_billing_local c ON c.scope=d.scope AND c.day=d.day AND c.kind='cash_source_coverage' WHERE d.scope=? AND d.day BETWEEN ? AND ? ORDER BY d.day").bind(source.scope,from,to).all());
  const expected=Math.round((Date.parse(to+'T12:00:00Z')-Date.parse(from+'T12:00:00Z'))/86400000)+1;
  const ready=days.filter(row=>{const cov=decode(row.coverage);return row.state==='ready'&&!row.pending&&complete(cov)&&cov.sourceDigest===row.source_digest;}),all=ready.length===expected&&!sourceStatus.pendingDays&&!sourceStatus.financialJobError&&!['error','backoff','stale'].includes(sourceStatus.state),times=days.map(row=>row.source_complete_at).filter(at=>Number.isFinite(Date.parse(at))).sort();
  const financialRevision=await hash({scope:source.scope,days:days.map(row=>[row.day,row.state,row.proof,row.cursor,row.source_complete_at,row.pending])});
  return{...sourceStatus,protocolVerified:true,timeSemanticsVerified:true,cancellationSemanticsVerified:true,automaticWritesEnabled:true,
    state:all?'ready':sourceStatus.financialJobError?'error':sourceStatus.state==='backoff'?'backoff':days.some(row=>row.state==='manual-review')?'manual-review':days.some(row=>row.state==='unmapped')?'unmapped':days.some(row=>row.state==='not-configured')?'not-configured':sourceStatus.state==='pending'||days.some(row=>row.state==='applying'||row.pending)?'pending':'partial',coverageVerified:all,lastCompleteAt:times[times.length-1]||null,financialRevision,
    financialDaysComplete:ready.length,financialDaysExpected:expected,issues:days.filter(row=>row.state!=='ready'||row.pending).map(row=>({day:row.day,state:row.state,issues:decode(row.issues)}))};
}
export async function automaticCashOverview(env,from,to){
  const source=requireSource(env),days=list(await env.DB.prepare('SELECT * FROM native_cash_auto_days WHERE scope=? AND day BETWEEN ? AND ? ORDER BY day DESC').bind(source.scope,from,to).all()),exclusions=list(await env.DB.prepare('SELECT e.*,s.business_day,s.store_id FROM native_cash_auto_exclusions e JOIN native_cash_auto_orders s ON s.scope=e.scope AND s.order_id=e.order_id WHERE e.scope=? AND s.business_day BETWEEN ? AND ? AND e.excluded=1 AND e.id=(SELECT x.id FROM native_cash_auto_exclusions x WHERE x.scope=e.scope AND x.order_id=e.order_id ORDER BY x.revision DESC LIMIT 1) ORDER BY e.created_at DESC LIMIT 200').bind(source.scope,from,to).all());return{scope:source.scope,contract:CONTRACT,days:days.map(row=>({...row,issues:decode(row.issues)})),exclusions};
}
