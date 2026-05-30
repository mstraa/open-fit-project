# STATUS

_Living doc — current state of the build. Update on every change._

**Last updated:** 2026-05-30
**Current phase:** Phase 0 — Foundations

## Done
- Rust workspace scaffolded: `ofit-core`, `ofit-ingest`, `ofit-analytics`, `ofit-plugins`, `ofit-db`, `ofit-api`, `ofit-mcp` (stubs, `cargo check --workspace` green).
- Root `Cargo.toml` with shared `[workspace.dependencies]` (axum, sqlx SQLite+Postgres, utoipa, fitparser, extism, tokio…).
- Docs: README, AGENTS.md, this STATUS, LICENSE (AGPLv3).
- Git initialized.

## In progress (Phase 0)
- [ ] `ofit-db`: sqlx pool (SQLite+Postgres), initial migrations, time-series schema for continuous wellness.
- [ ] `ofit-core`: canonical entities (Source, RawRecording, Activity, Stream, Wellness, MetricSourcePreference, Derived*).
- [ ] `ofit-api`: axum app, health route, OpenAPI (utoipa) scaffold, single-user auth stub, first-run wizard config.
- [ ] `web/`: Vite + React + TS scaffold, design-token theming, generated API client wiring.
- [ ] `docker/`: compose `simple` (SQLite binary) + `full` (api + Postgres/Timescale), Dockerfile.

## Next (Phase 1 — MVP: data column + dashboard)
FIT/zip import → RawRecording+Streams; dedup v1 (hash + temporal/sport clustering + per-metric prefs); REST + typed TS client; dashboard (uPlot + MapLibre + per-metric source picker).

## Notes / open risks
- Gadgetbridge coverage (Garmin FIT w/ Stryd over BLE? Helio?) — validate with real hardware before Phase 2b.
- FIT **writing** in Rust immature → Phase 6 risk.
- sqlx-cli not installed locally; migrations run via `ofit-db` at startup or `cargo sqlx` once added.
