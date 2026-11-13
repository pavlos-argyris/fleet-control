import assert from 'node:assert/strict';
import {parseCompiledManifest, certificateDigests, assertCandidate, compareApks, assertPermissionChanges} from './apk-audit-core.mjs';

const xml = [
 'E: manifest (line=1)', '  A: package="test.fleet" (Raw: "test.fleet")',
 '  A: android:versionCode(0x0101021b)=(type 0x10)0x63',
 '  A: android:versionName(0x0101021c)="5.61.0" (Raw: "5.61.0")',
 '  E: uses-sdk (line=2)', '    A: android:minSdkVersion(0x0101020c)=(type 0x10)0x17',
 '    A: android:targetSdkVersion(0x01010270)=(type 0x10)0x22',
 '  E: uses-permission (line=3)', '    A: android:name(0x01010003)="android.permission.INTERNET"',
 '  E: application (line=4)', '    A: android:allowBackup(0x01010280)=(type 0x12)0x0',
 '    A: android:usesCleartextTraffic(0x010104ec)=(type 0x12)0x0',
 '    E: activity (line=5)', '      A: android:name(0x01010003)=".MainActivity"',
 '      A: android:exported(0x01010010)=(type 0x12)0xffffffff',
 '      E: intent-filter (line=6)', '        E: action (line=7)', '          A: android:name(0x01010003)="android.intent.action.MAIN"',
 '    E: receiver (line=8)', '      A: android:name(0x01010003)=".BootReceiver"',
 '      A: android:exported(0x01010010)=(type 0x12)0x0',
 '      E: intent-filter (line=9)', '        E: action (line=10)', '          A: android:name(0x01010003)="android.intent.action.BOOT_COMPLETED"'
].join('\n');
const manifest = parseCompiledManifest(xml), cert = 'a'.repeat(64);
assert.equal(manifest.minSdk, 23); assert.equal(manifest.targetSdk, 34);
assert.equal(manifest.application.debuggable, null, 'Absent flag stays unknown, not fabricated false');
assert.deepEqual(manifest.components.find(c => c.name === '.BootReceiver').actions, ['android.intent.action.BOOT_COMPLETED']);
assert.deepEqual(manifest.components.find(c => c.name === '.MainActivity').actions, ['android.intent.action.MAIN']);
assert.deepEqual(certificateDigests('Signer #1 certificate SHA-256 digest: ' + cert + '\nSigner #1 public key SHA-256 digest: ' + 'b'.repeat(64)), [cert]);
const record = {label:'candidate', bytes:1024, manifest, signing:{certificates:[cert]}, archive:{nativeAbis:[],dex:[]}};
const config = {packageName:'test.fleet', version:'5.61.0',versionCode:99};
const source = '<uses-permission android:name="android.permission.INTERNET"/><uses-sdk android:minSdkVersion="23" android:targetSdkVersion="34"/>';
assertCandidate(record, config, cert, true, source);
assert.throws(() => assertCandidate({...record,bytes:192*1024*1024+1}, config, cert, false, source), /OTA/);
assertCandidate({...record,bytes:100*1024*1024},config,cert,false,source);
const changed = mutate => { const r = structuredClone(record); mutate(r); return r; };
assert.throws(() => assertCandidate(record, config, 'b'.repeat(64), true, source), /Original/);
assert.throws(() => assertCandidate(changed(r => r.manifest.components[1].exported = true), config, cert, false, source), /exported/);
assert.throws(() => assertCandidate(changed(r => r.manifest.application.usesCleartextTraffic = null), config, cert, false, source), /cleartext/);
assert.throws(() => assertCandidate(changed(r => r.manifest.permissions.push('android.permission.READ_SMS')), config, cert, false, source), /permissions/);
assert.throws(() => assertCandidate(changed(r => r.manifest.components[1].exported = null), config, cert, false, source), /exported/);
const old = changed(r => { r.label = 'historical'; r.manifest.components[1].exported = true; });
const diff = compareApks(old, record);
assert.equal(diff.components.length, 1); assert.equal(diff.components[0].after.exported, false);
assert.deepEqual(diff.permissionsAdded, []);
const special='android.permission.FOREGROUND_SERVICE_SPECIAL_USE',foreground='android.permission.FOREGROUND_SERVICE';
const previous=structuredClone(record);previous.kind='server';previous.manifest.packageName='gr.argyrismitsos.fleetserver';previous.manifest.permissions.push(foreground);
const direct=structuredClone(previous);direct.manifest.permissions.push(special);direct.manifest.components.push({kind:'service',name:'gr.argyrismitsos.fleetdirect.IndependentService',exported:false,process:':direct',foregroundServiceType:0x40000000,properties:[{name:'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',value:'Owner controlled private HTTPS fleet server with independent SQLite and read-only source synchronization.'}]});
assert.deepEqual(assertPermissionChanges(previous,direct).authorizedAdditions,[special]);
assert.deepEqual(assertPermissionChanges(record,record).authorizedAdditions,[]);
for(const mutate of [r=>r.kind='client',r=>r.manifest.permissions.push('android.permission.READ_SMS'),r=>r.manifest.components.at(-1).exported=true,r=>r.manifest.components.at(-1).process=null,r=>r.manifest.components.at(-1).foregroundServiceType=1,r=>r.manifest.components.at(-1).properties=[],r=>r.manifest.permissions=r.manifest.permissions.filter(p=>p!==foreground),r=>r.manifest.permissions=r.manifest.permissions.filter(p=>p!=='android.permission.INTERNET')]){
 const invalid=structuredClone(direct);mutate(invalid);assert.throws(()=>assertPermissionChanges(previous,invalid),'Only the exact private Direct purpose is authorized');
}
const compiledService=parseCompiledManifest(xml+'\n    E: service (line=11)\n      A: android:name(0x01010003)="gr.argyrismitsos.fleetdirect.IndependentService"\n      A: android:foregroundServiceType(0x01010599)=(type 0x11)0x40000000\n      E: property (line=12)\n        A: android:name(0x01010003)="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"\n        A: android:value(0x01010024)="Owner controlled private HTTPS fleet server with independent SQLite and read-only source synchronization."');
assert.equal(compiledService.components.find(c=>c.kind==='service').foregroundServiceType,0x40000000);assert.equal(compiledService.components.find(c=>c.kind==='service').properties[0].name,'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE');
console.log('PASS compiled APK audit parser, absent/default distinction, permission/export/signature rejection and precise history diff.');
