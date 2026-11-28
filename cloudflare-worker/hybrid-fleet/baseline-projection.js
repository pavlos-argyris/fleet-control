import { fleetRecordId } from '../src/snapshot-store.js';
import { fleetError, sha256, validFleetRecordId } from './ledger.js';
import { documentQr } from './invoice-identity.js';

export const BASELINE_CHUNK_BYTES=48*1024;
const MAX_LINE_BYTES=16*1024*1024;
const MAX_ROWS=32;
const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const hex=/^[a-f0-9]{64}$/;
const isObject=value=>value&&typeof value==='object'&&!Array.isArray(value);
const validKey=value=>typeof value==='string'&&value.length<=500&&value.startsWith('service-documents/')&&
  !value.includes('..')&&!value.endsWith('/')&&!value.includes('\0');
const validNumber=value=>Number.isSafeInteger(value)&&value>=0;
const identity=value=>fleetRecordId(value)||(validFleetRecordId(value)?value:'');
const invalid=()=>fleetError(409,'invalid_baseline_record');

function fileKeys(data) {
  const files=data.attachments??[];
  if (!Array.isArray(files)) throw invalid();
  const keys=files.flatMap(file=>file?.sourcePhoto?[file.key,file.sourcePhoto.key]:[file?.key]);
  if (keys.some(key=>!validKey(key))) throw invalid();
  return [...new Set(keys)];
}

function historyDetails(data) {
  const saved=data.invoiceData||{},invoiceJobId=identity(saved.qrJobId);
  return {type:data.type,serviceId:identity(data.id),files:fileKeys(data),invoiceJobId,invoiceQr:documentQr(saved.qrUrl||saved.qrValue),
    pendingInvoice:data.type==='service'&&['processing','pending','error'].includes(saved.qrProcessingStatus)&&
      Boolean(saved.qrUrl||saved.qrValue||invoiceJobId)};
}

export function recordIdentity(row,first) {
  if (!isObject(row)) throw invalid();
  const {kind,machineId='',recordId='',data}=row;
  if (first) {
    if (kind!=='snapshot'||!validNumber(row.version)||typeof row.updatedAt!=='string'||
        Object.keys(row).some(key=>!['kind','version','updatedAt'].includes(key))) throw invalid();
    return {kind,machineId,recordId,details:{}};
  }
  if (!isObject(data)||Object.keys(row).some(key=>!['kind','machineId','recordId','data'].includes(key))) throw invalid();
  const matchMachine=machine=>isObject(machine)&&validFleetRecordId(machineId)&&identity(machine.id)===machineId;
  let details={};
  switch (kind) {
    case 'machine': {
      if (!matchMachine(data)||recordId||!Array.isArray(data.historyDeletedIds??[])) throw invalid();
      const deleted=(data.historyDeletedIds??[]).map(identity);
      if (deleted.some(id=>!id)) throw invalid();
      details.deleted=deleted;
      break;
    }
    case 'machine-registry':
      if (!validFleetRecordId(machineId)||recordId) throw invalid();
      break;
    case 'machine-archive':
      if (!matchMachine(data.machine)||recordId||typeof data.active!=='boolean') throw invalid();
      details.archived=data.active;
      break;
    case 'history':
    case 'archived-history':
      if (!validFleetRecordId(machineId)||!validFleetRecordId(recordId)||
          identity(data.id)!==recordId||!['service','check'].includes(data.type)) throw invalid();
      details=historyDetails(data);
      break;
    case 'history-trash': {
      if (!validFleetRecordId(machineId)||!validFleetRecordId(recordId)||!isObject(data.entry)) throw invalid();
      const entryId=identity(data.entry.id),storedId=identity(data.recordId);
      // Android stores trash record identities as machineId:entryId; older exports use entryId.
      // Verify both components rather than stripping the prefix unconditionally.
      if (!entryId||(storedId!==entryId&&storedId!==`${machineId}:${entryId}`)) throw invalid();
      details=historyDetails(data.entry);
      break;
    }
    case 'invoice-job':
    case 'invoice-draft':
      if (machineId||!validFleetRecordId(recordId)) throw invalid();
      if (kind==='invoice-draft') details.invoiceJobId=identity(data.draft?.jobId);
      break;
    case 'document':
      if (machineId||!validKey(recordId)||typeof data.sha256!=='string'||!hex.test(data.sha256)||
          typeof data.name!=='string'||typeof data.contentType!=='string'||!validNumber(data.size)||data.size===0) throw invalid();
      details={sha256:data.sha256,size:data.size};
      break;
    default:
      throw invalid();
  }
  return {kind,machineId,recordId,details};
}

