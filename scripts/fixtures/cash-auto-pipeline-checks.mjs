import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {WORKFORCE_SCHEMA} from '../../cloudflare-worker/src/workforce.js';
import {CASH_SCHEMA} from '../../server-runtime/cash.js';
import {applyAutomaticCashBatch,queueAutomaticDay,automaticCashStatus} from '../../server-runtime/cash-auto.js';
import {REPORT_SCHEMA,storeReport} from '../../server-runtime/reports.js';

/** Consume the actual Java StoreBillingSync output file, without rebuilding source rows. */
export async function checkSharedCashPipeline(file,adapter,date){
 const original=adapter.sqlite,oldHost=globalThis.FleetHost,local=new DatabaseSync(file),scope='synthetic-source';adapter.sqlite=local;
 globalThis.FleetHost=command=>{assert.equal(command,'store.context');return{configured:true,scope,generation:'generation-1',worker:'https://fixture.invalid'};};
 try{
  local.exec(WORKFORCE_SCHEMA+CASH_SCHEMA+REPORT_SCHEMA);const env={DB:adapter,LOCAL_PRIMARY:true};
  const orders=local.prepare("SELECT store_id FROM store_billing_local WHERE scope=? AND kind='cash_snapshot_order'").all(scope);assert.equal(orders.length,51,'real shared reader produced all51 source rows');const stores=[...new Set(orders.map(row=>row.store_id))];assert.equal(stores.length,1);
  const at=new Date().toISOString();for(const[id,rider]of[['pipeline-a','17'],['pipeline-b','18']]){
   local.prepare("INSERT INTO app_users(id,full_name,username,password_hash,password_salt,role,active,login_enabled,created_at,updated_at) VALUES(?,?,?,'','','employee',1,0,?,?)").run(id,id,id,at,at);
   local.prepare("INSERT INTO native_cash_rider_links VALUES(?,?,?,'2026-01-01',1,?,?,?,'fixture-owner')").run('pipeline-link-'+rider,scope,rider,id,id,at);
  }
  local.prepare("INSERT INTO native_cash_rules VALUES('pipeline-rule',?,'Α','2026-01-01',1,250,?,'fixture-owner')").run(stores[0],at);
  assert.equal(local.prepare("SELECT COUNT(*) n FROM store_billing_local WHERE scope=? AND day=? AND kind='cash_apply_request'").get(scope,date).n,1,'actual atomic source promotion queued exactly one request for the accepted51-order day');
  async function drain(){for(let n=0;n<10;n++){local.exec('BEGIN IMMEDIATE');try{const result=await applyAutomaticCashBatch(env);local.exec('COMMIT');if(result.idle)return;}catch(error){local.exec('ROLLBACK');throw error;}}throw Error('Shared pipeline financial work did not finish');}
  await drain();const sum=local.prepare('SELECT COUNT(*) orders,SUM(amount_cents) amount FROM native_cash_events').get();assert.equal(sum.orders,51);assert.equal(sum.amount,12750);assert.equal(local.prepare("SELECT employee_id FROM native_cash_auto_orders WHERE scope=? AND order_id='5000'").get(scope).employee_id,'pipeline-b','actual repeated source reassignment selects explicit rider18 mapping');
  assert.equal((await automaticCashStatus(env,{pendingDays:0},date,date)).coverageVerified,true,'actual source and financial completion agree');
  const report=await storeReport(env,{scope,from:date,to:date});assert.equal(report.stores.length,2);assert(report.stores.every(store=>store.id.startsWith('store:')),'native report selects real catalogue primary IDs');assert.equal(report.complete,true,JSON.stringify(report.issues));assert.equal(report.totals.knownOrders,53,'store report retains two explicitly retained store orders independently of51 actual courier deliveries');
  await queueAutomaticDay(env,scope,date);await drain();assert.equal(local.prepare('SELECT COUNT(*) n FROM native_cash_events').get().n,51,'real source replay is financially idempotent');
  assert.equal(local.prepare("SELECT COUNT(*) n FROM store_billing_local WHERE kind LIKE 'cash_%' AND dirty<>0").get().n,0,'source/apply cells never enter raw cloud outbox');
  console.log('PASS actual shared Java reader → same SQLite → production financial applier:51 delivered orders, explicit reassignment,12750cents, completed coverage, replay and no extra provider/Worker reads.');
 }finally{adapter.sqlite=original;globalThis.FleetHost=oldHost;local.close();}
}
