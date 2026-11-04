import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectAndroidManifest} from './android-manifest-audit.mjs';
for(const p of ['server-android/AndroidManifest.xml','client-android/AndroidManifest.xml']){
 const x=inspectAndroidManifest(fs.readFileSync(p,'utf8'));
 assert.equal(x.hardening.allowBackupDisabled,true);
 assert.equal(x.hardening.cleartextTrafficDisabled,true);
 assert(Number(x.hardening.targetSdkVersion)>=34);
 assert(x.installerPermissions.includes('android.permission.REQUEST_INSTALL_PACKAGES'));
 assert(x.exportedComponents.some(c=>c.type==='activity'&&c.name==='.MainActivity'));
 assert.equal(x.verdict.startsWith('undetermined'),true);
}
assert.throws(()=>inspectAndroidManifest('<manifest/>'),/Missing application/);
console.log('PASS Android manifests security inventory: explicit backup/cleartext hardening, installer permissions reviewed; no Play Protect verdict assumed.');
