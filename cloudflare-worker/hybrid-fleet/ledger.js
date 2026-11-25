import { stableReviewJson } from '../src/invoice-review-store.js';

const encoder = new TextEncoder();
export const MAX_BYTES = 192 * 1024;
const MAX_OPERATIONS = 12;
const PAGE_SIZE = 24;
const kinds = {
  machine: { name:'text', brand:'text', model:'text', currentKm:'int', intervalKm:'int', lastServiceKm:'int', nextServiceKm:'int',
    lastCheckedAt:'text', availability:'text', notes:'text', createdAt:'text', updatedAt:'text' },
  mileage: { km:'int', date:'text', notes:'text', createdAt:'text', updatedAt:'text' },
  service: { km:'int', date:'text', notes:'text', tasks:'lines', workshop:'text', cost:'text', oilChanged:'boolean',
    majorService:'boolean', appointmentId:'text', createdAt:'text', updatedAt:'text' },
  invoice: { name:'text', contentType:'text', size:'int', sha256:'text', qrUrl:'text', qrValue:'text', sourcePhotoKey:'text',
    supplier:'text', invoiceNumber:'text', invoiceDate:'text', mark:'text', plate:'text', odometerKm:'text', totalAmount:'text',
    netAmount:'text', vatAmount:'text', laborAmount:'text', comments:'text', rawText:'text', lineItems:'lines', reviewedAt:'text',
    targetedOperationId:'text', createdAt:'text', updatedAt:'text' }
};
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value);
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const isInteger = value => Number.isSafeInteger(value) && value >= 0;
function valueMatches(value, kind) {
  if (kind === 'int') return isInteger(value);
  if (kind === 'boolean') return typeof value === 'boolean';
  if (kind === 'lines') return Array.isArray(value) && value.length <= 5120 &&
    value.every(item => typeof item === 'string' && item.length <= 500);
  return typeof value === 'string' && value.length <= 128000;
}

export function fleetError(status, code) {
  return Object.assign(new Error(code), { status, code });
}

export async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(bytes), number => number.toString(16).padStart(2, '0')).join('');
}

async function mutation(input) {
  const { operationId, kind, machineId, recordId, serviceId = '', expectedRevision, deleted, data } = input ?? {};
  if (!identifier(operationId) || operationId.length < 16 || !Object.hasOwn(kinds, kind) ||
      !identifier(machineId) || !identifier(recordId) || !isInteger(expectedRevision) || expectedRevision >= Number.MAX_SAFE_INTEGER ||
      typeof deleted !== 'boolean' || (kind === 'machine' && machineId !== recordId) ||
      (kind === 'invoice' ? !identifier(serviceId) : serviceId !== '')) throw fleetError(400,'invalid_mutation');
  if (input && Object.keys(input).some(key => !['operationId','kind','machineId','recordId','serviceId','expectedRevision','deleted','data'].includes(key))) {
    throw fleetError(400,'invalid_mutation_field');
  }
  if (deleted && (expectedRevision === 0 || data !== null)) throw fleetError(400,'invalid_tombstone');
  if (!deleted) {
    const fields = kinds[kind];
    if (!isObject(data) || Object.entries(data).some(([key,value])=>!Object.hasOwn(fields,key) || !valueMatches(value,fields[key]))) {
      throw fleetError(400,'invalid_record');
    }
    if (kind === 'machine' && !data.name?.trim()) throw fleetError(400,'missing_machine_name');
    if (['service','mileage'].includes(kind) && (!isInteger(data.km) || !/^\d{4}-\d{2}-\d{2}$/.test(data.date))) throw fleetError(400,'invalid_history');
  }
  const serialized = deleted ? null : stableReviewJson(data);
  const fingerprint = await sha256(stableReviewJson({kind,machineId,recordId,serviceId,expectedRevision,deleted,data}));
  return {operationId,kind,machineId,recordId,serviceId,expectedRevision,deleted,serialized,fingerprint};
}

export async function readBody(request) {
  const size = Number(request.headers.get('Content-Length') || 0);
  if (!request.body || size > MAX_BYTES) throw fleetError(size > MAX_BYTES ? 413 : 400,'body_size');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8',{fatal:true});
  let length=0, text='';
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) throw fleetError(413,'body_size');
      text += decoder.decode(value,{stream:true});
    }
    return JSON.parse(text+decoder.decode());
  } catch (error) {
    await reader.cancel().catch(()=>{});
    throw error.status ? error : fleetError(400,'invalid_json');
  }
}

