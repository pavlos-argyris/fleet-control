import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { inspectNativeFleetBackup } from './hybrid-fleet-preflight.mjs';
import { invoiceStageProof } from '../cloudflare-worker/hybrid-fleet/invoice-jobs.js';
import { validTargetedOperationId } from '../cloudflare-worker/src/targeted-service-qr.js';

const stableId=value=>typeof value==='string'||Number.isSafeInteger(value)?String(value):'';
const identity=(bikeId,entryId)=>JSON.stringify([stableId(bikeId),stableId(entryId)]);
const hash=value=>createHash('sha256').update(value).digest('hex');
const link=value=>{
  try { const url=new URL(value); url.hash=''; return url.href; }
  catch { return ''; }
};
const confirmed=file=>Boolean(file?.ocr?.confirmedAt||file?.invoiceData?.confirmedAt||file?.qrData?.confirmedAt);

// Only jobs and verified file bytes go to the scoped staging API.
// Original rows stay in the private plan for reconciliation.
export async function prepareNativeInvoicePlan(options) {
  let backlog;
  const preflight=inspectNativeFleetBackup(options,db=>{backlog=extractBacklog(db);});
  return {format:'private-fleet-invoice-plan-v1',sourceDatabaseSha256:preflight.sourceDatabaseSha256,
    count:backlog.jobs.length,manifestHash:await invoiceStageProof(backlog.jobs),...backlog,
    backupBlockingReasons:preflight.blockingReasons};
}

