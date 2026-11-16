import fs from 'node:fs';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
import {releaseCapacityError} from '../cloudflare-worker/src/release-limits.js';
import {DIRECT_ORIGIN} from '../cloudflare-worker/src/redirect.js';
const manifest=JSON.parse(fs.readFileSync('dist/release-manifest.json','utf8')),config=JSON.parse(fs.readFileSync('release-config.json','utf8'));
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(config.backendMode!=='direct'||manifest.publication?.mode!=='direct-github'||manifest.publication.directOrigin!==DIRECT_ORIGIN||manifest.sourceCommit!==commit||execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())throw Error('Publish only the verified saved Direct source');
const capacity=releaseCapacityError(manifest);if(capacity)throw Error(capacity);
const files=[...['client','server'].map(kind=>({...manifest[kind],local:'dist/'+manifest[kind].file})),...manifest.web.files.map(file=>({...file,local:'cloudflare-worker/public/'+file.path}))];
for(const file of files){const bytes=fs.readFileSync(file.local);if(bytes.length!==file.sizeBytes||crypto.createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('Prepared artifact changed: '+file.local);}
// GitHub release creation and the minimal redirect deploy are workflow steps.
// No cloud upload/activation/token/D1/R2/DO capability exists in this script.
console.log(JSON.stringify({dryRun:process.argv.includes('--dry-run'),verified:true,mode:'direct-github',sourceCommit:commit,releaseId:manifest.releaseId,files:files.length,cloudBusinessActivation:false,installationRequired:true}));
