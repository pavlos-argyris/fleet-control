import { stableReviewJson } from '../src/invoice-review-store.js';
import { evaluateInvoiceConfirmation, invoiceCents, invoicePlate, MAX_INVOICE_TEXT, parseInvoiceText } from '../src/invoice-extraction.js';
import { checkTargetedInvoiceRead, validTargetedOperationId } from '../src/targeted-service-qr.js';
import { currentEpoch, fleetError, sha256, validFleetRecordId, validOperationId } from './ledger.js';
import { baselineReadyForQueue } from './baseline.js';
import { findVerifiedBaselineService, verifiedBaselineDocument } from './baseline-projection.js';
import { baselineInvoiceLinks, fiscalIdentities, invoiceNumberParts } from './invoice-identity.js';

const proofId = /^[a-f0-9]{64}$/;
const sourceKinds = ['legacy-operation','legacy-draft','service-history','client-outbox','targeted-scan'];
const backupSources = new Set(['legacy-operation','legacy-draft','service-history']);
const fields = ['operationId','machineId','serviceId','qrValue','sourceKey','sourceSha256','explicitId','source','sourceId'];
const importedReasons = ['invoice_attached_elsewhere','original_service_not_verified','original_target_conflict'];
const PDF_CAP = 8 * 1024 * 1024;
const REPORT_CAP = Math.ceil(PDF_CAP / 3) * 4 + 1024 * 1024;
const MAX_ATTEMPTS = 8;

