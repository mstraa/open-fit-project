#!/usr/bin/env bash
#
# Open Fit — Proxmox VE LXC creator. RUN THIS ON THE PROXMOX HOST (as root).
#
# Creates an unprivileged Debian 12 container and installs the self-contained
# `ofit-api` binary (downloaded from GitHub Releases) as a systemd service. The
# container console auto-logs-in as root, and ships an `openfit-update` command.
#
# One-liner (community-scripts style):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/mstraa/open-fit-project/main/scripts/lxc/openfit-lxc.sh)"
#
# Override any default via env, e.g.:
#   CTID=151 RAM=2048 DISK=8 STORAGE=local-zfs BRIDGE=vmbr0 \
#     bash -c "$(curl -fsSL https://raw.githubusercontent.com/mstraa/open-fit-project/main/scripts/lxc/openfit-lxc.sh)"
#
set -euo pipefail

# ---- config (env-overridable) -----------------------------------------------
REPO="${OFIT_REPO:-mstraa/open-fit-project}"
BRANCH="${OFIT_BRANCH:-main}"
OFIT_VERSION="${OFIT_VERSION:-latest}"   # 'latest' or X.Y.Z
CTID="${CTID:-$(pvesh get /cluster/nextid 2>/dev/null)}"
CT_HOSTNAME="${CT_HOSTNAME:-openfit}"
DISK="${DISK:-6}"                # GiB
CORES="${CORES:-2}"
RAM="${RAM:-1024}"               # MiB
SWAP="${SWAP:-512}"              # MiB
BRIDGE="${BRIDGE:-vmbr0}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
OSVER="${OSVER:-12}"            # Debian 12 (bookworm)
UNPRIVILEGED="${UNPRIVILEGED:-1}"

msg() { echo -e "\e[1;32m[openfit]\e[0m $*"; }
err() { echo -e "\e[1;31m[openfit] ERROR:\e[0m $*" >&2; exit 1; }

command -v pct >/dev/null || err "this must run on a Proxmox VE host ('pct' not found)"
[ "$(id -u)" = 0 ] || err "run as root on the Proxmox host"
[ -n "$CTID" ] || err "could not determine a container id (set CTID=...)"

# ---- fetch the Debian template if needed ------------------------------------
msg "resolving Debian ${OSVER} template…"
pveam update >/dev/null 2>&1 || true
TEMPLATE="$(pveam available --section system | awk '{print $2}' \
  | grep -E "^debian-${OSVER}-standard_.*_amd64\.tar\.(zst|gz)$" | sort -V | tail -1 || true)"
[ -n "$TEMPLATE" ] || err "no Debian ${OSVER} standard template in 'pveam available'"
if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
  msg "downloading template $TEMPLATE → $TEMPLATE_STORAGE…"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi
TEMPLATE_REF="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}"

# ---- create + start the container -------------------------------------------
msg "creating CT $CTID ($CT_HOSTNAME): ${CORES} cores, ${RAM}MiB RAM, ${DISK}GiB on $STORAGE"
pct create "$CTID" "$TEMPLATE_REF" \
  --hostname "$CT_HOSTNAME" \
  --cores "$CORES" \
  --memory "$RAM" \
  --swap "$SWAP" \
  --rootfs "${STORAGE}:${DISK}" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=dhcp,ip6=auto" \
  --unprivileged "$UNPRIVILEGED" \
  --features nesting=1 \
  --onboot 1 \
  --ostype debian \
  --description "Open Fit — self-hosted fitness platform. status: systemctl status openfit · update: openfit-update"

pct start "$CTID"
msg "waiting for container network…"
net_ok=0
for _ in $(seq 1 30); do
  if pct exec "$CTID" -- getent hosts github.com >/dev/null 2>&1; then net_ok=1; break; fi
  sleep 2
done
[ "$net_ok" = 1 ] || err "CT $CTID has no network/DNS (bridge $BRIDGE, DHCP) — cannot reach github.com to install. Fix networking, then re-run: pct exec $CTID -- bash -c \"curl -fsSL https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/lxc/openfit-install.sh | bash\""

# ---- run the in-container installer -----------------------------------------
msg "installing Open Fit inside CT $CTID…"
pct exec "$CTID" -- bash -c \
  "export OFIT_REPO='$REPO' OFIT_BRANCH='$BRANCH' OFIT_VERSION='$OFIT_VERSION'; \
   curl -fsSL 'https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/lxc/openfit-install.sh' | bash"

# ---- summary ----------------------------------------------------------------
IP="$(pct exec "$CTID" -- bash -c "hostname -I | awk '{print \$1}'" 2>/dev/null | tr -d '[:space:]')"
msg "done."
cat <<EOF

  Open Fit is running in CT $CTID.
    URL:      http://${IP:-<container-ip>}:8087
    Token:    pct exec $CTID -- grep OFIT_TOKEN /etc/openfit/openfit.env
    Console:  pct console $CTID          (auto root login)
    Update:   pct exec $CTID -- openfit-update
    Logs:     pct exec $CTID -- journalctl -u openfit -f

EOF