export async function authorizeSync(request, db) {
  const match = /^Bearer ([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{43,128})$/.exec(request.headers.get('Authorization')||'');
  if (!match) throw fleetError(401,'sync_credential_required');
  const [,id,secret] = match;
  const hash=await sha256(secret), now=Date.now();
  const credential = await db.prepare(`SELECT scope FROM fleet_sync_credentials
    WHERE id=? AND secret_sha256=? AND revoked_at IS NULL AND expires_at>?`).bind(id,hash,now).first();
  if (!credential) throw fleetError(401,'sync_credential_invalid');
  return {...credential,id,hash};
}

export async function currentEpoch(db) {
  const state=await db.prepare('SELECT epoch FROM fleet_rehearsal_state WHERE id=1').first();
  if (!state) throw fleetError(503,'ledger_uninitialized');
  return state.epoch;
}

// Idempotent replay, CAS and parent checks are evaluated in the same D1
// transaction that appends the event and updates the materialized record.
export async function pushMutations(db, credential, epoch, input) {
  if (credential.scope !== 'sync-read-write') throw fleetError(403,'sync_write_scope_required');
  if (!isObject(input) || Object.keys(input).some(key=>key!=='operations') ||
      !Array.isArray(input.operations) || input.operations.length > MAX_OPERATIONS) throw fleetError(400,'invalid_batch');
  const operations=await Promise.all(input.operations.map(mutation));
  const results=[];
  for (const op of operations) {
    const revision=op.expectedRevision+1;
    const params=[op.kind,op.machineId,op.recordId];
    const statements=[
      db.prepare(`INSERT INTO fleet_mutations(operation_id,fingerprint,kind,machine_id,record_id,service_id,revision,deleted,data,committed_at)
        SELECT ?,?,?,?,?,?,?,?,?,?
        WHERE EXISTS (SELECT 1 FROM fleet_rehearsal_state WHERE id=1 AND epoch=?)
        AND EXISTS (SELECT 1 FROM fleet_sync_credentials WHERE id=? AND secret_sha256=? AND scope='sync-read-write'
          AND expires_at>? AND revoked_at IS NULL)
        AND COALESCE((SELECT revision FROM fleet_records WHERE kind=? AND machine_id=? AND record_id=?),0)=?
        AND NOT EXISTS (SELECT 1 FROM fleet_records WHERE kind=? AND machine_id=? AND record_id=? AND service_id<>?)
        AND (?='machine' OR EXISTS (SELECT 1 FROM fleet_records WHERE kind='machine' AND machine_id=? AND record_id=? AND deleted=0))
        AND (?<>'invoice' OR EXISTS (SELECT 1 FROM fleet_records WHERE kind='service' AND machine_id=? AND record_id=? AND deleted=0))
        ON CONFLICT(operation_id) DO NOTHING`).bind(
        op.operationId,op.fingerprint,...params,op.serviceId,revision,op.deleted?1:0,op.serialized,new Date().toISOString(),
        epoch,credential.id,credential.hash,Date.now(),...params,op.expectedRevision,...params,op.serviceId,op.kind,op.machineId,op.machineId,
        op.kind,op.machineId,op.serviceId),
      db.prepare('SELECT cursor,revision,fingerprint FROM fleet_mutations WHERE operation_id=?').bind(op.operationId),
      db.prepare('SELECT revision,deleted FROM fleet_records WHERE kind=? AND machine_id=? AND record_id=?').bind(...params)
    ];
    const [inserted,receipt,record]=await db.batch(statements);
    const saved=receipt.results[0], current=record.results[0];
    if (saved?.fingerprint===op.fingerprint) {
      results.push({operationId:op.operationId,status:inserted.meta.changes?'committed':'replayed',
        cursor:saved.cursor,revision:saved.revision});
    } else {
      results.push({operationId:op.operationId,status:saved?'operation_id_conflict':'conflict',
        revision:current?.revision || 0,deleted:Boolean(current?.deleted)});
    }
  }
  return results;
}

export async function pullMutations(db, cursor) {
  const [head, page] = await db.batch([
    db.prepare('SELECT COALESCE(MAX(cursor),0) AS value FROM fleet_mutations'),
    db.prepare(`SELECT cursor,operation_id AS operationId,kind,machine_id AS machineId,
      record_id AS recordId,service_id AS serviceId,revision,deleted,data,committed_at AS committedAt
      FROM fleet_mutations WHERE cursor>? ORDER BY cursor LIMIT ?`).bind(cursor,PAGE_SIZE)
  ]);
  const end=head.results[0].value;
  if (cursor>end) throw fleetError(409,'cursor_ahead');
  const changes=[];
  let size=0;
  for (const row of page.results) {
    // Include at least one valid individual record so a large document
    // cannot prevent the cursor from ever advancing.
    size+=encoder.encode(row.data||'').byteLength+1024;
    if (changes.length && size>MAX_BYTES) break;
    changes.push({...row,deleted:Boolean(row.deleted),data:row.data===null?null:JSON.parse(row.data)});
  }
  const nextCursor=changes.at(-1)?.cursor ?? cursor;
  return {changes,nextCursor,hasMore:nextCursor<end};
}
