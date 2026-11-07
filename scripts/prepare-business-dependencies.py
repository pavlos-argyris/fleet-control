"""Pinned business interpreter, bundled in the APK; no runtime code downloads."""
from pathlib import Path,PurePosixPath
import argparse,hashlib,json,shutil,subprocess,zipfile
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('destination',nargs='?',type=Path)
parser.add_argument('--resources',type=Path,help='Stage Java classpath resources before dependency classes are converted to DEX')
args=parser.parse_args()
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
    if args.destination:
        destination=args.destination;destination.mkdir(parents=True,exist_ok=True)
        shutil.copy2(target,destination/item['file'])
    if args.resources:
        with zipfile.ZipFile(target) as jar:
            names=set()
            for entry in jar.infolist():
                name=entry.filename
                if entry.is_dir() or name.endswith('.class') or (name.startswith('META-INF/') and not name.startswith('META-INF/services/')):
                    continue
                relative=PurePosixPath(name)
                if relative.is_absolute() or '..' in relative.parts or '\\' in name or name in names:
                    raise SystemExit('Invalid or duplicate business dependency resource: '+name)
                names.add(name)
                output=args.resources/relative
                data=jar.read(entry)
                if output.exists() and output.read_bytes()!=data:
                    raise SystemExit('Conflicting business dependency resource: '+name)
                output.parent.mkdir(parents=True,exist_ok=True)
                output.write_bytes(data)
        print('Staged '+str(len(names))+' verified business dependency resources.')
print('Verified pinned Rhino business interpreter.')
