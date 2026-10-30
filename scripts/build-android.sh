#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOLCHAIN_ROOT="${FLEET_ANDROID_TOOLCHAIN_ROOT:-$PROJECT_ROOT/.android-toolchain}"
ANDROID_JAR="${FLEET_ANDROID_JAR:-$TOOLCHAIN_ROOT/usr/share/java/com.android.android-23.jar}"
AAPT_BIN="${FLEET_AAPT_BIN:-$TOOLCHAIN_ROOT/usr/lib/android-sdk/build-tools/debian/aapt}"
ECJ_JAR="${FLEET_ECJ_JAR:-$TOOLCHAIN_ROOT/usr/share/java/eclipse-jdt-core-3.32.0.jar}"
DX_JAR="${FLEET_DX_JAR:-$TOOLCHAIN_ROOT/usr/share/java/com.android.dx-10.0.0.jar}"
ZIPALIGN_BIN="${FLEET_ZIPALIGN_BIN:-$TOOLCHAIN_ROOT/usr/lib/android-sdk/build-tools/debian/zipalign}"
APKSIGNER_JAR="${FLEET_APKSIGNER_JAR:-$TOOLCHAIN_ROOT/usr/share/java/apksigner-31.0.2.jar}"
KEYSTORE="${FLEET_KEYSTORE:-$PROJECT_ROOT/private/signing/fleet-control-release.p12}"
PRIVATE_KEYS="${FLEET_PRIVATE_KEYS:-$PROJECT_ROOT/private/PRIVATE_SETUP_KEYS.txt}"
DIST="$PROJECT_ROOT/dist"
BUILD_TARGET="${1:-all}"
python3 "$PROJECT_ROOT/scripts/prepare-pdf-viewer.py"
python3 "$PROJECT_ROOT/scripts/prepare-static-assets.py"
(cd "$PROJECT_ROOT" && node scripts/prepare-direct-permissions.mjs --check)

if [[ "$BUILD_TARGET" != "all" && "$BUILD_TARGET" != "client" && "$BUILD_TARGET" != "server" ]]; then
  echo "Χρήση: $0 [all|client|server]" >&2
  exit 2
fi

for required in "$ANDROID_JAR" "$AAPT_BIN" "$ECJ_JAR" "$DX_JAR" "$ZIPALIGN_BIN" "$APKSIGNER_JAR" "$KEYSTORE"; do
  if [[ ! -e "$required" ]]; then
    echo "Λείπει απαραίτητο αρχείο: $required" >&2
    exit 1
  fi
done

read_private_value() {
  if [[ ! -f "$PRIVATE_KEYS" ]]; then return; fi
  awk -F= -v requested="$1" '$1 == requested {sub(/^[^=]*=/, ""); print; exit}' "$PRIVATE_KEYS"
}

FC_STORE_PASSWORD="${FLEET_STORE_PASSWORD:-$(read_private_value STORE_PASSWORD)}"
FC_KEY_PASSWORD="${FLEET_KEY_PASSWORD:-$(read_private_value KEY_PASSWORD)}"
FC_KEY_ALIAS="${FLEET_KEY_ALIAS:-$(read_private_value ALIAS)}"
if [[ -z "$FC_STORE_PASSWORD" || -z "$FC_KEY_PASSWORD" || -z "$FC_KEY_ALIAS" ]]; then
  echo "Δεν βρέθηκαν τα στοιχεία υπογραφής." >&2
  exit 1
fi

export FLEET_STORE_PASSWORD="$FC_STORE_PASSWORD" FLEET_KEY_PASSWORD="$FC_KEY_PASSWORD"

FC_TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fleet-control-build.XXXXXX")"
cleanup() {
  if [[ "${FLEET_KEEP_BUILD:-}" == "1" ]]; then return; fi
  if [[ -n "${FC_TMP_ROOT:-}" && -d "$FC_TMP_ROOT" ]]; then
    rm -rf -- "$FC_TMP_ROOT"
  fi
}
trap cleanup EXIT
mkdir -p "$DIST"

