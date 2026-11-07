"""Pinned business interpreter, bundled in the APK; no runtime code downloads."""
from pathlib import Path
import hashlib,json,shutil,subprocess,sys
root=Path(__file__).resolve().parent.parent
cache=root/'.build/runtime-deps';cache.mkdir(parents=True,exist_ok=True)
lock=json.loads((root/'android-build-support/business-dependencies.lock.json').read_text())
for item in lock['items']:
    target=cache/item['file']
    def valid():
        return target.exists() and target.stat().st_size==item['sizeBytes'] and hashlib.sha256(target.read_bytes()).hexdigest()==item['sha256']
    if not valid():
        part=target.with_suffix('.part')
        subprocess.run(['curl','--fail','--location','--silent','--show-error','--retry','2','--max-time','120',item['url'],'-o',str(part)],check=True)
        part.replace(target)
    if not valid():raise SystemExit('Business dependency checksum mismatch')
    if len(sys.argv)>1:
        destination=Path(sys.argv[1]);destination.mkdir(parents=True,exist_ok=True)
        shutil.copy2(target,destination/item['file'])
print('Verified pinned Rhino business interpreter.')
