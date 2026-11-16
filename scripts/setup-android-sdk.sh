#!/usr/bin/env bash
#
# One-command Android toolchain setup for building the APK.
#
# Why this exists: android/build.sh needs a JDK and the Android SDK
# command-line tools. Those are NOT part of the repo and are NOT installed in a
# fresh container (and /opt is not persistent across sessions). This script
# installs them so `bash android/build.sh` works.
#
# Usage:  bash scripts/setup-android-sdk.sh
# Then:   ANDROID_HOME=/opt/android-sdk \
#         JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")" \
#         bash android/build.sh
#
# Idempotent: re-running it is safe; already-present pieces are skipped.
set -euo pipefail

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/android-sdk}}"
CMDLINE_VERSION="11076708"
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

# --- JDK (17+). Debian trixie ships openjdk-21; that is fine for this app. ---
if ! command -v java >/dev/null 2>&1; then
  echo "[1/3] Installing a JDK ..."
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq openjdk-21-jdk-headless unzip curl
else
  echo "[1/3] JDK present: $(java -version 2>&1 | head -1)"
fi

# --- Android command-line tools ---
CLT_DIR="$SDK/cmdline-tools/latest"
if [ ! -x "$CLT_DIR/bin/sdkmanager" ]; then
  echo "[2/3] Installing Android command-line tools into $SDK ..."
  $SUDO mkdir -p "$SDK/cmdline-tools"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/clt.zip" \
    "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_VERSION}_latest.zip"
  $SUDO unzip -q -o "$tmp/clt.zip" -d "$SDK/cmdline-tools"
  $SUDO rm -rf "$CLT_DIR"
  $SUDO mv "$SDK/cmdline-tools/cmdline-tools" "$CLT_DIR"
  $SUDO chown -R "$(id -u):$(id -g)" "$SDK"
  rm -rf "$tmp"
else
  echo "[2/3] cmdline-tools present"
fi

# --- SDK packages android/build.sh expects: build-tools 35.0.0 + platform 34 ---
export JAVA_HOME="${JAVA_HOME:-$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")}"
export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"
export PATH="$CLT_DIR/bin:$PATH"

echo "[3/3] Installing SDK packages (platform-tools, android-34, build-tools 35.0.0) ..."
yes | sdkmanager --licenses >/dev/null 2>&1 || true
sdkmanager "platform-tools" "platforms;android-34" "build-tools;35.0.0" >/dev/null

echo
echo "Done. Build the APK with:"
echo "  ANDROID_HOME=$SDK JAVA_HOME=$JAVA_HOME bash android/build.sh"
