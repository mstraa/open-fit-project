# AGENTS.md — guide for AI agents & contributors

Read this + [PLAN.md](PLAN.md) before working. Keep this file and [docs/STATUS.md](docs/STATUS.md) **up to date** as part of every change.

## What this project is
Cloudless, self-hosted, AGPLv3 fitness platform. **Scope = collect (local), display, process.** Hardware support is **delegated to Gadgetbridge** — do NOT add vendor connectors. Our two extension points are (1) per-metric multi-device dedup/fusion and (2) WASM algorithm plugins.

## Hard rules (locked with the user)
- **Zero cloud.** No Garmin Connect / Zepp / Stryd PowerCenter. Only exception: one-time initial zip/FIT import.
- Backend **100% Rust**; frontend **React + TS, API-first, themable**.
- `ofit-db` supports **SQLite and Postgres from day one** (sqlx) — never write SQLite-only or Postgres-only app code.
- Real-time ingestion (continuous HR, sleep) is first-class — model for streaming from day 1.
- Algorithm plugins run **sandboxed in WASM** (no network, CPU/mem limits) — they handle health data.
- License: **AGPL-3.0-or-later** (server), GPLv3 (mobile).

## Layout
See README.md table. `crates/` = Rust workspace, `web/` = React, `mobile/`, `registry/`, `migrations/`, `docker/`, `docs/`.

## Conventions
- Add deps via `[workspace.dependencies]` in root `Cargo.toml`, reference with `foo.workspace = true`.
- Errors: `thiserror` in libs, `anyhow` in bins/glue.
- Public types that cross the API boundary derive `serde` + `utoipa::ToSchema`.
- DB access goes through `ofit-db`; keep SQL portable across SQLite/Postgres or branch explicitly.
- The TS API client is **generated from OpenAPI** — don't hand-write API types in `web/`.

## Workflow for changes
1. `cargo check --workspace` must pass.
2. Update **docs/STATUS.md** (what changed, what's next) and any affected doc.
3. Keep commits scoped per crate/feature where possible.

## Canonical data model (summary)
`Source` → `RawRecording` (immutable, hashed) → `Activity` (logical workout, dedup unit) → `Stream` (per-recording time-series). Plus continuous `Wellness`, `MetricSourcePreference` (per-metric resolver: default + per-activity override + retroactive toggle), `DerivedMetric/DerivedStream` (algo outputs, tied to plugin+version). Full detail in PLAN.md.
