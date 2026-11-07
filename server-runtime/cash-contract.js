/** Genuine HTTP identity report + owner's explicit semantic confirmation07/11/2026.
 * These facts are code-owned; request/diagnostic flags cannot enable money. */
export const CASH_ORDER_CONTRACT=Object.freeze({
  revision:'ordexa-delivered-orders-20261107-v1',identityFieldsVerified:true,
  fields:{order:'id',rider:'riderId',shop:'shopId',timestamp:'at',nickname:'rider'},
  evidenceDate:'2026-11-07',semanticConfirmation:'owner-2026-11-07',
  timestampMeaning:'delivery',timeZone:'Europe/Athens',cutoffHour:5,
  cancellationMeaning:'absence-after-complete-repeated-snapshot',
  timeSemanticsVerified:true,cancellationSemanticsVerified:true,
  pilotIntervalSeconds:120
});
export function cashContext(){
  try{return typeof globalThis.FleetHost==='function'?globalThis.FleetHost('store.context')||{}:{};}catch{return{};}
}
