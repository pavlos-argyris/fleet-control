import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
for (const name of ['app.js', 'portal.js']) {
  const source = fs.readFileSync(new URL('../cloudflare-worker/public/' + name, import.meta.url), 'utf8');
  const extract = fn => { const match = source.match(new RegExp('^  function ' + fn + '\\([\\s\\S]*?^  \\}', 'm')); assert.ok(match); return match[0]; };
  let path; const strokes = []; let measurements = 0; let reduced = false;
  const paint = { setTransform() {}, clearRect() { strokes.length = 0; }, save() {}, restore() {}, setLineDash() {},
    beginPath() { path = []; }, moveTo(x, y) { path.push([x, y]); }, lineTo(x, y) { path.push([x, y]); }, stroke() { strokes.push(path); } };
  const window = { innerWidth: 412, devicePixelRatio: 2, matchMedia: () => ({ matches: reduced }), getComputedStyle: () => ({ width: 48, height: 48 }) };
  const context = vm.createContext({ window, Number, Math, String, wigglyProgressRings: new Set(), document: { documentElement: { contains: () => true } } });
  vm.runInContext(['wigglyProgressReducedMotion', 'clampWigglyProgress', 'isWigglyProgressAttached', 'drawWigglyProgressRing'].map(extract).join('\n'), context);
  const canvas = { isConnected: true, dataset: { progress: 40, status: 'processing' }, getBoundingClientRect() { measurements++; return { width: 48, height: 48 }; }, getContext: () => paint };
  const angle = point => Math.atan2(point[1] - 24, point[0] - 24);
  context.drawWigglyProgressRing(canvas, 0);
  assert.ok(Math.abs(angle(strokes[1][0]) + Math.PI / 2) < 1e-8);
  assert.equal(strokes[1].length, 73, '40 percent stays 40 percent while rotating');
  assert.deepEqual(strokes[0][0], strokes[0].at(-1), 'wavy loop closes without seam');
  context.drawWigglyProgressRing(canvas, 2000);
  assert.ok(angle(strokes[1][0]) > -Math.PI / 2 + 1, 'lit arc rotates clockwise');
  assert.equal(strokes[1].length, 73); assert.equal(canvas.__wigglyProgress, 40);
  assert.equal(measurements, 1, 'animation must not force layout measurement every frame');
  window.innerWidth = 800; context.drawWigglyProgressRing(canvas, 3000); assert.equal(measurements, 2);
  canvas.dataset.status = 'completed'; canvas.dataset.progress = 100; canvas.__wigglyProgress = 100;
  context.drawWigglyProgressRing(canvas, 5000); assert.ok(Math.abs(angle(strokes[1][0]) + Math.PI / 2) < 1e-8);
  canvas.dataset.status = 'processing'; canvas.dataset.progress = 40; reduced = true;
  context.drawWigglyProgressRing(canvas, 1000); const staticPath = JSON.stringify(strokes);
  context.drawWigglyProgressRing(canvas, 9000); assert.equal(JSON.stringify(strokes), staticPath, 'reduced motion is truly static');
}
console.log('OK actual Fleet/Portal ring: slower periodic zigzag, clockwise lit arc, accurate percent/closed loop, cached geometry, completed state and reduced motion.');