function extractBacklog(db) {
  const bikes=JSON.parse(db.prepare('SELECT data FROM fleet_snapshot WHERE id=1').get().data).bikes;
  const byTarget=new Map(), invoiceLinks=new Map(), historyJobLinks=new Map(), seenSources=new Set();
  const hasArchiveState=db.prepare("SELECT 1 FROM pragma_table_info('vehicle_archives') WHERE name='active'").get();
  const archives=db.prepare(hasArchiveState?'SELECT * FROM vehicle_archives WHERE active=1':'SELECT * FROM vehicle_archives').all();
  const archiveIds=new Set(archives.map(archive=>stableId(archive.bike_id)));
  function indexInvoices(bikeId,entry) {
    const key=identity(bikeId,entry.id);
    for (const file of entry.attachments||[]) {
      if (!confirmed(file)) continue;
      for (const value of [file.key,file.renderJobId,link(file.qrUrl||file.qrValue||file.ocr?.qrUrl)]) {
        if (!value) continue;
        const targets=invoiceLinks.get(String(value))||new Set();
        targets.add(key);
        invoiceLinks.set(String(value),targets);
      }
    }
  }
  for (const bike of bikes) {
    const deleted=new Set((bike.historyDeletedIds||[]).map(stableId));
    for (const entry of bike.history) {
      indexInvoices(bike.id,entry);
      if (entry.type!=='service'||deleted.has(stableId(entry.id))||archiveIds.has(stableId(bike.id))) continue;
      const target=identity(bike.id,entry.id);
      byTarget.set(target,entry);
      const saved=entry.invoiceData||{};
      if (saved.qrJobId && link(saved.qrUrl||saved.qrValue)) {
        const links=historyJobLinks.get(stableId(saved.qrJobId))||[];
        links.push({target,qr:link(saved.qrUrl||saved.qrValue)});
        historyJobLinks.set(stableId(saved.qrJobId),links);
      }
    }
  }
  for (const archive of archives) {
    for (const entry of JSON.parse(archive.snapshot_json).history||[]) indexInvoices(archive.bike_id,entry);
  }
  for (const deleted of db.prepare("SELECT payload FROM deleted_records WHERE record_type='fleet_history'").iterate()) {
    const {bikeId,entry}=JSON.parse(deleted.payload);
    if (entry) indexInvoices(bikeId,entry);
  }
  const available=new Map(db.prepare("SELECT key,local_name,name,content_type,size,sha256 FROM native_objects WHERE deleted_at IS NULL AND key LIKE 'service-documents/%'")
    .all().map(file=>[file.key,file]));
  const jobs=[],originals=[],objects=new Map(),excludedConfirmed=[];
  function add(source,sourceId,payload,original) {
    const sourceKey=String(payload.sourcePhotoKey||payload.documentKey||payload.attachment?.key||'');
    const qrValue=String(payload.qrValue||payload.qrUrl||payload.attachment?.qrUrl||'');
    let machineId=stableId(payload.bikeId);
    const serviceId=stableId(payload.entryId),qr=link(qrValue);
    let target=identity(machineId,serviceId);
    // A legacy operation may contain a truncated machine ID. Its own job
    // receipt plus the same QR and service ID can prove the canonical link.
    const historyLinks=historyJobLinks.get(sourceId)||[];
    if (source==='legacy-operation' && !payload.draftId && !payload.targetedOperationId && !byTarget.has(target) &&
        historyLinks.length===1 && qr && historyLinks[0].qr===qr) {
      const [canonicalMachine,canonicalService]=JSON.parse(historyLinks[0].target);
      if (canonicalService===serviceId) {
        machineId=canonicalMachine;
        target=historyLinks[0].target;
      }
    }
    const conflictingTarget=historyLinks.length>0 &&
      (historyLinks.length!==1 || historyLinks[0].target!==target || historyLinks[0].qr!==qr);
    const linked=new Set([sourceId,sourceKey,link(qrValue)].flatMap(value=>[...(invoiceLinks.get(value)||[])]));
    originals.push({source,sourceId,record:original});
    if (linked.size===1 && linked.has(target)) {
      excludedConfirmed.push({source,sourceId});
      return;
    }
    const file=available.get(sourceKey);
    if (file) objects.set(sourceKey,file);
    // A draft/archived record cannot supply permission to attach a second copy.
    const reviewReason=linked.size?'invoice_attached_elsewhere':conflictingTarget?'original_target_conflict':
      !byTarget.has(target)?'original_service_not_verified':'';
    const explicitId=validTargetedOperationId(payload.targetedOperationId)?payload.targetedOperationId:'';
    jobs.push({operationId:'legacy:'+hash(JSON.stringify([source,sourceId])),machineId,serviceId,qrValue,sourceKey,
      sourceSha256:file?.sha256||'',source,sourceId,explicitId,...(reviewReason?{reviewReason}:{})});
  }
  for (const row of db.prepare("SELECT * FROM fleet_operations WHERE type IN ('service_document_render','service_document_reprocess_batch') AND status IN ('pending','error') ORDER BY id").iterate()) {
    const payload=JSON.parse(row.payload);
    if (row.type==='service_document_reprocess_batch') {
      originals.push({source:'legacy-batch',sourceId:row.id,record:row});
      continue;
    }
    seenSources.add(stableId(row.id));
    add('legacy-operation',stableId(row.id),payload,row);
  }
  for (const row of db.prepare("SELECT * FROM invoice_import_drafts WHERE status IN ('processing','ready','committing','error') ORDER BY id").iterate()) {
    const payload=JSON.parse(row.data);
    add('legacy-draft',stableId(row.id),{...payload,bikeId:payload.commitIntent?.bikeId,entryId:payload.commitIntent?.entryId},row);
    if (payload.jobId) seenSources.add(stableId(payload.jobId));
  }
  for (const [key,entry] of byTarget) {
    const [bikeId,entryId]=JSON.parse(key),info=entry.invoiceData||{};
    if (seenSources.has(stableId(info.qrJobId))) continue;
    if (!['processing','pending','error'].includes(info.qrProcessingStatus) || !(info.qrUrl||info.qrValue||info.qrJobId)) continue;
    const file=entry.attachments?.find(file=>!confirmed(file) && info.qrJobId && file.renderJobId===info.qrJobId);
    const sourceId='history:'+hash(key);
    add('service-history',sourceId,{bikeId,entryId,qrUrl:info.qrUrl,qrValue:info.qrValue,
      targetedOperationId:info.targetedOperationId,sourcePhotoKey:file?.sourcePhoto?.key,documentKey:file?.key},info);
  }
  return {jobs,originals,objects:[...objects.values()],excludedConfirmed};
}

async function main() {
  try {
    const {values}=parseArgs({options:{database:{type:'string'},manifest:{type:'string'},objects:{type:'string'},'private-output':{type:'string'}}});
    if (!values.database || !values.manifest || !values['private-output']) throw new Error();
    const native=JSON.parse(readFileSync(values.manifest,'utf8'));
    const plan=await prepareNativeInvoicePlan({...values,manifest:native.nativeDatabase||native});
    writeFileSync(values['private-output'],JSON.stringify(plan),{flag:'wx',mode:0o600});
    console.log(JSON.stringify({count:plan.count,manifestHash:plan.manifestHash,excludedConfirmed:plan.excludedConfirmed.length}));
  } catch {
    console.error('Could not prepare the private Fleet invoice plan from a verified snapshot.');
    process.exitCode=2;
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) await main();
