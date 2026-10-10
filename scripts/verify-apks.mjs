import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const config = JSON.parse(fs.readFileSync('release-config.json', 'utf8'));
const root = process.env.FLEET_ANDROID_TOOLCHAIN_ROOT || path.resolve('.android-toolchain');
const signer = path.join(root, 'usr/share/java/apksigner-31.0.2.jar');
const expected = fs.readFileSync('signing-certificate.sha256', 'utf8').trim();
const libs = ['usr/lib/x86_64-linux-gnu/android', 'usr/lib', 'usr/lib/x86_64-linux-gnu', 'lib/x86_64-linux-gnu'].map(p => path.join(root, p)).join(':');
for (const kind of ['client', 'server']) {
  const value = config[kind], file = `dist/Fleet_Control_${kind === 'client' ? 'Client' : 'Server'}_v${value.version}.apk`;
  const cert = execFileSync('java', ['-jar', signer, 'verify', '--print-certs', file], { encoding: 'utf8' });
  if (cert.match(/certificate SHA-256 digest: ([a-f0-9]+)/)?.[1] !== expected) throw new Error(`Wrong signing certificate: ${kind}`);
  const info = execFileSync(path.join(root, 'usr/lib/android-sdk/build-tools/debian/aapt'), ['dump', 'badging', file], { encoding: 'utf8', env: { ...process.env, LD_LIBRARY_PATH: libs } });
  const match = info.match(/package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/);
  if (!match || match[1] !== value.packageName || Number(match[2]) !== value.versionCode || match[3] !== value.version) throw new Error(`Wrong APK package/version: ${kind}`);
  console.log(`Verified ${kind}: ${value.version}, code ${value.versionCode}, original signing certificate.`);
}
// Verify the packaged models and ARM64 alignment, not only the intermediate AAR.
execFileSync('python3', ['-c', `
import hashlib,json,struct,zipfile
lock=json.load(open('android-build-support/invoice-dependencies.lock.json'))
with zipfile.ZipFile('dist/Fleet_Control_Server_v${config.server.version}.apk') as z:
 for item in lock['items']:
  if item['file'].endswith('.traineddata'):
   data=z.read('assets/ocr/tessdata/'+item['file']);assert hashlib.sha256(data).hexdigest()==item['sha256']
 native=[n for n in z.namelist() if n.startswith('lib/arm64-v8a/') and n.endswith('.so')];assert len(native)==4
 for name in native:
  data=z.read(name);assert data[:5]==b'\\x7fELF\\x02';offset=struct.unpack_from('<Q',data,32)[0];size,count=struct.unpack_from('<HH',data,54)
  for i in range(count):
   header=struct.unpack_from('<IIQQQQQQ',data,offset+i*size)
   if header[0]==1:assert header[7]>=16384,name
 assert 'assets/invoice-reader-notices/PDFBOX-LICENSE.txt' in z.namelist()
print('Verified packaged Greek/English model hashes, ARM64 native libraries/16 KB alignment and notices.')
`], { stdio: 'inherit' });
