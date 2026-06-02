#!/usr/bin/env bash
#
# Open Fit — in-container installer. RUN INSIDE the LXC (Debian/Ubuntu) as root.
#
# Installs the self-contained `ofit-api` binary (UI embedded) as a systemd
# service on port 80, generates an auth token, enables console auto-login for
# root, and drops in the `update` command. Idempotent — safe to re-run to repair.
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
OFIT_BIND=0.0.0.0:80
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
# let the unprivileged service bind the privileged port 80
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
# hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
EOF

# ---- `update` command -------------------------------------------------------
msg "installing the 'update' command…"
if curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/lxc/openfit-update.sh" \
     -o /usr/local/bin/update 2>/dev/null; then
  chmod +x /usr/local/bin/update
  # Bake in this repo so `update` needs no arguments later (rewrite the REPO=
  # line deterministically so forks with a different owner work too).
  sed -i "s#^REPO=.*#REPO=\"\${OFIT_REPO:-${REPO}}\"#" /usr/local/bin/update
else
  msg "warning: could not fetch the update script (re-run the installer to retry)"
fi

# ---- console auto-login as root ---------------------------------------------
# `pct console` and the Proxmox web console attach to tty1, so the getty must run
# on tty%I — NOT pts/%I, which systemd's default container-getty uses; that
# mismatch is what leaves a plain login prompt. Configure every getty Proxmox
# might use; the blank ExecStart= first resets the unit's original command.
autologin_dropin() { # $1 = unit, $2 = agetty port/baud args
  mkdir -p "/etc/systemd/system/$1.d"
  cat > "/etc/systemd/system/$1.d/autologin.conf" <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear --keep-baud $2 \$TERM
EOF
}
autologin_dropin console-getty.service      "console 115200,38400,9600"
autologin_dropin container-getty@1.service  "tty%I 115200,38400,9600"
autologin_dropin getty@tty1.service         "%I"

# ---- enable + start ---------------------------------------------------------
systemctl daemon-reload
# Apply auto-login now (not just at next boot) by restarting the active getty.
for u in console-getty.service container-getty@1.service getty@tty1.service; do
  systemctl is-active --quiet "$u" && systemctl restart "$u" || true
done
msg "console gettys running: $(systemctl list-units --type=service --state=running --no-legend 2>/dev/null | awk '/getty/{print $1}' | tr '\n' ' ')"
systemctl enable --now openfit.service
sleep 1
systemctl --no-pager --lines=0 status openfit.service || true
IP_ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
msg "Open Fit is up at http://${IP_ADDR:-<container-ip>}/ (port 80)"
