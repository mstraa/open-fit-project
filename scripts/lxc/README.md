# Open Fit — Proxmox LXC

Native install (no Docker): the self-contained `ofit-api` binary running under
systemd in an unprivileged Debian 12 container. The web UI is embedded in the
binary, so the container serves everything on `:8087`.

## Install

On the **Proxmox host** (root):

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/mstraa/open-fit-project/main/scripts/lxc/openfit-lxc.sh)"
```

This creates the container, then runs [`openfit-install.sh`](openfit-install.sh)
inside it. Env overrides (e.g. `CTID`, `RAM`, `DISK`, `STORAGE`, `BRIDGE`,
`OFIT_VERSION`) are documented in [`../../docs/DEPLOY.md`](../../docs/DEPLOY.md).

## The three scripts

| Script | Runs on | Purpose |
|--------|---------|---------|
| [`openfit-lxc.sh`](openfit-lxc.sh) | Proxmox host | Create the CT, then run the installer inside it |
| [`openfit-install.sh`](openfit-install.sh) | inside the CT | Download the release binary, systemd service, token, console auto-login, `openfit-update` |
| [`openfit-update.sh`](openfit-update.sh) | inside the CT (as `openfit-update`) | Pull a newer release binary + restart |

All are **idempotent** and parameterised by `OFIT_REPO` / `OFIT_BRANCH` /
`OFIT_VERSION` so a fork or pinned version works without edits.

## Inside the container

```sh
systemctl status openfit                 # service state
systemctl restart openfit                # after editing config
journalctl -u openfit -f                 # logs
cat /etc/openfit/openfit.env             # token, bind, DATABASE_URL, RUST_LOG
openfit-update                           # update to the latest release
openfit-update 0.3.0                     # or pin a version
```

- **Binary:** `/usr/local/bin/ofit-api`
- **Config:** `/etc/openfit/openfit.env` (`OFIT_TOKEN` generated on first install)
- **Data:** `/var/lib/openfit/` (SQLite DB, imports)
- **Service runs as:** the unprivileged `ofit` system user

### Switch to Postgres/Timescale

Edit `DATABASE_URL` in `/etc/openfit/openfit.env` to a `postgres://…` URL and
`systemctl restart openfit` — same binary, no reinstall (sqlx supports both).
