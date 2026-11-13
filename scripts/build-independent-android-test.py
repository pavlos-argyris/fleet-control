#!/usr/bin/env python3
"""Compile disposable instrumentation against the actual isolated APK classes."""
import json, os, pathlib, subprocess, zipfile, sys, hashlib, shutil
root = pathlib.Path(__file__).resolve().parents[1]
unified='--unified' in sys.argv
out = root / ('.build/unified-android-test' if unified else '.build/independent-android-test')
out.mkdir(parents=True, exist_ok=True)
tool = root / '.android-toolchain'
android = tool / 'usr/share/java/com.android.android-23.jar'
program = root / ('.build/unified-server-classes.jar' if unified else '.build/independent-source/.build/independent-server-classes.jar')
lock = json.loads((root / 'android-build-support/independent-sqlite.lock.json').read_text())
with zipfile.ZipFile(root / '.build/independent-sqlite' / lock['file']) as aar:
    sqlite = out / 'sqlite.jar'
    sqlite.write_bytes(aar.read('classes.jar'))
fixtures=root/'scripts/fixtures/android-sqlite'
if unified:
    fixtures=out/'src';fixtures.mkdir(exist_ok=True)
    for source in (root/'scripts/fixtures/android-sqlite').glob('*.java'):
        text=source.read_text().replace('gr.argyrismitsos.fleetserver','gr.argyrismitsos.fleetdirect')
        if source.name=='AndroidSqliteChecks.java':
            text=text.replace('final Context target=getTargetContext();','final Context base=getTargetContext();final Context target=new ScopedContext(base);check(!base.getDatabasePath(NativeColdRestore.DATABASE_NAME).equals(target.getDatabasePath(NativeColdRestore.DATABASE_NAME)),"Cloud and Direct database paths must differ");base.getSharedPreferences("issue95_sentinel",0).edit().putString("keep","cloud-preserved").commit();')
            start=text.index('        // Real Activity lifecycle/preferences notification')
            end=text.index('\n    private static Object readField',start)
            text=text[:start]+'''        check(base.getSharedPreferences("issue95_sentinel",0).getString("keep","").equals("cloud-preserved"),"Direct restore preserves unscoped Cloud preferences");
        check(!gr.argyrismitsos.fleetserver.BackendMode.direct(base),"Import and probes never change the initial Cloudflare selection");
        Bundle status=base.getContentResolver().call(Uri.parse("content://gr.argyrismitsos.fleetserver.direct-control"),"status","",null);
        check(status.getBoolean("ok")&&new JSONObject(status.getString("json")).getBoolean("backupVerified"),"Private provider observes the same isolated restored configuration across processes");
        UnifiedNativeChecks.run(base,target,manifest,owner,PASSWORD);
    }
'''+text[end:]
        (fixtures/source.name).write_text(text)
    for source in (root/'scripts/fixtures/android-unified').glob('*.java'):
        (fixtures/source.name).write_text(source.read_text())
classes = out / 'classes'
classes.mkdir(exist_ok=True)
classpath = os.pathsep.join(map(str, [android, program, sqlite]))
subprocess.run(['java', '-jar', str(tool / 'usr/share/java/eclipse-jdt-core-3.32.0.jar'),
                '-proc:none', '-source', '8', '-target', '8', '-encoding', 'UTF-8',
                '-cp', classpath, '-d', str(classes),
                *map(str, sorted(fixtures.glob('*.java')))], check=True)
jar = out / 'tests.jar'
with zipfile.ZipFile(jar, 'w') as archive:
    for file in sorted(classes.rglob('*.class')):
        archive.writestr(file.relative_to(classes).as_posix(), file.read_bytes())
subprocess.run(['java', '-cp', str(root / ('.build/invoice-deps/r8.jar' if unified else '.build/independent-source/.build/invoice-deps/r8.jar')),
                'com.android.tools.r8.D8', '--release', '--min-api', '26', '--lib', str(android),
                '--classpath', str(program), '--classpath', str(sqlite), '--output', str(out), str(jar)], check=True)
env = dict(os.environ, LD_LIBRARY_PATH=':'.join(str(tool / p) for p in
           ['usr/lib/x86_64-linux-gnu/android', 'usr/lib', 'usr/lib/x86_64-linux-gnu', 'lib/x86_64-linux-gnu']))
manifest=root/'scripts/fixtures/android-sqlite/AndroidManifest.xml'
if unified:
    text=manifest.read_text().replace('gr.argyrismitsos.fleetserver','gr.argyrismitsos.fleetdirect').replace('gr.argyrismitsos.fleetdirect.independent','gr.argyrismitsos.fleetserver')
    manifest=out/'AndroidManifest.xml';manifest.write_text(text)
unsigned = out / 'unsigned.apk'
subprocess.run([str(tool / 'usr/lib/android-sdk/build-tools/debian/aapt'), 'package', '-f',
                '-M', str(manifest),
                '-I', str(android), '-F', str(unsigned)], env=env, check=True)
with zipfile.ZipFile(unsigned, 'a', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(out.glob('classes*.dex')):
        archive.writestr(file.name, file.read_bytes())
aligned = out / 'aligned.apk'
subprocess.run([str(tool / 'usr/lib/android-sdk/build-tools/debian/zipalign'), '-f', '4', str(unsigned), str(aligned)], env=env, check=True)
subprocess.run(['java', '-jar', str(tool / 'usr/share/java/apksigner-31.0.2.jar'), 'sign',
                '--ks', os.environ['FLEET_KEYSTORE'], '--ks-key-alias', os.environ['FLEET_KEY_ALIAS'],
                '--ks-pass', 'env:FLEET_STORE_PASSWORD', '--key-pass', 'env:FLEET_KEY_PASSWORD',
                '--out', str(out / 'sqlite-tests.apk'), str(aligned)], check=True)
print('Built disposable emulator-only instrumentation; it is excluded from delivery.')

if unified:
    config=json.loads((root/'release-config.json').read_text())
    original=root/'dist'/('Fleet_Control_Server_v'+config['server']['version']+'.apk')
    with zipfile.ZipFile(original) as src,zipfile.ZipFile(root/'.build/independent-sqlite'/lock['file']) as aar:
        for architecture in ['arm64-v8a','armeabi-v7a','x86','x86_64']:
            assert src.read('lib/'+architecture+'/libsqliteX.so')==aar.read('jni/'+architecture+'/libsqliteX.so'), 'Normal APK must contain every pinned SQLite ABI'
        dex={name:hashlib.sha256(src.read(name)).hexdigest() for name in src.namelist() if name.startswith('classes') and name.endswith('.dex')}
    digest=hashlib.sha256()
    with original.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1048576),b''):digest.update(chunk)
    shutil.copyfile(original,out/'server-abi-test.apk')
    (out/'source-apk.json').write_text(json.dumps({'exactNormalApk':True,'file':original.name,'sha256':digest.hexdigest(),'dex':dex,'signing':'disposable fixture; original signing is a separate release gate'},indent=2)+'\n')
    print('Unified instrumentation uses the byte-exact normal four-ABI APK, without repacking or resigning it.')
