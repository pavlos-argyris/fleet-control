import assert from 'node:assert/strict';
import {fetchReleaseReference} from './fetch-release-reference.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {parseCompiledManifest, certificateDigests, assertCandidate, compareApks} from './apk-audit-core.mjs';

const args = process.argv.slice(2);
assert.ok(args.every(a => ['--production','--local-only'].includes(a)), 'Unknown APK audit option');
const production = args.includes('--production'), localOnly = args.includes('--local-only');
const config = JSON.parse(fs.readFileSync('release-config.json','utf8'));
const references = JSON.parse(fs.readFileSync('android-build-support/apk-audit-references.json','utf8'));
const expectedCert = fs.readFileSync('signing-certificate.sha256','utf8').trim().toLowerCase();
assert.match(expectedCert, /^[a-f0-9]{64}$/);
const directory = '.build/verification/apk-security', cache = '.build/apk-audit';
fs.mkdirSync(directory,{recursive:true}); fs.mkdirSync(cache,{recursive:true});
const root = process.env.FLEET_ANDROID_TOOLCHAIN_ROOT || path.resolve('.android-toolchain');
const aapt = path.join(root,'usr/lib/android-sdk/build-tools/debian/aapt');
const signer = path.join(root,'usr/share/java/apksigner-31.0.2.jar');
const libraries = ['usr/lib/x86_64-linux-gnu/android','usr/lib','usr/lib/x86_64-linux-gnu','lib/x86_64-linux-gnu'].map(p => path.join(root,p)).join(':');
const shaFile = async file => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};
async function historicalFile(reference) {
  assert.match(reference.sha256,/^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(reference.size) && reference.size > 0 && reference.size < 128*1024*1024);
  assert.equal(reference.url,'https://github.com/' + references.repository + '/releases/download/' + reference.tag + '/' + reference.fileName);
  assert.equal(path.basename(reference.fileName),reference.fileName);
  const file = path.join(cache,reference.fileName);
  if (fs.existsSync(file) && fs.statSync(file).size === reference.size && await shaFile(file) === reference.sha256) return file;
  const temporary = file + '.partial'; let size = 0;
  const response = await fetchReleaseReference(reference.url,{repository:references.repository,assetId:reference.assetId});
  assert.ok(response.ok && response.body,'Historical release download failed: ' + reference.tag + ' HTTP ' + response.status);
  if (response.headers.has('content-length')) assert.equal(Number(response.headers.get('content-length')),reference.size,'Historical release size header');
  const bound = new Transform({transform(chunk,encoding,done) {
    size += chunk.length;
    done(size > reference.size ? new Error('Historical release exceeds pinned length') : null,chunk);
  }});
  try {
    await pipeline(Readable.fromWeb(response.body),bound,fs.createWriteStream(temporary));
    assert.equal(size,reference.size,'Historical release byte length');
    assert.equal(await shaFile(temporary),reference.sha256,'Historical release SHA-256');
    fs.renameSync(temporary,file);
  } catch(error) { fs.rmSync(temporary,{force:true}); throw error; }
  return file;
}
const zipInspection = [
 "import sys,zipfile,hashlib,json",
 "p=sys.argv[1]",
 "with open(p,'rb') as f:",
 " if f.read(4)!=b'PK\\x03\\x04': raise ValueError('Nonstandard APK ZIP header')",
 "with zipfile.ZipFile(p) as z:",
 " infos=z.infolist()",
 " if len(infos)>50000 or len({i.filename for i in infos})!=len(infos): raise ValueError('Duplicate or excessive ZIP entries')",
 " if sum(i.file_size for i in infos)>1024*1024*1024: raise ValueError('Excessive APK expanded size')",
 " if z.testzip() is not None: raise ValueError('APK ZIP CRC failed')",
 " def digest(i):",
 "  h=hashlib.sha256()",
 "  with z.open(i) as f:",
 "   while True:",
 "    c=f.read(1024*1024)",
 "    if not c: break",
 "    h.update(c)",
 "  return {'name':i.filename,'bytes':i.file_size,'sha256':h.hexdigest()}",
 " native=[digest(i) for i in infos if i.filename.startswith('lib/') and i.filename.endswith('.so')]",
 " dex=[digest(i) for i in infos if i.filename.endswith('.dex') and '/' not in i.filename]",
 " models=[digest(i) for i in infos if i.filename.endswith('.traineddata')]",
 " print(json.dumps({'entries':len(infos),'nativeAbis':sorted({i['name'].split('/')[1] for i in native}),'nativeLibraries':native,'dex':dex,'ocrModels':models}))"
].join('\n');
function command(binary,args,options = {}) {
  try { return execFileSync(binary,args,{encoding:'utf8',maxBuffer:8*1024*1024,timeout:90000,...options}); }
  catch(error) { throw new Error(path.basename(binary) + ' rejected APK inspection (exit ' + (error.status ?? error.code) + ')'); }
}
async function inspect(file,kind,label,role) {
  assert.ok(fs.statSync(file).size < 128*1024*1024,'APK size bound');
  const verified = command('java',['-jar',signer,'verify','--verbose','--print-certs',file]);
  const certificates = certificateDigests(verified);
  assert.ok(certificates.length,'apksigner did not report a certificate');
  const compiled = command(aapt,['dump','xmltree',file,'AndroidManifest.xml'],{env:{...process.env,LD_LIBRARY_PATH:libraries}});
  const manifest = parseCompiledManifest(compiled);
  const archive = JSON.parse(command('python3',['-c',zipInspection,file]));
  const record = {kind,label,role,fileName:path.basename(file),bytes:fs.statSync(file).size,sha256:await shaFile(file),
    signing:{verified:true,certificates,originalCertificate:JSON.stringify(certificates) === JSON.stringify([expectedCert]),
      schemes:Object.fromEntries([...verified.matchAll(/Verified using v([\d.]+) scheme[^:\n]*:\s*(true|false)/g)].map(m => ['v'+m[1],m[2] === 'true']))},
    manifest,archive};
  fs.writeFileSync(path.join(directory,kind + '-' + label.replace(/[^a-zA-Z0-9.-]/g,'_') + '-manifest.txt'),compiled);
  return record;
}
const records = [], comparisons = [];
if (!localOnly) for (const ref of references.references) {
  const record = await inspect(await historicalFile(ref),ref.kind,ref.tag,ref.role);
  assert.equal(record.bytes,ref.size); assert.equal(record.sha256,ref.sha256);
  assert.equal(record.manifest.packageName,config[ref.kind].packageName,'Historical package identity');
  if (ref.role === 'latest') assert.deepEqual(record.signing.certificates,[expectedCert],'Latest published original signing identity');
  record.pinnedAssetId = ref.assetId; records.push(record);
}
for (const kind of ['client','server']) {
  const file = 'dist/Fleet_Control_' + (kind === 'client' ? 'Client' : 'Server') + '_v' + config[kind].version + '.apk';
  const record = await inspect(file,kind,'candidate-' + config[kind].version,'candidate');
  assertCandidate(record,config[kind],expectedCert,production,fs.readFileSync(kind + '-android/AndroidManifest.xml','utf8'));
  if (!production) assert.equal(record.signing.originalCertificate,false,'PR CI must use a disposable test certificate');
  for (const before of records.filter(r => r.kind === kind)) {
    const comparison = compareApks(before,record); comparisons.push({kind,...comparison});
    if (before.role === 'latest') {
      assert.deepEqual(comparison.permissionsAdded,[],'No new permission is authorized by this update');
      assert.deepEqual(comparison.permissionsRemoved,[],'Existing update permissions must be preserved');
      assert.ok(record.manifest.versionCode > before.manifest.versionCode,'Candidate code must upgrade the installed release');
    }
  }
  records.push(record);
}
const report = {schemaVersion:1,sourceCommit:process.env.GITHUB_SHA || null,releaseVersion:config.releaseVersion,
  candidateSigningMode:production?'original-production':'disposable-ci-test',
  historicalComparison:localOnly?'skipped-local-only':'verified-pinned-release-bytes',
  playProtect:{status:'not-observed',physicalDevice:false,googleClassification:null,
    explanation:'Static APK/signature comparison is not a malware verdict or Google clearance.'},
  originalCertificateSha256:expectedCert,records,comparisons};
fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
const rows = records.map(r => '| '+[r.kind,r.label,r.bytes,r.manifest.versionCode,r.signing.originalCertificate?'original':'different/test',
  r.manifest.permissions.length,r.manifest.components.filter(c=>c.exported===true).length,r.archive.dex.length,r.archive.nativeAbis.join(',')||'none'].join(' | ')+' |');
const markdown = [
 '# Actual APK artifact audit','',
 'Candidate signatures: **' + report.candidateSigningMode + '**. Historical comparison: **' + report.historicalComparison + '**.',
 'No physical-device result or Google Play Protect classification was observed. These checks do not establish absence of malware.','',
 '| App | Artifact | Bytes | Code | Certificate | Permissions | Explicit exported components | DEX files | Native ABIs |',
 '|---|---|---:|---:|---|---:|---:|---:|---|',...rows,'',
 'The JSON includes exact SHA-256, verified certificate digests/signature schemes, compiled flags/components, permission diffs, native library/DEX/OCR model hashes.',
 'Absent Android flags remain null; no default behavior is asserted. Original production signing is mandatory in --production mode.','',
 'Official warning categories and appeal guidance: https://developers.google.com/android/play-protect/warning-dev-guidance',
 'A real warning must be classified by its exact wording before choosing a fix or appeal. No appeal was submitted.',''
].join('\n');
fs.writeFileSync(path.join(directory,'report.md'),markdown);
console.log(markdown);
console.log('PASS actual APK bytes, signatures, compiled manifest, ZIP integrity and historical comparison. Play Protect/device status remains unobserved.');
