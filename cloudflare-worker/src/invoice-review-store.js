// A review, its retry receipt, audit and Server outbox share one D1 transaction.
// Guards concern the selected entries, never an unrelated fleet-wide version.
const ACTION = 'service_invoice_review';

export function stableReviewJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableReviewJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => JSON.stringify(key) + ':' + stableReviewJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function identity(actor, requestId) {
  const owner = String(actor.user_id || actor.id || '');
  return { owner, id: ACTION + ':' + owner + ':' + requestId };
}

export async function readReviewReceipt(env, actor, requestId, hash) {
  const {owner,id} = identity(actor, requestId);
  const row = await env.DB.prepare('SELECT response FROM idempotency_keys WHERE id=? AND user_id=? AND action=?')
    .bind(id,owner,ACTION).first();
  if (!row) return null;
  const receipt = JSON.parse(row.response);
  return receipt.hash === hash ? { ...receipt.result, reused: true } : { conflict: true };
}

export async function commitInvoiceReview(env, options) {
  const {actor,requestId,hash,updates,result:initialResult,now,source,audit,changed} = options;
  const {owner,id} = identity(actor,requestId), nonce = crypto.randomUUID();
  const guards = [], args = [], bikes = new Map();
  for (const update of updates) {
    const located = update.located;
    if (!Number.isInteger(located.bikeIndex) || !Number.isInteger(located.entryIndex)) throw new Error('Invalid review location');
    const bikePath = '$.bikes[' + located.bikeIndex + ']', entryPath = bikePath + '.history[' + located.entryIndex + ']';
    guards.push('json_extract(s.data,?)=?','json_extract(s.data,?)=?',
      'NOT EXISTS (SELECT 1 FROM vehicle_archives WHERE bike_id=? AND active=1)');
    args.push(bikePath+'.id',String(located.bike.id),entryPath,located.entryJson,String(located.bike.id));
    if (update.bikeJson) { guards.push('json_extract(s.data,?)=?'); args.push(bikePath,update.bikeJson); }
    const current = bikes.get(String(located.bike.id)) || {path:bikePath,patch:{},operationId:crypto.randomUUID()};
    Object.assign(current.patch,update.bikePatch || {});
    bikes.set(String(located.bike.id),current);
  }
  if(options.renderJobId){guards.push("NOT EXISTS (SELECT 1 FROM fleet_operations WHERE id=? AND status='cancelled')");args.push(options.renderJobId);}
  const destination = String(initialResult.document.bikeId);
  const result = { ...initialResult, operationId: changed && options.syncBike!==false ? bikes.get(destination).operationId : '' };
  const receipt = JSON.stringify({hash,nonce,result});
  const marker = "EXISTS (SELECT 1 FROM idempotency_keys WHERE id=? AND user_id=? AND action='"+ACTION+"' AND json_extract(response,'$.nonce')=?)";
  const markerArgs = [id,owner,nonce];
  // If a guard fails, no fresh nonce is inserted. Every later statement is
  // fenced by this transaction's nonce, so an older receipt cannot authorize it.
  const statements = [env.DB.prepare(`INSERT INTO idempotency_keys(id,user_id,action,response,created_at)
    SELECT ?,?,?,json_set(json(?),'$.result.version',s.version+?),? FROM fleet_snapshot s
    WHERE s.id=1 AND ${guards.join(' AND ')}`)
    .bind(id,owner,ACTION,receipt,changed?1:0,now,...args)];
  if (changed) {
    const paths = [], values = [];
    for (const update of updates) {
      paths.push('?,json(?)');
      values.push('$.bikes['+update.located.bikeIndex+'].history['+update.located.entryIndex+']',JSON.stringify(update.entry));
    }
    for (const bike of bikes.values()) for (const [field,value] of Object.entries(bike.patch)) {
      if (!/^[a-zA-Z]+$/.test(field)) throw new Error('Invalid review field');
      if(field==='updatedAt'){
        paths.push("?,json_quote(max(COALESCE(json_extract(data,?),''),?))");
        values.push(bike.path+'.'+field,bike.path+'.'+field,String(value));
      }else{paths.push('?,json(?)');values.push(bike.path+'.'+field,JSON.stringify(value));}
    }
    statements.push(env.DB.prepare(`UPDATE fleet_snapshot SET data=json_set(data,${paths.join(',')}),
      version=version+1,source=?,updated_at=? WHERE id=1 AND ${marker}`).bind(...values,source,now,...markerArgs));
    for (const [bikeId,bike] of options.syncBike===false?[]:bikes) {
      statements.push(env.DB.prepare(`INSERT INTO vehicle_registry(bike_id,name,odometer,status,version,updated_at)
        SELECT ?,json_extract(b.value,'$.name'),json_extract(b.value,'$.currentKm'),'available',1,?
        FROM fleet_snapshot s,json_each(s.data,'$.bikes') b WHERE s.id=1 AND json_extract(b.value,'$.id')=? AND ${marker}
        ON CONFLICT(bike_id) DO UPDATE SET name=excluded.name,odometer=excluded.odometer,
        version=vehicle_registry.version+1,updated_at=excluded.updated_at`).bind(bikeId,now,bikeId,...markerArgs));
      // Serialize affected bikes inside D1. Queue by DB commit time (rowid
      // breaks timestamp ties), not by the earlier request start time.
      statements.push(env.DB.prepare(`INSERT INTO fleet_operations(id,source,type,payload,status,created_at)
        SELECT ?,'authenticated-client','snapshot_replace_bike',json_object('bike',json(b.value)),'pending',strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM fleet_snapshot s,json_each(s.data,'$.bikes') b WHERE s.id=1 AND json_extract(b.value,'$.id')=? AND ${marker}`)
        .bind(bike.operationId,bikeId,...markerArgs));
    }
    if(audit!==false)statements.push(env.DB.prepare(`INSERT INTO audit_log
      (id,timestamp,user_id,user_name,role,action,object_type,object_id,old_value,new_value,reason,ip_address,device_id,admin_pin_used)
      SELECT ?,?,?,?,?,?,'service_document',?,?,?,?,?,?,0 WHERE ${marker}`)
      .bind(crypto.randomUUID(),now,owner,String(actor.full_name||actor.fullName||actor.username||'System'),String(actor.role||'system'),audit.action,
        String(result.document.key),JSON.stringify(audit.before),JSON.stringify(audit.after),String(audit.reason||''),String(audit.ip||''),String(actor.device_id||''),...markerArgs));
  }
  try { await env.DB.batch(statements); }
  catch (error) {
    // A concurrent identical request may have inserted the unique receipt.
    // Any other failure rolls back the entire D1 transaction and propagates.
    const existing = await readReviewReceipt(env,actor,requestId,hash);
    if (existing) return existing;
    throw error;
  }
  const saved = await readReviewReceipt(env,actor,requestId,hash);
  if (!saved) return null;
  const row = await env.DB.prepare('SELECT json_extract(response,\'$.nonce\') AS nonce FROM idempotency_keys WHERE id=?').bind(id).first();
  return { ...saved, reused: row?.nonce !== nonce };
}
