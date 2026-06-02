# Deploying Open Fit

`ofit-api` is a single self-contained binary: the web UI (`web/dist`) is
**embedded into it** (see [`crates/ofit-api/src/static_assets.rs`](../crates/ofit-api/src/static_assets.rs)),
so one process on one port (`8087`) serves both the REST/WebSocket API and the
dashboard — no nginx, no separate web bundle. SQLite is the default store; point
`DATABASE_URL` at Postgres/Timescale for the high-volume tier.

Three supported ways to run it:

| Target | How | Best for |
|--------|-----|----------|
| **Proxmox LXC** | [`scripts/lxc/openfit-lxc.sh`](../scripts/lxc) — native binary + systemd | Home server / self-host (primary path) |
| **Docker** | [`docker/`](../docker) compose, image from GHCR | Anything that runs containers |
| **Bare binary** | download from [Releases](https://github.com/mstraa/open-fit-project/releases) | Manual / other init systems |

Everything is versioned by **git tag** (`vX.Y.Z`): one tag publishes the GHCR
image, the Linux binary, and the Android APK together (see [Releasing](#releasing)).

---

## Proxmox LXC (primary)

Run the one-liner **on the Proxmox host** (as root). It creates an unprivileged
Debian 12 container, installs the binary as a systemd service, generates an auth
token, and enables console auto-login for root:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/mstraa/open-fit-project/main/scripts/lxc/openfit-lxc.sh)"
```

Override any default with env vars:

```sh
CTID=151 RAM=2048 DISK=8 STORAGE=local-zfs BRIDGE=vmbr0 OFIT_VERSION=0.3.0 \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/mstraa/open-fit-project/main/scripts/lxc/openfit-lxc.sh)"
```

| Var | Default | Meaning |
|-----|---------|---------|
| `CTID` | next free id | Container id |
| `CT_HOSTNAME` | `openfit` | Hostname |
| `CORES` / `RAM` / `SWAP` / `DISK` | `2` / `1024` / `512` / `6` | Resources (MiB / GiB) |
| `STORAGE` | `local-lvm` | Rootfs storage pool |
| `BRIDGE` | `vmbr0` | Network bridge (DHCP) |
| `OFIT_VERSION` | `latest` | Release to install (`latest` or `X.Y.Z`) |

After it finishes:

```sh
pct console <CTID>                                   # auto root login
pct exec <CTID> -- grep OFIT_TOKEN /etc/openfit/openfit.env
pct exec <CTID> -- journalctl -u openfit -f          # logs
pct exec <CTID> -- openfit-update                    # update to the latest release
```

The UI/API is at `http://<container-ip>:8087`. Inside the container:

- service: `systemctl {status,restart,stop} openfit`
- config: `/etc/openfit/openfit.env` (token, bind, `DATABASE_URL`, `RUST_LOG`)
- data: `/var/lib/openfit/ofit.db` (SQLite)
- update: `openfit-update` (latest) or `openfit-update 0.3.0` (pin)

See [`scripts/lxc/README.md`](../scripts/lxc/README.md) for the install/update
internals.

---

## Docker

Images are published to **GHCR**: `ghcr.io/mstraa/ofit-api:<version>` (+ `:latest`).
Pin a version in `docker/.env` via `OFIT_VERSION`. Full operational guide in
[`docker/README.md`](../docker/README.md).

```sh
cp docker/.env.example docker/.env       # set OFIT_TOKEN (+ OFIT_VERSION to pin)

# simple tier — SQLite on a named volume
docker compose -f docker/docker-compose.simple.yml pull
docker compose -f docker/docker-compose.simple.yml up -d

# full tier — Postgres/TimescaleDB
docker compose -f docker/docker-compose.full.yml up -d
```

Both compose files keep a `build:` block, so `docker compose build` still builds
the image from source for local development.

> **First release only:** GHCR packages default to **private** even on a public
> repo. After the first `release` workflow run, open the package at
> `github.com/users/mstraa/packages/container/ofit-api/settings` and set its
> visibility to **Public** so `docker compose pull` works without auth. (The LXC
> native path is unaffected — public-repo release assets download anonymously.)

---

## Releasing

Versions are unified by [`scripts/bump-version.sh`](../scripts/bump-version.sh)
and published by [`.github/workflows/release.yml`](../.github/workflows/release.yml).

```sh
scripts/bump-version.sh 0.3.0 --tag      # rewrite manifests, commit, tag v0.3.0
git push && git push origin v0.3.0       # → triggers the release workflow
```

Pushing the `v*` tag builds and publishes, for that version:

- **GHCR image** — `ghcr.io/mstraa/ofit-api:0.3.0` and `:latest`
- **Linux x86_64 binary** — `ofit-api` (+ `ofit-api.sha256`), used by the LXC install/update
- **Android debug APK** — `open-fit-0.3.0.apk`
- a **GitHub Release** carrying the binary + APK (+ checksums) with generated notes

`bump-version.sh` keeps the Cargo workspace, `web`, `mobile`, and Android
(`versionName` + auto-incremented `versionCode`) in sync.

## CI

| Workflow | Trigger | Does |
|----------|---------|------|
| [`ci.yml`](../.github/workflows/ci.yml) | push to `main`, PRs | `cargo check`/`test` workspace; web typecheck + build |
| [`android.yml`](../.github/workflows/android.yml) | `mobile/**` or `web/**` changes, manual | Build debug APK, upload as artifact |
| [`release.yml`](../.github/workflows/release.yml) | tag `v*`, manual | Image + binary + APK + GitHub Release |

The Android workflow builds an **unsigned debug APK** (no secrets needed),
installable for personal sideloading. To ship a Play-Store / F-Droid-style
signed release later, add a `signingConfig` plus keystore secrets and switch the
release job to `assembleRelease`.
