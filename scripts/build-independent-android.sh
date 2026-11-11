#!/usr/bin/env bash
set -euo pipefail
FLEET_TASK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$FLEET_TASK_ROOT"
python3 scripts/prepare-independent-build.py
export FLEET_ISOLATED_BUILD=1
export FLEET_ANDROID_TOOLCHAIN_ROOT="$FLEET_TASK_ROOT/.android-toolchain"
# No production server secret is embedded in either independent APK.
export FLEET_SERVER_KEY="independent-internal-placeholder-never-accepted-over-network"
bash .build/independent-source/scripts/build-android.sh all
mkdir -p .build/independent-delivery
cp .build/independent-source/dist/Fleet_Control_Server_v1.0.0-test1.apk .build/independent-delivery/Fleet_Independent_Server_v1.0.0-test1.apk
cp .build/independent-source/dist/Fleet_Control_Client_v1.0.0-test1.apk .build/independent-delivery/Fleet_Independent_Client_v1.0.0-test1.apk
python3 scripts/check-independent-apks.py .build/independent-delivery
