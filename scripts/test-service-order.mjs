import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../cloudflare-worker/public/app.js', import.meta.url), 'utf8');
const extract = name => {
  const match = source.match(new RegExp('^  function ' + name + '\\([\\s\\S]*?^  \\}', 'm'));
  assert.ok(match, name); return match[0];
};
const service = (id, date, km, extra = {}) => ({ id, date, km, type: 'service', oilChanged: true, ...extra });
const bikes = [
  { id: 'old-upload', name: 'ΒΤΟ 756', lastServiceKm: 99000, history: [service('old-high', '2021-01-01', 99000, { createdAt: '2026-10-10', invoiceData: { invoiceDate: '2026-10-09' } }), service('recent', '2026-10-03', 9000)] },
  { id: 'new', name: '<Νέο>', lastServiceKm: 8000, history: [service('new', '2026-10-04', 8000), service('check', '2026-10-09', 8100, { type: 'check' })] },
  { id: 'initial', name: 'Αρχικό', history: [service('initial', '2026-10-10', 5000, { notes: 'Αρχική ένδειξη αλλαγής λαδιών' })] },
  { id: 'deleted', name: 'Διαγραφή', historyDeletedIds: ['deleted'], history: [service('deleted', '2026-10-09', 1000), service('valid', '2026-09-01', 2000)] },
  { id: 'invalid', name: 'Άγνωστο', history: [service('bad', '2026-02-31', 7000)] },
  { id: 'empty', name: 'Χωρίς', history: [] }
];
const node = hidden => {
  const classes = new Set(hidden ? ['is-hidden'] : []);
  return { innerHTML: '', textContent: '', classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) } };
};
const elements = { homeView: node(false), detailView: node(true), quickCheckView: node(true), serviceOrderView: node(true), serviceOrderSummary: node(), serviceOrderList: node() };
const stack = [{ view: 'home' }]; let position = 0; const scrolls = []; const modes = [];
const history = {
  get state() { return stack[position]; },
  pushState(state) { stack.splice(position + 1); stack.push(state); position++; },
  back() { if (position) { position--; context.handleFleetNavigation({ state: stack[position] }); } }
};
const context = vm.createContext({ bikes, elements, history, Set, Date, Number, String,
  activeBikeId: null, activeHistoryFilter: '', serviceOrderHomeScroll: 0, historyReportOpen: false,
  window: { scrollY: 850, scrollTo: (x, y) => scrolls.push(y) },
  getBike: id => bikes.find(x => x.id === id), renderDetail() {}, renderArchiveAccess() {}, renderHome() {},
  setDetailPresentation: (active, view) => modes.push(view),
  formatDate: value => String(value), formatKm: value => value + ' km',
  escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
});
vm.runInContext(['serviceDateKey', 'latestServiceRows', 'renderServiceOrder', 'openServiceOrder', 'backFromServiceOrder', 'showHome', 'openDetail', 'handleFleetNavigation'].map(extract).join('\n'), context);
const original = JSON.stringify(bikes);
const rows = context.latestServiceRows(bikes);
assert.deepEqual(Array.from(rows.slice(0, 3), x => x.bike.id), ['new', 'old-upload', 'deleted']);
assert.equal(rows[1].latest.id, 'recent'); assert.equal(rows[1].mileageWarning, true);
assert.equal(rows.find(x => x.bike.id === 'initial').latest, null);
assert.equal(rows.find(x => x.bike.id === 'invalid').date, '');
assert.equal(context.serviceDateKey({ date: '2024-02-29' }), '2024-02-29');
assert.equal(context.serviceDateKey({ date: '2025-02-29' }), '');
assert.equal(JSON.stringify(bikes), original, 'overview must not change stored metrics/history');
context.openServiceOrder(true);
assert.equal(history.state.view, 'service-order');
assert.equal(elements.homeView.classList.contains('is-hidden'), true);
assert.equal(elements.serviceOrderView.classList.contains('is-hidden'), false);
assert.match(elements.serviceOrderList.innerHTML, /&lt;Νέο>/);
assert.match(elements.serviceOrderList.innerHTML, /Έλεγξε τα χιλιόμετρα/);
assert.match(elements.serviceOrderList.innerHTML, /2026-10-03/);
assert.doesNotMatch(elements.serviceOrderList.innerHTML, /2021-01-01|2026-10-10/);
context.openDetail('old-upload', true);
assert.equal(elements.serviceOrderView.classList.contains('is-hidden'), true);
history.back(); assert.equal(history.state.view, 'service-order');
assert.equal(elements.serviceOrderView.classList.contains('is-hidden'), false);
context.backFromServiceOrder(); assert.equal(history.state.view, 'home');
assert.equal(elements.homeView.classList.contains('is-hidden'), false);
assert.equal(scrolls.at(-1), 850, 'Back restores the previous Fleet scroll position');
context.handleFleetNavigation({ state: { view: 'service-order' } });
assert.equal(elements.serviceOrderView.classList.contains('is-hidden'), false, 'forward history restores overview');
bikes[0].history.push(service('ancient-late-upload', '2018-01-01', 150000));
context.renderServiceOrder(); assert.ok(elements.serviceOrderList.innerHTML.indexOf('&lt;Νέο>') < elements.serviceOrderList.innerHTML.indexOf('ΒΤΟ 756'));
assert.equal(modes.at(-1), 'service-order');
console.log('OK actual Fleet service overview: service-date ordering independent of mileage/upload/invoice date, initial/check/deleted entries, invalid dates, warnings, escaping, read-only metrics and Back/Forward/detail return with scroll restoration.');
