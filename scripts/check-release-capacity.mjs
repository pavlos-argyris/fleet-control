import fs from 'node:fs';
import path from 'node:path';
import { releaseCapacityError } from '../cloudflare-worker/src/release-limits.js';
function walk(folder, prefix = '') {
  return fs.readdirSync(folder).sort().flatMap(name => {
    const full = path.join(folder, name), relative = prefix + name;
    return fs.statSync(full).isDirectory() ? walk(full, relative + '/') : [{ path: relative, sha256: '0'.repeat(64), sizeBytes: fs.statSync(full).size }];
  });
}
const files = walk('cloudflare-worker/public');
// Reserve more than the APK, notes and release metadata currently require.
const error = releaseCapacityError({ metadataReserve: 'x'.repeat(8192), web: { files } });
if (error) throw new Error(error);
console.log(`PASS: release capacity checked before upload (${files.length} Web files).`);
