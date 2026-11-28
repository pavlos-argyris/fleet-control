import { validTargetedOperationId } from '../src/targeted-service-qr.js';
import { fleetError, sha256, validFleetRecordId } from './ledger.js';
import { baselineReader, BASELINE_HISTORY_VISIBLE, BASELINE_MACHINE_VISIBLE, findVerifiedBaselineService,
  readIndexedBaselineRow } from './baseline-projection.js';
import { confirmedAttachment } from './invoice-identity.js';
import { sealInvoiceStage, stageInvoiceJobs } from './invoice-jobs.js';
import { resolveLegacyInvoiceTarget } from './legacy-invoice-target.js';

const validId=value=>{
  const id=Number.isSafeInteger(value)?String(value):value;
  return validFleetRecordId(id)?id:'';
};
const string=value=>typeof value==='string'?value:'';
const MAX_PAGE_BYTES=300*1024;
const MAX_PAGE_JOBS=3;
const checkpoint=`id=1 AND epoch=? AND state='loading' AND next_row=?
  AND EXISTS(SELECT 1 FROM fleet_rehearsal_state e WHERE e.id=1 AND e.epoch=fleet_baseline_invoice_import.epoch)`;
const cursor=state=>[state.epoch,state.next_row];

async function historyLinks(db,sourceId) {
  const rows=await db.prepare(`SELECT h.machine_id AS machineId,h.record_id AS serviceId,json_extract(h.details,'$.invoiceQr') AS qr
    FROM fleet_baseline_rows h JOIN fleet_baseline_rows m ON m.kind='machine' AND m.machine_id=h.machine_id AND m.record_id=''
    WHERE h.kind='history' AND json_extract(h.details,'$.invoiceJobId')=? AND json_extract(h.details,'$.invoiceQr')<>''
    AND ${BASELINE_HISTORY_VISIBLE} AND ${BASELINE_MACHINE_VISIBLE} LIMIT 2`).bind(sourceId).all();
  return rows.results;
}

async function hasOriginalJob(db,jobId) {
  return jobId&&await db.prepare(`SELECT EXISTS(SELECT 1 FROM fleet_baseline_rows WHERE kind='invoice-job' AND machine_id='' AND record_id=?)
    OR EXISTS(SELECT 1 FROM fleet_baseline_rows WHERE kind='invoice-draft' AND json_extract(details,'$.invoiceJobId')=?) AS found`)
    .bind(jobId,jobId).first('found');
}

async function fieldsFromHistory(db,row,history) {
  const invoice=history?.invoiceData||{},jobId=validId(invoice.qrJobId);
  if (await hasOriginalJob(db,jobId)) return null;
  const file=jobId&&(history?.attachments??[]).find(file=>!confirmedAttachment(file)&&validId(file.renderJobId)===jobId);
  const serviceId=validId(history?.id),sourceId='history:'+await sha256(JSON.stringify(
    row.kind==='history'?[row.machine_id,serviceId]:[row.kind,row.machine_id,row.record_id]));
  return {sourceId,payload:{bikeId:row.machine_id,entryId:serviceId,qrValue:invoice.qrValue,qrUrl:invoice.qrUrl,
    documentKey:file?.key,sourcePhotoKey:file?.sourcePhoto?.key,targetedOperationId:invoice.targetedOperationId},
    reason:row.kind==='history'?'':'original_service_not_verified'};
}

async function recoverJob(db,epoch,row,data) {
  let source,stored;
  if (row.kind==='invoice-job') {
    source='legacy-operation';
    const legacyBatch=data.type==='service_document_reprocess_batch';
    stored={sourceId:row.record_id,payload:legacyBatch?{}:data.input,
      reason:legacyBatch?'legacy_batch_needs_review':data.type==='service_document_render'?'':'legacy_source_needs_review'};
  } else if (row.kind==='invoice-draft') {
    source='legacy-draft';
    const draft=data.draft||{};
    stored={sourceId:row.record_id,payload:{...draft,bikeId:draft.commitIntent?.bikeId,entryId:draft.commitIntent?.entryId}};
  } else {
    source='service-history';
    stored=await fieldsFromHistory(db,row,row.kind==='history-trash'?data.entry:data);
  }
  if (!stored) return null;
  const sourceId=stored.sourceId,payload=stored.payload||{};
  let machineId=validId(payload.bikeId),serviceId=validId(payload.entryId);
  let reviewReason=stored.reason||'';
  if (source==='legacy-operation'&&!reviewReason) {
    const targetExists=machineId&&serviceId&&Boolean(await findVerifiedBaselineService(db,epoch,machineId,serviceId));
    const links=await historyLinks(db,sourceId);
    const resolved=resolveLegacyInvoiceTarget({source,payload,machineId,serviceId,targetExists,links});
    machineId=resolved.machineId;
    if (resolved.conflict) reviewReason='original_target_conflict';
  }
  let qrValue=string(payload.qrValue||payload.qrUrl||payload.attachment?.qrUrl);
  let sourceKey=string(payload.sourcePhotoKey||payload.documentKey||payload.attachment?.key);
  if (qrValue.length>4096||sourceKey.length>520) {
    qrValue='';
    sourceKey='';
    reviewReason='legacy_source_needs_review';
  }
  const sha=sourceKey&&await db.prepare(`SELECT json_extract(details,'$.sha256') AS sha FROM fleet_baseline_rows
    WHERE kind='document' AND machine_id='' AND record_id=?`).bind(sourceKey).first('sha');
  return {operationId:'legacy:'+await sha256(JSON.stringify([source,sourceId])),machineId,serviceId,qrValue,sourceKey,
    sourceSha256:sha||'',source,sourceId,explicitId:validTargetedOperationId(payload.targetedOperationId)?payload.targetedOperationId:'',
    ...(reviewReason?{reviewReason}:{})};
}

