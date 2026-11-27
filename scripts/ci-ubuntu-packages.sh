#!/usr/bin/env bash
set -euo pipefail
# Use only the official signed Ubuntu sources for these CI packages. Other
# package feeds preinstalled on the runner can be unavailable independently.
[[ "${GITHUB_ACTIONS:-}" == "true" ]] || { echo 'This setup is only for an ephemeral GitHub Actions runner.' >&2; exit 1; }
. /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_CODENAME:-}" =~ ^[a-z]+$ ]] || { echo 'Expected an Ubuntu CI runner.' >&2; exit 1; }
fleet_ci_sources="$(mktemp -t fleet-ubuntu.XXXXXX.list)"
trap 'rm -f -- "$fleet_ci_sources"' EXIT
chmod 644 "$fleet_ci_sources"
printf 'deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu %s main restricted universe multiverse\n' \
  "$VERSION_CODENAME" "$VERSION_CODENAME-updates" >"$fleet_ci_sources"
printf 'deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://security.ubuntu.com/ubuntu %s-security main restricted universe multiverse\n' \
  "$VERSION_CODENAME" >>"$fleet_ci_sources"
for FLEET_CI_DOMAIN in archive.ubuntu.com security.ubuntu.com; do
  if ! timeout 5 getent ahostsv4 "$FLEET_CI_DOMAIN" >/dev/null; then
    # Scope recovery to these two public hosts. APT still verifies TLS and the Ubuntu archive signatures.
    python3 scripts/ci-ubuntu-dns.py "$FLEET_CI_DOMAIN" | sudo tee -a /etc/hosts >/dev/null
  fi
done
fleet_ci_apt=(-o "Dir::Etc::sourcelist=$fleet_ci_sources" -o Dir::Etc::sourceparts=- -o Acquire::Retries=3 -o Acquire::https::Timeout=30)
sudo apt-get "${fleet_ci_apt[@]}" update
sudo apt-get "${fleet_ci_apt[@]}" install -y "$@"
