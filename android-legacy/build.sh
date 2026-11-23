#!/usr/bin/env bash
#
# Build a signed, installable APK without Gradle.
#
# Why no Gradle: this app is a single Activity with no third-party libraries, so
# the whole build is javac -> d8 -> aapt2 -> zipalign -> apksigner. That keeps the
# toolchain to the Android SDK command-line tools and a JDK, with nothing else to
# download or keep in sync.
#
# Requirements:
#   JAVA_HOME  -> a JDK 17+ (javac, keytool)
#   ANDROID_HOME (or ANDROID_SDK_ROOT) -> SDK with platforms/android-34 and
#                                         build-tools/35.0.0
#
# Usage:  bash android/build.sh [output.apk]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/app"
BUILD="$HERE/build"
OUT_APK="${1:-$HERE/movie-creator.apk}"

: "${JAVA_HOME:?set JAVA_HOME to a JDK}"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
: "${SDK:?set ANDROID_HOME to the Android SDK}"

BT="$SDK/build-tools/35.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
[ -f "$PLATFORM" ] || { echo "missing $PLATFORM (install platforms;android-34)"; exit 1; }

KEYSTORE="$HERE/moviecreator.keystore"
KS_ALIAS="moviecreator"
KS_PASS="${MOVIECREATOR_KS_PASS:-moviecreator}"

# Android refuses to update an installed app whose signature changed, so every
# build must use the same key or users have to uninstall first and lose data.
# CI has no committed key (it is a secret), so accept it from the environment
# and fall back to generating one that the workflow then caches.
if [ -n "${MOVIECREATOR_KEYSTORE_B64:-}" ]; then
  printf '%s' "$MOVIECREATOR_KEYSTORE_B64" | base64 -d > "$KEYSTORE"
fi

rm -rf "$BUILD"
mkdir -p "$BUILD/compiled" "$BUILD/gen" "$BUILD/classes" "$BUILD/dex"

# The web UI is compiled by Vite into dist/. Copy it in so the APK carries the
# real app instead of an empty WebView that can only ask for a server address.
ASSETS="$APP/src/main/assets/public"
DIST="$HERE/../dist"
if [ -f "$DIST/index.html" ]; then
  echo "[0/7] bundle the web UI into assets/public"
  rm -rf "$ASSETS"
  mkdir -p "$ASSETS"
  cp -R "$DIST"/. "$ASSETS"/
else
  # Refuse rather than ship a blank app: an APK without the UI is the bug this
  # step exists to prevent, and it installs fine, so nothing else would catch it.
  echo "error: $DIST/index.html is missing. Run 'npm run build' first." >&2
  exit 1
fi

echo "[1/7] aapt2 compile resources"
"$BT/aapt2" compile --dir "$APP/src/main/res" -o "$BUILD/compiled/res.zip"

echo "[2/7] aapt2 link (manifest + resources -> base.apk + R.java)"
"$BT/aapt2" link \
  -o "$BUILD/base.apk" \
  -I "$PLATFORM" \
  --manifest "$APP/src/main/AndroidManifest.xml" \
  --java "$BUILD/gen" \
  --min-sdk-version 21 \
  --target-sdk-version 34 \
  --version-code 4 \
  --version-name 1.0.3 \
  -A "$APP/src/main/assets" \
  "$BUILD/compiled/res.zip"

echo "[3/7] javac"
find "$APP/src/main/java" "$BUILD/gen" -name '*.java' > "$BUILD/sources.txt"
"$JAVA_HOME/bin/javac" \
  -source 8 -target 8 -nowarn \
  -bootclasspath "$PLATFORM" \
  -classpath "$PLATFORM" \
  -d "$BUILD/classes" \
  @"$BUILD/sources.txt" 2>&1 | grep -v 'bootstrap class path'
# A compile failure must stop the build. Without this the script went on to
# package an APK with no classes.dex, which installs and then crashes.
[ -f "$BUILD/classes/im/moviecreator/app/MainActivity.class" ] || {
  echo "javac produced no MainActivity.class - the build failed above" >&2
  exit 1
}

echo "[4/7] d8 (class files -> classes.dex)"
find "$BUILD/classes" -name '*.class' > "$BUILD/classes.txt"
"$BT/d8" --lib "$PLATFORM" --min-api 21 --output "$BUILD/dex" @"$BUILD/classes.txt"

echo "[5/7] add classes.dex into the APK"
( cd "$BUILD/dex" && "$BT/aapt" add -f "$BUILD/base.apk" classes.dex >/dev/null )

echo "[6/7] zipalign"
"$BT/zipalign" -f -p 4 "$BUILD/base.apk" "$BUILD/aligned.apk"

echo "[7/7] sign"
if [ ! -f "$KEYSTORE" ]; then
  echo "  generating a signing key at $KEYSTORE"
  "$JAVA_HOME/bin/keytool" -genkeypair -v \
    -keystore "$KEYSTORE" -alias "$KS_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=Movie Creator, O=LJR Group, C=PH" >/dev/null 2>&1
fi
"$BT/apksigner" sign \
  --ks "$KEYSTORE" --ks-key-alias "$KS_ALIAS" \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --out "$OUT_APK" "$BUILD/aligned.apk"

"$BT/apksigner" verify --print-certs "$OUT_APK" | head -4
echo "OK -> $OUT_APK ($(wc -c < "$OUT_APK") bytes)"
