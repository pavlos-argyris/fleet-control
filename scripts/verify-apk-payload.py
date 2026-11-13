#!/usr/bin/env python3
"""Check the actual packaged OCR/SQLite bytes after APK identity verification."""
from pathlib import Path
import hashlib
import json
import struct
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
config = json.loads((root / 'release-config.json').read_text())
apk = Path(sys.argv[1]) if len(sys.argv) == 2 else root / 'dist' / ('Fleet_Control_Server_v' + config['server']['version'] + '.apk')
invoice = json.loads((root / 'android-build-support/invoice-dependencies.lock.json').read_text())
sqlite = json.loads((root / 'android-build-support/independent-sqlite.lock.json').read_text())
tess = next(item for item in invoice['items'] if item['file'] == 'tesseract.aar')
tess_file = root / '.build/invoice-deps' / tess['file']
sqlite_file = root / '.build/independent-sqlite' / sqlite['file']
for file, expected in [(tess_file, tess['sha256']), (sqlite_file, sqlite['sha256'])]:
    with file.open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == expected, 'Pinned AAR hash: ' + file.name

expected = {}
with zipfile.ZipFile(tess_file) as archive:
    for abi in ['arm64-v8a', 'armeabi-v7a']:
        for name in ['libjpeg.so', 'libleptonica.so', 'libpngx.so', 'libtesseract.so']:
            expected['lib/' + abi + '/' + name] = archive.read('jni/' + abi + '/' + name)
with zipfile.ZipFile(sqlite_file) as archive:
    for abi in sqlite['abis']:
        expected['lib/' + abi + '/libsqliteX.so'] = archive.read('jni/' + abi + '/libsqliteX.so')

machines = {'arm64-v8a': (2, 183), 'armeabi-v7a': (1, 40), 'x86': (1, 3), 'x86_64': (2, 62)}
with zipfile.ZipFile(apk) as archive:
    names = archive.namelist()
    native = [name for name in names if name.startswith('lib/') and name.endswith('.so')]
    assert len(native) == len(set(native)) and set(native) == set(expected), 'Exact packaged OCR/SQLite ABI inventory'
    for name, pinned in expected.items():
        data = archive.read(name)
        assert data == pinned, 'Packaged library differs from pinned AAR: ' + name
        elf_class, machine = machines[name.split('/')[1]]
        assert data[:6] == b'\x7fELF' + bytes([elf_class, 1]), 'ELF class/endianness: ' + name
        assert struct.unpack_from('<H', data, 18)[0] == machine, 'ELF architecture: ' + name
        is64 = elf_class == 2
        offset = struct.unpack_from('<Q' if is64 else '<I', data, 32 if is64 else 28)[0]
        size, count = struct.unpack_from('<HH', data, 54 if is64 else 42)
        for i in range(count):
            header = struct.unpack_from('<IIQQQQQQ' if is64 else '<IIIIIIII', data, offset + i * size)
            if header[0] == 1:
                assert header[7] >= (16384 if is64 else 4096), 'ELF page alignment: ' + name
    for item in invoice['items']:
        if item['file'].endswith('.traineddata'):
            data = archive.read('assets/ocr/tessdata/' + item['file'])
            assert hashlib.sha256(data).hexdigest() == item['sha256'], 'Packaged OCR model: ' + item['file']
    assert 'assets/invoice-reader-notices/PDFBOX-LICENSE.txt' in names, 'PDFBox notice missing'

print('Verified exact packaged OCR libraries, all four pinned SQLite ABIs, model hashes, ELF architectures and 16 KiB 64-bit alignment.')
