from pathlib import Path
import sys, zipfile
from web_release_files import release_files
root = Path('cloudflare-worker/public')
with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED) as out:
    for relative in release_files():
        file = root / relative
        info = zipfile.ZipInfo(file.relative_to(root).as_posix(), (1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        out.writestr(info, file.read_bytes())
