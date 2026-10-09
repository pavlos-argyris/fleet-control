from pathlib import Path
import re, subprocess
files = subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0')
errors = []
for name in filter(None, files):
    if any(part in name.split('/') for part in ['private', 'signing', 'node_modules']) or name.endswith(('.p12', '.jks', '.keystore', 'PRIVATE_SETUP_KEYS.txt', 'BuildSecrets.java', '.dev.vars')):
        errors.append(name)
        continue
    try:
        text = Path(name).read_text()
    except (UnicodeError, OSError):
        continue
    if re.search(r'(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|SERVER_KEY\s*=\s*"[^"\n]{24,}"', text):
        errors.append(name)
if errors:
    raise SystemExit('Private values/files cannot be committed: ' + ', '.join(errors))
print('Tracked source contains no signing files or embedded Server credential.')
