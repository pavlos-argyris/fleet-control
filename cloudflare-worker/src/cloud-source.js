import {cloudCashSource} from './cloud-cash-source.js';
import {NativeError} from '../../server-runtime/common.js';
import {queueAutomaticDay,applyAutomaticCashBatch} from '../../server-runtime/cash-auto.js';
import {CASH_ORDER_CONTRACT} from '../../server-runtime/cash-contract.js';
const kinds=new Set(['store','terms','fleet_terms','ordexa_terms','policy','order','observation','local_day','coverage','cash_rider_alias','cash_catalog']);
export const cloudSourceKind=(id,kind)=>kinds.has(kind)||kind==='meta'&&['meta:store-billing','meta:cash-sync'].includes(id);
/** Only provider-owned cache cells. Financial ledger/history and configuration
 * tables are unreachable through this publisher. Changes, not entire rereads,
 * are sent by the phone's durable local journal. */
export async function routeCloudSource(request,env,configuration,storage){
 const url=new URL(request.url);if(!['/api/server/cloud-source','/api/server/cloud-source/cash'].includes(url.pathname))return null;
 if(request.method!=='POST'||request.localInternal!==true)throw new NativeError(403,'Χρειάζεται η εξουσιοδοτημένη υπηρεσία Server.');
 if(url.pathname.endsWith('/cash')){const result=await cloudCashSource(request,env,storage);return{response:Response.json(result),changed:result.done===true};}
 const b=await request.json();if(!Array.isArray(b.changes)||b.changes.length>64||!Array.isArray(b.ack)||b.ack.length>64)throw new NativeError(400,'Μη έγκυρη παρτίδα πηγής.');
 if(!b.context||typeof b.context.scope!=='string'||typeof b.context.generation!=='string'||b.context.scope.length>200||b.context.generation.length>200)throw new NativeError(400,'Μη έγκυρη πηγή καταστημάτων.');
 const source={configured:b.context.configured===true,scope:b.context.scope,generation:b.context.generation,worker:configuration.realm,cashOrdersProtocol:b.context.cashOrdersProtocol||null};
 let changed=false;
 for(const item of b.changes){
  if(!item||typeof item.id!=='string'||item.id.length>300||!cloudSourceKind(item.id,item.kind))throw new NativeError(400,'Η παρτίδα περιέχει μη επιτρεπτή εγγραφή.');
  if(item.deleted===true){const result=await env.DB.prepare("DELETE FROM store_billing_local WHERE id=? AND (kind IN ('store','terms','fleet_terms','ordexa_terms','policy','order','observation','local_day','coverage','cash_rider_alias','cash_catalog') OR kind='meta' AND id IN ('meta:store-billing','meta:cash-sync'))").bind(item.id).run();changed=changed||Number(result.meta.changes)>0;continue;}
  if(typeof item.data!=='string'||item.data.length>8*1024*1024||typeof item.scope!=='string'||item.scope.length>200||typeof item.store_id!=='string'||typeof item.day!=='string')throw new NativeError(400,'Άλλαξε η πηγή της παρτίδας.');
  const value=JSON.parse(item.data);
  if(item.kind==='cash_catalog'&&(item.scope!==source.scope||value.generation!==source.generation||value.version!==1||item.data.length>256*1024||!Array.isArray(value.riders)||value.riders.length>2000||!/^[a-f0-9]{64}$/.test(value.revision||'')||new Set(value.riders.map(r=>r?.riderId)).size!==value.riders.length||value.riders.some(r=>!r||typeof r.riderId!=='string'||!/^\d{1,16}$/.test(r.riderId)||!Number.isSafeInteger(Number(r.riderId))||typeof r.nickname!=='string'||r.nickname.length>200||!Array.isArray(r.aliases)||r.aliases.some(a=>!a||typeof a.nickname!=='string'||a.nickname.length>200||typeof a.observedAt!=='string'||a.observedAt.length>100))))throw new NativeError(400,'Μη έγκυρος έτοιμος κατάλογος διανομέων.');
  const result=await env.DB.prepare(`INSERT INTO store_billing_local(id,kind,scope,store_id,day,data,dirty) VALUES(?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,scope=excluded.scope,store_id=excluded.store_id,day=excluded.day,data=excluded.data,dirty=0 WHERE store_billing_local.kind<>excluded.kind OR store_billing_local.scope<>excluded.scope OR store_billing_local.store_id<>excluded.store_id OR store_billing_local.day<>excluded.day OR CASE WHEN excluded.kind='local_day' THEN json_remove(store_billing_local.data,'$.sourceLastSuccessAt','$.computedAt','$.runId')<>json_remove(excluded.data,'$.sourceLastSuccessAt','$.computedAt','$.runId') ELSE json_remove(store_billing_local.data,'$.lastSeenRun','$.pendingDeleteRun')<>json_remove(excluded.data,'$.lastSeenRun','$.pendingDeleteRun') END`).bind(item.id,item.kind,item.scope,item.store_id,item.day,item.data).run();
  if(Number(result.meta.changes)>0){changed=true;if(item.kind==='cash_source_coverage'&&item.scope===source.scope)await queueAutomaticDay(env,source.scope,item.day,'cloud-source');}
 }
 for(const ack of b.ack){if(typeof ack.id!=='string'||typeof ack.requestId!=='string')throw new NativeError(400,'Μη έγκυρη επιβεβαίωση λήψης.');await env.DB.prepare("DELETE FROM store_billing_local WHERE id=? AND kind='cash_refresh_request' AND json_extract(data,'$.requestId')=?").bind(ack.id,ack.requestId).run();}
 const contextChanged=JSON.stringify(configuration.context)!==JSON.stringify(source);configuration.context=source;if(b.health&&typeof b.health==='object')configuration.health={...b.health,serverLastSeenAt:new Date().toISOString()};if(contextChanged||b.health)await storage.put('cloud-business.configuration',configuration);env.BUSINESS_CONTEXT=source;env.BUSINESS_HEALTH=configuration.health||{};
 const automatic=source.configured?await applyAutomaticCashBatch(env):{idle:true};
 const pending=(await env.DB.prepare("SELECT id,kind,scope,store_id,day,data FROM store_billing_local WHERE scope=? AND kind='cash_refresh_request' ORDER BY day,id LIMIT 64").bind(source.scope).all()).results||[];
 const wanted=!!await env.DB.prepare('SELECT 1 found FROM native_cash_rules WHERE rate_cents>0 LIMIT 1').first();
 return{response:Response.json({saved:true,pending,wanted,pilotIntervalSeconds:CASH_ORDER_CONTRACT.pilotIntervalSeconds,automatic}),changed:changed||automatic.changed};
}
