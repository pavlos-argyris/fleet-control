import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const REPOSITORY = 'pavlos-argyris/fleet-control';
const WORKER_NAME = 'fleet-control';
const WORKER_SUBDOMAIN = 'pavlosargyris';
const WORKER_URL = `https://${WORKER_NAME}.${WORKER_SUBDOMAIN}.workers.dev`;
const ORIGINAL_KEYSTORE_SHA256 = 'f58572ec7cff932865356582324b39c7aad1da5d6569b31d861ad2e4ff65f27a';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bucketName = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

function parseJson(text, message) {
  try { return JSON.parse(text); } catch { throw new Error(message); }
}

export function invokeGh(args, input = '') {
  try {
    return execFileSync('gh', args, {
      input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000,
      env: { ...process.env, GH_HOST: 'github.com', GH_DEBUG: '', GH_PROMPT_DISABLED: '1' },
    }).trim();
  } catch {
    // CLI error bodies are deliberately suppressed: they can contain credentials.
    throw new Error(`GitHub CLI operation failed: ${args.slice(0, 3).join(' ')}. Check gh auth status and repository access.`);
  }
}

export async function readCloudflare(accountId, apiToken, resource) {
  let response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/${resource}`, {
      method: 'GET', headers: { Authorization: `Bearer ${apiToken}` },
      redirect: 'error', signal: AbortSignal.timeout(20000),
    });
  } catch { throw new Error('Cannot read Cloudflare settings. Check your connection and retry.'); }
  if (!response.ok) throw new Error(`Cloudflare read failed (HTTP ${response.status}). Check Account ID, token permissions and existing Worker.`);
  const data = parseJson(await response.text(), 'Cloudflare returned an invalid response.');
  if (data.success !== true || !data.result) throw new Error('Cloudflare could not verify the existing Worker configuration.');
  return data.result;
}

export function productionVariables(settings, subdomain, availability) {
  if (subdomain?.subdomain !== WORKER_SUBDOMAIN || availability?.enabled !== true) {
    throw new Error(`The selected account does not serve the existing ${WORKER_URL}. No settings were written.`);
  }
  const bindings = settings?.bindings;
  if (!Array.isArray(bindings)) throw new Error('Cloudflare did not return Worker bindings. No settings were written.');
  const requireBinding = (name, type) => {
    const matches = bindings.filter(b => b.name === name);
    if (matches.length !== 1 || matches[0].type !== type) {
      throw new Error(`Existing Worker binding ${name} (${type}) is missing or ambiguous. No settings were written.`);
    }
    return matches[0];
  };
  const db = requireBinding('DB', 'd1');
  const releases = requireBinding('RELEASES', 'r2_bucket');
  const documents = requireBinding('SERVICE_DOCS', 'r2_bucket');
  for (const name of ['SERVER_KEY', 'CLIENT_KEY']) requireBinding(name, 'secret_text');
  // Older installations can have an empty pepper. Never introduce or rotate it.
  if (bindings.some(b => b.name === 'PIN_PEPPER')) requireBinding('PIN_PEPPER', 'secret_text');
  if (!uuid.test(db.id || '')) throw new Error('The existing DB binding has no valid D1 ID. No settings were written.');
  for (const b of [releases, documents]) {
    if (!bucketName.test(b.bucket_name || '') || (b.jurisdiction && b.jurisdiction !== 'default')) {
      throw new Error(`Existing bucket ${b.name} needs manual configuration. No settings were written.`);
    }
  }
  if (releases.bucket_name === documents.bucket_name) throw new Error('Release and invoice storage must use distinct existing buckets.');
  return {
    FLEET_D1_DATABASE_ID: db.id,
    FLEET_WORKER_URL: WORKER_URL,
    FLEET_WORKER_NAME: WORKER_NAME,
    FLEET_RELEASES_BUCKET: releases.bucket_name,
    FLEET_DOCUMENTS_BUCKET: documents.bucket_name,
  };
}

export function readPrivateKeys(root) {
  const privatePath = path.join(root, 'private');
  let p12, text, server;
  try {
    p12 = fs.readFileSync(path.join(privatePath, 'signing/fleet-control-release.p12'));
    text = fs.readFileSync(path.join(privatePath, 'PRIVATE_SETUP_KEYS.txt'), 'utf8');
    server = parseJson(fs.readFileSync(path.join(privatePath, 'server-secrets.json'), 'utf8'), 'Invalid private server configuration.');
  } catch { throw new Error('Extract the original private recovery ZIP directly into the private folder beside Setup_OTA_Secrets.ps1.'); }
  if (createHash('sha256').update(p12).digest('hex') !== ORIGINAL_KEYSTORE_SHA256) {
    throw new Error('This is not the original signing container. Use Fleet_Control_Private_Recovery_Keys.zip.');
  }
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(ALIAS|STORE_PASSWORD|KEY_PASSWORD)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    if (Object.hasOwn(fields, match[1])) throw new Error('Duplicate entry in private signing configuration.');
    fields[match[1]] = match[2];
  }
  if (['ALIAS', 'STORE_PASSWORD', 'KEY_PASSWORD'].some(k => !fields[k]) || typeof server.serverKey !== 'string' || server.serverKey.length < 16) {
    throw new Error('The original private recovery files are incomplete.');
  }
  return {
    FLEET_KEYSTORE_BASE64: p12.toString('base64'),
    FLEET_STORE_PASSWORD: fields.STORE_PASSWORD,
    FLEET_KEY_PASSWORD: fields.KEY_PASSWORD,
    FLEET_KEY_ALIAS: fields.ALIAS,
    FLEET_SERVER_KEY: server.serverKey,
  };
}

export async function setupOta({ root, input, gh = invokeGh, cf = readCloudflare, keys = readPrivateKeys, log = console.log }) {
  if (!/^[0-9a-f]{32}$/i.test(input?.accountId || '') || typeof input.apiToken !== 'string' || input.apiToken.length < 20 || /\s/.test(input.apiToken)) {
    throw new Error('A valid Cloudflare Account ID and API token are required.');
  }
  const repo = parseJson(gh(['repo', 'view', REPOSITORY, '--json', 'nameWithOwner,isPrivate,viewerPermission']), 'Cannot verify the GitHub repository.');
  if (repo.nameWithOwner !== REPOSITORY || repo.isPrivate !== true || repo.viewerPermission !== 'ADMIN') {
    throw new Error('Sign in with a GitHub account that administers the private pavlos-argyris/fleet-control repository.');
  }
  const existingSecrets = parseJson(gh(['secret', 'list', '--repo', REPOSITORY, '--app', 'actions', '--json', 'name']), 'Cannot list repository secret names.');
  if (!Array.isArray(existingSecrets)) throw new Error('Cannot verify repository secret names.');
  const secretValues = keys(root);
  log('Checking existing Cloudflare Worker, database bindings and bucket bindings...');
  const settings = await cf(input.accountId, input.apiToken, `workers/scripts/${WORKER_NAME}/settings`);
  const subdomain = await cf(input.accountId, input.apiToken, 'workers/subdomain');
  const availability = await cf(input.accountId, input.apiToken, `workers/scripts/${WORKER_NAME}/subdomain`);
  const variables = productionVariables(settings, subdomain, availability);
  const tokenPath = path.join(root, 'private', 'fleet-release-token.txt');
  const hasReleaseToken = existingSecrets.some(s => s.name === 'FLEET_RELEASE_TOKEN');
  if (!hasReleaseToken) {
    let releaseToken;
    if (fs.existsSync(tokenPath)) {
      releaseToken = fs.readFileSync(tokenPath, 'utf8').trim();
      if (!/^[0-9a-f]{64}$/i.test(releaseToken)) throw new Error('The private release token file is invalid. Keep it for review; no secrets were written.');
    } else {
      releaseToken = randomBytes(32).toString('hex');
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      fs.writeFileSync(tokenPath, releaseToken + '\n', { mode: 0o600, flag: 'wx' });
    }
    secretValues.FLEET_RELEASE_TOKEN = releaseToken;
  }
  Object.assign(secretValues, { CLOUDFLARE_API_TOKEN: input.apiToken, CLOUDFLARE_ACCOUNT_ID: input.accountId });
  for (const [name, value] of Object.entries(secretValues)) {
    gh(['secret', 'set', name, '--repo', REPOSITORY, '--app', 'actions'], value);
    log(`Configured secret: ${name}`);
  }
  if (hasReleaseToken) log('Kept the existing FLEET_RELEASE_TOKEN unchanged.');
  for (const [name, value] of Object.entries(variables)) {
    gh(['variable', 'set', name, '--repo', REPOSITORY], value);
    log(`Configured variable: ${name}`);
  }
  const finalSecrets = parseJson(gh(['secret', 'list', '--repo', REPOSITORY, '--app', 'actions', '--json', 'name']), 'Cannot verify secret names after setup.');
  const finalVariables = parseJson(gh(['variable', 'list', '--repo', REPOSITORY, '--json', 'name,value']), 'Cannot verify variables after setup.');
  const requiredSecrets = [...Object.keys(secretValues), 'FLEET_RELEASE_TOKEN'];
  if (!requiredSecrets.every(name => finalSecrets.some(s => s.name === name)) ||
      !Object.entries(variables).every(([name, value]) => finalVariables.some(v => v.name === name && v.value === value))) {
    throw new Error('Some GitHub settings were not saved. Retry this setup to complete the remaining settings.');
  }
  log('OTA configuration complete: all 8 secret names and all 5 variables verified.');
  log(`Existing Worker: ${WORKER_URL}; releases bucket: ${variables.FLEET_RELEASES_BUCKET}; invoice bucket: ${variables.FLEET_DOCUMENTS_BUCKET}.`);
  if (!hasReleaseToken) log('Keep private/fleet-release-token.txt with your original private recovery files.');
  log('No Cloudflare changes or production updates were published. Take an external Server backup before Publish Fleet update.');
  return { variables, requiredSecrets: [...new Set(requiredSecrets)] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Install Node.js 22 or later.');
    let body = '';
    for await (const chunk of process.stdin) {
      body += chunk;
      if (Buffer.byteLength(body) > 16384) throw new Error('Invalid setup input.');
    }
    const input = parseJson(body.replace(/^\uFEFF/, ''), 'Start this tool with Setup_OTA_Secrets.ps1.');
    await setupOta({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), input });
  } catch (error) {
    // Output our controlled messages only; never dump API responses or CLI stderr.
    console.error(error.message);
    process.exitCode = 1;
  }
}
