#!/usr/bin/env bash
#
# Open Fit — update to a published release. RUN INSIDE the LXC as root.
# Installed as /usr/local/bin/openfit-update by openfit-install.sh.
#
#   openfit-update           # pull the latest release
#   openfit-update 0.3.0     # pin a specific version
#
set -euo pipefail

REPO="${OFIT_REPO:-mstraa/open-fit-project}"
VERSION="${1:-latest}"
BIN=/usr/local/bin/ofit-api

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

if [ "$VERSION" = latest ]; then
  URL="https://github.com/${REPO}/releases/latest/download/ofit-api"
else
  URL="https://github.com/${REPO}/releases/download/v${VERSION}/ofit-api"
fi

echo "[openfit] downloading $VERSION…"
TMP="$(mktemp)"
curl -fSL --retry 3 "$URL" -o "$TMP" \
  || { echo "[openfit] download failed: $URL" >&2; rm -f "$TMP"; exit 1; }

# Integrity check when the .sha256 sidecar is present in the release.
if curl -fsSL "${URL}.sha256" -o "${TMP}.sha256" 2>/dev/null; then
  EXPECT="$(awk '{print $1}' "${TMP}.sha256")"
  ACTUAL="$(sha256sum "$TMP" | awk '{print $1}')"
  if [ "$EXPECT" != "$ACTUAL" ]; then
    echo "[openfit] checksum mismatch — aborting" >&2
    rm -f "$TMP" "${TMP}.sha256"; exit 1
  fi
else
  echo "[openfit] warning: no .sha256 published — skipping integrity check" >&2
fi
rm -f "${TMP}.sha256"

install -m 0755 "$TMP" "$BIN"
rm -f "$TMP"
echo "[openfit] restarting service…"
systemctl restart openfit
sleep 1
systemctl --no-pager --lines=5 status openfit || true
