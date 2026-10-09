import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../cloudflare-worker/public/scroll-stability.js', import.meta.url), 'utf8');
let ownDialog = false; let mutation; let queued;
const handlers = {}; const visualHandlers = {}; const frameHandlers = {};
const classes = new Set(); const styles = {}; const messages = [];
const frame = { contentWindow: {}, addEventListener: (name, fn) => { frameHandlers[name] = fn; } };
const parent = { postMessage: value => messages.push(value) };
const document = { body: {}, documentElement: {
  classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name) },
  style: { setProperty: (key, value) => { styles[key] = value; } }
}, querySelector: () => ownDialog, getElementById: () => frame };
const window = { innerHeight: 900, innerWidth: 412, parent,
  visualViewport: { height: 900, addEventListener: (name, fn) => { visualHandlers[name] = fn; } },
  requestAnimationFrame: fn => { queued = fn; }, addEventListener: (name, fn) => { handlers[name] = fn; } };
vm.runInNewContext(source, { document, window, Math,
  MutationObserver: class { constructor(fn) { mutation = fn; } observe() {} }
});
assert.equal(classes.has('fleet-modal-open'), false);
ownDialog = true; mutation();
assert.equal(classes.has('fleet-modal-open'), true); assert.equal(styles['--fleet-dialog-viewport'], '900px');
window.visualViewport.height = 830; visualHandlers.resize(); handlers.resize(); queued();
assert.equal(styles['--fleet-dialog-viewport'], '900px', 'fast toolbar motion must not change modal margins');
window.visualViewport.height = 510; visualHandlers.resize(); queued();
assert.equal(styles['--fleet-dialog-viewport'], '510px', 'keyboard must keep fields reachable');
window.visualViewport.height = 900; visualHandlers.resize(); queued();
assert.equal(styles['--fleet-dialog-viewport'], '900px', 'closing keyboard restores modal bound');
window.innerWidth = 900; window.innerHeight = 412; window.visualViewport.height = 412; handlers.resize(); queued();
assert.equal(styles['--fleet-dialog-viewport'], '412px', 'rotation updates bound');
ownDialog = false; mutation(); assert.equal(classes.has('fleet-modal-open'), false);
assert.deepEqual(messages.map(x => x.open), [true, false], 'only actual dialog state changes message parent');
handlers.message({ source: {}, data: { type: 'fleet-control:modal-state', open: true } });
assert.equal(classes.has('fleet-modal-open'), false, 'unrelated window cannot lock portal');
handlers.message({ source: frame.contentWindow, data: { type: 'fleet-control:modal-state', open: true } });
assert.equal(classes.has('fleet-modal-open'), true, 'iframe dialog locks parent scroll');
frameHandlers.load(); assert.equal(classes.has('fleet-modal-open'), false, 'iframe reload cannot leave parent locked');
assert.equal(handlers.scroll, undefined, 'no layout work on scroll');
for (const root of ['cloudflare-worker/public', 'client-android/assets/www']) {
  for (const html of ['index.html', 'portal.html']) {
    const value = fs.readFileSync(new URL('../' + root + '/' + html, import.meta.url), 'utf8');
    assert.match(value, /scroll-stability\.js/); assert.match(value, /scroll-stability\.css/);
  }
  const cache = fs.readFileSync(new URL('../' + root + '/service-worker.js', import.meta.url), 'utf8');
  assert.match(cache, /scroll-stability\.js/); assert.match(cache, /scroll-stability\.css/);
}
console.log('OK actual shared scroll controller: stable toolbar resize, keyboard/rotation bounds, modal background lock, trusted iframe propagation/reload, cached assets and no scroll-triggered layout. Physical-device fast swipes remain unverified.');
