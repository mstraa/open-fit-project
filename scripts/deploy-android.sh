#!/usr/bin/env bash
#
# deploy-android.sh — build the Open Fit Android app and install it on a
# USB-connected phone in one shot.
#
# Pipeline: build ../web → cap sync → gradlew assembleDebug → adb install → launch.
#
# Usage:
#   scripts/deploy-android.sh            # full build + install + launch
#   scripts/deploy-android.sh --fast     # skip web/cap sync, just gradle + install
#   scripts/deploy-android.sh --no-launch
#
set -euo pipefail

# --- locate things -----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MOBILE_DIR="$REPO_ROOT/mobile"
ANDROID_DIR="$MOBILE_DIR/android"
APK="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
APP_ID="org.openfit.app"

# Default ANDROID_HOME to the standard macOS SDK location if unset.
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$ANDROID_HOME/platform-tools/adb"
[ -x "$ADB" ] || ADB="adb"   # fall back to whatever's on PATH

# --- flags -------------------------------------------------------------------
FAST=0
LAUNCH=1
for arg in "$@"; do
  case "$arg" in
    --fast)      FAST=1 ;;
    --no-launch) LAUNCH=0 ;;
    -h|--help)
      cat <<'EOF'
deploy-android.sh — build the Open Fit Android app and install it on a
USB-connected phone in one shot.

Pipeline: build ../web → cap sync → gradlew assembleDebug → adb install → launch.

Usage:
  scripts/deploy-android.sh            # full build + install + launch
  scripts/deploy-android.sh --fast     # skip web/cap sync, just gradle + install
  scripts/deploy-android.sh --no-launch
EOF
      exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# --- preflight ---------------------------------------------------------------
command -v "$ADB" >/dev/null 2>&1 || die "adb not found. Install Android platform-tools or set ANDROID_HOME (got '$ANDROID_HOME')."
[ -d "$ANDROID_DIR" ] || die "native project missing at $ANDROID_DIR — run 'npm install && npm run sync' in mobile/ first."

# Make sure exactly one device is connected and authorized over USB.
log "Checking for a connected device..."
"$ADB" start-server >/dev/null 2>&1 || true
DEVICES="$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1}')"
UNAUTH="$("$ADB" devices | awk 'NR>1 && $2=="unauthorized" {print $1}')"
[ -n "$UNAUTH" ] && die "Device $UNAUTH is unauthorized — unlock the phone and accept the USB debugging prompt."
COUNT="$(printf '%s\n' "$DEVICES" | grep -c . || true)"
[ "$COUNT" -eq 0 ] && die "No device detected. Connect the phone via USB, enable USB debugging (Developer options), and accept the prompt."
[ "$COUNT" -gt 1 ] && die "Multiple devices connected ($DEVICES). Disconnect extras, or set ANDROID_SERIAL and pass it to adb."
log "Device $DEVICES ready."

# --- build -------------------------------------------------------------------
if [ "$FAST" -eq 0 ]; then
  log "Building web assets + syncing Capacitor (npm run sync)..."
  ( cd "$MOBILE_DIR" && npm run sync )
else
  log "Fast mode: skipping web build + cap sync."
fi

log "Assembling debug APK (gradlew assembleDebug)..."
( cd "$ANDROID_DIR" && ./gradlew assembleDebug )
[ -f "$APK" ] || die "expected APK not found at $APK"

# --- install -----------------------------------------------------------------
log "Installing $(basename "$APK") on ${DEVICES}..."
"$ADB" install -r "$APK"

# --- launch ------------------------------------------------------------------
if [ "$LAUNCH" -eq 1 ]; then
  log "Launching ${APP_ID}..."
  "$ADB" shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null
fi

log "Done. App installed${LAUNCH:+ and launched} on ${DEVICES}."
