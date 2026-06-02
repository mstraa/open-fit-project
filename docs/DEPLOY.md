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

Interactive by default — a whiptail menu (Default/Advanced) picks the Debian
version, storage and resources. Set `OFIT_NONINTERACTIVE=1` to skip the menus
and use env/defaults. Every value is also overridable up-front via env:

| Var | Default | Meaning |
|-----|---------|---------|
| `CTID` | next free id | Container id |
| `CT_HOSTNAME` | `openfit` | Hostname |
| `OSVER` | `13` | Debian version — `13` (trixie) or `12` (bookworm) |
| `CORES` / `RAM` / `SWAP` / `DISK` | `2` / `1024` / `512` / `20` | Resources (MiB / GiB) |
| `STORAGE` | auto-detected | Rootfs storage (the only `rootdir`-capable one, else you pick) |
| `TEMPLATE_STORAGE` | auto-detected | Storage for the LXC template (`vztmpl`) |
| `BRIDGE` | `vmbr0` | Network bridge (DHCP) |
| `OFIT_VERSION` | `latest` | Release to install (`latest` or `X.Y.Z`) |

After it finishes:

```sh
pct console <CTID>                                   # auto root login
pct exec <CTID> -- grep OFIT_TOKEN /etc/openfit/openfit.env
pct exec <CTID> -- journalctl -u openfit -f          # logs
pct exec <CTID> -- update                            # update to the latest release
```

The web UI + API are served on **port 80** at `http://<container-ip>/`. Inside the container:

- service: `systemctl {status,restart,stop} openfit`
- config: `/etc/openfit/openfit.env` (token, bind, `DATABASE_URL`, `RUST_LOG`)
- data: `/var/lib/openfit/ofit.db` (SQLite)
- update: `update` (latest) or `update 0.3.0` (pin)

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

> **GHCR is opt-in (off by default).** The release workflow only builds/pushes a
> container image when the repo variable `ENABLE_GHCR` is set to `true`
> (Settings → Secrets and variables → Actions → Variables). Until then, releases
> ship the Linux binary + APK only, and the LXC native path is the supported
> Docker-free route.
>
> When you do enable it: GHCR packages default to **private** even on a public
> repo, so after the first image push, set the package public at
> `github.com/users/mstraa/packages/container/ofit-api/settings` for anonymous
> `docker compose pull`.

---

## Releasing

Versions are unified by [`scripts/bump-version.sh`](../scripts/bump-version.sh)
and published by [`.github/workflows/release.yml`](../.github/workflows/release.yml).

```sh
scripts/bump-version.sh 0.3.0 --tag      # rewrite manifests, commit, tag v0.3.0
git push && git push origin v0.3.0       # → triggers the release workflow
```

Pushing the `v*` tag builds and publishes, for that version:

- **Linux x86_64 binary** — `ofit-api` (+ `ofit-api.sha256`), used by the LXC install/update
- **Android debug APK** — `open-fit-0.3.0.apk`
- a **GitHub Release** carrying the binary + APK (+ checksums) with generated notes
- **GHCR image** — `ghcr.io/mstraa/ofit-api:0.3.0` and `:latest`, **only when `ENABLE_GHCR=true`** (see above)

`bump-version.sh` keeps the Cargo workspace, `web`, `mobile`, and Android
(`versionName` + auto-incremented `versionCode`) in sync.

## CI

| Workflow | Trigger | Does |
|----------|---------|------|
| [`ci.yml`](../.github/workflows/ci.yml) | push to `main`, PRs | `cargo check`/`test` workspace; web typecheck + build |
| [`android.yml`](../.github/workflows/android.yml) | `mobile/**` or `web/**` changes, manual | Build debug APK, upload as artifact |
| [`release.yml`](../.github/workflows/release.yml) | tag `v*`, manual | Binary + APK + GitHub Release (GHCR image if `ENABLE_GHCR=true`) |

The Android workflow builds an **unsigned debug APK** (no secrets needed),
installable for personal sideloading. To ship a Play-Store / F-Droid-style
signed release later, add a `signingConfig` plus keystore secrets and switch the
release job to `assembleRelease`.
