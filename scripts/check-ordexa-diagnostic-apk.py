"""Inspect the actual compiled standalone APK, never just its source manifest."""
import pathlib
import re
import sys
import zipfile

out = pathlib.Path(sys.argv[1])
manifest = (out / "compiled-manifest.txt").read_text()
signature = (out / "signature.txt").read_text()
assert 'package="gr.argyrismitsos.fleetordexadiagnostic"' in manifest
permissions = re.findall(r'E: uses-permission[^\n]*\n[^\n]*android:name[^\n]*="([^"]+)"', manifest)
assert permissions == ['android.permission.INTERNET'], permissions
assert 'sharedUserId' not in manifest
assert re.search(r'android:minSdkVersion[^\n]*\(type 0x10\)0x1a\b', manifest)
assert re.search(r'android:targetSdkVersion[^\n]*\(type 0x10\)0x22\b', manifest)
for name in ['allowBackup', 'debuggable', 'usesCleartextTraffic']:
    assert re.search(r'android:' + name + r'[^\n]*\(type 0x12\)0x0\b', manifest), name
assert len(re.findall(r'E: activity\b', manifest)) == 1
assert not re.search(r'E: (?:service|receiver|provider)\b', manifest)
assert 'gr.argyrismitsos.fleetserver.OrdexaDiagnosticActivity' in manifest
assert 'Verified using v2 scheme (APK Signature Scheme v2): true' in signature
assert 'CN=Fleet Ordexa Diagnostic Test' in signature
with zipfile.ZipFile(out / 'Fleet_Ordexa_Diagnostic_v0.1.0.apk') as apk:
    assert apk.testzip() is None
    assert 'classes.dex' in apk.namelist()
    assert not any(n.startswith(('assets/', 'lib/')) for n in apk.namelist())
    dex = apk.read('classes.dex')
    for forbidden in [b'getSharedPreferences', b'openFileOutput', b'Landroid/webkit/WebView;',
                      b'setDefaultHostnameVerifier', b'setSSLSocketFactory', b'workers.dev']:
        assert forbidden not in dex, forbidden
print('PASS actual standalone diagnostic APK: separate package, INTERNET only, no shared UID/services/backup/cleartext/debugging, verified test signature and ZIP integrity.')
