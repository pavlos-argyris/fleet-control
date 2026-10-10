"""Pinned, hash-verified OCR/PDF build inputs; no runtime model downloads."""
from pathlib import Path
import hashlib, json, shutil, subprocess, sys, zipfile
root=Path(__file__).resolve().parent.parent
cache=root/'.build/invoice-deps'
cache.mkdir(parents=True,exist_ok=True)
lock=json.loads((root/'android-build-support/invoice-dependencies.lock.json').read_text())
for item in lock['items']:
    target=cache/item['file']
    def valid():
        return target.exists() and target.stat().st_size==item['sizeBytes'] and hashlib.sha256(target.read_bytes()).hexdigest()==item['sha256']
    if not valid():
        part=target.with_suffix(target.suffix+'.part')
        subprocess.run(['curl','--fail','--location','--silent','--show-error','--retry','2','--max-time','180',item['url'],'-o',str(part)],check=True)
        part.replace(target)
    if not valid(): raise SystemExit('Invoice dependency checksum mismatch: '+item['file'])
destination=Path(sys.argv[1])
(destination/'jars').mkdir(parents=True,exist_ok=True)
(destination/'assets').mkdir(exist_ok=True)
(destination/'lib').mkdir(exist_ok=True)
for name in ['tesseract','pdfbox']:
    with zipfile.ZipFile(cache/(name+'.aar')) as archive:
        (destination/'jars'/(name+'.jar')).write_bytes(archive.read('classes.jar'))
        for member in archive.namelist():
            if member.endswith('/'): continue
            if member.startswith('assets/'):
                out=destination/member
            elif member.startswith(('jni/arm64-v8a/','jni/armeabi-v7a/')):
                out=destination/'lib'/member.removeprefix('jni/')
            else: continue
            out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(archive.read(member))
for name in ['bcprov','bcpkix','bcutil']: shutil.copy2(cache/(name+'.jar'),destination/'jars'/(name+'.jar'))
for name in ['eng','ell']:
    out=destination/'assets/ocr/tessdata'/(name+'.traineddata');out.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(cache/(name+'.traineddata'),out)
shutil.copy2(cache/'r8.jar',destination/'r8.jar')
print('Verified pinned PDFBox, Tesseract, Greek/English models and build inputs.')

shutil.copytree(root/"third-party/invoice-reader",destination/"assets/invoice-reader-notices",dirs_exist_ok=True)
