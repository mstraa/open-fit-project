# Open Fit — Proxmox LXC

Native install (no Docker): the self-contained `ofit-api` binary running under
systemd in an unprivileged Debian container (12 or 13). The web UI is embedded
in the binary, so the container serves everything on `:8087`.

## Install

On the **Proxmox host** (root):

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/mstraa/open-fit-project/main/scripts/lxc/openfit-lxc.sh)"
```

A whiptail menu asks **Default** or **Advanced**; either way the rootfs
**storage is auto-detected** (you pick it when more than one is available — no
more hardcoded `local-lvm`). **Advanced** also lets you choose the **Debian
version (13 or 12)**, CTID, hostname, CPU/RAM/disk and bridge. It then runs
[`openfit-install.sh`](openfit-install.sh) inside the container.

For unattended installs, set `OFIT_NONINTERACTIVE=1` and any overrides (e.g.
`STORAGE`, `OSVER`, `RAM`, `DISK`) — see [`../../docs/DEPLOY.md`](../../docs/DEPLOY.md).

## The scripts

| Script | Runs on | Purpose |
|--------|---------|---------|
| [`openfit-lxc.sh`](openfit-lxc.sh) | Proxmox host | Create the CT, then run the installer inside it |
| [`openfit-install.sh`](openfit-install.sh) | inside the CT | Download the release binary, systemd service (port 80), token, console auto-login, `update` + `update-main` commands |
| [`openfit-update.sh`](openfit-update.sh) | inside the CT (as `update`) | Pull a newer **tagged release** binary + restart |
| [`openfit-update-main.sh`](openfit-update-main.sh) | inside the CT (as `update-main`) | **Build from source** (default branch `main`) + restart — bleeding-edge, before a release |

All are **idempotent** and parameterised by `OFIT_REPO` / `OFIT_BRANCH` /
`OFIT_VERSION` so a fork or pinned version works without edits.

## Inside the container

```sh
systemctl status openfit                 # service state
systemctl restart openfit                # after editing config
journalctl -u openfit -f                 # logs
cat /etc/openfit/openfit.env             # token, bind, DATABASE_URL, RUST_LOG
update                                    # update to the latest tagged release
update 0.3.0                             # or pin a version
update-main                               # build + deploy the latest main (from source)
update-main some-branch                   # or build a specific branch
```

- **Web UI + API:** `http://<container-ip>/` (port 80)
- **Binary:** `/usr/local/bin/ofit-api`
- **Config:** `/etc/openfit/openfit.env` (`OFIT_TOKEN`, `OFIT_BIND=0.0.0.0:80` generated on first install)
- **Data:** `/var/lib/openfit/` (SQLite DB, imports)
- **Service runs as:** the unprivileged `ofit` user (granted `CAP_NET_BIND_SERVICE` to bind port 80)

### Build from source (`update-main`)

`update` installs the latest **published release** — fast, just a prebuilt binary download.
`update-main` instead **compiles `ofit-api` from a source branch** in the container, so you can
run `main` before it's tagged. The first run installs the build toolchain (git + Node 20 + Rust
via rustup) and clones the repo to `/opt/openfit-src`; later runs fetch + rebuild incrementally
(the checkout + cargo cache persist there).

> Building is heavy: give the container **~2 GB RAM and a few GB free disk**, and expect the
> first build to take several minutes. The release path (`update`) needs none of that.

### Switch to Postgres/Timescale

Edit `DATABASE_URL` in `/etc/openfit/openfit.env` to a `postgres://…` URL and
`systemctl restart openfit` — same binary, no reinstall (sqlx supports both).