FC_ANDROID_LIBS="$TOOLCHAIN_ROOT/usr/lib/x86_64-linux-gnu/android:$TOOLCHAIN_ROOT/usr/lib:$TOOLCHAIN_ROOT/usr/lib/x86_64-linux-gnu:$TOOLCHAIN_ROOT/lib/x86_64-linux-gnu"
FC_FGS_FRAMEWORK=""

build_fgs_framework_extension() {
  local extension_root="$PROJECT_ROOT/android-build-support/fgs-extension"
  FC_FGS_FRAMEWORK="$FC_TMP_ROOT/android-fgs-framework.apk"
  LD_LIBRARY_PATH="$FC_ANDROID_LIBS" "$AAPT_BIN" package -x -f \
    -M "$extension_root/AndroidManifest.xml" \
    -S "$extension_root/res" \
    -I "$ANDROID_JAR" \
    -F "$FC_FGS_FRAMEWORK"
}

build_apk() {
  local source_dir="$1"
  local output_name="$2"
  local framework_extension="${3:-}"
  local work_dir="$FC_TMP_ROOT/$output_name"
  mkdir -p "$work_dir/gen" "$work_dir/classes"
  local asset_dir="$source_dir/assets"
  local compile_classpath="$ANDROID_JAR"
  local invoice_jars=()
  if [[ "$source_dir" == "$PROJECT_ROOT/server-android" ]]; then
    python3 "$PROJECT_ROOT/scripts/prepare-invoice-dependencies.py" "$work_dir/invoice-deps"
    mkdir -p "$work_dir/assets"
    cp -R "$source_dir/assets/." "$work_dir/assets/"
    cp -R "$work_dir/invoice-deps/assets/." "$work_dir/assets/"
    asset_dir="$work_dir/assets"
    mapfile -t invoice_jars < <(rg --files "$work_dir/invoice-deps/jars" -g '*.jar' | sort)
    for jar in "${invoice_jars[@]}"; do compile_classpath="$compile_classpath:$jar"; done
  fi

  local framework_args=()
  if [[ -n "$framework_extension" ]]; then
    framework_args+=( -I "$framework_extension" )
  fi
  framework_args+=( -I "$ANDROID_JAR" )

  LD_LIBRARY_PATH="$FC_ANDROID_LIBS" "$AAPT_BIN" package -f -m \
    -J "$work_dir/gen" \
    -M "$source_dir/AndroidManifest.xml" \
    -S "$source_dir/res" \
    -A "$asset_dir" \
    "${framework_args[@]}" \
    -F "$work_dir/resources.ap_"

  if [[ "$source_dir" == "$PROJECT_ROOT/server-android" ]]; then
    (cd "$PROJECT_ROOT" && node scripts/generate-build-secrets.mjs "$work_dir/gen/gr/argyrismitsos/fleetserver/BuildSecrets.java")
  fi
  mapfile -t java_sources < <(rg --files "$source_dir/src" "$PROJECT_ROOT/common-android/src" "$work_dir/gen" -g '*.java' | sort)
  java -cp "$ECJ_JAR" org.eclipse.jdt.internal.compiler.batch.Main \
    -proc:none -source 1.8 -target 1.8 \
    -classpath "$compile_classpath" \
    -d "$work_dir/classes" \
    "${java_sources[@]}"

  if [[ "$source_dir" == "$PROJECT_ROOT/server-android" ]]; then
    python3 - "$work_dir" <<'PY'
import sys,zipfile
from pathlib import Path
p=Path(sys.argv[1])
with zipfile.ZipFile(p/'program.jar','w') as z:
 for f in sorted((p/'classes').rglob('*.class')): z.writestr(str(f.relative_to(p/'classes')),f.read_bytes())
for f in (p/'invoice-deps/jars').glob('*.jar'):
 with zipfile.ZipFile(f) as src: data={n:src.read(n) for n in src.namelist() if n.endswith('.class') and not n.startswith('META-INF/') and not n.endswith('module-info.class')}
 with zipfile.ZipFile(f,'w') as dst:
  for n,b in sorted(data.items()):dst.writestr(n,b)
PY
    mkdir -p "$work_dir/dex"
    java -cp "$work_dir/invoice-deps/r8.jar" com.android.tools.r8.D8 --release --min-api 23 --lib "$ANDROID_JAR" --output "$work_dir/dex" "$work_dir/program.jar" "${invoice_jars[@]}"
    cp "$work_dir/dex/"*.dex "$work_dir/"
  else
    java -jar "$DX_JAR" --dex --output="$work_dir/classes.dex" "$work_dir/classes"
  fi
  cp "$work_dir/resources.ap_" "$work_dir/unsigned.apk"
  (cd "$work_dir" && LD_LIBRARY_PATH="$FC_ANDROID_LIBS" "$AAPT_BIN" add unsigned.apk classes*.dex >/dev/null)
  if [[ "$source_dir" == "$PROJECT_ROOT/server-android" ]]; then
    python3 - "$work_dir" <<'PY'
import sys,zipfile
from pathlib import Path
p=Path(sys.argv[1])
with zipfile.ZipFile(p/'unsigned.apk','a',zipfile.ZIP_DEFLATED) as z:
 for f in sorted((p/'invoice-deps/lib').rglob('*.so')):z.writestr('lib/'+str(f.relative_to(p/'invoice-deps/lib')),f.read_bytes())
PY
  fi
  python3 "$PROJECT_ROOT/scripts/normalize-apk.py" "$work_dir/unsigned.apk" "$work_dir/deterministic.apk"
  LD_LIBRARY_PATH="$FC_ANDROID_LIBS" "$ZIPALIGN_BIN" -f 4 "$work_dir/deterministic.apk" "$work_dir/aligned.apk"

  rm -f "$DIST/$output_name.apk"
  java -jar "$APKSIGNER_JAR" sign \
    --ks "$KEYSTORE" \
    --ks-key-alias "$FC_KEY_ALIAS" \
    --ks-pass env:FLEET_STORE_PASSWORD \
    --key-pass env:FLEET_KEY_PASSWORD \
    --out "$DIST/$output_name.apk" \
    "$work_dir/aligned.apk"
  java -jar "$APKSIGNER_JAR" verify --verbose "$DIST/$output_name.apk" >/dev/null
  echo "Έτοιμο: $DIST/$output_name.apk"
}

if [[ "$BUILD_TARGET" == "all" || "$BUILD_TARGET" == "client" ]]; then
  CLIENT_CONFIG="$PROJECT_ROOT/client-android/assets/www/fleet-config.js"
  if ! rg -q 'apiBase:[[:space:]]*"https://fleet-control\.pavlosargyris\.workers\.dev"' "$CLIENT_CONFIG"; then
    echo "Το Android client δεν έχει έγκυρο απομακρυσμένο apiBase: $CLIENT_CONFIG" >&2
    exit 1
  fi
  build_apk "$PROJECT_ROOT/client-android" "Fleet_Control_Client_v$(sed -n 's/.*android:versionName="\([^"]*\)".*/\1/p' "$PROJECT_ROOT/client-android/AndroidManifest.xml")"
fi

if [[ "$BUILD_TARGET" == "all" || "$BUILD_TARGET" == "server" ]]; then
  build_fgs_framework_extension
  build_apk "$PROJECT_ROOT/server-android" "Fleet_Control_Server_v$(sed -n 's/.*android:versionName="\([^"]*\)".*/\1/p' "$PROJECT_ROOT/server-android/AndroidManifest.xml")" "$FC_FGS_FRAMEWORK"
fi
