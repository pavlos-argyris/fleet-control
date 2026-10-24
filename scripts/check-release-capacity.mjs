import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import { releaseCapacityError } from '../cloudflare-worker/src/release-limits.js';
const files=JSON.parse(execFileSync('python3',['scripts/web_release_files.py'],{encoding:'utf8'})).map(name=>({path:name,sha256:'0'.repeat(64),sizeBytes:fs.statSync(path.join('cloudflare-worker/public',name)).size}));
// Reserve more than the APK, notes and release metadata currently require.
const error = releaseCapacityError({ metadataReserve: 'x'.repeat(8192), web: { files } });
if (error) throw new Error(error);
console.log(`PASS: release capacity checked before upload (${files.length} Web files).`);