export function baselineReader(db,size) {
  return archiveReader(size,ordinal=>db.prepare(`SELECT ordinal,data FROM fleet_baseline_parts WHERE stream='records'
    AND ordinal>=? ORDER BY ordinal LIMIT 12`).bind(ordinal).all());
}

export function archiveReader(size,loadParts) {
  let parts=new Map();
  return async start=>{
    const views=[];
    let position=start,length=0;
    while (position<size) {
      const ordinal=Math.floor(position/BASELINE_CHUNK_BYTES);
      if (!parts.has(ordinal)) {
        const range=await loadParts(ordinal);
        parts=new Map(range.results.map(part=>[part.ordinal,new Uint8Array(part.data)]));
      }
      const part=parts.get(ordinal);
      if (part?.length!==Math.min(BASELINE_CHUNK_BYTES,size-ordinal*BASELINE_CHUNK_BYTES)) throw invalid();
      const offset=position%BASELINE_CHUNK_BYTES,end=part.indexOf(10,offset);
      const view=part.subarray(offset,end===-1?part.length:end);
      length+=view.length;
      if (length>MAX_LINE_BYTES) throw fleetError(409,'baseline_record_too_large');
      views.push(view);
      position+=view.length;
      if (end!==-1) {
        if (!length) throw invalid();
        const bytes=views.length===1?view:new Uint8Array(length);
        if (views.length!==1) {
          let written=0;
          for (const piece of views) { bytes.set(piece,written); written+=piece.length; }
        }
        let record;
        try { record=JSON.parse(decoder.decode(bytes)); } catch { throw invalid(); }
        return {record,next:position+1,digest:await sha256(bytes)};
      }
    }
    throw invalid();
  };
}

async function readIndexPage(db,state,manifest) {
  const read=baselineReader(db,manifest.dataBytes),rows=[];
  let next=state.next_byte,documents=state.documents;
  while (next<manifest.dataBytes&&rows.length<MAX_ROWS&&next-state.next_byte<2*BASELINE_CHUNK_BYTES) {
    const line=await read(next),identity=recordIdentity(line.record,next===0);
    if (identity.kind==='document') {
      const {sha256:hash,size}=identity.details;
      const proof=await db.prepare("SELECT digest FROM fleet_baseline_parts WHERE stream='files' AND ordinal=?").bind(documents).first('digest');
      if (proof!==await sha256(hash+':'+size)) throw fleetError(409,'baseline_document_proof_mismatch');
      documents++;
    }
    rows.push({...identity,ordinal:state.next_row+rows.length,start:next,end:line.next,digest:line.digest});
    next=line.next;
  }
  return {rows,next,documents};
}

const checkpoint=`id=1 AND epoch=? AND state='indexing' AND next_byte=? AND next_row=?
  AND EXISTS(SELECT 1 FROM fleet_rehearsal_state e WHERE e.id=1 AND e.epoch=fleet_baseline_projection.epoch)`;
const expected=state=>[state.epoch,state.next_byte,state.next_row];

