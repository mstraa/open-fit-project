# Open Fit

Self-hosted, **100% cloudless**, open-source (AGPLv3) fitness & health platform. Collect your data **locally / on your own server**, **display** it (themable, multi-UI dashboard), and **process** it (multi-device dedup/fusion + pluggable algorithms).

Data is collected **directly**: native **BLE** (connect to devices over Bluetooth — multiple streaming live at once), plus file/history imports (`.fit`, Zepp and Garmin exports) for backfill. No vendor cloud (Garmin Connect / Zepp / Stryd PowerCenter are deliberately excluded).

## Two novel cores
1. **Multi-device dedup/fusion** — N devices on one effort → 1 logical workout, keeping all raw data, picking the best source **per metric** (persistent, editable, retroactive preferences).
2. **Algorithms as plugins** — sandboxed WASM algorithms (HRV, recovery, sleep staging, training load, anomalies), versioned, shareable via a community registry.

## Status
**Phase 0 — Foundations** (in progress). Greenfield. See [PLAN.md](PLAN.md) for the full roadmap and [docs/STATUS.md](docs/STATUS.md) for current state.

## Architecture
Rust workspace (`crates/`) + React/Vite frontend (`web/`) + Android app (`mobile/`).

| Crate | Role |
|-------|------|
| `ofit-core` | Canonical entities + dedup/fusion engine + per-metric resolver |
| `ofit-ingest` | FIT / Zepp / Garmin import + batch/stream ingestion |
| `ofit-analytics` | Algorithm execution (built-in + plugins), versioned derived metrics |
| `ofit-plugins` | WASM plugin host (Extism), sandboxed loadable algorithms |
| `ofit-db` | sqlx (SQLite **and** Postgres/Timescale), migrations, time-series |
| `ofit-api` | axum REST + WebSocket/SSE, OpenAPI (utoipa), single-user auth |
| `ofit-mcp` | (later) MCP server over the API |

## Deployment
The web UI is **embedded in the `ofit-api` binary**, so one process serves both
the API and the dashboard on port `8087` — no nginx, no separate web bundle.
SQLite by default; point `DATABASE_URL` at Postgres/Timescale for the full tier.

- **Proxmox LXC** (primary, native + systemd): one-liner on the Proxmox host —
  ```sh
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/mstraa/open-fit-project/main/scripts/lxc/openfit-lxc.sh)"
  ```
- **Bare binary**: download from [Releases](https://github.com/mstraa/open-fit-project/releases).
- **Docker**: compose in [`docker/`](docker) (simple SQLite / full Postgres+Timescale); GHCR image publishing is opt-in.

Releases are tag-driven (`vX.Y.Z` → Linux binary + Android APK; GHCR image optional).
Full guide: **[docs/DEPLOY.md](docs/DEPLOY.md)**.

## Develop
```sh
cargo check --workspace      # build all crates
cargo run -p ofit-api        # run the API
```

## License
**AGPL-3.0-or-later** for the server (network copyleft, fits self-hosted web); the mobile app is GPLv3.
