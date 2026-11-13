#!/usr/bin/env python3
"""Pinned official SQLite, exclusively for the isolated Android Server build."""
import hashlib, json, os, pathlib, shutil, subprocess, sys, zipfile

root = pathlib.Path(__file__).resolve().parents[1]
lock = json.loads((root / 'android-build-support/independent-sqlite.lock.json').read_text())
cache = pathlib.Path(os.environ.get('FLEET_SQLITE_CACHE', root / '.build/independent-sqlite'))
cache.mkdir(parents=True, exist_ok=True)
archive = cache / lock['file']

def valid():
    if not archive.is_file() or archive.stat().st_size != lock['sizeBytes']:
        return False
    data = archive.read_bytes()
    return (hashlib.sha256(data).hexdigest() == lock['sha256'] and
            hashlib.sha3_256(data).hexdigest() == lock['sha3_256'])

if not valid():
    part = archive.with_suffix('.part')
    subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error',
                    '--retry', '2', '--max-time', '180', lock['url'], '-o', str(part)], check=True)
    part.replace(archive)
if not valid():
    raise SystemExit('Official SQLite dependency checksum mismatch')

destination = pathlib.Path(sys.argv[1])
(destination / 'jars').mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(archive) as aar:
    (destination / 'jars/independent-sqlite.jar').write_bytes(aar.read('classes.jar'))
    for abi in lock['abis']:
        out = destination / 'lib' / abi / 'libsqliteX.so'
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(aar.read('jni/' + abi + '/libsqliteX.so'))
shutil.copytree(root / 'third-party/independent-sqlite',
                destination / 'assets/independent-sqlite-notices', dirs_exist_ok=True)
print('Verified official SQLite ' + lock['version'] + ' Android bindings, JSON and four ABIs.')
