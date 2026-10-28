import assert from 'node:assert/strict';
import {invoiceText} from './fixtures/invoice-layout.mjs';
import {parseInvoiceText,enrichInvoiceExtraction,evaluateInvoiceConfirmation} from '../cloudflare-worker/src/invoice-extraction.js';
const bike={id:'synthetic',name:'BTO-756'},entry={id:'service',km:9000},bikes=[bike];
const evaluate=(value,extra={})=>evaluateInvoiceConfirmation(value,{bike,entry,bikes,...extra});
for(const count of [1,4,51,120,512]) {
  const text=invoiceText({count}), parsed=parseInvoiceText(text),data=enrichInvoiceExtraction({rawText:text,localReadStatus:'confident'});
  assert.equal(parsed.data.plate,'BTO-756');assert.equal(parsed.data.odometerKm,'9000');assert.equal(parsed.data.invoiceNumber,'ΤΔΑ0000123');assert.equal(parsed.data.invoiceDate,'2026-10-28');
  assert.equal(data.lineItems.length,count);assert.equal(parsed.completeTable,true,JSON.stringify(parsed.problems));assert.equal(evaluate(data).eligible,true,JSON.stringify(evaluate(data)));
  assert.ok(!data.workPerformed.includes('Μετρητοίς'));assert.ok(data.lineItems.every(x=>!x.startsWith('L000')));
}
for(const [text,field] of [
  [invoiceText().replace('Σχόλια\nΒΤΟ 756\n9000','Σχόλια\nΒΤΟ 756\n9000 10000'),'odometerKm'],
  [invoiceText()+'\nΠινακίδα BTO-757','plate'],
  [invoiceText({date:'31/02/2026'}),'invoiceDate'],
  [invoiceText({number:'??'}),'invoiceNumber'],
  [invoiceText({net:'99,00'}),'totalAmount'],
  [invoiceText().replace('Σύνολο γραμμών 4','Σύνολο γραμμών 5'),'lineItems'],
  [invoiceText().replace('Σύνολο Καθαρού Ποσού 100,00',''),'netAmount'],
  [invoiceText({count:513}),'lineItems'],
  [JSON.stringify({plate:'BTO-756',ocrConfidence:100}),'document']
]) {const result=evaluate(enrichInvoiceExtraction({rawText:text,ocrConfidence:100}));assert.equal(result.eligible,false);assert.ok(result.reasons.some(r=>r.field===field),JSON.stringify(result));}
const data=enrichInvoiceExtraction({rawText:invoiceText(),ocrConfidence:0});
assert.equal(evaluate({...data,ocrConfidence:100,localReadStatus:'ambiguous'}).eligible,false);
assert.equal(evaluate(data,{bikes:[bike,{id:'duplicate',name:'ΒΤΟ 756'}]}).eligible,false);
assert.equal(evaluate(data,{previous:{correctedByUserAt:'2026-10-27'}}).eligible,false);
assert.equal(evaluate({...data,lineItems:data.lineItems.slice(0,1)}).eligible,false);
assert.equal(evaluate({...data,invoiceNumber:'FORGED99'}).eligible,false);
assert.equal(evaluate({...data,plateAutoCorrectedFrom:'BTO-750'}).eligible,false);
assert.equal(evaluate({...data,extractionChecks:{eligible:true},rawText:''}).eligible,false);
console.log('OK deterministic invoice rules: comments plate/km, issue date/number, all 1/4/51/120/512 rows across pages, amounts and independent confirmation proof; ambiguous/missing/forged evidence never auto-confirms.');
