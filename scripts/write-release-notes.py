"""Render publication notes from the same version/notes used by OTA."""
from pathlib import Path
import json
import re
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
config = json.loads((root / 'release-config.json').read_text())
source = sys.argv[2] if len(sys.argv) > 2 else subprocess.check_output(
    ['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
assert re.fullmatch(r'[a-f0-9]{40}', source), 'A saved source commit is required'
notes = [line.strip().lstrip('•-').strip() for line in config['notes'].splitlines() if line.strip()]
assert notes, 'Release notes must describe the current update'
base = 'https://github.com/pavlos-argyris/fleet-control'
body = '# Fleet Control ' + config['releaseVersion'] + '\n\n'
body += 'Client/Web ' + config['client']['version'] + ' · Server ' + config['server']['version'] + ' · Worker ' + config['worker']['version'] + '.\n\n'
body += '\n'.join('- ' + line for line in notes) + '\n\n'
body += '[Πλήρης πηγαίος κώδικας APK](' + base + '/tree/' + source + ') · [Οδηγίες και έλεγχοι](' + base + '/blob/' + source + '/README_GR.md).\n'
target = Path(sys.argv[1])
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(body)
