from pathlib import Path
import hashlib,zipfile
root=Path(__file__).resolve().parents[1]
archive=root/'vendor/pdf-viewer-6.4.299.zip'
assert hashlib.sha256(archive.read_bytes()).hexdigest() == "818c7d7fe6abd45224ff9997ea25a021204518d833c50252d1b16943a37e766f", 'PDF viewer checksum differs'
with zipfile.ZipFile(archive) as z:
    assert all(not Path(n).is_absolute() and '..' not in Path(n).parts for n in z.namelist())
    for folder in ['cloudflare-worker/public/vendor/pdfjs','client-android/assets/www/vendor/pdfjs']:
        target=root/folder;target.mkdir(parents=True,exist_ok=True);z.extractall(target)
print('Prepared pinned Mozilla PDF viewer')
