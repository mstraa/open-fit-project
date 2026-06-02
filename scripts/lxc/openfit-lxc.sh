#!/usr/bin/env bash
#
# Open Fit — Proxmox VE LXC creator. RUN THIS ON THE PROXMOX HOST (as root).
#
# Creates an unprivileged Debian container and installs the self-contained
# `ofit-api` binary (from GitHub Releases) as a systemd service. Interactive
# whiptail menus pick the Debian version, storage and resources; every value
# can also be forced with an env var for unattended installs.
#
# One-liner:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/mstraa/open-fit-project/main/scripts/lxc/openfit-lxc.sh)"
#
# Unattended (skip the menus) — set OFIT_NONINTERACTIVE plus any overrides:
#   OFIT_NONINTERACTIVE=1 STORAGE=local-zfs OSVER=13 RAM=2048 DISK=8 \
#     bash -c "$(curl -fsSL https://raw.githubusercontent.com/mstraa/open-fit-project/main/scripts/lxc/openfit-lxc.sh)"
#
# Overridable env: CTID CT_HOSTNAME CORES RAM SWAP DISK BRIDGE STORAGE
#                  TEMPLATE_STORAGE OSVER(12|13) UNPRIVILEGED OFIT_VERSION
#
set -euo pipefail

REPO="${OFIT_REPO:-mstraa/open-fit-project}"
BRANCH="${OFIT_BRANCH:-main}"
OFIT_VERSION="${OFIT_VERSION:-latest}"

# Defaults for any value not provided by env or chosen in the Advanced menu.
: "${CT_HOSTNAME:=openfit}"
: "${CORES:=2}"
: "${RAM:=1024}"          # MiB
: "${SWAP:=512}"          # MiB
: "${DISK:=20}"           # GiB
: "${BRIDGE:=vmbr0}"
: "${OSVER:=13}"          # Debian 13 (trixie); 12 (bookworm) also works
: "${UNPRIVILEGED:=1}"

# Progress/errors go to stderr so they never pollute $(...) captures below.
msg()  { echo -e "\e[1;32m[openfit]\e[0m $*" >&2; }
warn() { echo -e "\e[1;33m[openfit]\e[0m $*" >&2; }
err()  { echo -e "\e[1;31m[openfit] ERROR:\e[0m $*" >&2; exit 1; }

command -v pct >/dev/null || err "this must run on a Proxmox VE host ('pct' not found)"
[ "$(id -u)" = 0 ] || err "run as root on the Proxmox host"

# Use the menus only when we have a terminal, whiptail, and weren't told not to.
interactive() { [ -z "${OFIT_NONINTERACTIVE:-}" ] && command -v whiptail >/dev/null && [ -t 0 ]; }

# Names of storages that accept a given content type (rootdir | vztmpl).
storages_for() { pvesm status -content "$1" 2>/dev/null | awk 'NR>1 {print $1}'; }

# Resolve a storage for content $1, honouring preset $2 if valid, else the only
# option, else a whiptail menu (interactive), else the first option.
resolve_storage() {
  local content="$1" preset="$2" title="$3" s opts menu=()
  mapfile -t opts < <(storages_for "$content")
  [ "${#opts[@]}" -gt 0 ] || err "no storage accepts '$content' content — add/enable one under Datacenter → Storage (a container needs a 'rootdir'-capable store such as LVM-thin, ZFS, or a directory)."
  if [ -n "$preset" ]; then
    printf '%s\n' "${opts[@]}" | grep -qxF -- "$preset" || err "storage '$preset' can't hold '$content'. Available: ${opts[*]}"
    echo "$preset"; return
  fi
  if [ "${#opts[@]}" -eq 1 ]; then echo "${opts[0]}"; return; fi
  if interactive; then
    for s in "${opts[@]}"; do menu+=("$s" ""); done
    whiptail --title "Open Fit — $title" --menu "Choose the $title:" 16 64 6 "${menu[@]}" 3>&1 1>&2 2>&3
  else
    warn "multiple '$content' storages (${opts[*]}); using '${opts[0]}' — set STORAGE/TEMPLATE_STORAGE to override"
    echo "${opts[0]}"
  fi
}

