#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test "${GITHUB_ACTIONS:-}" = true || { echo 'This test provisions only a disposable CI emulator.' >&2; exit 1; }
FLEET_SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
FLEET_SDK_TOOLS="$FLEET_SDK_ROOT/cmdline-tools/latest/bin"
export PATH="$FLEET_SDK_ROOT/platform-tools:$FLEET_SDK_ROOT/emulator:$FLEET_SDK_TOOLS:$PATH"
FLEET_TEST_DIR=.build/independent-android-test
FLEET_TEST_COMPONENT=gr.argyrismitsos.fleetserver.sqlitetest/gr.argyrismitsos.fleetserver.AndroidSqliteChecks
FLEET_TEST_SETUP_COMPONENT=gr.argyrismitsos.fleetserver.sqlitetest/gr.argyrismitsos.fleetserver.SyntheticBackupActivity
FLEET_TEST_SERVER=.build/independent-delivery/Fleet_Independent_Server_v1.0.0-test6.apk
FLEET_TEST_ARGS=()
if [[ "${FLEET_UNIFIED_TEST:-}" == "1" ]]; then
  FLEET_TEST_DIR=.build/unified-android-test
  FLEET_TEST_COMPONENT=gr.argyrismitsos.fleetdirect.sqlitetest/gr.argyrismitsos.fleetdirect.AndroidSqliteChecks
  FLEET_TEST_SETUP_COMPONENT=gr.argyrismitsos.fleetdirect.sqlitetest/gr.argyrismitsos.fleetdirect.SyntheticBackupActivity
  FLEET_TEST_SERVER="$FLEET_TEST_DIR/server-abi-test.apk"
  FLEET_TEST_ARGS=(--unified)
fi
mkdir -p "$FLEET_TEST_DIR"
export ANDROID_USER_HOME="$PWD/${FLEET_TEST_DIR}/android-user"
export ANDROID_EMULATOR_HOME="$ANDROID_USER_HOME"
export ANDROID_AVD_HOME="$PWD/${FLEET_TEST_DIR}/avd"
export ANDROID_SERIAL=emulator-5554
mkdir -p "$ANDROID_USER_HOME" "$ANDROID_AVD_HOME"
python3 scripts/build-independent-android-test.py "${FLEET_TEST_ARGS[@]}"
test -e /dev/kvm
sudo chmod a+rw /dev/kvm
timeout 300 sdkmanager 'system-images;android-30;default;x86_64' 2>&1 | tee ${FLEET_TEST_DIR}/sdk.log
echo no | timeout 60 avdmanager create avd --force --name fleet-sqlite --path "$ANDROID_AVD_HOME/fleet-sqlite.avd" --package 'system-images;android-30;default;x86_64' 2>&1 | tee ${FLEET_TEST_DIR}/avd.log
# SDK tools and emulator versions may use different default user directories.
# Keep the descriptor explicit as well as the shared documented environment.
printf 'avd.ini.encoding=UTF-8\npath=%s\ntarget=android-30\n' "$ANDROID_AVD_HOME/fleet-sqlite.avd" > "$ANDROID_AVD_HOME/fleet-sqlite.ini"
emulator -list-avds | tee ${FLEET_TEST_DIR}/avd-list.log
rg -q '^fleet-sqlite$' ${FLEET_TEST_DIR}/avd-list.log
emulator -avd fleet-sqlite -port 5554 -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect -cores 2 -memory 2048 > ${FLEET_TEST_DIR}/emulator.log 2>&1 &
FLEET_EMULATOR_PID=$!
cleanup(){ timeout 10 adb logcat -d -v brief > ${FLEET_TEST_DIR}/logcat.txt 2>&1 || true; kill "$FLEET_EMULATOR_PID" 2>/dev/null || true; }
trap cleanup EXIT
timeout 20 adb start-server
FLEET_ANDROID_BOOTED=false
FLEET_BOOT_DEADLINE=$((SECONDS+240))
while ((SECONDS<FLEET_BOOT_DEADLINE)); do
  kill -0 "$FLEET_EMULATOR_PID" 2>/dev/null || { tail -80 ${FLEET_TEST_DIR}/emulator.log; exit 1; }
  if [[ "$(timeout 5 adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)" == 1 ]]; then FLEET_ANDROID_BOOTED=true; break; fi
  sleep 2
done
test "$FLEET_ANDROID_BOOTED" = true
adb shell input keyevent 82
timeout 60 adb install -r "$FLEET_TEST_SERVER"
timeout 30 adb install -r ${FLEET_TEST_DIR}/sqlite-tests.apk
timeout 30 adb shell am start -W -n "$FLEET_TEST_SETUP_COMPONENT" | tee ${FLEET_TEST_DIR}/document-owner.log
timeout 360 adb shell am instrument -w -r "$FLEET_TEST_COMPONENT" | tee ${FLEET_TEST_DIR}/instrumentation.txt
rg -q '^INSTRUMENTATION_RESULT: stream=PASS actual Android bundled SQLite' ${FLEET_TEST_DIR}/instrumentation.txt
rg -q '^INSTRUMENTATION_CODE: -1' ${FLEET_TEST_DIR}/instrumentation.txt
echo 'PASS actual API30 Android SQLite/JNI + full SAF FCB3 cold import and owner login.'
