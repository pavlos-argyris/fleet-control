import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../cloudflare-worker/public/portal.js', import.meta.url), 'utf8');
const extract = name => {
  const match = source.match(new RegExp('^  (?:async )?function ' + name + '\\([\\s\\S]*?^  \\}', 'm'));
  assert.ok(match, name); return match[0];
};
const fields = {};
for (const name of ['invoiceQueueList', 'invoiceQueueSummary', 'invoiceStatusFilter', 'invoicePlateFilter', 'invoiceFileSearch', 'reprocessInvoices']) fields[name] = { value: '', innerHTML: '', hidden: false };
const record = (id, plate, date, extra = {}) => ({ id, key: 'service-documents/' + id + '.pdf', name: id + '.pdf', contentType: 'application/pdf', bikeName: plate, invoiceData: { invoiceDate: date }, warnings: [], ...extra });
const records = [record('newest', 'ΒΤΟ 756', '2026-10-03'), record('oldest', 'BTO-756', '01/10/2026'), record('second', 'ΒΤΟ 756', '2026-10-02'), record('unknown', 'ΒΤΟ 756', '31/02/2026'), record('other', 'ΤΝΗ 921', '2026-10-01'), record('pending', 'ΒΤΟ 756', '', { key: '' }), record('picture', 'ΒΤΟ 756', '', { contentType: 'image/png', name: 'pic.png' })];
const state = { invoiceDocuments: records, invoiceView: 'review', invoiceCollapsedGroups: new Set(), invoiceGroupAnimationUntil: 0, invoiceGroupRenderTimer: 0 };
let clock = 1000;
class Clock extends Date { static now() { return clock; } }
const ctx = vm.createContext({ document: { querySelector: () => ({hidden:false}), querySelectorAll: () => [] }, state, console, Map, Set, Date: Clock, encodeURIComponent,
  $: id => fields[id], can: () => true, renderInvoiceBulkProgress: () => {}, refreshWigglyProgressRings: () => {},
  portalInvoiceWorkItems: () => [], formatDate: String, km: String, invoiceProgressMarkup: () => '', invoiceStatusPill: () => '', invoiceStatusLabels: {},
  escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
  window: { matchMedia: () => ({ matches: false }), setTimeout: fn => { ctx.pendingRender = fn; return 1; } } });
vm.runInContext(['invoicePlateKey', 'invoiceDocumentDateKey', 'invoiceFileGroups', 'invoiceGroupMarkup', 'toggleInvoiceGroup', 'renderInvoiceFileList', 'renderInvoiceQueue'].map(extract).join('\n'), ctx);
const groups = ctx.invoiceFileGroups([...records, records[0]], '', '');
assert.equal(groups.length, 2); assert.equal(groups[0].items.length, 4);
assert.deepEqual(Array.from(groups[0].items, x => x.id), ['oldest', 'second', 'newest', 'unknown']);
assert.equal(ctx.invoiceFileGroups(records, '', 'BTO-756')[0].items.length, 4);
assert.equal(ctx.invoiceFileGroups(records, '', 'oldest')[0].items.length, 1);
assert.equal(ctx.invoiceFileGroups(records, '', '?!').length, 0);
assert.equal(ctx.invoiceFileGroups(records, 'TNH921', '')[0].items[0].id, 'other');
assert.equal(ctx.invoiceFileGroups([record('no-plate', '', '')], 'unknown', '')[0].key, 'unknown');
ctx.renderInvoiceQueue(); assert.match(fields.invoiceQueueList.innerHTML, /aria-expanded="true"/);
const body = { inert: false }, buttonAttrs = {}, classes = new Set();
const button = { dataset: { invoiceGroupToggle: 'review:BTO756' }, setAttribute: (name, value) => { buttonAttrs[name] = value; }, closest: () => ({ classList: { toggle: (name, active) => active ? classes.add(name) : classes.delete(name) }, querySelector: () => body }) };
ctx.toggleInvoiceGroup(button); assert.equal(body.inert, true); assert.equal(buttonAttrs['aria-expanded'], 'false');
const before = fields.invoiceQueueList.innerHTML;
ctx.renderInvoiceQueue(); assert.equal(fields.invoiceQueueList.innerHTML, before, 'Polling must wait for animation');
clock += 500; ctx.pendingRender();
assert.match(fields.invoiceQueueList.innerHTML, /is-collapsed[^>]*data-invoice-group="review:BTO756"/);
state.invoiceDocuments = [...records, record('later-upload', 'BTO-756', '2026-10-04')];
ctx.renderInvoiceQueue(); assert.match(fields.invoiceQueueList.innerHTML, /aria-expanded="false"/);
state.invoiceView = 'files'; fields.invoiceStatusFilter.value = 'error'; ctx.renderInvoiceQueue();
assert.equal(fields.invoiceStatusFilter.hidden, true); assert.equal(fields.invoiceQueueSummary.hidden, true);
assert.match(fields.invoiceQueueList.innerHTML, /data-invoice-open="oldest"/);
assert.match(fields.invoiceQueueList.innerHTML, /data-invoice-download="oldest"/);
assert.doesNotMatch(fields.invoiceQueueList.innerHTML, /invoice-queue-facts|invoice-queue-tasks|invoice-queue-warnings|data-invoice-review/);
assert.match(fields.invoiceQueueList.innerHTML, /data-invoice-group="files:BTO756"/);
assert.ok(fields.invoiceQueueList.innerHTML.indexOf('oldest.pdf') < fields.invoiceQueueList.innerHTML.indexOf('newest.pdf'));
ctx.toggleInvoiceGroup(button); clock += 500; state.invoiceView = 'review'; ctx.renderInvoiceQueue();
assert.equal(body.inert, false); assert.equal(state.invoiceCollapsedGroups.has('review:BTO756'), false);

for (const mode of ['server-first', 'workers-ai']) {
  const ui = { invoiceDocuments: [records[0]], invoiceReprocessBusy: false, invoiceReprocessStarting: false };
  const dialog = { close() {}, showModal() { this.open = true; } };
  const elements = { invoiceReprocessDialog: dialog, invoiceReprocessCount: {}, invoiceStatusFilter: { value: '' } };
  let calls = 0;
  const run = vm.createContext({ state: ui, Date, Set, window: {}, $: id => elements[id], invoiceBatchClientId: () => 'test-id', renderInvoiceQueue() {}, toast() {}, applyRemoteInvoiceReprocessBatch() {},
    api: async (url, options) => { calls++; assert.equal(url, '/api/admin/service-documents/reprocess-batch'); assert.equal(options.body.mode, mode); return { started: true, batch: { id: 'test-id' } }; } });
  vm.runInContext(extract('chooseInvoiceReprocessMode') + '\n' + extract('reprocessAllInvoiceDocuments'), run);
  run.chooseInvoiceReprocessMode(); assert.equal(dialog.open, true); assert.equal(calls, 0);
  const first = run.reprocessAllInvoiceDocuments(mode); const second = run.reprocessAllInvoiceDocuments(mode);
  await Promise.all([first, second]); assert.equal(calls, 1); assert.equal(ui.invoiceReprocessBusy, true); assert.equal(ui.invoiceReprocessStarting, false);
}
console.log('OK invoice library: actual queue collapse survives polling, transition deferred, independent views, unique PDFs, invoice date ordering, filename-only rows and explicit batch mode/double-click guard.');
