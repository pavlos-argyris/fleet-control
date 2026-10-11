import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeServiceDocumentOcr, serviceDocumentWarnings, refineInvoicePlateForFleet, cleanInvoiceWorkText } from '../cloudflare-worker/src/worker.js';

const app = fs.readFileSync(new URL('../cloudflare-worker/public/app.js', import.meta.url), 'utf8');
const portal = fs.readFileSync(new URL('../cloudflare-worker/public/portal.js', import.meta.url), 'utf8');
function extract(source, name) {
  const match = source.match(new RegExp('^  (?:async )?function ' + name + '\\([\\s\\S]*?^  \\}', 'm'));
  assert.ok(match, name); return match[0];
}
const helpers = ['stripInvoicePartCode', 'invoiceLineText', 'normalizeInvoiceData', 'mergeInvoiceData', 'invoiceDataFromAttachment',
  'cleanInvoiceWorkText', 'invoiceWorkItems', 'taskKey', 'isOilTask', 'mergeServiceTasks', 'splitImportedWork',
  'invoiceMoneyCents', 'reportCost', 'reportServiceDateCell', 'invoiceDateForName', 'invoicePlateKey', 'invoiceWarnings', 'parseInvoiceKm'];
const context = vm.createContext({ console, formatDate: value => value, escapeHtml: value => String(value).replace(/</g, '&lt;'), formatKm: String });
vm.runInContext(helpers.map(name => extract(app, name)).join('\n'), context);
const file = (key, amount, date = '2026-10-02') => ({ key, ocr: { totalAmount: amount, invoiceDate: date } });
assert.equal(context.reportCost({ cost: '9', invoiceData: { totalAmount: '50' }, attachments: [file('one', '9'), file('two', '50')] }), '59,00 €');
assert.equal(context.reportCost({ attachments: [file('one', '9,10 €'), file('two', '50.20')] }), '59,30 €');
assert.equal(context.reportCost({ attachments: [file('one', '1.234,56'), file('two', '1,234.56')] }), '2.469,12 €');
assert.equal(context.reportCost({ attachments: [file('one', '9'), file('one', '9')] }), '9,00 €');
assert.equal(context.reportCost({ cost: '90', attachments: [file('one', '0')] }), '0,00 €');
assert.equal(context.reportCost({ cost: '90', attachments: [] }), '90');
assert.equal(context.reportCost({ invoiceData: { totalAmount: '50' }, attachments: [file('one', ''), file('two', '')] }), '—');
assert.match(context.reportCost({ attachments: [file('one', '9'), file('two', '')] }), /9,00.*εκκρεμεί/);
assert.equal(context.invoiceMoneyCents('9,001,00'), null);
assert.equal(context.invoiceMoneyCents('λάθος'), null);
assert.equal(context.reportCost({ attachments: [{ key: 'one', qrData: { totalAmount: '9' }, ocr: { totalAmount: '50', confirmedAt: 'now' } }] }), '50,00 €');

const payment = 'Όροι Πληρωμής Συναλλαγής Τοίς Μετρητοίς';
for (const clean of [cleanInvoiceWorkText, context.cleanInvoiceWorkText]) {
  assert.equal(clean(payment), '');
  assert.equal(clean('Λάδι Yamalube — ' + payment), 'Λάδι Yamalube');
  assert.equal(clean('Αλλαγή τακακιών'), 'Αλλαγή τακακιών');
  assert.equal(clean('PAYMENT TERMS CASH'), '');
}
assert.deepEqual(Array.from(context.mergeServiceTasks([payment, 'Αλλαγή τακακιών'], [payment])), ['Αλλαγή τακακιών']);
const normalized = normalizeServiceDocumentOcr({ workPerformed: ['Λάδι Yamalube', payment], lineItems: [payment], parts: [payment] });
assert.equal(normalized.workPerformed, 'Λάδι Yamalube'); assert.deepEqual(normalized.lineItems, []); assert.deepEqual(normalized.parts, []);
const portalContext = vm.createContext({});
vm.runInContext(['cleanInvoiceWorkText', 'stripInvoicePartCode', 'portalLineText', 'portalTaskKey', 'portalMergeInvoiceTasks', 'portalInvoiceWorkItems'].map(name => extract(portal, name)).join('\n'), portalContext);
assert.deepEqual(Array.from(portalContext.portalInvoiceWorkItems({ tasks: [payment], invoiceData: { lineItems: ['Αλλαγή τακακιών', payment] } })), ['Αλλαγή τακακιών']);

