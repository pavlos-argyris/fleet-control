import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, webcrypto } from 'node:crypto';
import worker from '../cloudflare-worker/src/worker.js';
import { MAX_WEB_RELEASE_FILES, MAX_RELEASE_MANIFEST_BYTES, releaseCapacityError } from '../cloudflare-worker/src/release-limits.js';
globalThis.crypto ||= webcrypto;
const sqlite = new DatabaseSync(':memory:');
let failBatch = false;
class Statement {
  constructor(sql, values = []) { this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.sql, values); }
  async first() { return sqlite.prepare(this.sql).get(...this.values) || null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.values) }; }
  async run() { const value = sqlite.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(value.changes), last_row_id: Number(value.lastInsertRowid) } }; }
}
const DB = {
  prepare: sql => new Statement(sql),
  async exec(sql) { sqlite.exec(sql); },
  async batch(statements) { sqlite.exec('BEGIN'); try { const result = []; for (let i = 0; i < statements.length; i++) { result.push(await statements[i].run()); if (failBatch && i === 1) throw new Error('Simulated transaction failure'); } sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } }
};
const objects = new Map();
const RELEASES = {
  async head(key) { return objects.get(key) || null; },
  async get(key) { return objects.get(key) || null; },
  async put(key, data, options = {}) { const bytes = new Uint8Array(data); const object = { body: bytes, size: bytes.length, ...options }; objects.set(key, object); return object; }
};
const token = 'test-publisher-credential-at-least-32-characters';
const env = { DB, RELEASES, SERVER_KEY: 'test-server-credential-only', RELEASE_TOKEN: token, ASSETS: { fetch: async () => new Response('static fallback') } };
const origin = 'https://fleet.test';
async function call(path, method = 'GET', data, auth = '') {
  const headers = auth === 'publisher' ? { Authorization: `Bearer ${token}` } : auth === 'server' ? { 'X-Fleet-Server-Key': env.SERVER_KEY } : {};
  const body = data == null ? undefined : typeof data === 'object' && !(data instanceof Uint8Array) ? JSON.stringify(data) : data;
  return worker.fetch(new Request(origin + path, { method, headers, body }), env);
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const apk = text => new Uint8Array(Buffer.from('PK\x03\x04' + text));
function release(id, clientCode, serverCode, sourceCommit = 'a'.repeat(40)) {
  const bytes = { 'client.apk': apk('client-' + clientCode), 'server.apk': apk('server-' + serverCode), 'web/index.html': new Uint8Array(Buffer.from('<html>Fleet</html>')), 'web/portal.html': new Uint8Array(Buffer.from('<html>Login ' + clientCode + '</html>')), 'web/service-worker.js': new Uint8Array(Buffer.from('// SW ' + clientCode)) };
  const manifest = { releaseId: id, sourceCommit, notes: 'test', web: { version: '5.37.' + clientCode, files: [] } };
  for (const kind of ['client', 'server']) manifest[kind] = { version: kind === 'client' ? '5.37.' + clientCode : '2.1.' + serverCode, versionCode: kind === 'client' ? clientCode : serverCode, packageName: kind === 'client' ? 'gr.argyrismitsos.fleetcontrol' : 'gr.argyrismitsos.fleetserver', sizeBytes: bytes[kind + '.apk'].length, sha256: digest(bytes[kind + '.apk']) };
  for (const [path, data] of Object.entries(bytes)) if (path.startsWith('web/')) manifest.web.files.push({ path: path.slice(4), sizeBytes: data.length, sha256: digest(data) });
  return { manifest, bytes };
}
async function upload(value) { for (const [path, bytes] of Object.entries(value.bytes)) { const response = await call(`/api/deploy/releases/${value.manifest.releaseId}/${path}`, 'PUT', bytes, 'publisher'); assert.equal(response.status, 200); assert.equal((await response.json()).sha256, digest(bytes)); } }
const one = release('test-one', 48, 16);
assert.equal((await call('/api/deploy/releases/test-one/client.apk', 'PUT', one.bytes['client.apk'])).status, 401);
assert.equal((await call('/api/server-update')).status, 401);
assert.equal((await call('/download/server.apk')).status, 401);
await upload(one);
objects.delete('ota/test-one/web/portal.html');
assert.equal((await call('/api/deploy/releases/activate', 'POST', one.manifest, 'publisher')).status, 409);
assert.equal((await (await call('/api/client-update')).json()).available, false, 'Incomplete upload must not activate anything');
await upload(one);
assert.equal((await call('/api/deploy/releases/activate', 'POST', one.manifest, 'publisher')).status, 200);
const first = await (await call('/api/client-update')).json();
assert.equal(first.versionCode, 48); assert.equal(first.sourceCommit, 'a'.repeat(40));
assert.deepEqual(new Uint8Array(await (await call(first.downloadUrl.slice(origin.length))).arrayBuffer()), one.bytes['client.apk']);
assert.equal((await call('/api/deploy/releases/test-one/client.apk', 'PUT', apk('modified'), 'publisher')).status, 409, 'Published objects must remain immutable');
const two = release('test-two', 49, 17, 'b'.repeat(40)); await upload(two);
failBatch = true;
const savedConsole = console.error; console.error = () => {};
assert.equal((await call('/api/deploy/releases/activate', 'POST', two.manifest, 'publisher')).status, 500);
console.error = savedConsole; failBatch = false;
assert.equal((await (await call('/api/client-update')).json()).versionCode, 48, 'D1 failure must roll back all active pointers');
assert.equal((await call('/api/deploy/releases/activate', 'POST', two.manifest, 'publisher')).status, 200);
assert.equal((await (await call('/api/server-update', 'GET', null, 'server')).json()).versionCode, 17);
assert.deepEqual(new Uint8Array(await (await call(first.downloadUrl.slice(origin.length))).arrayBuffer()), one.bytes['client.apk'], 'Pinned old manifest must still download its exact APK');
const server = await (await call('/api/server-update', 'GET', null, 'server')).json();
assert.equal((await call(server.downloadUrl.slice(origin.length))).status, 401, 'Server APK remains protected even with an exact release ID');
assert.deepEqual(new Uint8Array(await (await call(server.downloadUrl.slice(origin.length), 'GET', null, 'server')).arrayBuffer()), two.bytes['server.apk']);
const portal = await call('/'); assert.match(await portal.text(), /Login 49/);
assert.equal((await call('/service-worker.js')).headers.get('Cache-Control'), 'no-cache');
assert.equal((await call('/api/deploy/releases/activate', 'POST', one.manifest, 'publisher')).status, 409, 'Automatic downgrade must be rejected');
assert.equal((await call('/api/deploy/releases/activate', 'POST', two.manifest, 'publisher')).status, 200, 'Identical activation is safely repeatable');
const wrong = structuredClone(two.manifest); wrong.server.packageName = 'other.app';
assert.equal((await call('/api/deploy/releases/activate', 'POST', wrong, 'publisher')).status, 400);
const traversal = await call('/api/deploy/releases/test-x/web/%2e%2e%2fkey', 'PUT', apk('data'), 'publisher'); assert.equal(traversal.status, 400);
const large = release('test-versioned-assets', 50, 18, 'c'.repeat(40));
for (let i = 0; large.manifest.web.files.length < 300; i++) {
  const path = `assets/v5.48.1/script-${i}.js`, bytes = new Uint8Array(Buffer.from('// immutable ' + i));
  large.bytes['web/' + path] = bytes;
  large.manifest.web.files.push({ path, sizeBytes: bytes.length, sha256: digest(bytes) });
}
assert.equal(releaseCapacityError(large.manifest), '');
await upload(large);
const missingKey = 'ota/test-versioned-assets/web/assets/v5.48.1/script-296.js', saved = objects.get(missingKey);
assert.ok(saved); objects.delete(missingKey);
assert.equal((await call('/api/deploy/releases/activate', 'POST', large.manifest, 'publisher')).status, 409, 'Every file beyond the old 250-file limit is still verified');
assert.equal((await (await call('/api/client-update')).json()).versionCode, 49, 'Incomplete large release preserves active pointers');
objects.set(missingKey, saved);
assert.equal((await call('/api/deploy/releases/activate', 'POST', large.manifest, 'publisher')).status, 200, 'Versioned static bundles with more than 250 files activate');
assert.equal((await (await call('/api/client-update')).json()).versionCode, 50);
const tooMany = structuredClone(large.manifest);
while (tooMany.web.files.length <= MAX_WEB_RELEASE_FILES) tooMany.web.files.push({ ...tooMany.web.files[0], path: `extra-${tooMany.web.files.length}.js` });
assert.match(releaseCapacityError(tooMany), /512/);
assert.equal((await call('/api/deploy/releases/activate', 'POST', tooMany, 'publisher')).status, 400);
const tooBig = { ...large.manifest, notes: 'α'.repeat(MAX_RELEASE_MANIFEST_BYTES / 2) };
assert.match(releaseCapacityError(tooBig), /128 KiB/);
assert.equal((await call('/api/deploy/releases/activate', 'POST', tooBig, 'publisher')).status, 413, 'Manifest byte limit also applies to multibyte text');
assert.equal((await (await call('/api/client-update')).json()).versionCode, 50);
sqlite.close();
console.log('PASS: authenticated publication, complete uploads, hashes, immutable APKs, atomic rollback, exact downloads, protected Server, automatic downgrade rejection, Web activation and SW freshness.');