function safeQr(value, hosts) {
  try {
    const url = new URL(value.trim());
    const host=url.hostname;
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(host) ||
        !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(host) || /\.(?:local|internal|localhost|onion)$/.test(host)) return '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

async function normalizeJob(job) {
  if (!job || Array.isArray(job) || typeof job !== 'object' || Object.keys(job).some(key => !fields.includes(key)&&key!=='reviewReason') ||
      fields.some(key => typeof job[key] !== 'string') || !validOperationId(job.operationId) ||
      !sourceKinds.includes(job.source) || !job.sourceId || job.sourceId.length > 240 || job.qrValue.length > 4096 ||
      job.machineId.length > 160 || job.serviceId.length > 160 || job.sourceKey.length > 520 ||
      (job.sourceSha256 && (!job.sourceKey || !proofId.test(job.sourceSha256))) ||
      (job.reviewReason!==undefined && (job.source==='targeted-scan' || !importedReasons.includes(job.reviewReason))) ||
      (job.explicitId && !validTargetedOperationId(job.explicitId)) ||
      (job.source === 'targeted-scan' && job.operationId !== job.explicitId)) throw fleetError(400,'invalid_invoice_job');
  const input = stableReviewJson(job);
  return {job,input,fingerprint:await sha256(input)};
}

export async function invoiceStageProof(jobs) {
  const rows=await Promise.all(jobs.map(normalizeJob));
  return invoiceStageDigest(rows.map(({job,fingerprint})=>({operation_id:job.operationId,fingerprint})));
}

function invoiceStageDigest(rows) {
  rows.sort((a,b)=>a.operation_id<b.operation_id?-1:a.operation_id>b.operation_id?1:0);
  return sha256(stableReviewJson(rows.map(row=>[row.operation_id,row.fingerprint])));
}

const AUTHORIZED = `EXISTS (SELECT 1 FROM fleet_sync_credentials WHERE id=? AND secret_sha256=?
  AND scope='sync-read-write' AND revoked_at IS NULL AND expires_at>?)
  AND EXISTS (SELECT 1 FROM fleet_rehearsal_state WHERE id=1 AND epoch=?)`;
const ACTIVE_TARGET = `EXISTS (SELECT 1 FROM fleet_records s JOIN fleet_records b ON b.kind='machine'
  AND b.machine_id=s.machine_id AND b.record_id=s.machine_id AND b.deleted=0
  WHERE s.kind='service' AND s.machine_id=? AND s.record_id=? AND s.deleted=0)`;

async function baselineJobProblem(env,epoch,job) {
  if (env.FLEET_BASELINE_TRANSFER!=='1'||!backupSources.has(job.source)) return '';
  const db=env.FLEET_DB;
  if (!await findVerifiedBaselineService(db,epoch,job.machineId,job.serviceId)) return 'original_service_not_verified';
  if (job.sourceKey&&!await verifiedBaselineDocument(db,epoch,job.sourceKey,job.sourceSha256)) return 'original_attachment_unverified';
  return '';
}

export async function stageInvoiceJobs(env,credential,epoch,input) {
  if (credential.scope !== 'sync-read-write') throw fleetError(403,'sync_write_scope_required');
  const verifyingBaseline=env.FLEET_BASELINE_TRANSFER==='1';
  if (!Array.isArray(input?.jobs) || !input.jobs.length || input.jobs.length>(verifyingBaseline?6:12)) {
    throw fleetError(400,'invalid_job_batch');
  }
  const jobs=await Promise.all(input.jobs.map(normalizeJob));
  if (!await baselineReadyForQueue(env)) throw fleetError(409,'baseline_projection_unverified');
  const hostnames=(env.FLEET_INVOICE_HOSTS||'').split(',').map(host=>host.trim().toLowerCase()).filter(Boolean);
  const db=env.FLEET_DB;
  const receipts=[];
  for (const {job,input,fingerprint} of jobs) {
    const qr=safeQr(job.qrValue,hostnames),qrHash=qr?await sha256(qr):'';
    const manual=job.source==='targeted-scan';
    if (manual && (!qr || !validFleetRecordId(job.machineId) || !validFleetRecordId(job.serviceId))) throw fleetError(422,'invalid_targeted_scan');
    const source=job.sourceSha256 ? await env.FLEET_DOCUMENTS?.head('sha256/'+job.sourceSha256) : null;
    const previous=verifyingBaseline?await baselineInvoiceLinks(db,[...(qrHash?['qr:'+qrHash]:[]),
      ...(job.sourceSha256?['pdf:'+job.sourceSha256]:[]),...(job.sourceKey?['file:'+await sha256(job.sourceKey)]:[])]):[];
    const confirmed=qr&&await db.prepare(`SELECT machine_id,service_id FROM fleet_records WHERE kind='invoice' AND deleted=0
      AND json_extract(data,'$.qrUrl')=? AND COALESCE(json_extract(data,'$.reviewedAt'),'')<>'' LIMIT 1`).bind(qr).first();
    if (confirmed) previous.push(confirmed);
    const baselineProblem=job.reviewReason||previous.length?'':await baselineJobProblem(env,epoch,job);
    let status='queued',reason='';
    if (job.reviewReason) {
      status='review'; reason=job.reviewReason;
    } else if (previous.length) {
      status=previous.every(item=>item.machine_id===job.machineId&&item.service_id===job.serviceId)?'already_confirmed':'review';
      reason=status==='review'?'invoice_attached_elsewhere':'';
    } else if (baselineProblem) {
      status='review'; reason=baselineProblem;
    } else if (!await db.prepare('SELECT '+ACTIVE_TARGET+' AS found').bind(job.machineId,job.serviceId).first('found')) {
      if (manual) throw fleetError(404,'invoice_target_missing');
      status='review'; reason='original_service_not_verified';
    } else if (job.sourceKey && (!source || source.checksums?.toJSON()?.sha256!==job.sourceSha256)) {
      status='review'; reason='original_attachment_unverified';
    } else if (!qr && !source) {
      status='review'; reason=job.qrValue?'qr_provider_not_verified':'original_document_missing';
    }
    const now=Date.now();
    const [written,receipt]=await db.batch([
      db.prepare(`INSERT INTO fleet_invoice_jobs(operation_id,fingerprint,machine_id,service_id,qr_hash,input,status,reason,available_at,initial_import)
        SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${AUTHORIZED}
        AND ?=(CASE WHEN EXISTS(SELECT 1 FROM fleet_invoice_stage WHERE id=1) THEN 0 ELSE 1 END)
        AND (?=0 OR ${ACTIVE_TARGET}) ON CONFLICT(operation_id) DO NOTHING`).bind(
        job.operationId,fingerprint,job.machineId,job.serviceId,qrHash,input,status,reason,now,manual?0:1,
        credential.id,credential.hash,now,epoch,manual?0:1,manual?1:0,job.machineId,job.serviceId),
      db.prepare('SELECT fingerprint,status,reason FROM fleet_invoice_jobs WHERE operation_id=?').bind(job.operationId)
    ]);
    const saved=receipt.results[0];
    if (!saved) throw fleetError(409,manual?'invoice_stage_not_verified':'invoice_stage_closed');
    if (saved.fingerprint!==fingerprint) throw fleetError(409,'invoice_operation_conflict');
    receipts.push({operationId:job.operationId,status:saved.status,reason:saved.reason,replayed:!written.meta.changes});
  }
  return {jobs:receipts};
}

export async function sealInvoiceStage(env,credential,epoch,input) {
  if (credential.scope !== 'sync-read-write') throw fleetError(403,'sync_write_scope_required');
  const {count,manifestHash}=input||{};
  if (!Number.isSafeInteger(count) || count<0 || count>5000 || typeof manifestHash!=='string'||!proofId.test(manifestHash)) {
    throw fleetError(400,'invalid_invoice_manifest');
  }
  if (!await baselineReadyForQueue(env)) throw fleetError(409,'baseline_projection_unverified');
  const db=env.FLEET_DB;
  const rows=await db.prepare('SELECT operation_id,fingerprint FROM fleet_invoice_jobs WHERE initial_import=1 LIMIT 5001').all();
  if (rows.results.length!==count || await invoiceStageDigest(rows.results)!==manifestHash) throw fleetError(409,'invoice_manifest_mismatch');
  const now=Date.now();
  const [,stored]=await db.batch([
    db.prepare(`INSERT INTO fleet_invoice_stage(id,manifest_hash,job_count,verified_at)
      SELECT 1,?,?,? WHERE ${AUTHORIZED} AND (SELECT count(*) FROM fleet_invoice_jobs WHERE initial_import=1)=?
      ON CONFLICT(id) DO NOTHING`).bind(manifestHash,count,now,credential.id,credential.hash,now,epoch,count),
    db.prepare('SELECT manifest_hash,job_count FROM fleet_invoice_stage WHERE id=1')
  ]);
  if (stored.results[0]?.manifest_hash!==manifestHash || stored.results[0]?.job_count!==count) throw fleetError(409,'invoice_manifest_mismatch');
  return {verified:true,count,manifestHash};
}

export async function invoiceQueueStatus(db) {
  const [counts,review]=await db.batch([
    db.prepare('SELECT status,count(*) AS count FROM fleet_invoice_jobs GROUP BY status'),
    db.prepare(`SELECT operation_id AS operationId,machine_id AS machineId,service_id AS serviceId,reason,attempts
      FROM fleet_invoice_jobs WHERE status='review' ORDER BY operation_id LIMIT 24`)
  ]);
  return {counts:Object.fromEntries(counts.results.map(row=>[row.status,row.count])),review:review.results};
}

async function boundedReport(response) {
  const reader=response.body?.getReader();
  if (!reader) throw fleetError(422,'missing_invoice_read');
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let length=0,text='';
  try {
    for (;;) {
      const {value,done}=await reader.read();
      if (done) break;
      length+=value.byteLength;
      if (length>REPORT_CAP) throw fleetError(422,'invoice_read_size');
      text+=decoder.decode(value,{stream:true});
    }
    return JSON.parse(text+decoder.decode());
  } catch (error) {
    await reader.cancel().catch(()=>{});
    throw error.status?error:fleetError(422,'invalid_invoice_read');
  }
}

async function readDocument(env,job) {
  const hosts=(env.FLEET_INVOICE_HOSTS||'').split(',').map(host=>host.trim().toLowerCase()).filter(Boolean);
  const qrUrl=safeQr(job.qrValue,hosts);
  if (!qrUrl && !job.sourceSha256) throw fleetError(422,'qr_provider_not_verified');
  const result=await env.FLEET_INVOICE_READER.fetch('https://fleet-invoice-reader.invalid/read',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({qrUrl,sourceSha256:job.sourceSha256}),signal:AbortSignal.timeout(20000)
  });
  if (!result.ok) throw result.status===408||result.status===429||result.status>=500
    ? fleetError(503,'invoice_reader_temporarily_unavailable') : fleetError(422,'invoice_reader_needs_review');
  const {pdfBase64,rawText}=await boundedReport(result)||{};
  if (typeof rawText!=='string'||rawText.length>MAX_INVOICE_TEXT||typeof pdfBase64!=='string'||pdfBase64.length>Math.ceil(PDF_CAP/3)*4) {
    throw fleetError(422,'invalid_invoice_read');
  }
  let pdf;
  try { pdf=Uint8Array.from(atob(pdfBase64),char=>char.charCodeAt(0)); }
  catch { throw fleetError(422,'invalid_invoice_pdf'); }
  const decoder=new TextDecoder();
  if (pdf.length>PDF_CAP || !decoder.decode(pdf.subarray(0,8)).startsWith('%PDF-') ||
      !/%%EOF\s*$/.test(decoder.decode(pdf.subarray(Math.max(0,pdf.length-1024))))) throw fleetError(422,'invalid_invoice_pdf');
  return {qrUrl,pdf,rawText};
}

