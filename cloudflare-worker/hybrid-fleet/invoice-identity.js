import { sha256 } from './ledger.js';

export function confirmedAttachment(file) {
  return [file?.ocr,file?.invoiceData,file?.qrData].find(data=>data?.confirmedAt);
}

export function documentQr(value) {
  try {
    const url=new URL(value);
    url.hash='';
    return url.href;
  } catch { return ''; }
}

export function invoiceNumberParts(data) {
  return {
    issuer:String(data.supplier||'').normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' '),
    number:String(data.invoiceNumber||'').normalize('NFKC').trim().toUpperCase(),
    mark:String(data.mark||'')
  };
}

export async function fiscalIdentities({issuer,number,mark},pdfHash,qrHash) {
  return [
    ...(pdfHash?['pdf:'+pdfHash]:[]),
    ...(qrHash?['qr:'+qrHash]:[]),
    ...(/^\d{6,24}$/.test(mark)?['mark:'+mark]:[]),
    ...(issuer&&number?['issuer:'+await sha256(issuer+'\0'+number)]:[])
  ];
}

export async function baselineInvoiceLinks(db,keys) {
  if (!keys.length) return [];
  const rows=await db.prepare(`SELECT DISTINCT machine_id,service_id FROM fleet_baseline_invoice_identity
    WHERE identity IN (SELECT value FROM json_each(?)) ORDER BY machine_id,service_id LIMIT 2`)
    .bind(JSON.stringify(keys)).all();
  return rows.results;
}
