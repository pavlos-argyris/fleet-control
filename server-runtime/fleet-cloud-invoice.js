import { readServiceEntry, fleetRecordId, fleetNames } from '../cloudflare-worker/src/snapshot-store.js';
import { commitInvoiceReview, readReviewReceipt, stableReviewJson } from '../cloudflare-worker/src/invoice-review-store.js';
import { documentQr, invoiceNumberParts } from '../cloudflare-worker/hybrid-fleet/invoice-identity.js';
import { resolveLegacyInvoiceTarget } from '../cloudflare-worker/hybrid-fleet/legacy-invoice-target.js';
import { INVOICE_RULES_VERSION, evaluateInvoiceConfirmation, parseInvoiceText } from '../cloudflare-worker/src/invoice-extraction.js';
import { checkTargetedInvoiceRead, validTargetedOperationId } from '../cloudflare-worker/src/targeted-service-qr.js';
import { publishChanges } from '../cloudflare-worker/src/change-events.js';
import { keepTargetedInvoiceService, normalizeServiceDocumentOcr } from '../cloudflare-worker/src/worker.js';

const actor = {id:'fleet-cloud-invoice', username:'Fleet Cloudflare', role:'system'};
const digestPattern = /^[a-f0-9]{64}$/;
const review = reason => Response.json({status:'review', reason}, {status:409});
const dataOf = file => [file.ocr, file.invoiceData, file.qrData].find(data => data?.confirmedAt);
const sameQr = (value, expected) => Boolean(expected && value && documentQr(value) === expected);

async function possibleDuplicate(db, location, sourceKey, invoice, fiscal) {
  // Include archived and deleted history. Legacy records may carry a fiscal
  // identity only in the service, rather than inside its PDF's metadata.
  const {results} = await db.prepare(`WITH history(bike_id,entry) AS (
    SELECT CAST(json_extract(b.value,'$.id') AS TEXT),h.value
    FROM fleet_snapshot s,json_each(s.data,'$.bikes') b,json_each(b.value,'$.history') h WHERE s.id=1
    UNION ALL SELECT bike_id,h.value FROM vehicle_archives a,json_each(a.snapshot_json,'$.history') h
    UNION ALL SELECT CAST(json_extract(payload,'$.bikeId') AS TEXT),json_extract(payload,'$.entry')
    FROM deleted_records WHERE record_type='fleet_history'
  ), proofs(bike_id,entry_id,object_key,photo_key,qr_url,qr_value,fiscal) AS (
    SELECT bike_id,CAST(json_extract(entry,'$.id') AS TEXT),json_extract(f.value,'$.key'),
      json_extract(f.value,'$.sourcePhoto.key'),json_extract(f.value,'$.qrUrl'),json_extract(f.value,'$.qrValue'),d.value
    FROM history,json_each(entry,'$.attachments') f,json_each(json_array(
      json_extract(f.value,'$.ocr'),json_extract(f.value,'$.invoiceData'),json_extract(f.value,'$.qrData'))) d
    WHERE d.type='object' OR d.key=0
    UNION ALL
    SELECT bike_id,CAST(json_extract(entry,'$.id') AS TEXT),NULL,NULL,NULL,NULL,json_extract(entry,'$.invoiceData')
    FROM history WHERE COALESCE(json_extract(entry,'$.invoiceData.confirmedAt'),'')<>''
  )
  SELECT p.bike_id,p.entry_id,p.object_key,p.photo_key,p.qr_url,p.qr_value,n.sha256,
    json_extract(p.fiscal,'$.qrUrl') AS fiscal_qr,json_extract(p.fiscal,'$.confirmedAt') AS confirmed,
    json_extract(p.fiscal,'$.supplier') AS supplier,json_extract(p.fiscal,'$.invoiceNumber') AS invoiceNumber,
    json_extract(p.fiscal,'$.mark') AS mark
  FROM proofs p LEFT JOIN native_objects n ON n.key=p.object_key
  WHERE n.sha256=? OR p.qr_url IS NOT NULL OR p.qr_value IS NOT NULL OR p.fiscal IS NOT NULL OR p.photo_key=?`)
    .bind(invoice.sha256,sourceKey).all();
  return results.some(row => {
    if (sourceKey && row.photo_key === sourceKey) return true;
    if (sourceKey && row.object_key === sourceKey && row.bike_id === location.bike.id &&
        row.entry_id === String(location.entry.id) && !row.confirmed) return false;
    const other = invoiceNumberParts(row);
    return row.sha256 === invoice.sha256 || [row.qr_url,row.qr_value,row.fiscal_qr].some(value => sameQr(value,invoice.qrUrl)) ||
      (fiscal.mark && fiscal.mark === other.mark) ||
      (fiscal.issuer && fiscal.issuer === other.issuer && fiscal.number === other.number);
  });
}

