"""Keep versioned JS/CSS snapshots: old active releases survive a new Worker deploy."""
from pathlib import Path
import json,re,shutil,sys
root=Path(__file__).resolve().parents[1]
version=json.loads((root/'release-config.json').read_text())['web']['version']
public=root/'cloudflare-worker/public';target=public/'assets'/('v'+version)
files=[p for p in public.iterdir() if p.is_file() and p.suffix in ('.js','.css') and p.name not in ('fleet-config.js','service-worker.js')]
check='--check' in sys.argv
if not check:target.mkdir(parents=True,exist_ok=True)
for p in files:
 out=target/p.name
 if check:assert out.exists() and out.read_bytes()==p.read_bytes(),'Versioned static asset differs: '+p.name
 else:out.write_bytes(p.read_bytes())
for name in ['index.html','portal.html']:
 p=public/name;s=p.read_text()
 for file in files:
  s=re.sub(r'((?:src|href)=["\'])\./(?:assets/v[0-9.]+/)?'+re.escape(file.name)+r'(?:\?v=[0-9.]+)?(["\'])',lambda m:m[1]+'./assets/v'+version+'/'+file.name+m[2],s)
 if check:assert s==p.read_text(),'HTML does not use current immutable assets: '+name
 else:p.write_text(s)
# These files are public code, never authenticated data. Cache by immutable path.
header='''/assets/*
  Cache-Control: public, max-age=31536000, immutable
  X-Content-Type-Options: nosniff
/vendor/*
  Cache-Control: public, max-age=3600
  X-Content-Type-Options: nosniff
'''
if check:assert (public/'_headers').read_text()==header
else:(public/'_headers').write_text(header)
if not check:
 client=root/'client-android/assets/www'
 for p in public.iterdir():
  if p.is_file() and p.name not in ('fleet-config.js','_headers'):shutil.copy2(p,client/p.name)
 shutil.copytree(public/'assets',client/'assets',dirs_exist_ok=True)
print(('Verified' if check else 'Prepared')+' immutable JS/CSS snapshots for '+version)
