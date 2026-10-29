import {invoicePlate} from './invoice-extraction.js';
const text=value=>String(value??'').normalize('NFKC').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
export const READ_FIELDS=['plate','odometerKm','invoiceNumber','invoiceDate','netAmount','vatAmount','totalAmount','lineItems'];
export function invoiceReadComparison(data,cents){
 const result={};
 for(const field of READ_FIELDS){
  const value=data?.[field];
  result[field]=field==='plate'?invoicePlate(value):/Amount$/.test(field)?cents(value):field==='odometerKm'?(value==null||value===''?null:String(Number(String(value).replace(/[\s.,]/g,'')))):field==='lineItems'?(Array.isArray(value)?value.map(item=>text(typeof item==='object'&&item?item.description??item.name??JSON.stringify(item):item)).sort():[]):text(value);
 }
 return result;
}
