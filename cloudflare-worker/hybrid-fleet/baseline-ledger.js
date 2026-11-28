import { invoicePlate } from '../src/invoice-extraction.js';
import { stableReviewJson } from '../src/invoice-review-store.js';
import { fleetError, sha256, validFleetRecordId } from './ledger.js';
import { confirmedAttachment, documentQr, fiscalIdentities, invoiceNumberParts } from './invoice-identity.js';
import { baselineReader, BASELINE_HISTORY_VISIBLE, BASELINE_MACHINE_VISIBLE, readIndexedBaselineRow } from './baseline-projection.js';

const encoder=new TextEncoder();
const MAX_RECORD_BYTES=160*1024;
const MAX_BATCH_BYTES=300*1024;
const MAX_BATCH_ROWS=24;
const copyFields=(data,fields)=>Object.fromEntries(fields.filter(key=>Object.hasOwn(data,key)).map(key=>[key,data[key]]));
const compactInvoiceFields=['supplier','invoiceNumber','invoiceDate','mark','plate','odometerKm','totalAmount','netAmount','vatAmount',
  'laborAmount','comments','currency','issuedBy','lineItems','workPerformed'];
const checkpoint=`id=1 AND epoch=? AND state='loading' AND next_row=?
  AND EXISTS(SELECT 1 FROM fleet_rehearsal_state e WHERE e.id=1 AND e.epoch=fleet_baseline_ledger.epoch)`;
const cursor=state=>[state.epoch,state.next_row];

async function seedRecord(kind,machineId,recordId,serviceId,data,updatedAt) {
  const payload=stableReviewJson(data);
  if (encoder.encode(payload).length>MAX_RECORD_BYTES) throw fleetError(409,'baseline_working_record_too_large');
  const address=stableReviewJson([kind,machineId,recordId,serviceId]);
  return {kind,machineId,recordId,serviceId,payload,updatedAt,operationId:'baseline:'+await sha256(address),
    fingerprint:await sha256(address+'\n'+payload)};
}

