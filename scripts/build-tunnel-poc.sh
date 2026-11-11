#!/usr/bin/env bash
# Separate package and ephemeral TEST signing. Never sources production secrets.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
FC_POC_ROOT="$PWD"
FC_POC_TOOLS="$FC_POC_ROOT/.android-toolchain"
FC_POC_OUT="$FC_POC_ROOT/.build/tunnel-poc"
FC_POC_TMP=$(mktemp -d /tmp/fleet-tunnel-poc.XXXXXX)
trap 'rm -rf -- "$FC_POC_TMP"' EXIT
FC_POC_JAR="$FC_POC_TOOLS/usr/share/java/com.android.android-23.jar"
FC_POC_AAPT="$FC_POC_TOOLS/usr/lib/android-sdk/build-tools/debian/aapt"
FC_POC_ALIGN="$FC_POC_TOOLS/usr/lib/android-sdk/build-tools/debian/zipalign"
FC_POC_LIBS="$FC_POC_TOOLS/usr/lib/x86_64-linux-gnu/android:$FC_POC_TOOLS/usr/lib:$FC_POC_TOOLS/usr/lib/x86_64-linux-gnu:$FC_POC_TOOLS/lib/x86_64-linux-gnu"
test -f "$FC_POC_OUT/lib/arm64-v8a/libcloudflared.so"
test -f "$FC_POC_OUT/assets/connector.json"
mkdir -p "$FC_POC_TMP/gen" "$FC_POC_TMP/classes" "$FC_POC_TMP/lib/arm64-v8a"
LD_LIBRARY_PATH="$FC_POC_LIBS" "$FC_POC_AAPT" package -x -f \
  -M android-build-support/fgs-extension/AndroidManifest.xml -S android-build-support/fgs-extension/res \
  -I "$FC_POC_JAR" -F "$FC_POC_TMP/fgs.apk"
LD_LIBRARY_PATH="$FC_POC_LIBS" "$FC_POC_AAPT" package -f -m -J "$FC_POC_TMP/gen" \
  -M tunnel-poc-android/AndroidManifest.xml -S tunnel-poc-android/res -A "$FC_POC_OUT/assets" \
  -I "$FC_POC_TMP/fgs.apk" -I "$FC_POC_JAR" -F "$FC_POC_TMP/resources.ap_"
mapfile -t FC_POC_SOURCES < <(python3 -c 'from pathlib import Path; print("\n".join(str(p) for p in sorted(Path("tunnel-poc-android/src").rglob("*.java"))))')
test "${#FC_POC_SOURCES[@]}" -gt 0
java -jar "$FC_POC_TOOLS/usr/share/java/eclipse-jdt-core-3.32.0.jar" -proc:none -source 8 -target 8 -encoding UTF-8 \
  -cp "$FC_POC_JAR" -d "$FC_POC_TMP/classes" "${FC_POC_SOURCES[@]}"
test -f "$FC_POC_TMP/classes/gr/argyrismitsos/fleettunnelpoc/PocService.class"
java -jar "$FC_POC_TOOLS/usr/share/java/com.android.dx-10.0.0.jar" --dex --min-sdk-version=26 \
  --output="$FC_POC_TMP/classes.dex" "$FC_POC_TMP/classes"
test -s "$FC_POC_TMP/classes.dex"
cp "$FC_POC_OUT/lib/arm64-v8a/libcloudflared.so" "$FC_POC_TMP/lib/arm64-v8a/"
cp "$FC_POC_TMP/resources.ap_" "$FC_POC_TMP/unsigned.apk"
(cd "$FC_POC_TMP" && LD_LIBRARY_PATH="$FC_POC_LIBS" "$FC_POC_AAPT" add unsigned.apk classes.dex lib/arm64-v8a/libcloudflared.so >/dev/null)
python3 scripts/normalize-apk.py "$FC_POC_TMP/unsigned.apk" "$FC_POC_TMP/normalized.apk"
LD_LIBRARY_PATH="$FC_POC_LIBS" "$FC_POC_ALIGN" -f 4 "$FC_POC_TMP/normalized.apk" "$FC_POC_TMP/aligned.apk"
export FC_POC_PASSWORD=fleet-tunnel-test-only
keytool -genkeypair -keystore "$FC_POC_TMP/test-only.p12" -storetype PKCS12 -alias tunnel-test \
  -keyalg RSA -keysize 2048 -validity 365 -dname 'CN=Fleet Tunnel PoC TEST ONLY' \
  -storepass:env FC_POC_PASSWORD -keypass:env FC_POC_PASSWORD >/dev/null 2>&1
FC_POC_APK="$FC_POC_OUT/Fleet_Tunnel_TEST_0.2.0.apk"
java -jar "$FC_POC_TOOLS/usr/share/java/apksigner-31.0.2.jar" sign \
  --ks "$FC_POC_TMP/test-only.p12" --ks-key-alias tunnel-test --ks-pass env:FC_POC_PASSWORD \
  --key-pass env:FC_POC_PASSWORD --out "$FC_POC_APK" "$FC_POC_TMP/aligned.apk"
java -jar "$FC_POC_TOOLS/usr/share/java/apksigner-31.0.2.jar" verify --verbose --print-certs "$FC_POC_APK" > "$FC_POC_OUT/test-signature.txt"
LD_LIBRARY_PATH="$FC_POC_LIBS" "$FC_POC_AAPT" dump xmltree "$FC_POC_APK" AndroidManifest.xml > "$FC_POC_OUT/compiled-manifest.txt"
python3 scripts/check-tunnel-poc-apk.py "$FC_POC_OUT"
cp docs/ANDROID_TUNNEL_POC_GR.md "$FC_POC_OUT/README.md"
git rev-parse HEAD > "$FC_POC_OUT/SOURCE_COMMIT.txt"
(cd "$FC_POC_OUT" && sha256sum Fleet_Tunnel_TEST_0.2.0.apk cloudflared-upstream-source.tar > SHA256SUMS.txt)
echo "Built separate TEST package; no Fleet update or cutover."
