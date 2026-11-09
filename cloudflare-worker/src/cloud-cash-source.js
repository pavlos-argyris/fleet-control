import {NativeError} from '../../server-runtime/common.js';
import {directHash} from './direct-relay.js';
import {queueAutomaticDay} from '../../server-runtime/cash-auto.js';
const q=(sql,text,...args)=>Array.from(sql.exec(text,...args)),HASH=/^[a-f0-9]{64}$/;
const complete=c=>c.identityVerified===true&&c.ordersCoverageComplete===true&&!c.needsSourceRefresh&&HASH.test(c.sourceDigest||'');
const key=(scope,day)=>'cloud-cash-coverage:'+scope+':'+day;
/** Provider snapshots are published atomically. A manifest asks only for changed
 * identities; staging can never remove an order from the last complete source. */
export async function cloudCashSource(request,env,storage){
 const b=await request.json(),source=env.BUSINESS_CONTEXT,sql=storage.sql;
 if(!source?.configured||b.scope!==source.scope||b.generation!==source.generation||!/^\d{4}-\d{2}-\d{2}$/.test(b.day||'')||!HASH.test(b.jobId||''))throw new NativeError(409,'Άλλαξε η πηγή της παρτίδας Ταμείου.');
 sql.exec('CREATE TABLE IF NOT EXISTS _cloud_cash_jobs(scope TEXT NOT NULL,day TEXT NOT NULL,job_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,day));CREATE TABLE IF NOT EXISTS _cloud_cash_stage(job_id TEXT NOT NULL,order_id TEXT NOT NULL,store_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(job_id,order_id));');
 const active=q(sql,"SELECT id,data FROM store_billing_local WHERE scope=? AND day=? AND kind='cash_source_coverage'",b.scope,b.day);
 if(active.length>1)throw new NativeError(409,'Χρειάζεται έλεγχος διπλής κάλυψης Ταμείου.');
 const current=active[0]&&JSON.parse(active[0].data),coverageId=active[0]?.id||key(b.scope,b.day);
 const writeCoverage=c=>sql.exec("INSERT INTO store_billing_local(id,kind,scope,store_id,day,data,dirty) VALUES(?,'cash_source_coverage',?,'',?,?,0) ON CONFLICT(id) DO UPDATE SET data=excluded.data",coverageId,b.scope,b.day,JSON.stringify(c));
 const publish=async(c,runId)=>{writeCoverage({...c,runId,cloudSourceRunId:c.runId,cloudJobId:b.jobId});await queueAutomaticDay(env,b.scope,b.day,'cloud-complete-source');};
 if(b.action==='partial'){
  if(!b.coverage||complete(b.coverage))throw new NativeError(400,'Μη έγκυρη μερική κάλυψη.');
  writeCoverage({...b.coverage,runId:current?.runId||'',cloudSourceRunId:b.coverage.runId||'',needsSourceRefresh:true});return{done:true};
 }
 if(current?.cloudJobId===b.jobId&&complete(current))return{done:true,replayed:true};
 if(b.action==='prepare'){
  if(!complete(b.coverage)||typeof b.coverage.runId!=='string'||!Array.isArray(b.orders)||b.orders.length>20000)throw new NativeError(400,'Χρειάζεται πλήρες ελεγμένο στιγμιότυπο ημέρας.');
  const orders=[...b.orders].sort((a,c)=>a.id<c.id?-1:a.id>c.id?1:0),ids=new Set();let digest='';
  for(const o of orders){if(typeof o.id!=='string'||o.id.length>32||!/^\d+$/.test(o.id)||!HASH.test(o.fingerprint||'')||ids.has(o.id))throw new NativeError(400,'Μη έγκυρες ταυτότητες παραγγελιών.');ids.add(o.id);digest+=o.id+':'+o.fingerprint+'\n';}
  if(await directHash(digest)!==b.coverage.sourceDigest)throw new NativeError(409,'Δεν συμφωνεί η πλήρης απογραφή της ημέρας.');
  const existing=q(sql,"SELECT json_extract(data,'$.sourceOrderId') id,json_extract(data,'$.fingerprint') fingerprint FROM store_billing_local WHERE scope=? AND day=? AND kind='cash_snapshot_order' AND json_extract(data,'$.runId')=?",b.scope,b.day,current?.runId||'');
  const byId=new Map();for(const r of existing){if(byId.has(r.id))throw new NativeError(409,'Διπλή ενεργή ταυτότητα πηγής.');byId.set(r.id,r.fingerprint);}
  const stable=current?.runId==='cloud-source-v1';
  if(stable&&existing.length===orders.length&&orders.every(o=>byId.get(o.id)===o.fingerprint)){await publish(b.coverage,current.runId);return{done:true,unchanged:true};}
  const prior=q(sql,'SELECT job_id,data FROM _cloud_cash_jobs WHERE scope=? AND day=?',b.scope,b.day)[0];
  const manifest={orders,coverage:b.coverage,base:active[0]?.data||null};
  if(prior?.job_id===b.jobId){const saved=JSON.parse(prior.data);if(JSON.stringify(saved)!==JSON.stringify(manifest))throw new NativeError(409,'Άλλαξε η παρτίδα με την ίδια ταυτότητα.');}
  else{if(prior)sql.exec('DELETE FROM _cloud_cash_stage WHERE job_id=?',prior.job_id);sql.exec('INSERT INTO _cloud_cash_jobs VALUES(?,?,?,?) ON CONFLICT(scope,day) DO UPDATE SET job_id=excluded.job_id,data=excluded.data',b.scope,b.day,b.jobId,JSON.stringify(manifest));}
  const staged=new Set(q(sql,'SELECT order_id FROM _cloud_cash_stage WHERE job_id=?',b.jobId).map(r=>r.order_id));
  return{done:false,missing:orders.filter(o=>(!stable||byId.get(o.id)!==o.fingerprint)&&!staged.has(o.id)).map(o=>o.id)};
 }
 const job=q(sql,'SELECT job_id,data FROM _cloud_cash_jobs WHERE scope=? AND day=?',b.scope,b.day)[0];if(job?.job_id!==b.jobId)throw new NativeError(409,'Η παρτίδα Ταμείου χρειάζεται νέα απογραφή.');const manifest=JSON.parse(job.data),expected=new Map(manifest.orders.map(o=>[o.id,o.fingerprint]));
 if(b.action==='stage'){
  if(!Array.isArray(b.rows)||!b.rows.length||b.rows.length>64)throw new NativeError(400,'Μη έγκυρη παρτίδα ταυτοτήτων.');
  for(const r of b.rows){const value=JSON.parse(r.data);if(expected.get(value.sourceOrderId)!==value.fingerprint||value.runId!==manifest.coverage.runId||value.businessDay!==b.day||typeof r.store_id!=='string')throw new NativeError(409,'Άλλαξε ταυτότητα κατά τη μεταφορά.');
   sql.exec('INSERT INTO _cloud_cash_stage VALUES(?,?,?,?) ON CONFLICT(job_id,order_id) DO UPDATE SET store_id=excluded.store_id,data=excluded.data',b.jobId,value.sourceOrderId,r.store_id,r.data);
  }return{saved:true};
 }
 if(b.action==='finish'){
  if((active[0]?.data||null)!==manifest.base)throw new NativeError(409,'Άλλαξε η ενεργή κάλυψη κατά τη μεταφορά.');
  const previous=q(sql,"SELECT id,store_id,data FROM store_billing_local WHERE scope=? AND day=? AND kind='cash_snapshot_order'",b.scope,b.day),byId=new Map();
  for(const r of previous){const v=JSON.parse(r.data);if(v.runId===current?.runId)byId.set(v.sourceOrderId,{...r,value:v});}
  const staged=new Map(q(sql,'SELECT order_id,store_id,data FROM _cloud_cash_stage WHERE job_id=?',b.jobId).map(r=>[r.order_id,{...r,value:JSON.parse(r.data)}]));
  for(const o of manifest.orders){const r=staged.get(o.id)||byId.get(o.id);if(!r||r.value.fingerprint!==o.fingerprint)throw new NativeError(409,'Λείπουν επαληθευμένες παραγγελίες.');}
  // All checks precede activation. This entire handler, including the financial
  // batch and receipt, is one serialized Cloudflare SQLite transaction.
  for(const r of previous){const v=JSON.parse(r.data);if(!expected.has(v.sourceOrderId)||v.runId!=='cloud-source-v1')sql.exec('DELETE FROM store_billing_local WHERE id=?',r.id);}
  for(const o of manifest.orders){const r=staged.get(o.id)||byId.get(o.id);if(!staged.has(o.id)&&r.value.runId==='cloud-source-v1')continue;const value={...r.value,runId:'cloud-source-v1'};delete value.pageKey;const id='cloud-cash-row:'+await directHash(b.scope+'\0'+b.day+'\0'+o.id);sql.exec("INSERT INTO store_billing_local(id,kind,scope,store_id,day,data,dirty) VALUES(?,'cash_snapshot_order',?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET store_id=excluded.store_id,data=excluded.data",id,b.scope,r.store_id,b.day,JSON.stringify(value));}
  await publish(manifest.coverage,'cloud-source-v1');sql.exec('DELETE FROM _cloud_cash_stage WHERE job_id=?',b.jobId);sql.exec('DELETE FROM _cloud_cash_jobs WHERE scope=? AND day=? AND job_id=?',b.scope,b.day,b.jobId);return{done:true};
 }
 throw new NativeError(400,'Μη έγκυρη ενέργεια πηγής Ταμείου.');
}
