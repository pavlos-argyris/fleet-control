#!/usr/bin/env bash
set -euo pipefail
FLEET_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
(cd "$FLEET_ROOT/tools" && sha256sum -c android-toolchain-linux.sha256)
mkdir -p "$FLEET_ROOT/.android-toolchain"
tar -xzf "$FLEET_ROOT/tools/android-toolchain-linux.tar.gz" -C "$FLEET_ROOT/.android-toolchain" --strip-components=1
echo "Android toolchain ready."
