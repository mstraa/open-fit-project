# STATUS

_Living doc — current state of the build. Update on every change._

**Last updated:** 2026-05-30
**Current phase:** Phase 1 (MVP: data column + dashboard) — **DONE & verified end-to-end** ✅

## Run the MVP
```sh
DATABASE_URL="sqlite://./data/ofit.db?mode=rwc" cargo run -p ofit-api   # api on :8080
cd web && npm install && npm run dev                                    # dashboard (VITE_API_BASE defaults to :8080)
# import via the dashboard, or: curl -F file=@test-data/long-run.fit http://localhost:8080/api/import
```
Verified flow: import the 6 `test-data/` files → **2 activities** (Running ×3, Cycling ×3, exact-hash dedup) → detail shows 7 resolved scalar charts + map track → per-metric source picker flips `selected_by` to `activity_override`.

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

## Phase 1 — in progress
- [x] `ofit-ingest`: file-import adapter. `import_file(&Path)` / `import_bytes(name, bytes)`
      → `ParsedRecording { recording: RawRecording, streams: Vec<Stream> }`. Formats
      detected by extension + content sniff: **.fit** (`fitparser` → HR/Power incl. Stryd
      dev "Power"/Cadence/Speed/Altitude/Distance/Temperature/LatLng; semicircles→deg),
      **.gpx** (`gpx` crate spine + `quick-xml` gpxtpx HR/cad/atemp extensions),
      **.tcx** (`quick-xml`; LatLng/Altitude/Distance/HR/Cadence/Speed/Watts, Sport from
      `Activity@Sport`). **Real SHA-256** (`sha2`) over original bytes set on
      `content_hash` (verified == `shasum -a 256`). `source_id` = deterministic
      `PLACEHOLDER_SOURCE_ID` until the import/dedup stage assigns the real `Source`.
      `started_at/ended_at` from first/last timestamp; `Sample.t_offset_ms` = ms since start.
      metadata JSON: filename, format, parser, device. Integration test parses all 6
      `/test-data` files (6 → green): run=Running 4004s, velo=Cycling 953s, 4–8 streams each.

- [x] `ofit-core::dedup`: pure dedup/fusion engine. `cluster_recordings(&[RawRecording])
      -> Vec<Activity>` (single-linkage on the existing `Activity::accepts`/`add_recording`
      sport+time-overlap rule, deterministic order). `resolve_activity_view(activity,
      streams, sources, recording_source map, prefs) -> ResolvedActivityView` picks the
      best source **per `StreamKind`** (override > default > highest `Source.default_priority`),
      returning the resolved `Stream` + `SelectionReason` per metric. `should_reresolve_history`
      encodes the retroactive-default policy. 4 unit tests (clustering split/merge,
      override>default>priority, retroactive flag). Added `PartialOrd/Ord` to `StreamKind`
      (additive, for stable BTreeMap ordering).
- [x] `ofit-db`: dedup/fusion persistence + read-side queries (all portable Any-driver SQL):
      `recording_exists_by_hash`/`recording_id_by_hash` (exact-dedup probe),
      `insert_stream`/`insert_streams`/`streams_for_recording` (JSON sample blob per the
      existing `streams` table), `upsert_activity` (portable UPDATE-then-INSERT) +
      `set_activity_recordings`, `find_source_by_identity`/`list_sources`,
      `insert_preference`/`list_preferences`/`preferences_for_activity`, plus
      `list_activities`/`get_activity`/`get_recording`/`list_recordings`/`recording_sources`
      and count helpers. Existing Phase-0 helpers untouched.
- [x] `ofit-ingest::pipeline`: `import_path(&Db, &Path) -> Result<ImportOutcome, PipelineError>`
      orchestration — parse → exact-hash dedup (skip→`Duplicate`) → create/reuse `Source`
      (one per detected **device** label, else per-format `FileImport` fallback; matched by
      (kind,name)) → persist `RawRecording`+`Streams` → re-run `cluster_recordings` over all
      recordings and reconcile `activities`/`activity_recordings` (reuses existing activity
      ids). **Fil-rouge test** (`tests/import_pipeline.rs`): imports all 6 `/test-data` files
      into a fresh SQLite db → **6 raw_recordings, exactly 2 activities (1 Running w/ 3
      recordings, 1 Cycling w/ 3 recordings)**; re-importing all 6 is a no-op (counts
      unchanged); resolved view yields one stream per metric kind. **Passes.**

