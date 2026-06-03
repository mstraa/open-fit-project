#!/usr/bin/env bash
#
# Open Fit — build + install from SOURCE (default branch: main).
# RUN INSIDE the LXC as root. Installed as /usr/local/bin/update-main.
#
# Unlike `update` (which downloads the latest *tagged release* binary), this
# compiles ofit-api from a source branch on the box — so you can run bleeding-edge
# `main` (or any branch) before it's released. The web UI is built first and baked
# into the binary (rust-embed), exactly like the release build / Docker image.
#
#   update-main              # build + deploy origin/main
#   update-main some-branch  # build + deploy a specific branch
#
# Toolchain: git + Node 20 + Rust. The FIRST run installs them and clones the repo
# into /opt/openfit-src; later runs fetch + rebuild incrementally (the checkout and
# the cargo target cache persist there). A first build is heavy — give the container
# enough headroom (~2 GB RAM + a few GB free disk, several minutes). Override with:
#   OFIT_REPO=owner/repo  OFIT_BRANCH=main  OFIT_SRC_DIR=/opt/openfit-src
set -euo pipefail

REPO="${OFIT_REPO:-mstraa/open-fit-project}"
BRANCH="${1:-${OFIT_BRANCH:-main}}"
SRC="${OFIT_SRC_DIR:-/opt/openfit-src}"
GIT_URL="https://github.com/${REPO}.git"
BIN=/usr/local/bin/ofit-api

export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8 LANG=C.UTF-8

msg() { echo -e "\e[1;32m[openfit]\e[0m $*"; }
err() { echo -e "\e[1;31m[openfit] ERROR:\e[0m $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1; }
[ "$(id -u)" = 0 ] || err "run as root"

# ---- build prerequisites ----------------------------------------------------
if ! need git || ! need cc || ! need pkg-config; then
  msg "installing build essentials…"
  apt-get update -qq
  apt-get install -y -qq git build-essential pkg-config libssl-dev ca-certificates curl >/dev/null
fi

# Node 20 — the Vite build needs a modern Node; Debian's packaged one is too old.
node_major() { node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'; }
if ! need node || [ "$(node_major)" -lt 18 ] 2>/dev/null; then
  msg "installing Node.js 20…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

# Rust (rustup) — the workspace needs a recent stable; Debian's cargo is too old.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
if ! need cargo; then
  msg "installing Rust (rustup, minimal profile)…"
  curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null
  . "$HOME/.cargo/env"
fi

# ---- fetch source -----------------------------------------------------------
if [ -d "$SRC/.git" ]; then
  msg "fetching ${REPO}@${BRANCH} → $SRC…"
  git -C "$SRC" remote set-url origin "$GIT_URL"
  git -C "$SRC" fetch --depth 1 origin "$BRANCH"
  git -C "$SRC" checkout -f -B "$BRANCH" FETCH_HEAD
else
  msg "cloning ${REPO}@${BRANCH} → $SRC…"
  rm -rf "$SRC"
  mkdir -p "$(dirname "$SRC")"
  git clone --depth 1 --branch "$BRANCH" "$GIT_URL" "$SRC"
fi
REV="$(git -C "$SRC" rev-parse --short HEAD)"

# ---- build the web SPA (baked into the binary by rust-embed) ----------------
msg "building web UI…"
if [ -f "$SRC/web/package-lock.json" ]; then
  npm --prefix "$SRC/web" ci
else
  npm --prefix "$SRC/web" install
fi
npm --prefix "$SRC/web" run build

# ---- build the release binary (web/dist must exist first → real UI embedded) -
msg "building ofit-api (release — this can take several minutes)…"
( cd "$SRC" && cargo build --release -p ofit-api )
[ -x "$SRC/target/release/ofit-api" ] || err "build produced no ofit-api binary"

# ---- install + restart ------------------------------------------------------
# Install to a temp name then rename over the live binary: a plain overwrite of a
# running executable fails with ETXTBSY, but rename(2) atomically swaps the dentry.
install -m 0755 "$SRC/target/release/ofit-api" "${BIN}.new"
mv -f "${BIN}.new" "$BIN"
msg "installed ${BRANCH}@${REV} → $BIN"
msg "restarting service…"
systemctl restart openfit
sleep 1
systemctl --no-pager --lines=5 status openfit || true
