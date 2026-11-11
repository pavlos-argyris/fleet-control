#!/usr/bin/env bash
set -euo pipefail
FLEET_TASK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$FLEET_TASK_ROOT"
mkdir -p .build
exec {FLEET_INDEPENDENT_LOCK_FD}>.build/independent-build.lock
flock -n "$FLEET_INDEPENDENT_LOCK_FD" || { echo "Another isolated build is already running" >&2; exit 1; }
python3 scripts/prepare-independent-build.py
export FLEET_ISOLATED_BUILD=1
export FLEET_ANDROID_TOOLCHAIN_ROOT="$FLEET_TASK_ROOT/.android-toolchain"
export FLEET_SQLITE_CACHE="$FLEET_TASK_ROOT/.build/independent-sqlite"
export FLEET_KEYSTORE="${FLEET_KEYSTORE:-$FLEET_TASK_ROOT/private/signing/fleet-control-release.p12}"
export FLEET_PRIVATE_KEYS="${FLEET_PRIVATE_KEYS:-$FLEET_TASK_ROOT/private/PRIVATE_SETUP_KEYS.txt}"
# No production server secret is embedded in either independent APK.
FLEET_SERVER_KEY=$(git rev-parse 'HEAD^{tree}')
export FLEET_SERVER_KEY
bash .build/independent-source/scripts/build-android.sh all
mkdir -p .build/independent-delivery
cp .build/independent-source/dist/Fleet_Control_Server_v1.0.0-test2.apk .build/independent-delivery/Fleet_Independent_Server_v1.0.0-test2.apk
cp .build/independent-source/dist/Fleet_Control_Client_v1.0.0-test2.apk .build/independent-delivery/Fleet_Independent_Client_v1.0.0-test2.apk
python3 scripts/check-independent-apks.py .build/independent-delivery
