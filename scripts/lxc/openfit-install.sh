#!/usr/bin/env bash
#
# Open Fit — in-container installer. RUN INSIDE the LXC (Debian/Ubuntu) as root.
#
# Installs the self-contained `ofit-api` binary (UI embedded) as a systemd
# service, generates an auth token, enables console auto-login for root, and
# drops in the `openfit-update` command. Idempotent — safe to re-run to repair.
#
# Normally invoked by openfit-lxc.sh, but you can run it directly in a container:
#   curl -fsSL https://raw.githubusercontent.com/mstraa/open-fit-project/main/scripts/lxc/openfit-install.sh | bash
#
set -euo pipefail

REPO="${OFIT_REPO:-mstraa/open-fit-project}"
BRANCH="${OFIT_BRANCH:-main}"
VERSION="${OFIT_VERSION:-latest}"   # 'latest' or X.Y.Z

OFIT_USER=ofit
DATA_DIR=/var/lib/openfit
ETC_DIR=/etc/openfit
BIN=/usr/local/bin/ofit-api

msg() { echo -e "\e[1;32m[openfit]\e[0m $*"; }
err() { echo -e "\e[1;31m[openfit] ERROR:\e[0m $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || err "run as root"

# ---- prerequisites ----------------------------------------------------------
msg "installing prerequisites…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl openssl >/dev/null

# ---- service user + dirs ----------------------------------------------------
id -u "$OFIT_USER" >/dev/null 2>&1 || \
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$OFIT_USER"
install -d -o "$OFIT_USER" -g "$OFIT_USER" "$DATA_DIR"
install -d "$ETC_DIR"

# ---- download the release binary --------------------------------------------
if [ "$VERSION" = latest ]; then
  URL="https://github.com/${REPO}/releases/latest/download/ofit-api"
else
  URL="https://github.com/${REPO}/releases/download/v${VERSION}/ofit-api"
fi
msg "downloading ofit-api ($VERSION)…"
TMP="$(mktemp)"
curl -fSL --retry 3 "$URL" -o "$TMP" \
  || err "download failed: $URL  (has a release been published yet? otherwise set OFIT_VERSION)"
# Verify checksum if the sidecar is published next to the binary.
if curl -fsSL "${URL}.sha256" -o "${TMP}.sha256" 2>/dev/null; then
  EXPECT="$(awk '{print $1}' "${TMP}.sha256")"
  ACTUAL="$(sha256sum "$TMP" | awk '{print $1}')"
  [ "$EXPECT" = "$ACTUAL" ] || err "checksum mismatch for ofit-api"
  msg "checksum verified"
else
  msg "warning: no .sha256 published for this release — skipping integrity check"
fi
rm -f "${TMP}.sha256"
install -m 0755 "$TMP" "$BIN"
rm -f "$TMP"
msg "installed → $BIN"

# ---- environment file (generate a token on first install) -------------------
if [ ! -f "$ETC_DIR/openfit.env" ]; then
  TOKEN="$(openssl rand -hex 32)"
  cat > "$ETC_DIR/openfit.env" <<EOF
# Open Fit runtime config. Restart after editing: systemctl restart openfit
OFIT_BIND=0.0.0.0:8087
DATABASE_URL=sqlite://${DATA_DIR}/ofit.db?mode=rwc
OFIT_TOKEN=${TOKEN}
RUST_LOG=info
EOF
  chmod 0640 "$ETC_DIR/openfit.env"
  msg "generated auth token in $ETC_DIR/openfit.env"
fi

# ---- systemd service --------------------------------------------------------
cat > /etc/systemd/system/openfit.service <<EOF
[Unit]
Description=Open Fit API
After=network-online.target
Wants=network-online.target

[Service]
User=${OFIT_USER}
Group=${OFIT_USER}
EnvironmentFile=${ETC_DIR}/openfit.env
WorkingDirectory=${DATA_DIR}
ExecStart=${BIN}
Restart=on-failure
RestartSec=3
# hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

# ---- openfit-update helper --------------------------------------------------
msg "installing the openfit-update command…"
if curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/lxc/openfit-update.sh" \
     -o /usr/local/bin/openfit-update 2>/dev/null; then
  chmod +x /usr/local/bin/openfit-update
  # Bake in this repo so `openfit-update` needs no arguments later (rewrite the
  # REPO= line deterministically so forks with a different owner work too).
  sed -i "s#^REPO=.*#REPO=\"\${OFIT_REPO:-${REPO}}\"#" /usr/local/bin/openfit-update
else
  msg "warning: could not fetch openfit-update (re-run the installer to retry)"
fi

# ---- console auto-login as root ---------------------------------------------
mkdir -p /etc/systemd/system/console-getty.service.d
cat > /etc/systemd/system/console-getty.service.d/autologin.conf <<'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear --keep-baud console 115200,38400,9600 $TERM
EOF
mkdir -p /etc/systemd/system/container-getty@1.service.d
cat > /etc/systemd/system/container-getty@1.service.d/autologin.conf <<'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear --keep-baud %I 115200,38400,9600 $TERM
EOF

# ---- enable + start ---------------------------------------------------------
systemctl daemon-reload
systemctl enable --now openfit.service
sleep 1
systemctl --no-pager --lines=0 status openfit.service || true
msg "Open Fit is up on :8087"