export async function baselineInvoiceImportReady(db) {
  const row=await db.prepare(`SELECT 1 FROM fleet_baseline_invoice_import i JOIN fleet_rehearsal_state e ON e.id=i.id AND e.epoch=i.epoch
    JOIN fleet_invoice_stage s ON s.id=i.id AND s.job_count=i.job_count WHERE i.id=1 AND i.state='ready'`).first();
  return Boolean(row);
}

export async function advanceBaselineInvoiceImport(env) {
  const db=env.FLEET_DB;
  await db.prepare(`INSERT INTO fleet_baseline_invoice_import(id,epoch,state,reason)
    SELECT l.id,l.epoch,CASE WHEN x.found OR s.id IS NOT NULL THEN 'blocked' ELSE 'loading' END,
      CASE WHEN x.found OR s.id IS NOT NULL THEN 'baseline_invoice_queue_not_empty' ELSE '' END
    FROM fleet_baseline_ledger l JOIN fleet_rehearsal_state e ON e.id=l.id AND e.epoch=l.epoch
    LEFT JOIN (SELECT 1 AS found FROM fleet_invoice_jobs LIMIT 1) x ON 1=1
    LEFT JOIN fleet_invoice_stage s ON s.id=l.id
    WHERE l.id=1 AND l.state='ready' AND NOT EXISTS(SELECT 1 FROM fleet_baseline_invoice_import WHERE id=1)`).run();
  const state=await db.prepare(`SELECT i.*,json_extract(b.manifest,'$.dataBytes') AS data_bytes FROM fleet_baseline_invoice_import i
    JOIN fleet_baseline_ledger l ON l.id=i.id AND l.epoch=i.epoch AND l.state='ready'
    JOIN fleet_rehearsal_state e ON e.id=i.id AND e.epoch=i.epoch
    JOIN fleet_baseline b ON b.id=i.id AND b.epoch=i.epoch WHERE i.id=1 AND i.state='loading'`).first();
  if (!state) return false;
  try {
    const candidates=await db.prepare(`SELECT ordinal,kind,machine_id,record_id,start_byte,end_byte,digest FROM fleet_baseline_rows
      WHERE ordinal>=? AND (kind IN ('invoice-job','invoice-draft') OR json_extract(details,'$.pendingInvoice')=1)
      ORDER BY ordinal LIMIT ?`).bind(state.next_row,MAX_PAGE_JOBS).all();
    if (!candidates.results.length) {
      await sealInvoiceStage(env,null,state.epoch,{count:state.job_count});
      await db.prepare(`UPDATE fleet_baseline_invoice_import SET state='ready' WHERE ${checkpoint}`).bind(...cursor(state)).run();
    } else {
      const read=baselineReader(db,state.data_bytes),jobs=[];
      let next=state.next_row,bytes=0;
      for (const row of candidates.results) {
        const size=row.end_byte-row.start_byte;
        if (next!==state.next_row&&bytes+size>MAX_PAGE_BYTES) break;
        const job=await recoverJob(db,state.epoch,row,await readIndexedBaselineRow(read,row));
        if (job) jobs.push(job);
        next=row.ordinal+1;
        bytes+=size;
      }
      if (state.job_count+jobs.length>5000) throw fleetError(409,'baseline_invoice_count_exceeds_limit');
      if (jobs.length) await stageInvoiceJobs(env,null,state.epoch,{jobs});
      await db.prepare(`UPDATE fleet_baseline_invoice_import SET next_row=?,job_count=job_count+? WHERE ${checkpoint}`)
        .bind(next,jobs.length,...cursor(state)).run();
    }
  } catch (error) {
    if (![400,409].includes(error.status)) throw error;
    await db.prepare(`UPDATE fleet_baseline_invoice_import SET state='blocked',reason=? WHERE ${checkpoint}`)
      .bind(error.code,...cursor(state)).run();
  }
  return true;
}
