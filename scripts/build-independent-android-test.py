#!/usr/bin/env python3
"""Compile disposable instrumentation against the actual isolated APK classes."""
import json, os, pathlib, subprocess, zipfile
root = pathlib.Path(__file__).resolve().parents[1]
out = root / '.build/independent-android-test'
out.mkdir(parents=True, exist_ok=True)
tool = root / '.android-toolchain'
android = tool / 'usr/share/java/com.android.android-23.jar'
program = root / '.build/independent-source/.build/independent-server-classes.jar'
lock = json.loads((root / 'android-build-support/independent-sqlite.lock.json').read_text())
with zipfile.ZipFile(root / '.build/independent-sqlite' / lock['file']) as aar:
    sqlite = out / 'sqlite.jar'
    sqlite.write_bytes(aar.read('classes.jar'))
classes = out / 'classes'
classes.mkdir(exist_ok=True)
classpath = os.pathsep.join(map(str, [android, program, sqlite]))
subprocess.run(['java', '-jar', str(tool / 'usr/share/java/eclipse-jdt-core-3.32.0.jar'),
                '-proc:none', '-source', '8', '-target', '8', '-encoding', 'UTF-8',
                '-cp', classpath, '-d', str(classes),
                *map(str, sorted((root / 'scripts/fixtures/android-sqlite').glob('*.java')))], check=True)
jar = out / 'tests.jar'
with zipfile.ZipFile(jar, 'w') as archive:
    for file in sorted(classes.rglob('*.class')):
        archive.writestr(file.relative_to(classes).as_posix(), file.read_bytes())
subprocess.run(['java', '-cp', str(root / '.build/independent-source/.build/invoice-deps/r8.jar'),
                'com.android.tools.r8.D8', '--release', '--min-api', '26', '--lib', str(android),
                '--classpath', str(program), '--classpath', str(sqlite), '--output', str(out), str(jar)], check=True)
env = dict(os.environ, LD_LIBRARY_PATH=':'.join(str(tool / p) for p in
           ['usr/lib/x86_64-linux-gnu/android', 'usr/lib', 'usr/lib/x86_64-linux-gnu', 'lib/x86_64-linux-gnu']))
unsigned = out / 'unsigned.apk'
subprocess.run([str(tool / 'usr/lib/android-sdk/build-tools/debian/aapt'), 'package', '-f',
                '-M', str(root / 'scripts/fixtures/android-sqlite/AndroidManifest.xml'),
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
