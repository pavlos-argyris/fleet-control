from pathlib import Path
import sys, zipfile
root = Path('cloudflare-worker/public')
with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED) as out:
    for file in sorted(root.rglob('*')):
        if file.is_file():
            info = zipfile.ZipInfo(file.relative_to(root).as_posix(), (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            out.writestr(info, file.read_bytes())