async function originalJob(env, location, invoice, sourceMatches) {
  if (invoice.legacySource !== 'legacy-operation') return null;
  const row = await env.DB.prepare(`SELECT type,status,payload FROM fleet_operations WHERE id=?`)
    .bind(invoice.legacyOperationId).first();
  if (!row || row.type !== 'service_document_render' || !['pending','error'].includes(row.status)) return false;
  const payload = JSON.parse(row.payload);
  const machineId=fleetRecordId(payload.bikeId),serviceId=fleetRecordId(payload.entryId);
  if (serviceId !== String(location.entry.id)) return false;
  const sameBike = machineId === location.bike.id;
  const {results} = await env.DB.prepare(`SELECT CAST(json_extract(b.value,'$.id') AS TEXT) AS machineId,
    CAST(json_extract(h.value,'$.id') AS TEXT) AS serviceId,
    COALESCE(NULLIF(json_extract(h.value,'$.invoiceData.qrValue'),''),json_extract(h.value,'$.invoiceData.qrUrl')) AS qr
    FROM fleet_snapshot s,json_each(s.data,'$.bikes') b,json_each(b.value,'$.history') h
    WHERE s.id=1 AND json_extract(h.value,'$.invoiceData.qrJobId')=? AND json_extract(h.value,'$.type')<>'check'
    AND NOT EXISTS(SELECT 1 FROM vehicle_archives a WHERE a.active=1 AND a.bike_id=CAST(json_extract(b.value,'$.id') AS TEXT))
    AND NOT EXISTS(SELECT 1 FROM json_each(b.value,'$.historyDeletedIds') d WHERE CAST(d.value AS TEXT)=CAST(json_extract(h.value,'$.id') AS TEXT))
    LIMIT 2`).bind(invoice.legacyOperationId).all();
  const links = results.map(link=>({...link,qr:documentQr(link.qr)}));
  const targetExists = sameBike || Boolean(await readServiceEntry(env,machineId,serviceId));
  const resolved = resolveLegacyInvoiceTarget({source:invoice.legacySource,payload,machineId,serviceId,targetExists,links});
  const sameDocument = [payload.qrValue,payload.qrUrl].some(value => sameQr(value,invoice.qrUrl)) ||
    (sourceMatches && [payload.sourcePhotoKey,payload.documentKey].includes(invoice.sourcePhotoKey));
  return !resolved.conflict && resolved.machineId === location.bike.id && sameDocument &&
    (payload.targetedOperationId || '') === invoice.targetedOperationId ? row : false;
}

/** Native-only application of one verified invoice journal entry. The signed
 * Android runtime supplies the transaction and bytes from its private replica. */
