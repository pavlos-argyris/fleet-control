import assert from 'node:assert/strict';
import {WORKFORCE_SCHEMA} from '../cloudflare-worker/src/workforce.js';
import {createSimulation} from './fixtures/workforce-simulation.mjs';
import {CASH_SCHEMA} from '../server-runtime/cash.js';
import {CASH_AUTO_SCHEMA,queueAutomaticDay,applyAutomaticCashBatch,cashAutomaticPreview,reconcileManualCash,preserveAutomaticReversal,resumeAutomaticOrder,automaticCashStatus} from '../server-runtime/cash-auto.js';
import {CASH_ORDER_CONTRACT as CONTRACT} from '../server-runtime/cash-contract.js';
import {hash} from '../server-runtime/common.js';
const date='2026-11-07',scope='auto-fixture';let clock=Date.now()-60000;
globalThis.FleetHost=command=>{assert.equal(command,'store.context');return{configured:true,scope,generation:'generation1',worker:'https://simulation.invalid'};};
async function fixture(){
 const simulation=createSimulation();await simulation.db.exec(WORKFORCE_SCHEMA);
 const db=simulation.db;await db.exec(CASH_SCHEMA+CASH_AUTO_SCHEMA+"CREATE TABLE store_billing_local(id TEXT PRIMARY KEY,kind TEXT,scope TEXT,store_id TEXT,day TEXT,data TEXT,dirty INTEGER DEFAULT 0);");
 for(const id of ['employee-a','employee-b'])db.sqlite.prepare("INSERT INTO app_users(id,full_name,username,password_hash,password_salt,role,active,login_enabled,created_at,updated_at) VALUES(?,?,?,'','','employee',1,0,?,?)").run(id,id,id,new Date().toISOString(),new Date().toISOString());
 for(const shop of ['shop-a','shop-b']){db.sqlite.prepare("INSERT INTO store_billing_local VALUES(?,'store',?,?, '',?,0)").run(shop,scope,shop,JSON.stringify({id:shop}));db.sqlite.prepare("INSERT INTO native_cash_rules VALUES(?,?, 'Α','2026-01-01',1,250,?,'owner')").run('rule-'+shop,shop,new Date().toISOString());}
 for(const[rider,employee]of[['17','employee-a'],['18','employee-b']])db.sqlite.prepare("INSERT INTO native_cash_rider_links VALUES(?,?,?,'2026-01-01',1,?,?,?,'owner')").run('link-'+rider,scope,rider,employee,employee,new Date().toISOString());
 const env={...simulation.env,LOCAL_PRIMARY:true,DB:db};return{...simulation,env};
}
async function source(f,rows,day=date,complete=true){
 const run=crypto.randomUUID(),at=new Date(clock+=1000).toISOString(),normalized=await Promise.all(rows.map(async r=>({sourceOrderId:String(r.id),sourceRiderId:String(r.rider??17),sourceShopId:r.store||'shop-a',businessDay:day,at:r.at||day+'T09:00:00Z',nickname:r.nickname||'Synthetic alias',runId:run,identityVerified:true,fingerprint:await hash({id:r.id,rider:r.rider??17,store:r.store||'shop-a',at:r.at||day+'T09:00:00Z'})})));
 f.db.sqlite.prepare("DELETE FROM store_billing_local WHERE scope=? AND kind='cash_snapshot_order' AND day=?").run(scope,day);
 for(const r of normalized)f.db.sqlite.prepare("INSERT INTO store_billing_local VALUES(?,'cash_snapshot_order',?,?,?,?,0)").run('row:'+run+':'+r.sourceOrderId,scope,r.sourceShopId,day,JSON.stringify(r));
 const coverage={revision:CONTRACT.revision,runId:run,sourceDigest:await hash(normalized.map(r=>r.fingerprint).sort()),sourceAt:at,lastCompleteAt:at,identityVerified:true,ordersCoverageComplete:complete,timeSemanticsVerified:true,cancellationSemanticsVerified:true};
 f.db.sqlite.prepare("INSERT OR REPLACE INTO store_billing_local VALUES(?,'cash_source_coverage',?,'',?,?,0)").run('cash-coverage:'+await hash({scope,id:day}),scope,day,JSON.stringify(coverage));await queueAutomaticDay(f.env,scope,day);return coverage;
}
async function transaction(f,fn){f.db.sqlite.exec('BEGIN IMMEDIATE');try{const result=await fn();f.db.sqlite.exec('COMMIT');return result;}catch(e){f.db.sqlite.exec('ROLLBACK');throw e;}}
async function drain(f){const results=[];for(let i=0;i<100;i++){const r=await transaction(f,()=>applyAutomaticCashBatch(f.env));results.push(r);if(r.idle)return results;}throw Error('Financial queue did not finish');}
function ledger(f){return f.db.sqlite.prepare("SELECT COALESCE(SUM(CASE WHEN COALESCE(o.kind,e.kind)='assessment' THEN CASE WHEN e.kind='reversal' THEN -e.quantity ELSE e.quantity END ELSE 0 END),0) orders,COALESCE(SUM(CASE WHEN COALESCE(o.kind,e.kind)='assessment' THEN CASE WHEN e.kind='reversal' THEN -e.amount_cents ELSE e.amount_cents END ELSE 0 END),0) due,COALESCE(SUM(CASE WHEN COALESCE(o.kind,e.kind)='receipt' THEN CASE WHEN e.kind='reversal' THEN -e.amount_cents ELSE e.amount_cents END ELSE 0 END),0) received FROM native_cash_events e LEFT JOIN native_cash_events o ON o.id=e.reverses_id").get();}
const count=(f,table)=>Number(f.db.sqlite.prepare('SELECT COUNT(*) n FROM '+table).get().n);
function event(f,{id=crypto.randomUUID(),kind='assessment',day:businessDay=date,quantity=15,rate=250,amount=quantity*rate,reverses=null,sourceKey=null}={}){f.db.sqlite.prepare('INSERT INTO native_cash_events(id,kind,business_day,courier_id,courier_name,store_id,category,quantity,rate_cents,amount_cents,rule_id,reverses_id,source_key,notes,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,kind,businessDay,'employee-a','employee-a',kind==='receipt'?'':'shop-a',kind==='receipt'?'':'Α',kind==='receipt'?0:quantity,kind==='receipt'?0:rate,amount,kind==='receipt'?null:'rule-shop-a',reverses,sourceKey,'Synthetic checked event','owner','Synthetic owner',new Date().toISOString());return id;}
const user={user_id:'owner',full_name:'Synthetic owner',role:'owner'},request=body=>new Request('https://simulation.invalid/api/native/cash/reconcile',{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'}});
{
 const f=await fixture();try{
  for(const n of [0,1,50,51,1055]){const rows=Array.from({length:n},(_,id)=>({id}));await source(f,rows);await drain(f);assert.equal(ledger(f).orders,n);assert.equal(ledger(f).due,n*250);const old=count(f,'native_cash_events');await source(f,rows);await drain(f);assert.equal(count(f,'native_cash_events'),old,'identical full source repeat creates no events');}
  let rows=Array.from({length:1055},(_,id)=>({id}));const old=count(f,'native_cash_events');await source(f,[],date,false);await drain(f);assert.equal(count(f,'native_cash_events'),old,'partial/failed source cannot cancel previous charges');assert.equal((await automaticCashStatus(f.env,{pendingDays:0},date,date)).coverageVerified,false);
  rows=rows.filter(r=>r.id!==0);await source(f,rows);await drain(f);assert.equal(ledger(f).orders,1054,'complete absence reverses once');
  rows.find(r=>r.id===1).rider=18;await source(f,rows);await drain(f);assert.equal(ledger(f).orders,1054);assert.equal(ledger(f).due,1054*250);assert.equal(f.db.sqlite.prepare("SELECT employee_id FROM native_cash_auto_orders WHERE order_id='1'").get().employee_id,'employee-b');
  const aliases=count(f,'native_cash_events');rows[0].nickname='Renamed alias';await source(f,rows);await drain(f);assert.equal(count(f,'native_cash_events'),aliases,'alias does not change a financial identity');
  f.db.sqlite.prepare("INSERT INTO native_cash_rules VALUES('new-rate','shop-a','Α','2026-01-01',2,300,?,'owner')").run(new Date().toISOString());rows.push({id:2000});await source(f,rows);await drain(f);assert.equal(ledger(f).due,1054*250+300,'old delivered orders keep their historical price; new order takes new price');
  rows.find(r=>r.id===2).store='shop-b';await source(f,rows);await drain(f);assert.equal(ledger(f).due,1054*250+300,'shop change reverses/reapplies at new shop rate without extra order');
  await source(f,rows.filter(r=>r.id!==3));await source(f,[{id:3}], '2026-11-06');await drain(f);assert.equal(ledger(f).orders,1055,'cross-day move has one global order identity');assert.equal(f.db.sqlite.prepare("SELECT business_day FROM native_cash_auto_orders WHERE order_id='3'").get().business_day,'2026-11-06');
  assert.throws(()=>f.db.sqlite.exec("UPDATE native_cash_auto_history SET revision=999"),/cash_auto_history_immutable/);
  assert.equal((await automaticCashStatus(f.env,{pendingDays:0},date,date)).coverageVerified,true);
 }finally{f.db.sqlite.close();}
}
{
 const f=await fixture();try{
  const manual=event(f,{sourceKey:'manual:original'});event(f,{kind:'receipt',amount:1200});await source(f,Array.from({length:10},(_,id)=>({id})));await drain(f);assert.equal(ledger(f).orders,15,'existing manual quantities block automatic doubling');const preview=await cashAutomaticPreview(f.env,date);assert.equal(preview.state,'manual-review');assert.equal(preview.manualEvents[0].id,manual);
  await assert.rejects(transaction(f,()=>reconcileManualCash(request({scope,day:date,decision:'replace-manual-with-ordexa',proof:'stale'}),f.env,user)),e=>e.status===409);assert.equal(ledger(f).orders,15);
  await transaction(f,()=>reconcileManualCash(request({scope,day:date,decision:'replace-manual-with-ordexa',proof:preview.proof}),f.env,user));await drain(f);assert.equal(ledger(f).orders,10);assert.equal(ledger(f).received,1200);assert.equal(ledger(f).due-ledger(f).received,1300);
  const auto=f.db.sqlite.prepare("SELECT * FROM native_cash_events WHERE kind='assessment' AND source_key LIKE 'ordexa:%' LIMIT 1").get();event(f,{kind:'reversal',quantity:1,amount:250,reverses:auto.id});await transaction(f,()=>preserveAutomaticReversal(f.env,auto,user,'Synthetic explicit exclusion'));await drain(f);assert.equal(ledger(f).orders,9);await source(f,Array.from({length:10},(_,id)=>({id})));await drain(f);assert.equal(ledger(f).orders,9,'explicit reversal cannot be resurrected by automatic refresh');
  const exclusion=f.db.sqlite.prepare('SELECT * FROM native_cash_auto_exclusions LIMIT 1').get();await transaction(f,()=>resumeAutomaticOrder(request({scope,orderId:exclusion.order_id,expectedRevision:1,notes:'Synthetic resume'}),f.env,user));await drain(f);assert.equal(ledger(f).orders,10);assert.equal(ledger(f).received,1200);
  const countBefore=count(f,'native_cash_events');await source(f,[{id:999}]);f.db.sqlite.exec("CREATE TRIGGER fixture_fail_history BEFORE INSERT ON native_cash_auto_history BEGIN SELECT RAISE(ABORT,'fixture financial history failed'); END;");await assert.rejects(transaction(f,()=>applyAutomaticCashBatch(f.env)),/fixture financial history failed/);assert.equal(count(f,'native_cash_events'),countBefore,'events and state roll back together after history failure');f.db.sqlite.exec('DROP TRIGGER fixture_fail_history');await drain(f);assert.equal(ledger(f).orders,1);
 }finally{f.db.sqlite.close();}
}
{
 const f=await fixture();try{
  const rows=Array.from({length:201},(_,id)=>({id}));await source(f,rows);await transaction(f,()=>applyAutomaticCashBatch(f.env));assert.equal(ledger(f).orders,200);f.db.sqlite.prepare("INSERT INTO native_cash_rules VALUES('mid-batch','shop-a','Α','2026-01-01',2,300,?,'owner')").run(new Date().toISOString());await queueAutomaticDay(f.env,scope,date);await drain(f);assert.equal(ledger(f).due,201*300,'unfinished initial batch rechecks a changed tariff consistently');
  f.db.sqlite.prepare("INSERT INTO native_cash_rules VALUES('after-final','shop-a','Α','2026-01-01',3,400,?,'owner')").run(new Date().toISOString());rows.push({id:999});await source(f,rows);await drain(f);assert.equal(ledger(f).due,201*300+400,'completed charges keep their pinned historical rate');
  const states=count(f,'native_cash_auto_orders');await source(f,[...rows,...Array.from({length:100},(_,i)=>({id:10000+i,store:'not-participating'}))]);await drain(f);assert.equal(count(f,'native_cash_auto_orders'),states,'non-participating orders have no cash state/history');
 }finally{f.db.sqlite.close();}
}
{
 const f=await fixture();try{
  await source(f,[{id:1}]);await drain(f);const past='2026-11-06';event(f,{id:'past-manual',day:past,sourceKey:'manual:past'});const before=count(f,'native_cash_events');await source(f,[]);await source(f,[{id:1}],past);await drain(f);assert.equal(count(f,'native_cash_events'),before,'cross-day movement cannot silently bypass manual reconciliation in the destination day');const review=await cashAutomaticPreview(f.env,past);assert.equal(review.state,'manual-review');await transaction(f,()=>reconcileManualCash(request({scope,day:past,proof:review.proof,decision:'replace-manual-with-ordexa'}),f.env,user));await drain(f);assert.equal(ledger(f).orders,1);
 }finally{f.db.sqlite.close();}
}
console.log('PASS actual SQLite auto cash:0/1/50/51/1055, bounded/repeat/dedupe, partial retention, cancellation, rider/shop/day movement, alias, pinned historical rates, manual reconciliation/CAS with receipts retained, explicit reversal/resume and atomic history failure rollback. Synthetic source data only.');
