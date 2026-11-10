#!/usr/bin/env python3
"""Fail closed if an isolated connector test APK accidentally contains Fleet."""
import hashlib
import json
import re
from pathlib import Path
import sys
import zipfile

root = Path(sys.argv[1])
with zipfile.ZipFile(root / 'Fleet_Tunnel_TEST_0.2.0.apk') as apk:
    names = apk.namelist()
    assert not any('business-runtime' in name or 'BuildSecrets' in name or name.startswith('assets/www/') for name in names)
    assert [name for name in names if name.startswith('lib/')] == ['lib/arm64-v8a/libcloudflared.so']
    info = json.loads(apk.read('assets/connector.json'))
    assert info['productionApproved'] is False
    assert hashlib.sha256(apk.read('lib/arm64-v8a/libcloudflared.so')).hexdigest() == info['sha256']
    dex = apk.read('classes.dex')
    for forbidden in [b'gr/argyrismitsos/fleetserver/', b'gr/argyrismitsos/fleetclient/', b'FleetDataStore', b'CloudReturnController', b'ServerConfig', b'fleet-control-server.db']:
        assert forbidden not in dex, forbidden
    assert b'fleettunnelpoc/PocService;' in dex
manifest = (root / 'compiled-manifest.txt').read_text()
assert 'gr.argyrismitsos.fleettunnelpoc' in manifest
assert 'extractNativeLibs' in manifest and 'allowBackup' in manifest
assert 'usesCleartextTraffic' in manifest
assert re.search(r'android:allowBackup\([^)]*\)=\(type 0x12\)0x0(?:\s|$)', manifest)
assert re.search(r'android:extractNativeLibs\([^)]*\)=\(type 0x12\)0xffffffff(?:\s|$)', manifest)
assert re.search(r'android:usesCleartextTraffic\([^)]*\)=\(type 0x12\)0x0(?:\s|$)', manifest)
assert re.search(r'android:versionCode\([^)]*\)=\(type 0x10\)0x2(?:\s|$)', manifest)
assert '"0.2.0"' in manifest
assert 'fleetserver' not in manifest and 'fleetclient' not in manifest
assert 'test-only.p12' not in names
print('PASS separate compiled TEST APK, packaged connector hash and no Fleet business classes/assets.')
