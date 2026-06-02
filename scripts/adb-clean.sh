#!/usr/bin/env bash
#
# adb-clean.sh — completely remove the Open Fit app from a USB-connected phone,
# for EVERY Android user, then optionally install a fresh APK.
#
# Why this exists: "uninstall" from the launcher (especially on Xiaomi/MIUI)
# often only removes the app for the current user. A stale copy can linger for a
# secondary / dual-app / work-profile user, and because each old build was signed
# with a different debug key, that leftover blocks reinstall with
# "INSTALL_FAILED_UPDATE_INCOMPATIBLE" — even via adb. Uninstalling for all users
# clears it.
#
# Usage:
#   scripts/adb-clean.sh                 # remove org.openfit.app for all users
#   scripts/adb-clean.sh path/to.apk     # ...then install that APK + launch
#   scripts/adb-clean.sh --latest        # ...then download the latest GitHub
#                                        #    release APK (needs `gh`) + install
#
set -euo pipefail

PKG="org.openfit.app"

# --- locate adb (match deploy-android.sh) ------------------------------------
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$ANDROID_HOME/platform-tools/adb"
[ -x "$ADB" ] || ADB="adb"   # fall back to whatever's on PATH

log()  { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

command -v "$ADB" >/dev/null 2>&1 || die "adb not found. Install Android platform-tools or set ANDROID_HOME (tried '$ANDROID_HOME/platform-tools/adb')."

# --- one authorized device ---------------------------------------------------
"$ADB" start-server >/dev/null 2>&1 || true
devices="$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1}')"
n="$(printf '%s\n' "$devices" | grep -c . || true)"
[ "$n" -ge 1 ] || die "no authorized device. Plug the phone in, enable USB debugging, and accept the prompt."
if [ "$n" -gt 1 ] && [ -z "${ANDROID_SERIAL:-}" ]; then
  die "more than one device connected — set ANDROID_SERIAL=<serial> to pick one. Found:
$devices"
fi
log "Device: $(printf '%s' "$devices" | head -1)  ·  package: $PKG"

# --- uninstall for every user ------------------------------------------------
# Enumerate real user ids, then add common hidden ones (999 = MIUI dual-app /
# Second Space) so a leftover there is caught even if `pm list users` hides it.
users="$("$ADB" shell pm list users 2>/dev/null | tr -d '\r' | grep -oE 'UserInfo\{[0-9]+' | grep -oE '[0-9]+' || true)"
users="$(printf '%s\n0\n999\n' "$users" | sort -un)"

log "Uninstalling for users: $(printf '%s ' $users)"
for u in $users; do
  out="$("$ADB" shell pm uninstall --user "$u" "$PKG" 2>&1 | tr -d '\r' || true)"
  [ -n "$out" ] && printf '  [user %s] %s\n' "$u" "$out"
done
# Also a plain (current-user) uninstall to clear any retained app data.
"$ADB" uninstall "$PKG" >/dev/null 2>&1 || true

# --- verify it's really gone -------------------------------------------------
present="$("$ADB" shell pm list packages "$PKG" 2>/dev/null | tr -d '\r' | grep -x "package:$PKG" || true)"
ghost="$("$ADB" shell pm list packages -u "$PKG" 2>/dev/null | tr -d '\r' | grep -x "package:$PKG" || true)"
if [ -n "$present" ]; then
  die "package is STILL installed for some user. On MIUI, also check Settings → Apps (and Second Space / Dual apps) and remove it there, then re-run."
elif [ -n "$ghost" ]; then
  warn "package is uninstalled but data is retained for some user (won't block install)."
else
  ok "package fully removed from the device."
fi

# --- optional install --------------------------------------------------------
arg="${1:-}"
[ -z "$arg" ] && { ok "Clean done. To install: scripts/adb-clean.sh <apk>  or  --latest"; exit 0; }

APK=""
if [ "$arg" = "--latest" ]; then
  command -v gh >/dev/null 2>&1 || die "--latest needs the GitHub CLI (gh). Or pass a downloaded .apk path instead."
  tmp="$(mktemp -d)"
  log "Downloading the latest release APK with gh…"
  gh release download -D "$tmp" -p '*.apk' >/dev/null 2>&1 || die "gh release download failed (are you authenticated / in the repo?)."
  APK="$(find "$tmp" -name '*.apk' | head -1)"
  [ -n "$APK" ] || die "no .apk in the latest release."
else
  APK="$arg"
  [ -f "$APK" ] || die "APK not found: $APK"
fi

log "Installing $APK"
# -r reinstall · -d allow downgrade · -g grant runtime perms · -t allow test/debug pkg
if out="$("$ADB" install -r -d -g -t "$APK" 2>&1)"; then
  ok "Installed."
  "$ADB" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
  ok "Launched $PKG."
else
  printf '%s\n' "$out" >&2
  die "install failed — the INSTALL_FAILED_* code above is the exact reason."
fi
