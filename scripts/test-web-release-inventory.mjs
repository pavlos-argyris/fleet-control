import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const files=JSON.parse(execFileSync('python3',['scripts/web_release_files.py'],{encoding:'utf8'})),config=JSON.parse(fs.readFileSync('release-config.json','utf8'));
assert.ok(files.length<512);assert.equal(files.length,new Set(files).size);
for(const version of [config.web.version,...config.web.retainedAssetVersions])assert.ok(files.includes('assets/v'+version+'/app.js'));
const older='assets/v5.49.0/app.js';assert.ok(fs.existsSync('cloudflare-worker/public/'+older),'Historical source/static binding is preserved');assert.ok(!files.includes(older),'Historical snapshots do not exhaust each OTA manifest');
const publicRoot=path.resolve('cloudflare-worker/public');for(const relative of files){assert.ok(path.resolve(publicRoot,relative).startsWith(publicRoot+path.sep));assert.ok(fs.statSync(path.join(publicRoot,relative)).isFile());}
const temp=path.resolve('verification/web-inventory-fixture.zip');fs.mkdirSync(path.dirname(temp),{recursive:true});try{execFileSync('python3',['scripts/package-web.py',temp]);const zipped=JSON.parse(execFileSync('python3',['-c','import sys,json,zipfile;print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))',temp],{encoding:'utf8'}));assert.deepEqual(zipped,files,'Portable Web ZIP and OTA manifest use the same full inventory');}finally{fs.rmSync(temp,{force:true});}
// Fail before upload if a retained/current directory or referenced asset is absent.
execFileSync('python3',['-c',`import sys,tempfile,json
from pathlib import Path
sys.path.insert(0,'scripts')
from web_release_files import release_files
with tempfile.TemporaryDirectory() as temp:
 root=Path(temp);(root/'assets/v1.0.0').mkdir(parents=True)
 (root/'index.html').write_text('<script src="./assets/v1.0.0/missing.js"></script>');(root/'portal.html').write_text('')
 for cfg in [{'web':{'version':'1.0.0','retainedAssetVersions':[]}}, {'web':{'version':'2.0.0','retainedAssetVersions':[]}}]:
  try:release_files(root,cfg)
  except ValueError:pass
  else:raise AssertionError('Incomplete inventory accepted')
`]);
console.log('PASS bounded OTA inventory and exact Web ZIP: complete current/previous assets, unchanged historical static sources, missing-reference/directory guards and original 512-file limit.');