async function documents(db,attachments) {
  const keys=attachments.flatMap(file=>file.sourcePhoto?[file.key,file.sourcePhoto.key]:[file.key]);
  const result=await db.prepare(`SELECT record_id,details FROM fleet_baseline_rows WHERE kind='document' AND machine_id=''
    AND record_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(keys)).all();
  return new Map(result.results.map(row=>[row.record_id,JSON.parse(row.details)]));
}

async function seedHistory(db,row,data,updatedAt) {
  const attachments=(data.attachments??[]).filter(confirmedAttachment);
  const mutations=[],identities=[];
  if (row.visible) {
    const {attachments:files,invoiceData,...fields}=data;
    mutations.push(await seedRecord(data.type==='service'?'service':'mileage',row.machine_id,row.record_id,'',fields,updatedAt));
  }
  if (!attachments.length) return {mutations,identities};
  const stored=await documents(db,attachments),serviceId=row.kind==='history-trash'?data.id:row.record_id;
  for (const file of attachments) {
    const confirmation=confirmedAttachment(file),proof=stored.get(file.key),photo=stored.get(file.sourcePhoto?.key);
    if (!proof || (file.sourcePhoto && !photo)) throw fleetError(409,'baseline_document_proof_mismatch');
    const qrUrl=documentQr(file.qrUrl||file.qrValue||confirmation.qrUrl),qrHash=qrUrl?await sha256(qrUrl):'';
    const keys=await fiscalIdentities(invoiceNumberParts(confirmation),proof.sha256,qrHash);
    keys.push('file:'+await sha256(file.key));
    if (file.sourcePhoto) keys.push('file:'+await sha256(file.sourcePhoto.key));
    identities.push(...keys.map(identity=>({identity,machineId:row.machine_id,serviceId})));
    if (!row.visible) continue;
    const fileId=String(file.id??'');
    const recordId=validFleetRecordId(fileId)?fileId:'file:'+await sha256(file.key);
    const invoice={...copyFields(confirmation,compactInvoiceFields),name:file.name||'τιμολόγιο',
      contentType:file.contentType||'application/octet-stream',size:proof.size,sha256:proof.sha256,
      qrUrl,qrValue:file.qrValue||qrUrl,reviewedAt:String(confirmation.confirmedAt),attachmentKey:file.key,
      sourcePhotoKey:file.sourcePhoto?.key||'',sourceSha256:photo?.sha256||''};
    mutations.push(await seedRecord('invoice',row.machine_id,recordId,serviceId,invoice,updatedAt));
  }
  return {mutations,identities};
}

async function prepareSeeds(db,state) {
  const read=baselineReader(db,state.data_bytes),batch={mutations:[],identities:[],next:state.next_row};
  const indexed=await db.prepare(`SELECT h.*,CASE WHEN h.kind IN ('machine','history') AND ${BASELINE_MACHINE_VISIBLE}
    AND (h.kind='machine' OR ${BASELINE_HISTORY_VISIBLE}) THEN 1 ELSE 0 END AS visible
    FROM fleet_baseline_rows h
    LEFT JOIN fleet_baseline_rows m ON m.kind='machine' AND m.machine_id=h.machine_id AND m.record_id=''
    WHERE h.ordinal>=? ORDER BY h.ordinal LIMIT ?`).bind(state.next_row,MAX_BATCH_ROWS).all();
  let sourceBytes=0,writeBytes=0;
  for (const row of indexed.results) {
    const bytes=row.end_byte-row.start_byte;
    if (batch.next!==state.next_row&&sourceBytes+bytes>MAX_BATCH_BYTES) break;
    if (row.ordinal!==batch.next) throw fleetError(409,'baseline_working_cursor_gap');
    let seeds={mutations:[],identities:[]};
    if (row.kind==='machine'&&row.visible) {
      const data=await readIndexedBaselineRow(read,row);
      seeds.mutations.push(await seedRecord('machine',row.machine_id,row.machine_id,'',
        {...data,plateKey:invoicePlate(data.name)},data.updatedAt||data.createdAt||state.started_at));
    } else if (['history','archived-history','history-trash'].includes(row.kind)) {
      const info=JSON.parse(row.details);
      if (row.visible||info.files?.length) {
        const content=await readIndexedBaselineRow(read,row);
        const data=row.kind==='history-trash'?content.entry:content;
        const history={...data,id:String(data.id)};
        seeds=await seedHistory(db,row,history,data.updatedAt||data.createdAt||state.started_at);
      }
    }
    const proposed=encoder.encode(JSON.stringify(seeds)).length;
    if (proposed>MAX_BATCH_BYTES) throw fleetError(409,'baseline_working_record_too_large');
    if (batch.next!==state.next_row&&writeBytes+proposed>MAX_BATCH_BYTES) break;
    batch.mutations.push(...seeds.mutations);
    batch.identities.push(...seeds.identities);
    batch.next++;
    sourceBytes+=bytes;
    writeBytes+=proposed;
  }
  return batch;
}

async function saveSeeds(db,state,page) {
  const keys=new Set(page.mutations.map(row=>JSON.stringify([row.kind,row.machineId,row.recordId])));
  const rows=JSON.stringify(page.mutations);
  const exists=await db.prepare(`SELECT 1 FROM json_each(?) j JOIN fleet_records r
    ON r.kind=json_extract(j.value,'$.kind') AND r.machine_id=json_extract(j.value,'$.machineId')
    AND r.record_id=json_extract(j.value,'$.recordId') LIMIT 1`).bind(rows).first();
  if (exists||keys.size!==page.mutations.length) throw fleetError(409,'baseline_working_duplicate_record');
  const guard=`EXISTS(SELECT 1 FROM fleet_baseline_ledger WHERE ${checkpoint})`,before=cursor(state);
  await db.batch([
    db.prepare(`INSERT INTO fleet_mutations(operation_id,fingerprint,kind,machine_id,record_id,service_id,revision,deleted,data,committed_at)
      SELECT json_extract(j.value,'$.operationId'),json_extract(j.value,'$.fingerprint'),json_extract(j.value,'$.kind'),
        json_extract(j.value,'$.machineId'),json_extract(j.value,'$.recordId'),json_extract(j.value,'$.serviceId'),1,0,
        json_extract(j.value,'$.payload'),json_extract(j.value,'$.updatedAt')
      FROM json_each(?) j WHERE ${guard} ORDER BY CAST(j.key AS INTEGER)`).bind(rows,...before),
    db.prepare(`INSERT INTO fleet_baseline_invoice_identity(identity,machine_id,service_id)
      SELECT json_extract(j.value,'$.identity'),json_extract(j.value,'$.machineId'),json_extract(j.value,'$.serviceId')
      FROM json_each(?) j WHERE ${guard} ON CONFLICT(identity,machine_id,service_id) DO NOTHING`)
      .bind(JSON.stringify(page.identities),...before),
    db.prepare(`UPDATE fleet_baseline_ledger SET next_row=?,seeded_rows=seeded_rows+? WHERE ${checkpoint}`)
      .bind(page.next,page.mutations.length,...before)
  ]);
}

export async function advanceBaselineLedger(db) {
  await db.prepare(`INSERT INTO fleet_baseline_ledger(id,epoch,state,reason,started_at)
    SELECT p.id,p.epoch,CASE WHEN m.found OR r.found THEN 'blocked' ELSE 'loading' END,
      CASE WHEN m.found OR r.found THEN 'baseline_working_ledger_not_empty' ELSE '' END,datetime('now')
    FROM fleet_baseline_projection p JOIN fleet_rehearsal_state e ON e.id=p.id AND e.epoch=p.epoch
    LEFT JOIN (SELECT 1 AS found FROM fleet_mutations LIMIT 1) m ON 1=1
    LEFT JOIN (SELECT 1 AS found FROM fleet_records LIMIT 1) r ON 1=1
    WHERE p.id=1 AND p.state='verified' AND NOT EXISTS(SELECT 1 FROM fleet_baseline_ledger WHERE id=1)`).run();
  const state=await db.prepare(`SELECT l.*,p.next_row AS total,json_extract(b.manifest,'$.dataBytes') AS data_bytes
    FROM fleet_baseline_ledger l JOIN fleet_baseline_projection p ON p.id=l.id AND p.epoch=l.epoch AND p.state='verified'
    JOIN fleet_baseline b ON b.id=l.id AND b.epoch=l.epoch AND b.verified_at IS NOT NULL
    JOIN fleet_rehearsal_state e ON e.id=l.id AND e.epoch=l.epoch WHERE l.id=1 AND l.state='loading'`).first();
  if (!state) return false;
  try {
    if (state.next_row===state.total) {
      const consistent=await db.prepare(`SELECT (SELECT count(*) FROM fleet_mutations)=? AND
        (SELECT count(*) FROM fleet_records)=? AS verified`).bind(state.seeded_rows,state.seeded_rows).first('verified');
      if (!consistent) throw fleetError(409,'baseline_working_count_mismatch');
      await db.prepare(`UPDATE fleet_baseline_ledger SET state='ready' WHERE ${checkpoint}`).bind(...cursor(state)).run();
    } else {
      const page=await prepareSeeds(db,state);
      if (page.next===state.next_row) throw fleetError(409,'baseline_working_cursor_gap');
      await saveSeeds(db,state,page);
    }
  } catch (error) {
    if (error.status!==409) throw error;
    await db.prepare(`UPDATE fleet_baseline_ledger SET state='blocked',reason=? WHERE ${checkpoint}`)
      .bind(error.code,...cursor(state)).run();
  }
  return true;
}
