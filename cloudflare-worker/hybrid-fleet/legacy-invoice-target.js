import { documentQr } from './invoice-identity.js';

// A stale ID is recoverable only from its unique receipt on the exact saved
// service and QR. A valid unrelated service with the same local ID is a conflict.
export function resolveLegacyInvoiceTarget({source,payload,machineId,serviceId,targetExists,links}) {
  const qr=documentQr(payload.qrValue||payload.qrUrl||payload.attachment?.qrUrl);
  const original=links.length===1?links[0]:null;
  if (source==='legacy-operation'&&!payload.draftId&&!payload.targetedOperationId&&!targetExists&&
      qr&&original?.qr===qr&&original.serviceId===serviceId) machineId=original.machineId;
  const conflict=links.length>0&&(!original||original.machineId!==machineId||original.serviceId!==serviceId||original.qr!==qr);
  return {machineId,conflict};
}
