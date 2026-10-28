import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { releaseCapacityError } from '../cloudflare-worker/src/release-limits.js';
const config = JSON.parse(fs.readFileSync('release-config.json', 'utf8'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('A saved Git commit is required');
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) throw new Error('Commit all source changes before creating the release.');
fs.mkdirSync('dist', { recursive: true });
const manifest = { releaseId: `v${config.releaseVersion}-${commit.slice(0, 12)}`, sourceCommit: commit, notes: config.notes };
const checksum = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
for (const kind of ['client', 'server']) {
  const xml = fs.readFileSync(`${kind}-android/AndroidManifest.xml`, 'utf8');
  const expected = config[kind];
  if (xml.match(/android:versionName="([^"]+)"/)[1] !== expected.version || Number(xml.match(/android:versionCode="(\d+)"/)[1]) !== expected.versionCode || xml.match(/package="([^"]+)"/)[1] !== expected.packageName) throw new Error(`Version configuration differs for ${kind}`);
  const file = `Fleet_Control_${kind === 'client' ? 'Client' : 'Server'}_v${expected.version}.apk`;
  const bytes = fs.readFileSync(path.join('dist', file));
  manifest[kind] = { ...expected, file, sha256: checksum(bytes), sizeBytes: bytes.length };
}
function walk(folder, prefix = '') {
  const result = [];
  for (const name of fs.readdirSync(folder).sort()) {
    const relative = prefix + name, full = path.join(folder, name);
    if (fs.statSync(full).isDirectory()) result.push(...walk(full, relative + '/'));
    else { const bytes = fs.readFileSync(full); result.push({ path: relative, sha256: checksum(bytes), sizeBytes: bytes.length }); }
  }
  return result;
}
manifest.web = { version: config.web.version, files: JSON.parse(execFileSync('python3',['scripts/web_release_files.py'],{encoding:'utf8'})).map(name=>{const bytes=fs.readFileSync(path.join('cloudflare-worker/public',name));return {path:name,sha256:checksum(bytes),sizeBytes:bytes.length};}) };
manifest.worker = config.worker;
const capacityError = releaseCapacityError(manifest);
if (capacityError) throw new Error(capacityError);
fs.writeFileSync('dist/release-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
execFileSync('git', ['archive', '--format=zip', '-o', `dist/Fleet_Control_Source_v${config.releaseVersion}.zip`, commit]);
execFileSync('git', ['archive', '--format=zip', '-o', `dist/Fleet_Control_Worker_v${config.worker.version}.zip`, commit, 'cloudflare-worker', 'scripts/prepare-pdf-viewer.py', 'vendor/pdf-viewer-6.4.299.zip', 'third-party/PDFJS_LICENSE.txt', 'release-config.json', 'docs/ORDEXA_INTEGRATION_5.52.0_GR.md', 'docs/SERVICE_UPDATE_5.43.0_GR.md', 'docs/FOLLOWUP_UPDATE_5.44.0_GR.md', 'docs/UI_NAVIGATION_UPDATE_5.45.0_GR.md', 'docs/OPERATIONS_UPDATE_5.46.0_GR.md', 'docs/SERVER_OFFLOAD_5.47.0_GR.md', 'docs/REQUEST_REDUCTION_5.48.0_GR.md', 'docs/NAVIGATION_MOTION_5.49.0_GR.md', 'docs/BOTTOM_NAVIGATION_5.49.1_GR.md', 'docs/CARD_MOTION_FIX_5.49.2_GR.md', 'docs/RETURN_SURFACE_5.49.3_GR.md', 'docs/SMOOTH_RETURN_5.49.4_GR.md', 'docs/SHARED_SLIDE_5.49.5_GR.md', 'docs/NEXT_SERVICE_NOTES_5.50.0_GR.md', 'docs/NEXT_SERVICE_NOTES_5.50.1_GR.md', 'docs/UI_SYSTEM_5.51.0_GR.md', 'docs/FLEET_LIST_LAYOUT_5.51.1_GR.md', 'docs/INVOICE_FILTER_UI_5.51.2_GR.md', 'docs/INVOICE_FAILURES_5.51.3_GR.md', 'docs/INVOICE_REVIEW_5.51.4_GR.md', 'scripts/web_release_files.py']);
execFileSync('python3', ['scripts/package-web.py', `dist/Fleet_Control_Web_Assets_v${config.web.version}.zip`]);
execFileSync('python3', ['scripts/package-invoice-dependencies.py', `dist/Fleet_Invoice_Build_Inputs_v${config.releaseVersion}.zip`]);
const sums = walk('dist').filter(f => f.path !== 'SHA256SUMS.txt').map(f => `${f.sha256}  ${f.path}`).join('\n') + '\n';
fs.writeFileSync('dist/SHA256SUMS.txt', sums);
console.log(JSON.stringify({ prepared: true, sourceCommit: commit, releaseId: manifest.releaseId, versions: config }));
