#!/usr/bin/env python3
"""Compiled payload checks. Original signing identity is a separate release gate."""
from pathlib import Path
import json,zipfile

root=Path(__file__).resolve().parents[1]
config=json.loads((root/'release-config.json').read_text())
for kind in ('client','server'):
    apk=root/'dist'/('Fleet_Control_'+kind.title()+'_v'+config[kind]['version']+'.apk')
    assert apk.stat().st_size<192*1024*1024, 'New OTA 192MiB ceiling: '+str(apk)
    with zipfile.ZipFile(apk) as z:
        dex=b''.join(z.read(n) for n in z.namelist() if n.startswith('classes') and n.endswith('.dex'))
        if kind=='server':
            for name in ('fleetserver/BackendMode','fleetdirect/IndependentRuntime','fleetdirect/DirectControlProvider','fleetdirect/ScopedContext'):
                assert ('Lgr/argyrismitsos/'+name+';').encode() in dex,name
            assert z.read('assets/independent-www/download/client.apk')==(root/'dist'/('Fleet_Control_Client_v'+config['client']['version']+'.apk')).read_bytes(), 'Full signed Client is embedded byte for byte'
            for abi in ('arm64-v8a','armeabi-v7a'):assert 'lib/'+abi+'/libsqliteX.so' in z.namelist()
            html=z.read('assets/www/index.html').decode();assert 'id="backendModePanel"' in html
            for tab in ('status','backup','updates','settings'):assert 'data-tab="'+tab+'"' in html
        else:
            assert b'Lgr/argyrismitsos/fleetcontrol/BackendSelection;' in dex
            html=z.read('assets/www/portal.html').decode()
            assert html.index('/backend-mode.js')<html.index('/primary-transport.js')<html.index('/portal.js')
    print('PASS compiled '+kind+' payload and new 192MiB size bound: '+str(apk.stat().st_size)+' bytes')
print('APK construction checks do not prove original signature, real restore, router access or physical device acceptance.')
