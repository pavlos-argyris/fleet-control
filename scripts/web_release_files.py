"""Bound the OTA inventory while retaining every historical static URL in source.

Cloudflare ASSETS still deploys the complete public directory, so old cached HTML
continues to receive byte-identical immutable assets without executing a Worker.
Only the OTA manifest and portable Web ZIP omit snapshots outside the declared
current/previous versions; previous R2 releases and all Git sources stay intact.
"""
from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[1]


def release_files(root=None, config=None):
    public = Path(root) if root is not None else ROOT / 'cloudflare-worker/public'
    config = config if config is not None else json.loads((ROOT / 'release-config.json').read_text())
    web = config['web']
    retained = web.get('retainedAssetVersions')
    if retained is None:
        return sorted(p.relative_to(public).as_posix() for p in public.rglob('*') if p.is_file())
    versions = [web['version'], *retained]
    if len(versions) > 3 or len(versions) != len(set(versions)):
        raise ValueError('Choose the current and at most two distinct previous asset versions.')
    for version in versions:
        if not re.fullmatch(r'\d+\.\d+\.\d+', version) or not (public / 'assets' / ('v' + version)).is_dir():
            raise ValueError('Missing or invalid retained asset version: ' + str(version))
    result = []
    for p in sorted(public.rglob('*')):
        if not p.is_file():
            continue
        relative = p.relative_to(public).as_posix()
        match = re.match(r'^assets/v(\d+\.\d+\.\d+)/', relative)
        if match and match[1] not in versions:
            continue
        result.append(relative)
    # Every immutable stylesheet/script referenced by current HTML must ship.
    names = set(result)
    for html in ['index.html', 'portal.html']:
        for asset in re.findall(r'(?:src|href)=["\']\./(assets/[^"\']+)', (public / html).read_text()):
            if asset not in names:
                raise ValueError('HTML depends on an omitted asset: ' + asset)
    return result


if __name__ == '__main__':
    print(json.dumps(release_files()))