- [x] `web/` Phase-1 dashboard (React, **no Rust touched**). Added deps `uplot` +
      `maplibre-gl`. Centralized API-boundary types in `src/api/types.ts` (mirror
      ofit-core serde `snake_case` enums) + tolerant typed endpoint wrappers in
      `src/api/endpoints.ts` (normalize likely field aliases at the boundary;
      `TODO(api-first)` to swap for the OpenAPI-generated client). Transport
      extended (`apiSend` JSON, `apiPostForm` multipart). Views: **activities list**
      (sport icon/date/duration/#recordings, graceful when API offline) with an
      **import control** (multipart `file` → `POST /api/import`, per-file outcomes,
      refreshes list); **activity detail** = **uPlot** line charts (HR/power/cadence/
      speed/altitude from `resolved`) + **MapLibre GL** map of the resolved LatLng
      track (key-free OSM raster, cloudless) + **per-metric source picker** (PUT
      `/api/preferences` scope `activity` for override; default scope w/ retroactive
      toggle; charts re-fetch the resolved view on change). Everything token-themed
      (light/dark), detail view code-split (charts lazy-loaded). `npm install` +
      `npm run build` (tsc strict + vite) **green**. `cargo check --workspace` still green.

- [x] `ofit-api`: Phase-1 REST surface (all under `/api`, behind the auth stub).
      Thin handlers in `handlers.rs`, DTOs in `dto.rs` (serde + `utoipa::ToSchema`),
      every path/schema registered in `ApiDoc`. Endpoints:
      **POST /import** (axum `multipart`, 512 MB body limit on this route; per-file
      outcome `{filename, ok, recording_id?, activity_id?, deduped, streams_found,
      error?}`), **GET /sources**, **GET /activities**
      (id/sport/started_at/ended_at/recording_count/duration_secs),
      **GET /activities/{id}** (recordings w/ source name+format+`available_metrics`,
      RESOLVED `resolved_metrics:[{kind,source_id,source_name,recording_id,
      selected_by,sample_count,points:[{t_offset_ms,value}]}]` via
      `resolve_activity_view` downsampled to ≤1000 pts, resolved LatLng `track:
      [{t_offset_ms,lat,lng}]` + `track_source_id`), **GET/PUT /preferences**
      (default|activity scope; an override flips the resolved view at read time),
      **GET /wellness?kind=&from=&to=** (trend; empty for this dataset but correct).
      Added `Db::wellness_samples(kind, from, to)` (portable lexicographic range query)
      and `ofit_ingest::import_bytes_path(db, name, bytes)` (multipart entry sharing the
      file pipeline). Added `utoipa::ToSchema` to the core enums that cross the API
      boundary (`Sport`, `StreamKind`, `SourceKind`, `WellnessKind`, `SelectionReason`).
      **Verified end-to-end** on a temp SQLite db: POST all 6 `/test-data` files →
      `GET /api/activities` = **2** (Running 4004s ×3, Cycling 953s ×3); detail returns
      7 resolved scalar metrics + a 1000-pt LatLng track; a per-activity HR override
      resolves with `selected_by=activity_override`; re-import is `deduped:true`.
      `cargo check --workspace` + `cargo test` green.
      **Web reconcile — DONE:** `web/src/api/endpoints.ts::getActivity` now maps the
      real API shapes into the view model — `available_metrics`, the `resolved_metrics`
      **array** (keyed into the `resolved` map by `kind`, `points`→samples), and the
      top-level `track`+`track_source_id`→`resolved.lat_lng`. Preferences come from
      `GET /api/preferences`. The normalizer keeps the old aliases as fallbacks; when the
      OpenAPI-generated client lands it replaces this hand mapping.

## Next (Phase 1 — MVP: data column + dashboard)
Wire the generated typed TS client (`gen:api` from `/api-docs/openapi.json`) and
reconcile the web dashboard's tolerant aliases (see **API field assumptions** below)
with the implemented shapes (noted above). Retroactive re-resolution when a retroactive
default changes (`should_reresolve_history`) — resolution is recomputed at read time so
the view is already correct; a materialized cache is the optimization. Consider a
normalized samples table if per-sample queries land. Ingest a wellness feed so
`/api/wellness` has data.

### API field assumptions the web client makes (reconcile with ofit-api)
The web client targets these shapes under `/api` (base = `VITE_API_BASE`, default
`http://localhost:8080`). Enum values are canonical ofit-core serde **snake_case**.
- `GET /api/activities` → `[{ id, sport, started_at, ended_at, recording_count,
  duration_secs }]`. Client falls back to `ended_at-started_at` if `duration_secs`
  is absent; tolerates `activity_id`, `start/end`, `recordings_count` aliases.
- `GET /api/activities/{id}` → `{ recordings:[{ id, source_id, source_name, format,
  stream_kinds:[StreamKind] }], resolved: { <StreamKind>: { source_id, recording_id?,
  selected_by?, samples:[{t_offset_ms,value}] } }, preferences:[MetricSourcePreference] }`.
  For `lat_lng` the resolved entry carries a **track**: `samples:[{t_offset_ms,lat,lng}]`
  (client also accepts `.track`/`.points`, `lon`/`longitude`). `selected_by` ∈
  `activity_override|default|priority`.
- `GET /api/sources` → `[Source]` (id, kind, name, manufacturer?, default_priority).
- `GET/PUT /api/preferences` → `MetricSourcePreference { metric, scope:'default'|
  'activity', activity_id?, source_id, retroactive }`. **PUT** is an upsert; the UI
  sends scope `activity` (+ activity_id) for a per-activity override, and scope
  `default` (+ retroactive) for the persistent default.
- `POST /api/import` (multipart, field name **`file`**, repeated for multiple files)
  → per-file outcome array (or `{results:[…]}`); client reads `filename`, `status`/
  `outcome`, optional `message`.
**Source-of-metric for the picker** is derived client-side by intersecting each
recording's `stream_kinds` with its `source_id`/`source_name` (no extra endpoint
needed). If the API later exposes per-metric candidate sources directly, simplify
`candidatesByMetric` in `web/src/views/ActivityDetail.tsx`.

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
