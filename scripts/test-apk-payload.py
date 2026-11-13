#!/usr/bin/env python3
"""Reject missing or changed native/model payloads using real compiled APK bytes."""
from pathlib import Path
import json
import subprocess
import sys
import tempfile
import warnings
import zipfile

root = Path(__file__).resolve().parents[1]
config = json.loads((root / 'release-config.json').read_text())
apk = root / 'dist' / ('Fleet_Control_Server_v' + config['server']['version'] + '.apk')
verifier = root / 'scripts/verify-apk-payload.py'
with zipfile.ZipFile(apk) as archive:
    payload = {name: archive.read(name) for name in archive.namelist()
               if name.startswith(('lib/', 'assets/ocr/tessdata/'))
               or name == 'assets/invoice-reader-notices/PDFBOX-LICENSE.txt'}

sqlite = 'lib/arm64-v8a/libsqliteX.so'
model = 'assets/ocr/tessdata/eng.traineddata'
cases = [
    ('missing ARM64 SQLite', sqlite, None, 'ABI inventory'),
    ('missing x86_64 SQLite', 'lib/x86_64/libsqliteX.so', None, 'ABI inventory'),
    ('changed SQLite', sqlite, payload[sqlite][:-1] + bytes([payload[sqlite][-1] ^ 1]), 'pinned AAR'),
    ('changed OCR model', model, payload[model][:-1] + bytes([payload[model][-1] ^ 1]), 'OCR model'),
    ('unexpected native library', 'lib/arm64-v8a/libunexpected.so', b'not trusted', 'ABI inventory'),
    ('missing notice', 'assets/invoice-reader-notices/PDFBOX-LICENSE.txt', None, 'notice missing'),
]
with tempfile.TemporaryDirectory(prefix='fleet-apk-payload-') as directory:
    fixture = Path(directory) / 'payload.apk'
    for label, name, replacement, error in cases:
        changed = dict(payload)
        if replacement is None:
            changed.pop(name)
        else:
            changed[name] = replacement
        with zipfile.ZipFile(fixture, 'w') as archive:
            for entry, data in changed.items():
                archive.writestr(entry, data)
        result = subprocess.run([sys.executable, str(verifier), str(fixture)], capture_output=True, text=True)
        assert result.returncode != 0 and error in result.stderr, label + ': ' + result.stderr
        print('PASS payload rejection: ' + label)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', UserWarning)
        with zipfile.ZipFile(fixture, 'w') as archive:
            for entry, data in payload.items():
                archive.writestr(entry, data)
            archive.writestr(sqlite, payload[sqlite])
    result = subprocess.run([sys.executable, str(verifier), str(fixture)], capture_output=True, text=True)
    assert result.returncode != 0 and 'ABI inventory' in result.stderr, 'duplicate native ZIP entry'
    print('PASS payload rejection: duplicate native ZIP entry')
