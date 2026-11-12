#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "${GITHUB_ACTIONS:-}" = true || { echo 'This test provisions only a disposable CI emulator.' >&2; exit 1; }
FLEET_SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
FLEET_SDK_TOOLS="$FLEET_SDK_ROOT/cmdline-tools/latest/bin"
export PATH="$FLEET_SDK_ROOT/platform-tools:$FLEET_SDK_ROOT/emulator:$FLEET_SDK_TOOLS:$PATH"
mkdir -p .build/independent-android-test
export ANDROID_USER_HOME="$PWD/.build/independent-android-test/android-user"
export ANDROID_EMULATOR_HOME="$ANDROID_USER_HOME"
export ANDROID_AVD_HOME="$PWD/.build/independent-android-test/avd"
export ANDROID_SERIAL=emulator-5554
mkdir -p "$ANDROID_USER_HOME" "$ANDROID_AVD_HOME"
python3 scripts/build-independent-android-test.py
test -e /dev/kvm
sudo chmod a+rw /dev/kvm
timeout 300 sdkmanager 'system-images;android-30;default;x86_64' 2>&1 | tee .build/independent-android-test/sdk.log
echo no | timeout 60 avdmanager create avd --force --name fleet-sqlite --path "$ANDROID_AVD_HOME/fleet-sqlite.avd" --package 'system-images;android-30;default;x86_64' 2>&1 | tee .build/independent-android-test/avd.log
# SDK tools and emulator versions may use different default user directories.
# Keep the descriptor explicit as well as the shared documented environment.
printf 'avd.ini.encoding=UTF-8\npath=%s\ntarget=android-30\n' "$ANDROID_AVD_HOME/fleet-sqlite.avd" > "$ANDROID_AVD_HOME/fleet-sqlite.ini"
emulator -list-avds | tee .build/independent-android-test/avd-list.log
rg -q '^fleet-sqlite$' .build/independent-android-test/avd-list.log
emulator -avd fleet-sqlite -port 5554 -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect -cores 2 -memory 2048 > .build/independent-android-test/emulator.log 2>&1 &
FLEET_EMULATOR_PID=$!
cleanup(){ timeout 10 adb logcat -d -v brief > .build/independent-android-test/logcat.txt 2>&1 || true; kill "$FLEET_EMULATOR_PID" 2>/dev/null || true; }
trap cleanup EXIT
timeout 20 adb start-server
FLEET_ANDROID_BOOTED=false
FLEET_BOOT_DEADLINE=$((SECONDS+240))
while ((SECONDS<FLEET_BOOT_DEADLINE)); do
  kill -0 "$FLEET_EMULATOR_PID" 2>/dev/null || { tail -80 .build/independent-android-test/emulator.log; exit 1; }
  if [[ "$(timeout 5 adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)" == 1 ]]; then FLEET_ANDROID_BOOTED=true; break; fi
  sleep 2
done
test "$FLEET_ANDROID_BOOTED" = true
adb shell input keyevent 82
timeout 60 adb install -r .build/independent-delivery/Fleet_Independent_Server_v1.0.0-test6.apk
timeout 30 adb install -r .build/independent-android-test/sqlite-tests.apk
timeout 360 adb shell am instrument -w -r gr.argyrismitsos.fleetserver.sqlitetest/gr.argyrismitsos.fleetserver.AndroidSqliteChecks | tee .build/independent-android-test/instrumentation.txt
rg -q '^INSTRUMENTATION_RESULT: stream=PASS actual Android bundled SQLite' .build/independent-android-test/instrumentation.txt
rg -q '^INSTRUMENTATION_CODE: -1' .build/independent-android-test/instrumentation.txt
echo 'PASS actual API30 Android SQLite/JNI + full SAF FCB3 cold import and owner login.'