async function savePage(db,state,page) {
  const unique=new Set(page.rows.map(row=>JSON.stringify([row.kind,row.machineId,row.recordId])));
  if (unique.size!==page.rows.length) throw fleetError(409,'baseline_duplicate_record');
  const rows=JSON.stringify(page.rows),last=state.next_row+page.rows.length;
  const bound=expected(state);
  await db.batch([
    db.prepare(`INSERT INTO fleet_baseline_rows(ordinal,kind,machine_id,record_id,start_byte,end_byte,digest,details)
      SELECT json_extract(j.value,'$.ordinal'),json_extract(j.value,'$.kind'),json_extract(j.value,'$.machineId'),
        json_extract(j.value,'$.recordId'),json_extract(j.value,'$.start'),json_extract(j.value,'$.end'),
        json_extract(j.value,'$.digest'),json_extract(j.value,'$.details')
      FROM json_each(?) j WHERE EXISTS(SELECT 1 FROM fleet_baseline_projection WHERE ${checkpoint})
      AND NOT EXISTS(SELECT 1 FROM json_each(?) p JOIN fleet_baseline_rows r
        ON r.kind=json_extract(p.value,'$.kind') AND r.machine_id=json_extract(p.value,'$.machineId') AND r.record_id=json_extract(p.value,'$.recordId'))`)
      .bind(rows,...bound,rows),
    db.prepare(`INSERT INTO fleet_baseline_document_links(file_key,machine_id,service_id)
      SELECT f.value,r.machine_id,json_extract(r.details,'$.serviceId')
      FROM fleet_baseline_rows r,json_each(r.details,'$.files') f WHERE r.ordinal>=? AND r.ordinal<?
      AND EXISTS(SELECT 1 FROM fleet_baseline_projection WHERE ${checkpoint})
      ON CONFLICT(file_key,machine_id,service_id) DO NOTHING`)
      .bind(state.next_row,last,...bound),
    db.prepare(`UPDATE fleet_baseline_projection SET next_byte=?,next_row=?,documents=? WHERE ${checkpoint}
      AND (SELECT count(*) FROM fleet_baseline_rows WHERE ordinal>=? AND ordinal<?)=?`)
      .bind(page.next,last,page.documents,...bound,state.next_row,last,page.rows.length),
    db.prepare(`UPDATE fleet_baseline_projection SET state='blocked',reason='baseline_duplicate_record' WHERE ${checkpoint}`)
      .bind(...bound)
  ]);
}

async function finish(db,state,manifest) {
  const [missingParent,missingFile]=await db.batch([
    db.prepare(`SELECT 1 FROM fleet_baseline_rows r WHERE r.kind IN ('history','archived-history')
      AND NOT EXISTS(SELECT 1 FROM fleet_baseline_rows p WHERE p.kind=CASE r.kind WHEN 'history' THEN 'machine'
        ELSE 'machine-archive' END AND p.machine_id=r.machine_id AND p.record_id='') LIMIT 1`),
    db.prepare(`SELECT 1 FROM fleet_baseline_rows r, json_each(r.details,'$.files') f
      WHERE NOT EXISTS(SELECT 1 FROM fleet_baseline_rows d WHERE d.kind='document' AND d.machine_id='' AND d.record_id=f.value) LIMIT 1`)
  ]);
  const reason=state.documents!==manifest.files?'baseline_document_count_mismatch':missingParent.results.length?'baseline_parent_missing':
    missingFile.results.length?'baseline_document_missing':'';
  await db.prepare(`UPDATE fleet_baseline_projection SET state=?,reason=? WHERE ${checkpoint}`)
    .bind(reason?'blocked':'verified',reason,...expected(state)).run();
}

