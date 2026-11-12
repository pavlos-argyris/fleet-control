#!/usr/bin/env python3
import pathlib,sys,subprocess,zipfile,hashlib,json,os
root=pathlib.Path(__file__).resolve().parents[1]
aapt=root/'.android-toolchain/usr/lib/android-sdk/build-tools/debian/aapt'
libs=[root/'.android-toolchain'/p for p in ('usr/lib/x86_64-linux-gnu/android','usr/lib','usr/lib/x86_64-linux-gnu','lib/x86_64-linux-gnu')]
env={**os.environ,'LD_LIBRARY_PATH':':'.join(map(str,libs))}
folder=pathlib.Path(sys.argv[1]);checks=[]
for component,package in [('Server','gr.argyrismitsos.fleetserver.independent'),('Client','gr.argyrismitsos.fleetindependentclient')]:
    file=folder/f'Fleet_Independent_{component}_v1.0.0-test4.apk'
    info=subprocess.check_output([str(aapt),'dump','badging',str(file)],env=env,text=True)
    assert f"package: name='{package}'" in info and "versionCode='4'" in info and "versionName='1.0.0-test3'" in info, info[:300]
    tree=subprocess.check_output([str(aapt),'dump','xmltree',str(file),'AndroidManifest.xml'],env=env,text=True)
    assert 'usesCleartextTraffic' in tree and 'allowBackup' in tree
    if component=='Server':
        assert 'IndependentApplication' in tree and 'IndependentService' in tree
        assert '.SyncService' not in tree and 'FleetApplication' not in tree and 'dataSync' not in tree
        assert 'specialUse' in info or 'foregroundServiceType' in tree
        with zipfile.ZipFile(file) as apk:
            names=apk.namelist()
            for name in ['assets/independent-www/portal.html','assets/business-runtime/runtime.js','org/mozilla/javascript/resources/Messages.properties']:
                assert name in names,name
            assert b'primary/descriptor' not in apk.read('assets/independent-www/primary-transport.js')
            assert b'fleet-control.pavlosargyris.workers.dev' not in apk.read('assets/independent-www/fleet-config.js')
            portal=apk.read('assets/independent-www/portal.html')
            assert b'./fleet.html?embedded=1' in portal and b'./index.html?embedded=1' not in portal
            assert b'href="./direct.html"' not in portal
            lock=json.loads((root/'android-build-support/independent-sqlite.lock.json').read_text())
            data=(root/'.build/independent-sqlite'/lock['file']).read_bytes()
            assert len(data)==lock['sizeBytes'] and hashlib.sha256(data).hexdigest()==lock['sha256'] and hashlib.sha3_256(data).hexdigest()==lock['sha3_256']
            import io
            with zipfile.ZipFile(io.BytesIO(data)) as aar:
                for abi in lock['abis']:
                    name='lib/'+abi+'/libsqliteX.so'
                    assert apk.read(name)==aar.read('jni/'+abi+'/libsqliteX.so'),'Wrong/missing bundled SQLite ABI: '+abi
            dex=b''.join(apk.read(name) for name in names if name.endswith('.dex'))
            for descriptor in [b'Lorg/sqlite/database/sqlite/SQLiteDatabase;',b'Lgr/argyrismitsos/fleetserver/IndependentSqlite;']:
                assert descriptor in dex,'Bundled provider/preflight missing from dex'
            assert b'Lgr/argyrismitsos/fleetserver/AndroidSqliteChecks;' not in dex,'Disposable instrumentation must never ship'
            assert 'assets/independent-sqlite-notices/NOTICE.txt' in names
            assert apk.read('assets/independent-www/download/client.apk')==(folder/'Fleet_Independent_Client_v1.0.0-test4.apk').read_bytes(),'Android-hosted download must be the exact signed isolated Client'
            with zipfile.ZipFile(root/'vendor/pdf-viewer-6.4.299.zip') as viewer:
                for name in viewer.namelist():
                    if not name.endswith('/'):assert apk.read('assets/independent-www/vendor/pdfjs/'+name)==viewer.read(name),'Pinned PDF viewer input missing/different: '+name
    cert=subprocess.check_output(['java','-jar',str(root/'.android-toolchain/usr/share/java/apksigner-31.0.2.jar'),'verify','--print-certs',str(file)],text=True)
    import re
    fingerprint=re.search(r'certificate SHA-256 digest: ([a-f0-9]+)',cert).group(1)
    if os.environ.get('FLEET_REQUIRE_ORIGINAL_SIGNATURE')=='1':assert fingerprint==(root/'signing-certificate.sha256').read_text().strip(),'Wrong original signing certificate'
    checks.append({'certificateSha256':fingerprint,'component':component,'applicationId':package,'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
(folder/'APK_VERIFICATION.json').write_text(json.dumps({'schema':1,'isolated':True,'productionActivation':False,'artifacts':checks},indent=2)+'\n')
print('PASS compiled isolated IDs/code4, TLS-only manifests, pinned SQLite four ABI bytes/preflight, no test hooks and APK business/Web resources')