for (const plate of ['ΞΝ-131', 'ADE-6472', 'SH-125', 'BTO-75699', 'ΤΔΑ-1234']) assert.equal(normalizeServiceDocumentOcr({ plate })?.plate, undefined, plate);
assert.equal(normalizeServiceDocumentOcr({ plate: 'ΒΤΟ 756', rawText: 'Πινακίδα: ΒΤΟ 756' }).plate, 'BTO-756');
assert.equal(normalizeServiceDocumentOcr({ plate: 'BTO-756', rawText: 'Κωδικός είδους BTO-756 λάδι' }).plate, undefined);
assert.equal(normalizeServiceDocumentOcr({ plate: 'BTO-756', rawText: 'Σχόλια\nBTO-756 9000 χλμ' }).plate, 'BTO-756');
const fleet = [{ id: 'bike', name: 'ΒΤΟ 756' }];
const read = { plate: 'BTH-756', rawText: 'Πινακίδα: BTH-756' };
assert.equal(refineInvoicePlateForFleet(read, fleet).plate, 'BTO-756');
assert.equal(refineInvoicePlateForFleet(read, fleet).plateAutoCorrectedFrom, 'BTH-756');
assert.equal(refineInvoicePlateForFleet({ ...read, plate: 'BTH-757', rawText: 'Πινακίδα: BTH-757' }, fleet).plate, 'BTH-757', 'Digits are never guessed');
assert.equal(refineInvoicePlateForFleet(read, [...fleet, { name: 'ΒΤΗ 756' }]).plate, 'BTH-756', 'Exact other vehicle must not be redirected');
assert.equal(refineInvoicePlateForFleet(read, [...fleet, { name: 'ΒΤΝ 756' }]).plate, 'BTH-756', 'Ambiguous correction rejected');
assert.equal(refineInvoicePlateForFleet({ ...read, rawText: 'Είδος BTH-756' }, fleet).plate, 'BTH-756');
assert.equal(refineInvoicePlateForFleet({ ...read, confirmedAt: 'now' }, fleet).plate, 'BTH-756', 'Manual decisions remain authoritative');

const resolution = { plate: 'BTO-757', odometerKm: '9000', confirmedAt: 'now', plateResolution: 'kept-current',
  plateResolutionBikeId: 'bike', plateResolutionPlate: 'BTO756', plateResolutionRead: 'BTO757', correctedByUserAt: 'now', ocrFallbackUsed: 'true' };
assert.deepEqual(serviceDocumentWarnings(fleet[0], { km: 9000 }, resolution), []);
assert.equal(context.invoiceWarnings(fleet[0], { km: 9000 }, resolution).length, 0);
for (const change of [{ plate: 'BTO-758' }, { plateResolutionBikeId: 'other' }, { confirmedAt: '' }]) {
  assert.ok(serviceDocumentWarnings(fleet[0], { km: 9000 }, { ...resolution, ...change }).some(warning => warning.type === 'plate'));
}
assert.ok(serviceDocumentWarnings(fleet[0], { km: 9100 }, resolution).some(warning => warning.type === 'odometer'), 'A different mismatch is not suppressed');

const dates = context.reportServiceDateCell({ date: '2026-10-01', invoiceData: { invoiceDate: '1999-01-01' }, attachments: [file('one', '9', '02/10/2026'), file('two', '50', '2026-10-03')] });
assert.ok(dates.indexOf('2026-10-01') < dates.indexOf('2026-10-02'));
assert.match(dates, /Τιμολόγιο: 2026-10-02/); assert.match(dates, /Τιμολόγιο: 2026-10-03/); assert.doesNotMatch(dates, /1999/);
assert.equal((context.reportServiceDateCell({ date: '2026-10-01', attachments: [file('one', '9'), file('two', '50')] }).match(/Τιμολόγιο:/g) || []).length, 1);

for (const accepted of [false, true]) {
  const fields = {};
  for (const name of ['Supplier', 'Plate', 'Odometer', 'Number', 'Date', 'Total', 'Tasks', 'Comments', 'Error', 'Save']) fields['invoiceReview' + name] = { value: '', textContent: '', disabled: false };
  fields.invoiceReviewPlate.value = 'BTO-757'; fields.invoiceReviewOdometer.value = '9100';
  fields.invoiceReviewTasks.value = 'Αλλαγή τακακιών';
  fields.invoiceReviewTransfer = { classList: { contains: () => false } };
  let requests = 0, closed = false, confirmations = 0;
  fields.invoiceReviewDialog = { close: () => { closed = true; } };
  const record = { id: 'invoice', key: 'file', bikeId: 'bike', entryId: 'entry', serviceKm: 9000, invoiceData: {} };
  const review = vm.createContext({ state: { invoiceReviewDocument: record, invoiceReviewTransferChoice: 'keep', invoiceDocuments: [record] },
    $: name => fields[name], window: { FleetServiceUI: { mileage: async (current, read) => { confirmations++; assert.equal(current,9000); assert.equal(read,9100); return accepted ? 'apply' : null; } } }, km: String,
    api: async (url, options) => { requests++; assert.equal(url, '/api/admin/service-documents/review');
      assert.equal(options.body.keepOnCurrent, true); assert.equal(options.body.updateServiceKm, true); assert.equal(options.body.expectedServiceKm, 9000);
      return { document: { ...record, status: 'confirmed', serviceKm: 9100 } }; },
    loadInvoices: async () => {}, renderInvoiceQueue: () => {}, toast: () => {} });
  vm.runInContext(extract(portal, 'saveAdminInvoiceReview'), review);
  await review.saveAdminInvoiceReview({ preventDefault() {} });
  assert.equal(confirmations, 1); assert.equal(requests, Number(accepted)); assert.equal(closed, accepted);
  if (!accepted) assert.equal(fields.invoiceReviewSave.disabled, false);
}
console.log('OK invoice improvements: exact cost sums, separate invoice data/dates, payment terms removed, strict plate evidence, unique letter tolerance and durable user resolutions.');
