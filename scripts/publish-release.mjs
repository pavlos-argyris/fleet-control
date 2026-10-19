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
async function uploadFiles(files, request, report = console.log) {
  let completed = 0, cursor = 0, failure = null;
  const upload = async file => {
    const result = await request(`/api/deploy/releases/${manifest.releaseId}/${file.remote}`, 'PUT', fs.readFileSync(file.local));
    if (result.sha256 !== file.sha256 || result.sizeBytes !== file.sizeBytes) throw new Error(`Upload verification failed: ${file.remote}`);
    completed++;
    if (completed <= 2 || completed % 10 === 0 || completed === files.length) report(`Verified upload ${completed}/${files.length}: ${file.remote}`);
  };
  // Large APK bodies remain sequential to bound Worker memory. Small Web files
  // use three connections; no activation occurs until all workers have ended.
  for (const file of files.filter(f => !f.remote.startsWith('web/'))) await upload(file);
  const web = files.filter(f => f.remote.startsWith('web/'));
  const workers = Array.from({ length: Math.min(3, web.length) }, async () => {
    while (!failure && cursor < web.length) {
      const file = web[cursor++];
      try { await upload(file); } catch (error) { failure ||= error; }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
}
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
        const response = await fetch(new URL(path, base), { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': method === 'POST' ? 'application/json' : 'application/octet-stream' }, body, redirect: 'error', signal: AbortSignal.timeout(method === 'POST' ? 180000 : 90000) });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if ((response.status === 429 || response.status >= 500) && attempt < 3) { console.log(`Retry ${attempt + 2}/4 ${method} ${path}: HTTP ${response.status}`);await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); continue; }
          throw new Error(`Publish failed (${response.status}) for ${path}. The release was not confirmed.`);
        }
        return await response.json();
      } catch (error) { if (attempt === 3 || String(error.message).startsWith('Publish failed')) throw new Error(`${method} ${path}: ${error.message}`,{cause:error}); console.log(`Retry ${attempt + 2}/4 ${method} ${path}: ${error.name || 'network failure'}`);await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); }
    }
  };
  await uploadFiles(files, request);
  console.log(`Verified all ${files.length} uploads. Checking objects and activating release ${manifest.releaseId}.`);
  const result = await request('/api/deploy/releases/activate', 'POST', JSON.stringify(manifest));
  if (!result.activated || result.sourceCommit !== manifest.sourceCommit) throw new Error('Activation was not confirmed');
  console.log(JSON.stringify(result));
}
