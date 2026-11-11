#!/usr/bin/env bash
set -euo pipefail
# CI runner only: avoid the observed Azure mirror DNS failure. APT signature verification stays enabled.
[[ "${GITHUB_ACTIONS:-}" == "true" ]] || { echo 'This setup is only for an ephemeral GitHub Actions runner.' >&2; exit 1; }
if [[ -f /etc/apt/apt-mirrors.txt ]]; then
  printf '%s\n' 'https://archive.ubuntu.com/ubuntu' 'https://security.ubuntu.com/ubuntu' | sudo tee /etc/apt/apt-mirrors.txt >/dev/null
fi
for FLEET_CI_DOMAIN in archive.ubuntu.com security.ubuntu.com; do
  if ! timeout 5 getent ahostsv4 "$FLEET_CI_DOMAIN" >/dev/null; then
    # Scope recovery to these two public hosts. APT still verifies TLS and the Ubuntu archive signatures.
    python3 scripts/ci-ubuntu-dns.py "$FLEET_CI_DOMAIN" | sudo tee -a /etc/hosts >/dev/null
  fi
done
sudo apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update
sudo apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install -y "$@"
