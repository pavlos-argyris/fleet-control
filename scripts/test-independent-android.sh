#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "${GITHUB_ACTIONS:-}" = true || { echo 'This test provisions only a disposable CI emulator.' >&2; exit 1; }
FLEET_SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
FLEET_SDK_TOOLS="$FLEET_SDK_ROOT/cmdline-tools/latest/bin"
export PATH="$FLEET_SDK_ROOT/platform-tools:$FLEET_SDK_ROOT/emulator:$FLEET_SDK_TOOLS:$PATH"
mkdir -p .build/independent-android-test
python3 scripts/build-independent-android-test.py
test -e /dev/kvm
sudo chmod a+rw /dev/kvm
sdkmanager 'system-images;android-30;google_apis;x86_64' > .build/independent-android-test/sdk.log 2>&1
echo no | avdmanager create avd --force --name fleet-sqlite --package 'system-images;android-30;google_apis;x86_64' > .build/independent-android-test/avd.log 2>&1
emulator -avd fleet-sqlite -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect -cores 2 -memory 2048 > .build/independent-android-test/emulator.log 2>&1 &
FLEET_EMULATOR_PID=$!
cleanup(){ adb logcat -d -v brief > .build/independent-android-test/logcat.txt 2>&1 || true; kill "$FLEET_EMULATOR_PID" 2>/dev/null || true; }
trap cleanup EXIT
timeout 240 adb wait-for-device
FLEET_ANDROID_BOOTED=false
for ((attempt=0;attempt<120;attempt++)); do
  if [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; then FLEET_ANDROID_BOOTED=true; break; fi
  sleep 2
done
test "$FLEET_ANDROID_BOOTED" = true
adb shell input keyevent 82
adb install -r .build/independent-delivery/Fleet_Independent_Server_v1.0.0-test2.apk
adb install -r .build/independent-android-test/sqlite-tests.apk
timeout 360 adb shell am instrument -w gr.argyrismitsos.fleetserver.sqlitetest/gr.argyrismitsos.fleetserver.AndroidSqliteChecks | tee .build/independent-android-test/instrumentation.txt
rg -q '^INSTRUMENTATION_RESULT: stream=PASS actual Android bundled SQLite' .build/independent-android-test/instrumentation.txt
rg -q '^INSTRUMENTATION_CODE: -1' .build/independent-android-test/instrumentation.txt
echo 'PASS actual API30 Android SQLite/JNI + full SAF FCB3 cold import and owner login.'
