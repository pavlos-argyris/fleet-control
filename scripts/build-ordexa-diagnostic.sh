#!/usr/bin/env bash
# Standalone one-shot test tool. Never reads production signing/configuration files.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
FC_DIAG_ROOT="$PWD"
FC_DIAG_TOOLS="$FC_DIAG_ROOT/.android-toolchain"
FC_DIAG_JAR="$FC_DIAG_TOOLS/usr/share/java/com.android.android-23.jar"
FC_DIAG_AAPT="$FC_DIAG_TOOLS/usr/lib/android-sdk/build-tools/debian/aapt"
FC_DIAG_ALIGN="$FC_DIAG_TOOLS/usr/lib/android-sdk/build-tools/debian/zipalign"
FC_DIAG_LIBS="$FC_DIAG_TOOLS/usr/lib/x86_64-linux-gnu/android:$FC_DIAG_TOOLS/usr/lib:$FC_DIAG_TOOLS/usr/lib/x86_64-linux-gnu:$FC_DIAG_TOOLS/lib/x86_64-linux-gnu"
FC_DIAG_TMP=$(mktemp -d /tmp/fleet-ordexa-diagnostic.XXXXXX)
trap 'rm -rf -- "$FC_DIAG_TMP"' EXIT
FC_DIAG_OUT="$FC_DIAG_ROOT/.build/ordexa-diagnostic"
mkdir -p "$FC_DIAG_OUT" "$FC_DIAG_TMP/gen" "$FC_DIAG_TMP/classes"
LD_LIBRARY_PATH="$FC_DIAG_LIBS" "$FC_DIAG_AAPT" package -f -m -J "$FC_DIAG_TMP/gen" \
  -M ordexa-diagnostic-android/AndroidManifest.xml -S ordexa-diagnostic-android/res \
  -I "$FC_DIAG_JAR" -F "$FC_DIAG_TMP/resources.ap_"
FC_DIAG_PROVIDER="$FC_DIAG_ROOT/server-android/src/gr/argyrismitsos/fleetserver"
FC_DIAG_SOURCE="$FC_DIAG_ROOT/ordexa-diagnostic-android/src/gr/argyrismitsos/fleetserver"
java -jar "$FC_DIAG_TOOLS/usr/share/java/eclipse-jdt-core-3.32.0.jar" -proc:none -source 8 -target 8 -encoding UTF-8 \
  -cp "$FC_DIAG_JAR" -d "$FC_DIAG_TMP/classes" \
  "$FC_DIAG_PROVIDER/OrdexaClient.java" "$FC_DIAG_PROVIDER/StoreBillingProtocol.java" "$FC_DIAG_PROVIDER/StoreBillingEngine.java" \
  "$FC_DIAG_SOURCE/OrdexaDiagnosticSession.java" "$FC_DIAG_SOURCE/OrdexaDiagnosticActivity.java" \
  "$FC_DIAG_TMP/gen/gr/argyrismitsos/fleetordexadiagnostic/R.java"
java -jar "$FC_DIAG_TOOLS/usr/share/java/com.android.dx-10.0.0.jar" --dex --min-sdk-version=26 --output="$FC_DIAG_TMP/classes.dex" "$FC_DIAG_TMP/classes"
cp "$FC_DIAG_TMP/resources.ap_" "$FC_DIAG_TMP/unsigned.apk"
(cd "$FC_DIAG_TMP" && LD_LIBRARY_PATH="$FC_DIAG_LIBS" "$FC_DIAG_AAPT" add unsigned.apk classes.dex >/dev/null)
python3 scripts/normalize-apk.py "$FC_DIAG_TMP/unsigned.apk" "$FC_DIAG_TMP/normalized.apk"
LD_LIBRARY_PATH="$FC_DIAG_LIBS" "$FC_DIAG_ALIGN" -f 4 "$FC_DIAG_TMP/normalized.apk" "$FC_DIAG_TMP/aligned.apk"
export FC_DIAG_PASSWORD=diagnostic-test-only
keytool -genkeypair -keystore "$FC_DIAG_TMP/test-only.p12" -storetype PKCS12 -alias diagnostic \
  -keyalg RSA -keysize 2048 -validity 365 -dname 'CN=Fleet Ordexa Diagnostic Test' \
  -storepass:env FC_DIAG_PASSWORD -keypass:env FC_DIAG_PASSWORD >/dev/null 2>&1
FC_DIAG_APK="$FC_DIAG_OUT/Fleet_Ordexa_Diagnostic_v0.1.0.apk"
java -jar "$FC_DIAG_TOOLS/usr/share/java/apksigner-31.0.2.jar" sign \
  --ks "$FC_DIAG_TMP/test-only.p12" --ks-key-alias diagnostic \
  --ks-pass env:FC_DIAG_PASSWORD --key-pass env:FC_DIAG_PASSWORD --out "$FC_DIAG_APK" "$FC_DIAG_TMP/aligned.apk"
java -jar "$FC_DIAG_TOOLS/usr/share/java/apksigner-31.0.2.jar" verify --verbose --print-certs "$FC_DIAG_APK" > "$FC_DIAG_OUT/signature.txt"
LD_LIBRARY_PATH="$FC_DIAG_LIBS" "$FC_DIAG_AAPT" dump xmltree "$FC_DIAG_APK" AndroidManifest.xml > "$FC_DIAG_OUT/compiled-manifest.txt"
python3 scripts/check-ordexa-diagnostic-apk.py "$FC_DIAG_OUT"
cp docs/ORDEXA_DIAGNOSTIC_GR.md "$FC_DIAG_OUT/README.md"
git rev-parse HEAD > "$FC_DIAG_OUT/SOURCE_COMMIT.txt"
(cd "$FC_DIAG_OUT" && sha256sum Fleet_Ordexa_Diagnostic_v0.1.0.apk > SHA256SUMS.txt)
echo "Built standalone manual diagnostic: $FC_DIAG_APK"