async function settle(db,row,status,reason,availableAt=0) {
  await db.prepare(`UPDATE fleet_invoice_jobs SET status=?,reason=?,available_at=?,lease_token=NULL,lease_until=NULL
    WHERE operation_id=? AND status='running' AND lease_token=?`).bind(status,reason,availableAt,row.operation_id,row.lease_token).run();
}

async function applyInvoice(env,row,job,target,read) {
  const {qrUrl,pdf,rawText}=read;
  const proof=parseInvoiceText(rawText),now=new Date().toISOString(),invoice={...proof.data,rawText,qrUrl};
  const service=JSON.parse(target.service),bike=JSON.parse(target.machine);
  if (job.explicitId) {
    const issues=checkTargetedInvoiceRead(invoice,{bike,entry:service,proof});
    if (issues.length) throw fleetError(422,'invoice_read_incomplete');
  } else {
    const plate=invoicePlate(invoice.plate);
    const match=await env.FLEET_DB.prepare(`SELECT count(*) AS n FROM fleet_records WHERE kind='machine' AND deleted=0
      AND json_extract(data,'$.plateKey')=?`).bind(plate).first('n');
    const decision=evaluateInvoiceConfirmation(invoice,{bike,entry:service,bikes:match===1?[{...bike,id:job.machineId}]:[],proof});
    if (!decision.eligible) throw fleetError(422,'original_match_needs_review');
  }
  const binaryHash=crypto.subtle.digest('SHA-256',pdf);
  const {issuer,number,mark}=invoiceNumberParts(invoice);
  if (!number || (!issuer && !mark) || invoiceCents(invoice.totalAmount)===null) throw fleetError(422,'invoice_identity_unverified');
  const sha=Array.from(new Uint8Array(await binaryHash),byte=>byte.toString(16).padStart(2,'0')).join('');
  const identity=await fiscalIdentities({issuer,number,mark},sha,row.qr_hash);
  const db=env.FLEET_DB,invoiceId='pdf:'+sha,opId='invoice:'+await sha256(row.operation_id);
  if (env.FLEET_BASELINE_TRANSFER==='1'&&(await baselineInvoiceLinks(db,identity)).length) throw fleetError(409,'possible_duplicate_invoice');
  const exists=await db.prepare(`SELECT 1 AS found FROM fleet_records WHERE kind='invoice' AND deleted=0 AND (
    json_extract(data,'$.sha256')=? OR (?<>'' AND json_extract(data,'$.qrUrl')=?) OR
    (?<>'' AND json_extract(data,'$.mark')=?) OR (?<>'' AND lower(trim(json_extract(data,'$.supplier')))=? AND upper(trim(json_extract(data,'$.invoiceNumber')))=?)) LIMIT 1`)
    .bind(sha,qrUrl,qrUrl,mark,mark,issuer,issuer,number).first();
  if (exists) throw fleetError(409,'possible_duplicate_invoice');
  const object=await env.FLEET_DOCUMENTS.put('sha256/'+sha,pdf,{
    sha256:sha,onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/pdf'}
  });
  const stored=object||await env.FLEET_DOCUMENTS.head('sha256/'+sha);
  if (!stored || stored.checksums?.toJSON()?.sha256!==sha || stored.size!==pdf.length) throw fleetError(503,'invoice_document_not_durable');
  // Appending the mutation, projecting it, claiming the fiscal identities,
  // and completing the lease all happen in a single transaction.
  const data=stableReviewJson({...invoice,qrValue:job.qrValue,name:number+'.pdf',contentType:'application/pdf',
    size:pdf.length,sha256:sha,sourcePhotoKey:job.sourceKey,sourceSha256:job.sourceSha256,reviewedAt:now,
    targetedOperationId:job.explicitId,legacyOperationId:job.sourceId});
  const identities=JSON.stringify(identity),time=Date.now();
  const [saved]=await db.batch([
    db.prepare(`INSERT INTO fleet_mutations(operation_id,fingerprint,kind,machine_id,record_id,service_id,revision,deleted,data,committed_at)
      SELECT ?,?,'invoice',?,?,?,1,0,?,? WHERE ${ACTIVE_TARGET}
      AND EXISTS (SELECT 1 FROM fleet_records WHERE kind='service' AND machine_id=? AND record_id=? AND revision=?)
      AND EXISTS (SELECT 1 FROM fleet_invoice_jobs WHERE operation_id=? AND status='running' AND lease_token=? AND lease_until>?)
      AND NOT EXISTS (SELECT 1 FROM fleet_invoice_identity WHERE identity IN (SELECT value FROM json_each(?)))
      AND NOT EXISTS (SELECT 1 FROM fleet_records WHERE kind='invoice' AND machine_id=? AND record_id=?)
      AND NOT EXISTS (SELECT 1 FROM fleet_records WHERE kind='invoice' AND deleted=0 AND (
        json_extract(data,'$.sha256')=? OR (?<>'' AND json_extract(data,'$.qrUrl')=?) OR (?<>'' AND json_extract(data,'$.mark')=?) OR
        (?<>'' AND lower(trim(json_extract(data,'$.supplier')))=? AND upper(trim(json_extract(data,'$.invoiceNumber')))=?)))
      ON CONFLICT(operation_id) DO NOTHING`).bind(opId,row.fingerprint,job.machineId,invoiceId,job.serviceId,data,now,
        job.machineId,job.serviceId,job.machineId,job.serviceId,target.revision,row.operation_id,row.lease_token,time,
        identities,job.machineId,invoiceId,sha,qrUrl,qrUrl,mark,mark,issuer,issuer,number),
    db.prepare(`INSERT INTO fleet_invoice_identity(identity,operation_id) SELECT value,? FROM json_each(?)
      WHERE EXISTS (SELECT 1 FROM fleet_mutations WHERE operation_id=? AND fingerprint=?)`)
      .bind(row.operation_id,identities,opId,row.fingerprint),
    db.prepare(`UPDATE fleet_invoice_jobs SET status='completed',reason='',invoice_id=?,lease_token=NULL,lease_until=NULL
      WHERE operation_id=? AND status='running' AND lease_token=?
      AND EXISTS (SELECT 1 FROM fleet_mutations WHERE operation_id=? AND fingerprint=?)`)
      .bind(invoiceId,row.operation_id,row.lease_token,opId,row.fingerprint)
  ]);
  if (!saved.meta.changes) throw fleetError(409,'invoice_target_changed_or_duplicate');
}

