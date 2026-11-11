#!/usr/bin/env python3
import pathlib,sys,subprocess,zipfile,hashlib,json,os
root=pathlib.Path(__file__).resolve().parents[1]
aapt=root/'.android-toolchain/usr/lib/android-sdk/build-tools/debian/aapt'
libs=[root/'.android-toolchain'/p for p in ('usr/lib/x86_64-linux-gnu/android','usr/lib','usr/lib/x86_64-linux-gnu','lib/x86_64-linux-gnu')]
env={**os.environ,'LD_LIBRARY_PATH':':'.join(map(str,libs))}
folder=pathlib.Path(sys.argv[1]);checks=[]
for component,package in [('Server','gr.argyrismitsos.fleetserver.independent'),('Client','gr.argyrismitsos.fleetindependentclient')]:
    file=folder/f'Fleet_Independent_{component}_v1.0.0-test1.apk'
    info=subprocess.check_output([str(aapt),'dump','badging',str(file)],env=env,text=True)
    assert f"package: name='{package}'" in info and "versionCode='1'" in info, info[:300]
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
    checks.append({'component':component,'applicationId':package,'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
(folder/'APK_VERIFICATION.json').write_text(json.dumps({'schema':1,'isolated':True,'productionActivation':False,'artifacts':checks},indent=2)+'\n')
print('PASS compiled isolated application IDs, TLS-only manifests, exclusive Server components and APK business/Web resources')
