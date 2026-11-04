#!/usr/bin/env bash
# Fast, dependency-free source checks. The full required check.yml / check-all.sh
# remains the only source-CI authority for publication.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "::group::Shell syntax"
for script in scripts/*.sh; do bash -n "$script"; done
echo "::endgroup::"

echo "::group::JavaScript syntax"
for file in scripts/*.mjs cloudflare-worker/src/*.js client-android/assets/www/app.js server-android/assets/www/app.js; do
  [[ -f "$file" ]] || continue
  node --check "$file" >/dev/null
done
echo "::endgroup::"

echo "::group::Tracked source and role rules"
python3 scripts/check-source-safety.py
node scripts/prepare-direct-permissions.mjs --check
echo "::endgroup::"

echo "::group::Lightweight release and transport contracts"
node scripts/check-release-capacity.mjs
node --test scripts/test-publish-request.mjs
node scripts/test-release-transport.mjs
echo "::endgroup::"

echo "PASS fast source gate. Full browser/native/Android/Worker checks remain mandatory before merge and publication."
