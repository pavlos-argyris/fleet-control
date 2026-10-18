import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { releaseCapacityError } from '../cloudflare-worker/src/release-limits.js';
const dryRun = process.argv.includes('--dry-run');
const manifest = JSON.parse(fs.readFileSync('dist/release-manifest.json', 'utf8'));
const capacityError = releaseCapacityError(manifest);
if (capacityError) throw new Error(capacityError);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (manifest.sourceCommit !== commit || execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) throw new Error('Publish only the saved, verified source commit.');
const files = [
  ...['client', 'server'].map(kind => ({ ...manifest[kind], local: `dist/${manifest[kind].file}`, remote: `${kind}.apk` })),
  ...manifest.web.files.map(file => ({ ...file, local: `cloudflare-worker/public/${file.path}`, remote: `web/${file.path}` }))
];
for (const file of files) {
  const bytes = fs.readFileSync(file.local);
  if (bytes.length !== file.sizeBytes || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`File changed after verification: ${file.local}`);
}
if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, files: files.length, releaseId: manifest.releaseId, sourceCommit: commit }));
} else {
  const base = new URL(process.env.FLEET_WORKER_URL || '');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Set FLEET_WORKER_URL to the HTTPS origin of your Worker.');
  const token = process.env.FLEET_RELEASE_TOKEN;
  if (!token || token.length < 32) throw new Error('FLEET_RELEASE_TOKEN is required.');
  const request = async (path, method, body) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch(new URL(path, base), { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': method === 'POST' ? 'application/json' : 'application/octet-stream' }, body, redirect: 'error', signal: AbortSignal.timeout(90000) });
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < 3) { await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue; }
          throw new Error(`Publish failed (${response.status}) for ${path}. The release was not confirmed.`);
        }
        return await response.json();
      } catch (error) { if (attempt === 3 || String(error.message).startsWith('Publish failed')) throw error; await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); }
    }
  };
  for (const file of files) {
    const result = await request(`/api/deploy/releases/${manifest.releaseId}/${file.remote}`, 'PUT', fs.readFileSync(file.local));
    if (result.sha256 !== file.sha256 || result.sizeBytes !== file.sizeBytes) throw new Error(`Upload verification failed: ${file.remote}`);
  }
  const result = await request('/api/deploy/releases/activate', 'POST', JSON.stringify(manifest));
  if (!result.activated || result.sourceCommit !== manifest.sourceCommit) throw new Error('Activation was not confirmed');
  console.log(JSON.stringify(result));
}
