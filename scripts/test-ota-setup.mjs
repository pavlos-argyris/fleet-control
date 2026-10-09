import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { productionVariables, readPrivateKeys, setupOta, readCloudflare } from './setup-ota-secrets.mjs';

const fixture = () => ({ bindings: [
  { name: 'DB', type: 'd1', id: '01234567-89ab-cdef-0123-456789abcdef' },
  { name: 'RELEASES', type: 'r2_bucket', bucket_name: 'existing-releases' },
  { name: 'SERVICE_DOCS', type: 'r2_bucket', bucket_name: 'existing-invoices' },
  { name: 'SERVER_KEY', type: 'secret_text' },
  { name: 'CLIENT_KEY', type: 'secret_text' },
] });
const subdomain = { subdomain: 'pavlosargyris' };
const availability = { enabled: true };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ota-setup-'));
let scenarios = 0;
try {
  const variables = productionVariables(fixture(), subdomain, availability);
  assert.equal(variables.FLEET_D1_DATABASE_ID, fixture().bindings[0].id);
  assert.equal(variables.FLEET_DOCUMENTS_BUCKET, 'existing-invoices');
  assert.throws(() => productionVariables(fixture(), { subdomain: 'other-account' }, availability), /selected account/);
  assert.throws(() => productionVariables(fixture(), subdomain, { enabled: false }), /selected account/);
  for (const name of ['DB', 'RELEASES', 'SERVICE_DOCS', 'SERVER_KEY', 'CLIENT_KEY']) {
    const missing = fixture();
    missing.bindings = missing.bindings.filter(b => b.name !== name);
    assert.throws(() => productionVariables(missing, subdomain, availability), /missing or ambiguous/);
  }
  const duplicate = fixture();
  duplicate.bindings.push(duplicate.bindings[0]);
  assert.throws(() => productionVariables(duplicate, subdomain, availability), /ambiguous/);
  const wrongId = fixture();
  wrongId.bindings[0].id = 'not-a-production-database-id';
  assert.throws(() => productionVariables(wrongId, subdomain, availability), /D1 ID/);
  const region = fixture();
  region.bindings[1].jurisdiction = 'eu';
  assert.throws(() => productionVariables(region, subdomain, availability), /manual configuration/);
  const wrongPepper = fixture();
  wrongPepper.bindings.push({ name: 'PIN_PEPPER', type: 'plain_text', text: 'test-only' });
  assert.throws(() => productionVariables(wrongPepper, subdomain, availability), /PIN_PEPPER/);
  scenarios += 11;

  assert.throws(() => readPrivateKeys(root), /original private recovery ZIP/);
  fs.mkdirSync(path.join(root, 'private/signing'), { recursive: true });
  fs.writeFileSync(path.join(root, 'private/signing/fleet-control-release.p12'), 'a different signing key');
  fs.writeFileSync(path.join(root, 'private/PRIVATE_SETUP_KEYS.txt'), 'ALIAS=test\nSTORE_PASSWORD=test\nKEY_PASSWORD=test\n');
  fs.writeFileSync(path.join(root, 'private/server-secrets.json'), JSON.stringify({ serverKey: 'test-only-server-key' }));
  assert.throws(() => readPrivateKeys(root), /not the original signing container/);
  scenarios += 2;

  const fakeKeys = {
    FLEET_KEYSTORE_BASE64: 'test-only-base64-key', FLEET_STORE_PASSWORD: 'test-only-store-password',
    FLEET_KEY_PASSWORD: 'test-only-key-password', FLEET_KEY_ALIAS: 'test-only-alias',
    FLEET_SERVER_KEY: 'test-only-server-key',
  };
  const input = { accountId: '0123456789abcdef0123456789abcdef', apiToken: 'test-only-cloudflare-token' };
  const secrets = new Map(), savedVariables = new Map(), calls = [], logs = [], reads = [];
  let privateRepo = true;
  const gh = (args, stdin = '') => {
    calls.push({ args, stdin });
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'pavlos-argyris/fleet-control', isPrivate: privateRepo, viewerPermission: 'ADMIN' });
    if (args[0] === 'secret' && args[1] === 'list') return JSON.stringify([...secrets].map(([name]) => ({ name })));
    if (args[0] === 'variable' && args[1] === 'list') return JSON.stringify([...savedVariables].map(([name, value]) => ({ name, value })));
    if (args[1] === 'set') {
      (args[0] === 'secret' ? secrets : savedVariables).set(args[2], stdin);
      return '';
    }
    throw new Error('Unexpected GitHub operation in setup test');
  };
  const cf = async (account, token, resource) => {
    reads.push(resource);
    assert.equal(account, input.accountId); assert.equal(token, input.apiToken);
    if (resource.endsWith('/settings')) return fixture();
    return resource === 'workers/subdomain' ? subdomain : availability;
  };
  const options = { root, input, gh, cf, keys: () => ({ ...fakeKeys }), log: message => logs.push(message) };
  const result = await setupOta(options);
  assert.equal(secrets.size, 8); assert.equal(savedVariables.size, 5);
  assert.deepEqual(result.variables, variables);
  const releaseToken = secrets.get('FLEET_RELEASE_TOKEN');
  assert.match(releaseToken, /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(path.join(root, 'private/fleet-release-token.txt'), 'utf8').trim(), releaseToken);
  assert.deepEqual(reads, ['workers/scripts/fleet-control/settings', 'workers/subdomain', 'workers/scripts/fleet-control/subdomain']);
  for (const secret of [...Object.values(fakeKeys), input.apiToken, releaseToken]) {
    assert.ok(!JSON.stringify(logs).includes(secret), 'Secret value leaked in setup output');
    assert.ok(!JSON.stringify(calls.map(c => c.args)).includes(secret), 'Secret value leaked in process arguments');
  }
  assert.ok(calls.every(c => !c.args.includes('workflow') && !c.args.includes('release')), 'Setup must not publish');
  scenarios++;

  const count = calls.length;
  await setupOta(options);
  assert.equal(secrets.get('FLEET_RELEASE_TOKEN'), releaseToken);
  assert.ok(!calls.slice(count).some(c => c.args[0] === 'secret' && c.args[1] === 'set' && c.args[2] === 'FLEET_RELEASE_TOKEN'));
  secrets.delete('FLEET_RELEASE_TOKEN');
  await setupOta(options);
  assert.equal(secrets.get('FLEET_RELEASE_TOKEN'), releaseToken, 'Retry must reuse the saved recovery token');
  scenarios += 2;

  const writeCount = () => calls.filter(c => c.args[1] === 'set').length;
  let before = writeCount();
  privateRepo = false;
  await assert.rejects(setupOta(options), /private pavlos-argyris/);
  assert.equal(writeCount(), before);
  privateRepo = true;
  await assert.rejects(setupOta({ ...options, cf: async () => { throw new Error('Test Cloudflare read failure'); } }), /Cloudflare read failure/);
  assert.equal(writeCount(), before);
  await assert.rejects(setupOta({ ...options, cf: async (account, token, resource) => resource.endsWith('/settings') ? fixture() : { subdomain: 'wrong-account', enabled: true } }), /selected account/);
  assert.equal(writeCount(), before);
  scenarios += 3;

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, config) => {
      assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/workers/scripts/fleet-control/settings`);
      assert.equal(config.method, 'GET'); assert.equal(config.redirect, 'error');
      assert.equal(config.headers.Authorization, `Bearer ${input.apiToken}`);
      return { ok: true, text: async () => JSON.stringify({ success: true, result: fixture() }) };
    };
    assert.deepEqual(await readCloudflare(input.accountId, input.apiToken, 'workers/scripts/fleet-control/settings'), fixture());
    globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => input.apiToken });
    await assert.rejects(readCloudflare(input.accountId, input.apiToken, 'workers/subdomain'), /HTTP 403/);
    scenarios += 2;
  } finally { globalThis.fetch = originalFetch; }
  console.log(`OTA setup: ${scenarios} checks passed; existing resources and release token preserved, secret values kept out of logs/arguments, no deployment.`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