export async function restoreFleetCloudInvoice(env, serialized, pdf) {
  let envelope;
  try { envelope = JSON.parse(serialized); } catch { return review('invoice_journal_invalid'); }
  const {epoch, change} = envelope || {};
  const invoice = change?.data;
  if (typeof epoch !== 'string' || !/^[a-f0-9]{32}$/.test(epoch) || !invoice ||
      !Number.isSafeInteger(change.cursor) || change.cursor < 1 || change.kind !== 'invoice' ||
      !/^invoice:[a-f0-9]{64}$/.test(change.operationId || '') || change.deleted !== false || change.revision !== 1 ||
      !digestPattern.test(invoice.sha256 || '') || change.recordId !== 'pdf:'+invoice.sha256 ||
      invoice.contentType !== 'application/pdf' || !pdf?.__file || pdf.type !== 'application/pdf' ||
      !Number.isSafeInteger(invoice.size) || invoice.size < 5 || invoice.size > 15*1024*1024 ||
      pdf.size !== invoice.size || pdf.sha256 !== invoice.sha256 ||
      typeof change.machineId !== 'string' || !fleetRecordId(change.machineId) ||
      typeof change.serviceId !== 'string' || !fleetRecordId(change.serviceId) ||
      typeof invoice.legacyOperationId !== 'string' || !invoice.legacyOperationId || invoice.legacyOperationId.length > 240 ||
      typeof invoice.qrValue !== 'string' || invoice.qrValue.length > 4096 ||
      typeof invoice.qrUrl !== 'string' || invoice.qrUrl.length > 4096 ||
      typeof invoice.rawText !== 'string' ||
      (invoice.targetedOperationId !== '' && !validTargetedOperationId(invoice.targetedOperationId))) {
    return review('invoice_journal_invalid');
  }
  if (await pdf.slice(0,5).text() !== '%PDF-') return review('invoice_pdf_invalid');
  const requestId = epoch+':'+change.operationId;
  const hash = await digest(stableReviewJson(change));
  const prior = await readReviewReceipt(env,actor,requestId,hash);
  if (prior) return prior.conflict ? review('invoice_operation_conflict') : Response.json(prior);

  if (!['legacy-operation','service-history','targeted-scan'].includes(invoice.legacySource)) return review('invoice_origin_needs_review');
  const sourceOperation = invoice.legacySource === 'targeted-scan' ? invoice.targetedOperationId :
    'legacy:'+await digest(JSON.stringify([invoice.legacySource,invoice.legacyOperationId]));
  if (!sourceOperation || change.operationId !== 'invoice:'+await digest(sourceOperation)) return review('invoice_journal_invalid');
  const location = await readServiceEntry(env,change.machineId,change.serviceId);
  if (!location || location.entry.type === 'check') return review('invoice_target_missing');
  const {entry,bike} = location;
  const proof = parseInvoiceText(invoice.rawText);
  const qrUrl = documentQr(invoice.qrUrl);
  if (invoice.qrUrl && qrUrl !== invoice.qrUrl) return review('invoice_read_unverified');
  if (invoice.targetedOperationId) {
    if (checkTargetedInvoiceRead(invoice,{bike,entry,proof}).length) return review('invoice_read_unverified');
  } else if (!evaluateInvoiceConfirmation(invoice,{bike,entry,proof,bikes:await fleetNames(env)}).eligible) {
    return review('invoice_read_unverified');
  }
  const fiscal = invoiceNumberParts(proof.data);
  if (!fiscal.number || (!fiscal.issuer && !fiscal.mark)) return review('invoice_identity_unverified');
  const files = Array.isArray(entry.attachments) ? entry.attachments : [];
  const sourceKey = invoice.sourcePhotoKey || '';
  const sources = sourceKey ? files.filter(file => file?.key === sourceKey) : [];
  let photo = null, keepPdf = false;
  if (sourceKey) {
    const original = sources[0];
    const native = await env.DB.prepare('SELECT sha256,size,content_type FROM native_objects WHERE key=? AND deleted_at IS NULL')
      .bind(sourceKey).first();
    if (sources.length !== 1 || dataOf(original) || !native || !digestPattern.test(invoice.sourceSha256 || '') ||
        native.sha256 !== invoice.sourceSha256 || native.size !== original.size || native.content_type !== original.contentType) {
      return review('invoice_original_attachment_needs_review');
    }
    const verified = await env.SERVICE_DOCS.head(sourceKey);
    if (!verified || verified.sha256 !== native.sha256) return review('invoice_original_attachment_needs_review');
    keepPdf = original.contentType === 'application/pdf' && native.sha256 === invoice.sha256;
    photo = globalThis.FleetServiceModel.sourcePhoto(original);
    if (!keepPdf && !photo) return review('invoice_original_attachment_needs_review');
  }
  const old = entry.invoiceData || {};
  const sameHistoryQr = [old.qrValue,old.qrUrl].some(value=>sameQr(value,qrUrl));
  if (invoice.legacySource === 'service-history' && (old.confirmedAt || (!sameHistoryQr && !sources.length) ||
      (old.targetedOperationId || '') !== invoice.targetedOperationId ||
      invoice.legacyOperationId !== 'history:'+await digest(JSON.stringify([bike.id,String(entry.id)])))) {
    return review('invoice_original_job_needs_review');
  }
  const job = await originalJob(env,location,invoice,Boolean(sources.length));
  if (job === false) return review('invoice_original_job_needs_review');
  if (await possibleDuplicate(env.DB,location,sourceKey,invoice,fiscal)) return review('invoice_possible_duplicate');
  if (files.length - sources.length >= 10) return review('invoice_attachment_limit');

  const now = new Date().toISOString();
  const key = keepPdf ? sourceKey : 'service-documents/fleet-cloud/'+invoice.sha256+'.pdf';
  if (!keepPdf && await env.DB.prepare('SELECT 1 AS found FROM native_objects WHERE key=?').bind(key).first()) {
    return review('invoice_document_key_conflict');
  }
  const docName = fiscal.number.replace(/[^\p{L}\p{N}_.-]/gu,'_').slice(0,90)+'.pdf';
  const ocr = normalizeServiceDocumentOcr({
    ...proof.data,rawText:invoice.rawText,source:'fleet-cloud',qrUrl,confirmedAt:now,reviewedBy:actor.username,
    reviewStatus:'confirmed',reviewDocumentKey:key,confirmationRuleVersion:INVOICE_RULES_VERSION,
    confirmationMethod:invoice.targetedOperationId ? 'targeted-qr' : 'fleet-cloud-recovery',
    confirmationReason:'Επαληθευμένη καταχώριση Cloudflare στο καταγεγραμμένο σέρβις.',
    targetedOperationId:invoice.targetedOperationId,
    ...(invoice.targetedOperationId?keepTargetedInvoiceService(bike,entry,proof.data):{})
  });
  const file = {
    ...(keepPdf?sources[0]:{id:key.split('/').at(-1),name:docName,originalName:docName,uploadedAt:now}), key,
    contentType:'application/pdf', size:pdf.size, qrValue:invoice.qrValue, qrUrl,
    ...(job?{renderJobId:invoice.legacyOperationId}:{}), ...(photo?{sourcePhoto:photo}:{}), ocr
  };
  const pendingMatches = (job && old.qrJobId === invoice.legacyOperationId) ||
    (invoice.legacySource === 'service-history' && sameHistoryQr) ||
    (!old.qrJobId && (!old.qrValue && !old.qrUrl || sameHistoryQr));
  const updated = {
    ...entry, attachments:[...files.filter(file=>file?.key!==sourceKey),file],
    ...(!old.confirmedAt && pendingMatches ? {invoiceData:{...ocr,qrValue:invoice.qrValue,
      ...(job?{qrJobId:invoice.legacyOperationId}:{}), qrProcessingStatus:'completed',qrProcessingProgress:'100',
      qrProcessingStage:'Ολοκληρώθηκε',qrProcessingUpdatedAt:now}} : {})
  };
  // From the first write onwards, a failure must roll back the entire native
  // request. Only the unreferenced immutable bytes can survive a rollback.
  if (!keepPdf) await env.SERVICE_DOCS.put(key,pdf,{httpMetadata:{contentType:'application/pdf'},
    customMetadata:{bikeId:bike.id,entryId:String(entry.id),displayName:docName}});
  const saved = await commitInvoiceReview(env,{
    actor,requestId,hash,now,source:'fleet-cloud-invoice',changed:true,syncBike:false,
    updates:[{located:location,entry:updated}],result:{status:'applied',document:{key,bikeId:bike.id,entryId:String(entry.id)}},
    audit:{action:'fleet_cloud_invoice_restored',before:{},after:{epoch,cursor:change.cursor,operationId:change.operationId,
      machineId:bike.id,serviceId:String(entry.id)},reason:'Εφαρμογή επαληθευμένης εγγραφής Cloudflare.'}
  });
  if (!saved || saved.conflict) throw new Error('Fleet invoice receipt was not committed');
  if (job) {
    const result = await env.DB.prepare(`UPDATE fleet_operations SET status='applied',applied_at=?
      WHERE id=? AND status=? AND payload=?`).bind(now,invoice.legacyOperationId,job.status,job.payload).run();
    if (result.meta.changes !== 1) throw new Error('Fleet invoice legacy receipt was not committed');
    await env.DB.prepare(`UPDATE system_alerts SET resolved=1,resolved_at=? WHERE type='invoice_processing_failed' AND object_id=? AND resolved=0`)
      .bind(now,invoice.legacyOperationId).run();
  }
  await publishChanges(env,['fleet','invoices']);
  return Response.json(saved);
}

async function digest(text) {
  const result = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return Array.from(new Uint8Array(result),byte=>byte.toString(16).padStart(2,'0')).join('');
}
