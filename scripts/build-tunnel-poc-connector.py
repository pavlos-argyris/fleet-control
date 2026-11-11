#!/usr/bin/env python3
"""Build a pinned upstream Android executable. No runtime download or credentials."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def run(args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def build(source, go, output):
    lock = json.loads((ROOT / 'tunnel-poc-android/connector.lock.json').read_text())
    if run([go, 'version']).split()[2] != lock['goVersion']:
        raise RuntimeError('The pinned Go toolchain is required')
    commit = run(['git', '-C', str(source), 'rev-parse', lock['commit'] + '^{commit}'])
    if commit != lock['commit']:
        raise RuntimeError('Upstream commit does not match the lock')
    # Archive that exact Git object, ignoring untracked or modified checkout files.
    with tempfile.TemporaryDirectory(prefix='fleet-tunnel-connector-') as temporary:
        work = Path(temporary)
        archive = work / 'upstream.tar'
        with archive.open('wb') as stream:
            subprocess.run(['git', '-C', str(source), 'archive', commit], stdout=stream, check=True)
        pristine = work / 'source'
        pristine.mkdir()
        with tarfile.open(archive) as entries:
            entries.extractall(pristine, filter='data')
        patch = ROOT / 'tunnel-poc-android/connector/fleet_poc_android.go'
        shutil.copyfile(patch, pristine / 'cmd/cloudflared/fleet_poc_android.go')
        native = output / 'lib/arm64-v8a/libcloudflared.so'
        native.parent.mkdir(parents=True, exist_ok=True)
        environment = dict(os.environ, GOTOOLCHAIN='local', CGO_ENABLED='0', GOOS='android', GOARCH='arm64',
                           GOFLAGS='-mod=readonly', GOSUMDB='sum.golang.org', GOPROXY='https://proxy.golang.org')
        subprocess.run([go, 'mod', 'download'], cwd=pristine, env=environment, check=True)
        subprocess.run([go, 'mod', 'verify'], cwd=pristine, env=environment, check=True)
        subprocess.run([go, 'build', '-trimpath', '-buildvcs=false', '-buildmode=pie',
                        '-ldflags=-s -w -buildid= -X main.Version=' + lock['version'] + '-fleet-poc',
                        '-o', str(native.resolve()), './cmd/cloudflared'], cwd=pristine, env=environment, check=True)
        raw = native.read_bytes()
        if raw[:6] != b'\x7fELF\x02\x01' or struct.unpack_from('<HH', raw, 16) != (3, 183) or b'/system/bin/linker64\0' not in raw:
            raise RuntimeError('Expected Android ARM64 PIE ELF with Android linker')
        assets = output / 'assets'
        assets.mkdir(parents=True, exist_ok=True)
        provenance = dict(lock, sha256=hashlib.sha256(raw).hexdigest(),
                          dnsPatchSha256=hashlib.sha256(patch.read_bytes()).hexdigest(),
                          goModSha256=hashlib.sha256((pristine / 'go.mod').read_bytes()).hexdigest(),
                          goSumSha256=hashlib.sha256((pristine / 'go.sum').read_bytes()).hexdigest())
        (assets / 'connector.json').write_text(json.dumps(provenance, indent=2) + '\n')
        shutil.copyfile(pristine / 'LICENSE', assets / 'cloudflared-LICENSE.txt')
        (output / 'GO_BUILD_INFO.txt').write_text(run([go, 'version', '-m', str(native)]) + '\n')
        # A public source archive is useful for review; it contains no credentials.
        shutil.copyfile(archive, output / 'cloudflared-upstream-source.tar')
        print('Built pinned Android-only test connector:', provenance['sha256'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True, help='Clone of the official cloudflare/cloudflared repository')
    parser.add_argument('--go', required=True, help='Absolute path to the pinned Go executable')
    parser.add_argument('--output', type=Path, default=ROOT / '.build/tunnel-poc')
    options = parser.parse_args()
    build(options.source.resolve(), options.go, options.output.resolve())
