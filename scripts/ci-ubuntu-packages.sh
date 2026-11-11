#!/usr/bin/env bash
set -euo pipefail
# CI runner only: avoid the observed Azure mirror DNS failure. APT signature verification stays enabled.
[[ "${GITHUB_ACTIONS:-}" == "true" ]] || { echo 'This setup is only for an ephemeral GitHub Actions runner.' >&2; exit 1; }
if [[ -f /etc/apt/apt-mirrors.txt ]]; then
  printf '%s\n' 'https://archive.ubuntu.com/ubuntu' 'https://security.ubuntu.com/ubuntu' | sudo tee /etc/apt/apt-mirrors.txt >/dev/null
fi
for FLEET_CI_DOMAIN in archive.ubuntu.com security.ubuntu.com; do
  if ! timeout 5 getent ahostsv4 "$FLEET_CI_DOMAIN" >/dev/null; then
    # HTTPS resolver documented at https://developers.google.com/speed/public-dns/docs/doh/json
    # Scope recovery to these two public hosts. APT still verifies TLS and the Ubuntu archive signatures.
    python3 - "$FLEET_CI_DOMAIN" <<'PY' | sudo tee -a /etc/hosts >/dev/null
import sys,json,ipaddress,urllib.request
host=sys.argv[1]
assert host in ('archive.ubuntu.com','security.ubuntu.com')
with urllib.request.urlopen('https://dns.google/resolve?name='+host+'&type=A&cd=false&edns_client_subnet=0.0.0.0/0',timeout=20) as response:
    value=json.loads(response.read(65536))
assert value.get('Status')==0 and not value.get('TC') and not value.get('CD')
assert any(q.get('name','').rstrip('.')==host and q.get('type')==1 for q in value.get('Question',[]))
addresses={str(ipaddress.IPv4Address(row['data'])) for row in value.get('Answer',[]) if row.get('type')==1}
assert addresses and all(ipaddress.ip_address(address).is_global for address in addresses)
for address in sorted(addresses):print(address,host)
print('Recovered CI resolver for '+host+' via authenticated HTTPS; archive verification remains enabled.',file=sys.stderr)
PY
  fi
done
sudo apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update
sudo apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install -y "$@"