export async function runInvoiceQueue(env) {
  if (env.FLEET_INVOICE_PROCESSING!=='1' || !env.FLEET_INVOICE_READER || !env.FLEET_DOCUMENTS) return;
  const db=env.FLEET_DB,now=Date.now();
  const row=await db.prepare(`UPDATE fleet_invoice_jobs SET status='running',lease_token=?,lease_until=?,attempts=attempts+1
    WHERE operation_id=(SELECT operation_id FROM fleet_invoice_jobs WHERE (status='queued' AND available_at<=?)
    OR (status='running' AND lease_until<=?) ORDER BY available_at,operation_id LIMIT 1)
    AND EXISTS (SELECT 1 FROM fleet_invoice_stage WHERE id=1)
    RETURNING operation_id,fingerprint,input,attempts,lease_token,qr_hash`).bind(crypto.randomUUID(),now+90000,now,now).first();
  if (!row) return;
  try {
    const job=JSON.parse(row.input);
    if (row.attempts>MAX_ATTEMPTS) throw fleetError(422,'invoice_attempts_exhausted');
    if (env.FLEET_BASELINE_TRANSFER==='1'&&backupSources.has(job.source)) {
      const problem=await baselineJobProblem(env,await currentEpoch(db),job);
      if (problem) throw fleetError(422,problem);
    }
    const target=await db.prepare(`SELECT s.data AS service,s.revision,b.data AS machine FROM fleet_records s JOIN fleet_records b ON b.kind='machine'
      AND b.machine_id=s.machine_id AND b.record_id=s.machine_id AND b.deleted=0
      WHERE s.kind='service' AND s.machine_id=? AND s.record_id=? AND s.deleted=0`).bind(job.machineId,job.serviceId).first();
    if (!target) throw fleetError(422,'original_service_not_verified');
    if (row.qr_hash && await db.prepare(`SELECT 1 AS found FROM fleet_invoice_identity WHERE identity=?`).bind('qr:'+row.qr_hash).first()) {
      throw fleetError(409,'possible_duplicate_invoice');
    }
    await applyInvoice(env,row,job,target,await readDocument(env,job));
  } catch (error) {
    const temporary=!error.status||error.status>=500;
    if (temporary && row.attempts<MAX_ATTEMPTS) {
      const retry=Date.now()+Math.min(3600000,30000*2**row.attempts)+Math.floor(Math.random()*15000);
      await settle(db,row,'queued','invoice_reader_temporarily_unavailable',retry);
    } else {
      await settle(db,row,'review',temporary?'invoice_attempts_exhausted':error.code);
    }
  }
}
