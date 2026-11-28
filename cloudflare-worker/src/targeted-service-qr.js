import { evaluateInvoiceConfirmation } from './invoice-extraction.js';

export function validTargetedOperationId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(value);
}

export const TARGETED_SERVICE_QR_SCHEMA = `
CREATE INDEX IF NOT EXISTS fleet_render_qr ON fleet_operations(json_extract(payload,'$.qrUrl'),status)
 WHERE type='service_document_render' AND status IN ('pending','error');
CREATE INDEX IF NOT EXISTS fleet_render_targeted_operation ON fleet_operations(json_extract(payload,'$.targetedOperationId'))
 WHERE type='service_document_render' AND json_extract(payload,'$.targetedOperationId') IS NOT NULL;
`;

export function checkTargetedInvoiceRead(data, context) {
  const decision = evaluateInvoiceConfirmation(data, context);
  // The owner chose the link. The document still has to be read and its
  // independent evidence (invoice number, date, lines and amounts) verified.
  return decision.reasons.filter(({ field, code }) => {
    if (code === 'vehicle-match' || code === 'service-mileage' || code === 'ocr-correction') return false;
    return !(['plate', 'odometerKm'].includes(field) && code === 'missing-evidence');
  });
}

export async function targetedQrReplay(env, operationId) {
  const row = await env.DB.prepare(`SELECT id,status,payload FROM fleet_operations
    WHERE type='service_document_render' AND json_extract(payload,'$.targetedOperationId')=?
    ORDER BY rowid DESC LIMIT 1`).bind(operationId).first();
  return row && { ...row, payload: JSON.parse(row.payload) };
}

export async function activeQrReservation(env, qrUrl) {
  const row = await env.DB.prepare(`SELECT id,status,payload FROM fleet_operations
    WHERE type='service_document_render' AND status IN ('pending','error')
    AND json_extract(payload,'$.qrUrl')=? ORDER BY rowid DESC LIMIT 1`).bind(qrUrl).first();
  return row && { ...row, payload: JSON.parse(row.payload) };
}

export async function reserveTargetedQr(env, jobId, payload) {
  const result = await env.DB.prepare(`INSERT INTO fleet_operations(id,source,type,payload,status,created_at)
    SELECT ?,'authenticated-client','service_document_render',?,'pending',?
    WHERE NOT EXISTS (SELECT 1 FROM fleet_operations WHERE type='service_document_render'
      AND json_extract(payload,'$.targetedOperationId')=?)
    AND NOT EXISTS (SELECT 1 FROM fleet_operations WHERE type='service_document_render'
      AND status IN ('pending','error') AND json_extract(payload,'$.qrUrl')=?)`)
    .bind(jobId, JSON.stringify(payload), payload.requestedAt, payload.targetedOperationId, payload.qrUrl).run();
  return Number(result.meta?.changes) === 1;
}
