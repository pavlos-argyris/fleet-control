"""Archive verified offline build inputs with their original pinned names."""
from pathlib import Path
import hashlib, json, sys, zipfile
root=Path(__file__).resolve().parent.parent
lock=json.loads((root/'android-build-support/invoice-dependencies.lock.json').read_text())
with zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as out:
    for item in lock['items']:
        file=root/'.build/invoice-deps'/item['file'];data=file.read_bytes()
        if len(data)!=item['sizeBytes'] or hashlib.sha256(data).hexdigest()!=item['sha256']:raise SystemExit('Bad build input: '+item['file'])
        info=zipfile.ZipInfo('.build/invoice-deps/'+item['file'],(1980,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;out.writestr(info,data)
    for file in [root/'android-build-support/invoice-dependencies.lock.json',*sorted((root/'third-party/invoice-reader').glob('*'))]:
        if file.is_file():
            info=zipfile.ZipInfo(file.relative_to(root).as_posix(),(1980,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;out.writestr(info,file.read_bytes())
print('Archived verified offline invoice reader inputs.')