# ---- interactive setup (Default vs Advanced) --------------------------------
if interactive; then
  mode=$(whiptail --title "Open Fit LXC installer" --menu \
    "How would you like to set up the container?" 12 64 2 \
    "Default"  "Recommended settings (you'll just pick storage)" \
    "Advanced" "Pick Debian version, resources and network" \
    3>&1 1>&2 2>&3) || err "cancelled"
  if [ "$mode" = "Advanced" ]; then
    OSVER=$(whiptail --title "Debian version" --default-item "$OSVER" --menu "Container OS:" 11 56 2 \
      "13" "Debian 13 (trixie)" \
      "12" "Debian 12 (bookworm)" 3>&1 1>&2 2>&3) || err "cancelled"
    CTID=$(whiptail --title "Container ID" --inputbox "CTID:" 9 56 "${CTID:-$(pvesh get /cluster/nextid)}" 3>&1 1>&2 2>&3) || err "cancelled"
    CT_HOSTNAME=$(whiptail --title "Hostname" --inputbox "Hostname:" 9 56 "$CT_HOSTNAME" 3>&1 1>&2 2>&3) || err "cancelled"
    CORES=$(whiptail --title "CPU" --inputbox "CPU cores:" 9 56 "$CORES" 3>&1 1>&2 2>&3) || err "cancelled"
    RAM=$(whiptail --title "Memory" --inputbox "RAM (MiB):" 9 56 "$RAM" 3>&1 1>&2 2>&3) || err "cancelled"
    DISK=$(whiptail --title "Disk" --inputbox "Root disk (GiB):" 9 56 "$DISK" 3>&1 1>&2 2>&3) || err "cancelled"
    BRIDGE=$(whiptail --title "Network" --inputbox "Bridge:" 9 56 "$BRIDGE" 3>&1 1>&2 2>&3) || err "cancelled"
  fi
fi

# ---- resolve remaining values (env > menu > default/auto) -------------------
CTID="${CTID:-$(pvesh get /cluster/nextid 2>/dev/null)}"
[ -n "$CTID" ] || err "could not determine a container id (set CTID=...)"
STORAGE="$(resolve_storage rootdir "${STORAGE:-}" "root-filesystem storage")" || err "cancelled"
TEMPLATE_STORAGE="$(resolve_storage vztmpl "${TEMPLATE_STORAGE:-}" "template storage")" || err "cancelled"

# Confirm before creating (interactive only).
if interactive; then
  whiptail --title "Open Fit — confirm" --yesno \
"Create this container?

  CTID:      $CTID
  Hostname:  $CT_HOSTNAME
  OS:        Debian $OSVER
  Cores:     $CORES
  RAM:       ${RAM} MiB  (swap ${SWAP} MiB)
  Disk:      ${DISK} GiB on '$STORAGE'
  Template:  on '$TEMPLATE_STORAGE'
  Network:   bridge $BRIDGE (DHCP)
  Open Fit:  $OFIT_VERSION" 20 64 3>&1 1>&2 2>&3 || err "cancelled"
fi

# ---- fetch the Debian template if needed ------------------------------------
msg "resolving Debian ${OSVER} template…"
pveam update >/dev/null 2>&1 || true
TEMPLATE="$(pveam available --section system | awk '{print $2}' \
  | grep -E "^debian-${OSVER}-standard_.*_amd64\.tar\.(zst|gz)$" | sort -V | tail -1 || true)"
[ -n "$TEMPLATE" ] || err "no Debian ${OSVER} standard template is available from 'pveam' (try OSVER=12 or OSVER=13)."
if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
  msg "downloading template $TEMPLATE → $TEMPLATE_STORAGE…"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi
TEMPLATE_REF="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}"

# ---- create + start the container -------------------------------------------
msg "creating CT $CTID ($CT_HOSTNAME): Debian $OSVER, ${CORES} cores, ${RAM}MiB RAM, ${DISK}GiB on $STORAGE"
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
[ "$net_ok" = 1 ] || err "CT $CTID has no network/DNS (bridge $BRIDGE, DHCP) — fix networking, then re-run: pct exec $CTID -- bash -c \"curl -fsSL https://raw.githubusercontent.com/${REPO}/${BRANCH}/scripts/lxc/openfit-install.sh | bash\""

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
    Web UI:   http://${IP:-<container-ip>}/          (API under /api)
    Token:    pct exec $CTID -- grep OFIT_TOKEN /etc/openfit/openfit.env
    Console:  pct console $CTID                      (auto root login)
    Update:   pct exec $CTID -- update
    Logs:     pct exec $CTID -- journalctl -u openfit -f

EOF
