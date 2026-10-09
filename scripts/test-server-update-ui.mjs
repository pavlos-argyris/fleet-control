import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../server-android/assets/www/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../server-android/assets/www/index.html', import.meta.url), 'utf8');
const nodes = new Map();
function element(id) {
  if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, textContent: '', innerHTML: '', hidden: false, disabled: false,
    listeners: {}, attrs: {}, style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(name, fn) { this.listeners[name] = fn; }, setAttribute(name, value) { this.attrs[name] = value; }, removeAttribute(name) { delete this.attrs[name]; },
    parentElement: { setAttribute() {} }, close() {}, showModal() {}, reset() {} });
  return nodes.get(id);
}
let data = { serverVersion: '2.1.4', syncSeconds: 30, invoiceParallelism: 4, workerUrl: 'https://simulation.invalid', serviceRunning: true, serverOnline: true, health: {} };
let saveOk = true, saved;
const bridge = { getDashboard: () => JSON.stringify(data), saveSettings: raw => {
  saved = JSON.parse(raw); if (!saveOk) return JSON.stringify({ ok: false, message: 'error' });
  data = { ...data, ...saved }; return JSON.stringify({ ...data, ok: true });
}, loadReleases() {}, checkServerUpdate() {} };
let tick;
const context = vm.createContext({ console, window: { AndroidServer: bridge, scrollTo() {} },
  document: { getElementById: element, querySelectorAll: () => [] }, setInterval: fn => { tick = fn; }, setTimeout: () => 1, clearTimeout() {} });
vm.runInContext(source, context);
assert.equal(element('syncSeconds').value, '30');
element('settingsForm').listeners.focusin({ target: element('syncSeconds') });
element('syncSeconds').value = '60'; element('workerUrl').value = 'https://new.invalid';
for (let i = 0; i < 10; i++) tick();
assert.equal(element('syncSeconds').value, '60'); assert.equal(element('workerUrl').value, 'https://new.invalid');
element('settingsForm').listeners.submit({ preventDefault() {} });
assert.equal(saved.syncSeconds, 60); assert.equal(saved.workerUrl, 'https://new.invalid');
data.syncSeconds = 300; tick(); assert.equal(element('syncSeconds').value, '300', 'Saved settings become live again');
element('settingsForm').listeners.input({}); element('syncSeconds').value = '10'; saveOk = false;
element('settingsForm').listeners.submit({ preventDefault() {} }); tick();
assert.equal(element('syncSeconds').value, '10', 'Failed save must keep user changes');
assert.equal(element('settingsMessage').textContent, 'error');
data.ota = { stage: 'downloading', installStatus: 'failed', ready: { version: '2.1.5', notes: '• Πρώτο\n• Δεύτερο <script>' }, downloadPercent: 40, downloadedBytes: 40000, totalBytes: 100000 };
tick(); assert.equal(element('otaProgress').attrs['aria-valuenow'], '40'); assert.equal(element('installServerUpdate').disabled, true);
assert.match(element('otaNotes').innerHTML, /<li>Πρώτο<\/li>/); assert.match(element('otaNotes').innerHTML, /&lt;script&gt;/);
data.ota = { stage: 'waiting', ready: { version: '2.1.5' }, message: 'Ready' };
tick(); assert.equal(element('installServerUpdate').disabled, false); assert.equal(element('otaProgress').hidden, true); assert.equal(element('otaProgressLabel').textContent, '');
data.ota = { stage: 'backup', ready: { version: '2.1.5' } };
tick(); assert.equal(element('otaProgress').attrs['aria-valuenow'], undefined, 'No invented backup percentage');
data.ota = { stage: 'installing', installStatus: 'confirmation', installMessage: 'Android confirmation', ready: { version: '2.1.5' } };
tick(); assert.equal(element('installServerUpdate').textContent, 'Επιβεβαίωση στο Android'); assert.equal(element('installServerUpdate').disabled, false);
context.window.FleetServer.onNativeEvent('releases', { ok: true, releases: [{ kind: 'server', version: '2.1.5', notes: 'Πρώτο, Δεύτερο', created_at: '2026-10-10' }] });
assert.match(element('releaseList').innerHTML, /<li>Πρώτο<\/li><li>Δεύτερο<\/li>/);
for (const id of nodes.keys()) assert.ok(html.includes('id="' + id + '"'), 'Missing HTML element: ' + id);
console.log('OK actual Server UI: draft settings survive 1-second polling/focus/native events, save success/failure, escaped bullet notes, download progress, truthful indeterminate backup and Android confirmation.');
