# STATUS

_Living doc — current state of the build. Update on every change._

**Last updated:** 2026-05-30
**Current phase:** Phase 0 complete → starting Phase 1 (MVP: data column + dashboard)

## Done
- Rust workspace scaffolded: `ofit-core`, `ofit-ingest`, `ofit-analytics`, `ofit-plugins`, `ofit-db`, `ofit-api`, `ofit-mcp` (stubs, `cargo check --workspace` green).
- Root `Cargo.toml` with shared `[workspace.dependencies]` (axum, sqlx SQLite+Postgres, utoipa, fitparser, extism, tokio…).
- Docs: README, AGENTS.md, this STATUS, LICENSE (AGPLv3).
- Git initialized.

## Phase 0 — DONE ✅
- [x] `ofit-core`: canonical entities (Source, RawRecording, Activity, Stream, WellnessSample, MetricSourcePreference, Derived*), module-per-concept, serde throughout, thiserror error.
- [x] `ofit-db`: sqlx over the **`Any`** driver → one code path + portable migrations serve SQLite **and** Postgres (chosen at runtime from `DATABASE_URL`). `migrations/0001_init.sql` (sources, raw_recordings w/ unique hash index, activities, streams, wellness_samples indexed by ts, prefs, derived). `connect`/`run_migrations` + minimal insert/get helpers.
- [x] `ofit-api`: axum app — `GET /health` (reports db backend), `GET /api/version`, OpenAPI at `/api-docs/openapi.json` + swagger-ui, CORS + tracing, single-user **bearer auth stub** (`OFIT_TOKEN`), env config w/ SQLite default, connects db + runs migrations on startup. **Verified end-to-end**: boots on SQLite, migrates, serves all routes (curl-checked).
- [x] `web/`: Vite + React 18 + TS (strict) scaffold. Design-token theming
      (`src/theme/tokens.css`, light+dark via `[data-theme]`) + `ThemeProvider`/`ThemeToggle`.
      App shows name, theme toggle, and live `GET /health` check (base from
      `VITE_API_BASE`, default `http://localhost:8080`). API-first: `src/api/` has a
      temporary fetch wrapper + README noting the typed client is generated from
      OpenAPI (`/api-docs/openapi.json`); `gen:api` placeholder script. `npm install`
      done (67 pkgs); `npm run build` green (tsc + vite).
- [x] `docker/`: compose `simple` (SQLite binary) + `full` (api + Postgres/Timescale), Dockerfile.
      Multi-stage `Dockerfile` (rust:1.83-bookworm → debian:bookworm-slim, port 8080, `/data` VOLUME,
      `DATABASE_URL` default SQLite, `OFIT_TOKEN`, `/health` HEALTHCHECK). `docker/.env.example`,
      `docker/README.md` with the two-tier commands from PLAN.md verification (steps 1 & 7).

## Next (Phase 1 — MVP: data column + dashboard)
FIT/zip import → RawRecording+Streams; dedup v1 (hash + temporal/sport clustering + per-metric prefs); REST + typed TS client; dashboard (uPlot + MapLibre + per-metric source picker).

## Notes / open risks
- Gadgetbridge coverage (Garmin FIT w/ Stryd over BLE? Helio?) — validate with real hardware before Phase 2b.
- FIT **writing** in Rust immature → Phase 6 risk.
- sqlx-cli not installed locally; migrations run via `ofit-db` at startup or `cargo sqlx` once added.

## Carry-over for Phase 1 (from Phase 0 build)
- **Hash:** `ofit_core::ContentHash::of_bytes` is a crypto-free **non-cryptographic fallback**. `ofit-ingest` (already depends on `sha2`) MUST overwrite it with real SHA-256 at ingestion — the dedup unique-hash index depends on this. Honor the documented ALGORITHM/hex contract.
- **Streams** currently persist samples as a JSON blob in the `streams` table. If Phase 1 analytics need per-sample queries, add a normalized (portable) samples table.
- **Postgres untested:** only SQLite was exercised. The `Any`-driver path + portable SQL are designed for both; run `docker/docker-compose.full.yml` and re-run the verification thread to confirm.
- **Timescale:** `wellness_samples` is shaped to become a hypertable — add a Postgres-only migration branch when the full tier is exercised.
- **Auth:** replace the `OFIT_TOKEN` bearer stub in `ofit-api` with real single-user auth wired to the first-run wizard.
- **web `gen:api`:** implement for real (e.g. `openapi-typescript` from `/api-docs/openapi.json` → `src/api/generated/`) and drop the hand-written `HealthResponse` type.
- **Need from user:** real **945 + Stryd `.fit`** files (+ an overlapping recording from another source) to verify dedup/fusion. Suggested drop dir: `samples/`.