export async function advanceBaselineProjection(db) {
  await db.prepare(`INSERT INTO fleet_baseline_projection(id,epoch,state)
    SELECT 1,b.epoch,'indexing' FROM fleet_baseline b JOIN fleet_rehearsal_state e ON e.id=1 AND e.epoch=b.epoch
    WHERE b.id=1 AND b.verified_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM fleet_baseline_projection WHERE id=1)`).run();
  const state=await db.prepare(`SELECT p.*,b.manifest FROM fleet_baseline_projection p
    JOIN fleet_baseline b ON b.id=p.id AND b.epoch=p.epoch AND b.verified_at IS NOT NULL
    JOIN fleet_rehearsal_state e ON e.id=p.id AND e.epoch=p.epoch WHERE p.id=1 AND p.state='indexing'`).first();
  if (!state) return false;
  const manifest=JSON.parse(state.manifest);
  try {
    if (state.next_byte===manifest.dataBytes) await finish(db,state,manifest);
    else await savePage(db,state,await readIndexPage(db,state,manifest));
  } catch (error) {
    if (error.status!==409) throw error;
    await db.prepare(`UPDATE fleet_baseline_projection SET state='blocked',reason=? WHERE ${checkpoint}`)
      .bind(error.code,...expected(state)).run();
  }
  return true;
}

export const BASELINE_MACHINE_VISIBLE=`NOT EXISTS(SELECT 1 FROM fleet_baseline_rows a WHERE a.kind='machine-archive'
  AND a.machine_id=h.machine_id AND a.record_id='' AND json_extract(a.details,'$.archived')=1)`;

export const BASELINE_HISTORY_VISIBLE=`NOT EXISTS(SELECT 1 FROM json_each(m.details,'$.deleted') WHERE value=h.record_id)`;

export function findVerifiedBaselineService(db,epoch,machineId,serviceId) {
  return db.prepare(`SELECT h.start_byte,h.end_byte,h.digest,json_extract(b.manifest,'$.dataBytes') AS size
    FROM fleet_baseline_rows h JOIN fleet_baseline_rows m ON m.kind='machine' AND m.machine_id=h.machine_id AND m.record_id=''
    JOIN fleet_baseline_projection p ON p.id=1 AND p.epoch=? AND p.state='verified'
    JOIN fleet_baseline b ON b.id=p.id AND b.epoch=p.epoch AND b.verified_at IS NOT NULL
    WHERE h.kind='history' AND h.machine_id=? AND h.record_id=? AND json_extract(h.details,'$.type')='service'
    AND ${BASELINE_HISTORY_VISIBLE} AND ${BASELINE_MACHINE_VISIBLE}`)
    .bind(epoch,machineId,serviceId).first();
}

export function verifiedBaselineDocument(db,epoch,key,hash,machineId,serviceId) {
  return db.prepare(`SELECT EXISTS(SELECT 1 FROM fleet_baseline_document_links a WHERE a.file_key=d.record_id
    AND (a.machine_id<>? OR a.service_id<>?)) AS conflict FROM fleet_baseline_rows AS d
    JOIN fleet_baseline_projection p ON p.id=1 AND p.epoch=? AND p.state='verified'
    WHERE d.kind='document' AND d.machine_id='' AND d.record_id=? AND json_extract(d.details,'$.sha256')=?`)
    .bind(machineId,serviceId,epoch,key,hash).first();
}

export async function verifiedBaselineService(db,epoch,machineId,serviceId) {
  if (!validFleetRecordId(machineId)||!validFleetRecordId(serviceId)) throw fleetError(400,'invalid_baseline_target');
  const row=await findVerifiedBaselineService(db,epoch,machineId,serviceId);
  if (!row) {
    const ready=await db.prepare("SELECT 1 FROM fleet_baseline_projection WHERE id=1 AND epoch=? AND state='verified'").bind(epoch).first();
    if (!ready) throw fleetError(409,'baseline_projection_unverified');
    throw fleetError(404,'baseline_service_absent');
  }
  const service=await readIndexedBaselineRow(baselineReader(db,row.size),row);
  return {epoch,machineId,serviceId,recordSha256:row.digest,service};
}

export async function readIndexedBaselineRow(read,row) {
  const saved=await read(row.start_byte);
  if (saved.next!==row.end_byte||saved.digest!==row.digest) throw fleetError(409,'baseline_record_proof_mismatch');
  return saved.record.data;
}
