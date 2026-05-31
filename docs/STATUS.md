# STATUS

_Living doc — current state of the build. Update on every change._

**Last updated:** 2026-05-31
**Current phase:** Phases 0–3 DONE ✅ · **Phase 4 (life tracker / wellness views)** 🚧 (Dashboard + Wellness + Sleep wired to real data; Trends/posture next)

## Phase 4 — life tracker / wellness views (web/, React)
- **Wellness screen — WIRED ✅** no longer Phase-4 stubs: a real **Readiness banner** (score + word from the `readiness` algorithm via `/api/analytics/training-load`), 4 stat tiles with latest **resting HR / HRV / stress avg / body battery**, trend sparklines (HRV, body battery, resting HR, stress, steps) over Day/Week/Month windows **anchored to each series' latest sample** (so imported history that ends a day or two ago still shows), with even-stride downsampling for the big series (HRV ~10k, stress ~9.5k pts). A **last-night sleep card** (score + stage bar) walks back to the most recent night with data and links to `/sleep`.
- **Sleep screen — DONE ✅** (`/sleep`, see Phase 2/3 entries): last-night tiles + recent-nights stage bars from the `sleep` algorithm.
- **Dashboard** already bound (readiness banner + `WellnessLatestTile` resting-HR/body-battery, correct serde kind names).
- **Key fix:** `getWellness` now reads the API's `ts` field (was looking for `date`/`day`), and the Wellness screen uses the real serde kind names (`resting_heart_rate`/`sleep_stage`, not `resting_hr`/`sleep`) — that field/name mismatch was why the computed data wasn't showing.
- **Verified live (8087):** Readiness 67/100 · HRV 67ms (baseline 47) · resting_heart_rate 101 · hrv 10,080 · stress 9,590 · body_battery 56 · steps 7,217 samples.
- **Next in Phase 4:** Weight/Calories tiles + a **Trends** screen (long-term day/week/month); posture (lying/sitting/standing) pending a Helio/Gadgetbridge source.

## Phase 3 — derived persistence + analytics REST (ofit-db + ofit-api)
Stage 3: persist algorithm outputs and expose the analytics engine over REST so the dashboard can list algorithms, recompute, and read chart-ready derivations.
- **ofit-db**: new portable migration `0003_derived_streams.sql` (mirrors the `streams` table: JSON sample blob in TEXT, indexed by `(subject_kind,subject_id)` + `(plugin_id,plugin_version)`; `derived_metrics` already existed from 0001). Helpers (all `Db::p` portable, SQLite+Postgres): `persist_derived(&[DerivedMetric], &[DerivedStream])` — **idempotent recompute** (one tx; delete-then-insert superseding by `(plugin_id,version,subject_kind,subject_id,name)`); `derived_metrics_for_subject`/`derived_streams_for_subject` (read a subject's derivations); `derived_metrics_for_plugin`/`derived_streams_for_plugin(plugin,version,name?)` ordered by `computed_at` (latest-wins for the training-load view); `count_derived`. `DerivedSubject ↔ (kind,id)` via `subject_parts`/`subject_from_parts`; `row_to_derived_{metric,stream}` mappers.
- **ofit-analytics**: added `day_from_uuid(Uuid)->Option<NaiveDate>` (inverse of `day_uuid`) so the API recovers absolute calendar dates from a `DerivedSubject::Day` id to date the offset-from-first-day CTL/ATL/TSB samples. Re-exported from `algorithms`.
- **ofit-api** (`analytics.rs`, thin handlers behind `require_auth`, DTOs serde+ToSchema in `ApiDoc`): registry assembly `load_algorithms(plugins_dir)` = `ofit_analytics::builtin_algorithms()` + `PluginHost::load_dir_lenient` (a bad plugin is skipped+logged, never fails the run); a new `AppState.plugins_dir` from `OFIT_PLUGINS_DIR` (absent ⇒ built-ins only). Endpoints: **GET /api/algorithms** (id/version/name/description/inputs[`stream:`/`wellness:` tags]/outputs/applicable_hardware/kind[`built_in`|`wasm`]/enabled); **POST /api/analytics/recompute** (builds one `AnalyticsInput` from *all* activities — each with `resolve_activity_view` best-source-per-metric scalar streams — + the HRV/RHR/HR wellness series; runs every algorithm sync, then persists per-algorithm; returns per-algorithm `{metrics,streams}` counts; idempotent); **GET /api/analytics/derived?subject=activity:{id}|day:{YYYY-MM-DD}** (chart-ready metrics+streams; `day:` re-derives the stable `day_uuid`); **GET /api/analytics/training-load** (CTL/ATL/TSB fused into dated `{date,ctl,atl,tsb}` points via `day_from_uuid` + latest readiness/`readiness_available`/`hrv_rmssd`/`hrv_baseline`; empty when not computed).
- **Verified (curl, temp SQLite)**: imported RUN001-Stryd+RUN001-Zepp (→ 1 running activity, 2 recordings, 14+5 streams) + BIKE001 (cycling); POSTed a 7-day HRV+RHR series with a today RHR spike (80 vs 55); `POST /api/analytics/recompute` → `{training_load: 2 metrics/3 streams, readiness: 4/0, anomaly: 1/0}` (7 metrics, 3 streams). `GET /api/algorithms` lists all 3 built-ins (`kind:built_in`). `GET /api/analytics/training-load` → **329 dated CTL/ATL/TSB points** (2025-07-03 first bike day → 2026-05-27 run day; run-day ATL jumps to 16.8), readiness 48.9 (available), HRV rmssd 75 / baseline 62.1. `GET derived?subject=activity:{run}` → **TSS 126.5**; `subject=day:2026-05-30` → `resting_hr_anomaly=1.0` + readiness/HRV. **Idempotent**: a 2nd recompute keeps totals at 7/3 and the run still has exactly 1 TSS row. Bad subject → 400. OpenAPI registers all 4 paths + 10 schemas. `cargo check --workspace` + `cargo test --workspace` green (no regressions; 10 analytics + 9+5 plugin tests still pass).
## Phase 3 — web analytics surface (web/, React, no Rust) — DONE ✅
Surfaced the analytics engine in the dashboard. **Schema refreshed** via `npm run gen:api` against a live API (built `ofit-api` binary on a temp SQLite db) → `src/api/generated/schema.d.ts` now carries `AlgorithmDto`/`RecomputeResponse`/`TrainingLoadResponse`/`DerivedResponse` + friends; aliased in `src/api/schema.ts`.
- **endpoints.ts**: `listAlgorithms()`, `recomputeAnalytics()`, `getTrainingLoad()` (degrades to an empty result on unreachable API / uncomputed analytics so the dashboard shows its empty state, not an error), `getDerived(subject)` (throws on the API's 400 for a malformed subject). Shapes come straight from the generated schema (no normalization needed).
- **Algorithms screen** (`screens/Algorithms.tsx` + `.css`, new route replacing the ComingSoon): each algorithm as a design card (name, `vX.Y.Z`, Built-in vs **WASM plugin** badge, input chips parsed from `stream:`/`wellness:` tags, output chips, applicable-hardware tags, enabled pill). Split into a **Built-in** section and a distinct **Community plugins** (sandboxed WASM) section — the latter shows an on-brand empty state describing `OFIT_PLUGINS_DIR` when no plugin is loaded. Topbar **Recompute** button POSTs `/api/analytics/recompute`, surfaces per-run counts in a banner, then refreshes. The rail's Algorithms badge is now the **real** registry count (`useAlgorithms` hook), not the old static 7.
- **Dashboard**: the **Training load & fitness** card renders a real CTL/ATL/TSB multi-series uPlot chart (`charts/MultiLineChart.tsx`, dated x-axis; legend colors `--accent`/`--cal`/`--elev` matching the design) from `getTrainingLoad()`. The **Training load · 7d** tile = latest ATL (+ form/TSB tag), the **HRV · overnight** tile = latest `hrv_rmssd` (+ baseline). The training-status banner becomes a **readiness banner** (0–100 score + good/warn/bad tone) when readiness is available, else an on-brand "Recompute →" prompt. All keep the "No data yet" empty state when analytics haven't run.
- **Activity detail**: the old "Derived" empty card is now an **Analysis** card showing the activity's derived metrics (TSS etc.) from `getDerived(activity:{id})`, each tile tagged with its producing `plugin_id vX.Y.Z`; empty state preserved when nothing is computed.
- **Verified**: imported the 6 `/test-data` FITs + a 7-day HRV/RHR series via `POST /api/wellness`, `POST /api/analytics/recompute` (7 metrics / 3 streams), then confirmed `GET /api/algorithms` (3 built-ins), `/api/analytics/training-load` (329 dated points, readiness 43.9 available, HRV 76/baseline 73) and `derived?subject=activity:{run}` → **TSS 126.5**. `cd web && npx tsc --noEmit` **clean** (did not run vite build — the verifier does). The only generated-file change is `schema.d.ts` (regenerated, not hand-edited).
- **Next**: a per-algorithm enable toggle (the `enabled` field + a future PATCH); when a real `.wasm` plugin is dropped in `OFIT_PLUGINS_DIR` it appears in the Algorithms screen's Community section (`kind:wasm`) and recompute persists its outputs through the same path; weekly-volume + Today-rings cards still await their aggregations.

## Phase 3 — sandboxed WASM plugin host (ofit-plugins)
The project's extension point: community/third-party **algorithms as WASM plugins**, run sandboxed, behind the **same** stage-1 `Algorithm`/`RunnableAlgorithm` abstraction as the built-ins so `ofit-analytics` mixes them uniformly.
- **Manifest** (`manifest.rs`): `PluginManifest` (TOML *or* JSON next to the `.wasm`) declares the same `AlgorithmSpec` fields (id, version, name, inputs, outputs, applicable_hardware) + a `[wasm]` section (`path`, optional `sha256` integrity pin, `entrypoint` default `run`). `spec()` rebuilds the canonical `AlgorithmSpec` — always `kind = Wasm` (a plugin can never masquerade as a built-in). Layout: `plugins/<name>/{plugin.toml, <name>.wasm}` (top level or one subdir level).
- **Sandbox** (`sandbox.rs`): `SandboxLimits { max_pages, max_var_bytes, timeout_ms }` (defaults 64 pages/4 MiB, 64 KiB vars, 5 s). `extism_manifest()` builds the Extism `Manifest` **deny-by-default**: `disallow_all_hosts()` + `max_http_response_bytes=0` (**no network**), plugins built `with_wasi=false` + **no** `allowed_paths` (**no filesystem/WASI**), **empty imports** list (**no host functions** — only data-in/data-out), bounded memory + interrupting timeout. Policy only ever *tightens* Extism defaults.
- **Host** (`host.rs`): `PluginHost::load_dir(dir, limits)` discovers + parses manifests, reads each `.wasm`, **verifies SHA-256** against the pin, rejects duplicate `(id,version)`. `WasmPlugin` impls `ofit_core::Algorithm` + `ofit_analytics::RunnableAlgorithm`: `compute()` builds a **fresh sandboxed Extism instance per call** (no cross-call state), marshals `AnalyticsInput`→`PluginInput` JSON in, calls the entrypoint, reads `PluginOutput` JSON out, **validates every output name against the declared outputs**, and tags each with the plugin's `PluginRef(id,version)`+`computed_at` (host is the provenance authority). Failures (trap, mem/timeout limit, malformed/undeclared output) degrade to zero outputs (logged), never panic. `host.into_runnables()` hands boxed `RunnableAlgorithm`s so `let mut a = ofit_analytics::builtin_algorithms(); a.extend(host.into_runnables());` runs built-ins + plugins through one list.
- **Wire** (`wire.rs`): `PluginInput`/`PluginOutput` — the explicit JSON ABI a plugin author commits to (mirrors the non-serde analytics input structs); round-trip-tested lossless. Authoring a real plugin (extism-pdk + `wasm32` target) documented in the crate root.
- **Verified**: `cargo test -p ofit-plugins` green (14 tests). **Two verification paths** (this machine has no wasm toolchain): (1) a **real prebuilt Extism module** `tests/fixtures/count_vowels.wasm` (fetched once at build from the public Extism release, committed; SHA pinned) is loaded under the sandbox manifest and called end-to-end (proves Extism compile→instantiate→data-in→data-out); (2) tiny **WAT modules compiled in-process** via the `wat` crate (no toolchain) that speak our ABI exercise the **typed** `try_compute` path: marshalling + output validation + provenance tagging, **undeclared-output rejection**, **timeout actually firing** (250 ms interrupt on an infinite loop), and full `load_dir`→`RunnableAlgorithm` discovery. Plus 9 unit tests (manifest TOML/JSON parse, version/outputs validation, hash-pin mismatch, registry dedup, sandbox-limit config, wire round-trip). `cargo check --workspace` + `cargo test --workspace` green.
- **Next**: ofit-api endpoints to list plugin specs alongside built-ins + a configured plugins dir; persist plugin-derived metrics/streams (same `(plugin_id,version,subject,name)` supersede key); the community registry (Phase 7) publishing these manifests+wasm.

## Phase 3 — algorithm abstraction + built-in algorithms (ofit-core + ofit-analytics)
The pure-Rust, user-visible Phase-3 win: versioned, recalculable built-in algorithms over the existing activity + wellness data.
- **ofit-core::analytics** (new module): `AlgorithmSpec { id, version, name, description, inputs: Vec<AlgorithmInput>, outputs: Vec<AlgorithmOutput>, applicable_hardware: Vec<String>, kind: AlgorithmKind(BuiltIn|Wasm) }`; `AlgorithmInput::{Stream(StreamKind)|Wellness(WellnessKind)}`; `AlgorithmOutput::{Metric(name)|Stream(name)}`. The `Algorithm { fn spec(&self)->&AlgorithmSpec }` trait. `AlgorithmSpec::plugin_ref()/tag_metric()/tag_stream()` build `DerivedMetric`/`DerivedStream` tagged with `PluginRef(id, version)` — the canonical, recompute-keyed tagging the DB+API+plugin-host bind to. All API-boundary types derive serde + `utoipa::ToSchema`. `derived.rs` untouched (extended via tagging helpers).
- **ofit-analytics** (was a stub): DB-free input structs (`AnalyticsInput { activities: Vec<ActivityInput>, wellness: Vec<WellnessPoint> }`, `ActivityInput`, `MetricSeries`, `WellnessPoint`) the API feeds from `ofit-db`; the `RunnableAlgorithm: Algorithm { fn compute(&self, &AnalyticsInput, computed_at) -> AlgorithmOutputs }` compute seam (`AlgorithmOutputs { metrics, streams }`). Built-ins: **TrainingLoad** (per-activity TSS — power-based Coggan when Power present, hrTSS vs LTHR otherwise, duration-only fallback; all thresholds in `AthleteThresholds`/`LoadTimeConstants` params; CTL 42-d / ATL 7-d EWMA + TSB=CTL−ATL → 3 DerivedStreams over a dense daily timeline), **Readiness** (HRV summary + 0–100 score from HRV+RHR vs personal baseline; emits `readiness_available` 0/1 and degrades to insufficient-data when <3 HRV samples / empty), **AnomalyFlag** (resting-HR z-score outlier on the latest reading). Registry `builtin_algorithms()` / `builtin_specs()`; orchestration `run_for_subject[_at]()` runs all built-ins and returns tagged outputs. Day subjects use a deterministic `day_uuid(date)` so derivations are stable across recompute.
- **Verified**: `cargo test -p ofit-core -p ofit-analytics` green (10 analytics tests: TSS in sane ranges for HR/power/fallback, CTL/ATL/TSB produced + tagged, readiness computed vs gracefully insufficient, anomaly flags an outlier, registry specs versioned x.y.z + unique, orchestrator tags every output). `cargo check --workspace` + `cargo test --workspace` green. Analytics crate is now pure (deps: ofit-core, chrono, uuid only — dropped the unused ofit-db/ofit-plugins deps; the API layer owns the DB→AnalyticsInput marshalling).
- **Next in Phase 3**: ofit-db derived_metrics/streams persistence keyed by `(plugin_id, version, subject, name)` + supersede-on-recompute; ofit-api endpoints to list specs, run for a subject, read derivations; the WASM **PluginHost** (Extism) implementing `RunnableAlgorithm` by marshalling `AnalyticsInput` across the sandbox (no wasm32 toolchain locally → host loads a prebuilt/test-fixture .wasm).

## Phase 2 — Android app (Capacitor) + mobile auth 🚧
- **mobile/**: Capacitor project wrapping the React web UI (`webDir → ../web/dist`) → the Android app reuses the entire dashboard/activities/wellness UI. `@capacitor-community/sqlite` + `@capacitor/filesystem` deps for the coming Gadgetbridge-DB reader; cleartext LAN http allowed. `android/` generated; **debug APK builds** (JDK 21 + Android SDK + Gradle). Build: `cd mobile && npm install && npm run sync && (cd android && ANDROID_HOME=~/Library/Android/sdk ./gradlew assembleDebug)`.
- **Mobile-ready auth**: login/setup also return the session token; `require_auth`/`/me`/`logout` accept `Authorization: Bearer <session-token>` (mobile is cross-origin to the LAN server → cookies don't apply). Web client base is runtime-configurable (`localStorage ofit_api_base`, set via a **"Connect to your server"** screen) with VITE_API_BASE/relative fallbacks; stores+sends the token as Bearer.
- **Gadgetbridge import — DONE ✅ (multi-device)** `ofit-ingest::gadgetbridge` reads an exported GB SQLite **per `DEVICE_ID`** (Huami/Amazfit + Garmin tables) → HR/steps/stress/SpO2/resting-HR/respiration/**HRV** (`GENERIC_HRV_VALUE_SAMPLE`)/**body-battery** (Garmin `BODY_ENERGY`); auto-normalizes mixed s/ms epochs; idempotent (delete-by-source before insert). `POST /api/import/gadgetbridge` → one source per device + per-device `by_kind`. Verified on the real 2-device export (Helio + 945): **87,884 readings** → Readiness 67/100.
- **Zepp / Amazfit app-export import — DONE ✅** `ofit-ingest::zepp` reads the app's "Export data" folder (zipped) — `read_zepp_zip(bytes)` extracts + `read_zepp_export(dir)` parses the category CSVs: `HEARTRATE_AUTO`→HeartRate, `SLEEP_MINUTE`→**SleepStage** (+in-sleep HR & respiration), `ACTIVITY`(daily)→Steps+**Calories**, `BODY`→**Weight**. Skips SPORT (summaries, no streams), ACTIVITY_MINUTE/STAGE (would double-count), SLEEP daily (derived). New `WellnessKind::{Weight,Calories}`. `POST /api/import/zepp` (multipart .zip) + a Wellness-screen card. Verified on the real export: **772,882 readings** (617k HR, 154k sleep-stage, 337 step-days, 337 calorie-days, 12 weights).
- **Sleep analyzer — DONE ✅ (new built-in)** `ofit-analytics::Sleep` (id `sleep` v1.0.0) groups per-minute `SleepStage` into nights (evening ≥18:00 → next morning) → `sleep_total/deep/rem/light/awake_min` + a 0–100 `sleep_score` (70% duration vs 8h + 30% deep+REM share) per night, `sleep_available` flag. Wired into recompute (`SleepStage` added to `ANALYTICS_WELLNESS_KINDS`). Verified: **2,331 metrics across ~333 nights** (e.g. 2026-05-27: score 97, 7h42m, deep 103m / REM 101m).
- **Sleep screen — DONE ✅** `web/src/screens/Sleep.tsx` (route `/sleep`, was ComingSoon): pulls the last 21 day-subjects' derived sleep metrics → last-night score/asleep/deep/REM tiles + a recent-nights list with stacked deep/REM/light/awake stage bars.
- **BLE stability — FIXED ✅** the live GATT connection now lives in an app-global `web/src/ble/BleProvider.tsx` mounted **above the router** (next to AuthProvider), so it **survives navigation** (previously the connection died when leaving `/devices`); adds silent auto-reconnect (3× backoff) on unexpected drops and a busy-guard against connect/scan churn. `BleDevices.tsx` is now a thin `useBle()` consumer.
- **Next**: confirm on-device which services the 945/Stryd/Helio expose; Gadgetbridge auto-export auto-sync; a Settings "server URL" editor; surface Weight/Calories trends + a Trends screen; later import the **full Garmin account export**.

## Phase 2a — real-time wellness ingestion (server side; no hardware needed)
The streaming-first wellness path the model was pre-wired for is now live.
- **ofit-db**: `insert_wellness_samples(&[..])` (batched, one tx) + `ensure_source(kind,name)` (get-or-create) for attributing streamed samples.
- **ofit-api**: `POST /api/wellness` batch ingest (sourceless samples → shared "Live stream" source; persists + fans out) and **`GET /api/wellness/live` WebSocket** that pushes live samples as JSON frames via a `tokio::broadcast` channel. `GET /api/wellness?kind=&from=&to=` (trend) already existed. DTOs `WellnessIngest`/`WellnessIngestResponse`/`LiveWellness` in OpenAPI.
- **web**: `useWellnessLive` hook (WS → latest-per-kind + rolling buffer, auto-reconnect); a **Live HR card** on the Wellness screen (current bpm + sparkline + connection pill). The screen's trend cards already consume `getWellness`, so they light up once data exists.
- **`scripts/wellness-sim.sh`**: dev tool that seeds a few days of resting-HR/HRV/stress/body-battery and streams live HR ~1/s to `POST /api/wellness` — to demo the dashboard without hardware (a Gadgetbridge relay replaces it in Phase 2a-interop).
- **Verified**: batch ingest + trend GET; WS upgrade → 101; **live frames delivered end-to-end** (Node WS client received streamed HR in real time); web builds.
- **Next in Phase 2a**: Gadgetbridge relay (Android) as the real producer; wire dashboard wellness tiles to latest values; the **Timescale hypertable** can now land (wellness has a native-timestamp write-path to design against). Cross-origin WS cookie auth caveat once an account exists (same-origin prod is fine).

## Earlier (Phase 1 + tie-off, design port, etc.) — details below

## Remove a recording from an activity — durable manual split (ofit-core + ofit-db + ofit-api)
The user can detach a recording (one device's contribution) from an activity without losing it: it moves into its **own new single-recording activity**, and the split is **durable** (re-importing never auto-merges it back).
- **ofit-core::dedup**: `detach_recording(&Activity, Uuid) -> Option<DetachResult { remaining, detached }>` (pure split: trims the original, seeds a fresh single-recording activity, marks **both** `user_confirmed`; `None` when the recording isn't a member or is the only one). New `cluster_recordings_respecting(&[RawRecording], locked: &[Activity])` treats `user_confirmed` activities as closed sets — their recordings are never re-clustered and new recordings never join them; `cluster_recordings` is now `cluster_recordings_respecting(recs, &[])`. Re-exported from the crate root. 2 new unit tests (detach + reclustering-respects-split).
- **ofit-db**: `detach_recording_from_activity(activity_id, recording_id) -> Uuid` (calls core, tightens both activity windows from member recording times, persists both groupings; returns the new activity id; `DbError::Conflict` for the guards) + `delete_activity` + new `DbError::Conflict` variant (maps to 4xx, not 500). Raw recordings + streams untouched. New integration test `tests/detach_split.rs`: 2 overlapping recordings → 1 activity → detach → **2 activities (1+1, both user_confirmed)**, raw data preserved, re-clustering keeps them split, last-recording detach is a Conflict no-op.
- **ofit-ingest::pipeline**: `recluster_and_persist` now loads existing `user_confirmed` activities, passes them as `locked` to `cluster_recordings_respecting`, persists them verbatim (stable ids) and excludes them from reuse-matching — so a manual split survives every re-import.
- **ofit-api**: `DELETE /api/activities/{id}/recordings/{recording_id}` (utoipa-documented) → **200** `RemoveRecordingResponse { activity: ActivityDetail (re-resolved), detached_activity_id }`. Guards: unknown activity → **404**; not-a-member or only-recording → **400** no-op (never orphans an empty activity). `get_activity` refactored to share `build_activity_detail` so the response re-resolves the per-metric view after removal.
- **Verified (curl, temp SQLite):** import RUN001-Zepp.fit + RUN001-Stryd.fit → 1 running activity, 2 sources with real names ("Garmin Forerunner 945" / Garmin, "Zepp" / "Zepp / Amazfit (Huami)"); detail shows the Stryd recording's 14 metrics incl. all running-dynamics kinds (air_power, form_power, ground_contact_time, leg_spring_stiffness, stride_length, vertical_oscillation, vertical_ratio when present) + a 1000-pt lat_lng track; DELETE the Zepp recording → **2 activities (1+1)**, original re-resolves to 13 metrics; re-import is `deduped:true` and stays split; 400/404 guards confirmed; OpenAPI lists the new path + schema. `cargo check --workspace` + `cargo test --workspace` green.

## FIT metric + device-name extraction (ofit-core + ofit-ingest)
Drove the change from a field dump of the real `/test-data` FITs (Stryd export, Zepp export, Garmin bike). **`StreamKind`** gained running-dynamics kinds (serde snake_case): `vertical_oscillation` (mm), `ground_contact_time` (ms), `stride_length` (mm), `vertical_ratio` (%), `form_power` (W), `air_power` (W), `leg_spring_stiffness` (kN/m). `StreamKind::ALL`, `unit()`, `label()` helpers added; `builder.rs::kind_key` extended. **`fit.rs`** extracts those from Stryd developer fields (`Vertical Oscillation` cm→mm, `Ground Time` ms, `Form Power`/`Air Power` W, `Leg Spring Stiffness` kN/m, `cycle_length16` m→mm stride) and native Garmin profile names (`vertical_oscillation`, `stance_time`, `step_length`, `vertical_ratio`) — missing fields are skipped, never panic. **Device naming** now reads `file_id` (manufacturer + garmin_product) + the creator `device_info` row: Garmin product ids map to models (`fr945` → "Garmin Forerunner 945", + Forerunner/Fenix/Edge table); Zepp/Huami detected via the `source=run.mifit.huami.com` host → "Zepp"; manufacturer ids map to display names; filename keywords are the last-resort fallback only. GPX/TCX infer manufacturer from creator; GPX without a track `<type>` infers sport from the filename so it still clusters. `metadata.device` + new `metadata.manufacturer` flow onto `Source.name`/`Source.manufacturer` in the pipeline. **Result:** Stryd FIT → "Garmin Forerunner 945" with 14 streams (incl. all running dynamics); Zepp FIT → "Zepp" (5 streams); bike FIT → "Garmin Forerunner 945" (6 streams). `cargo test -p ofit-ingest -p ofit-core` green; `cargo check --workspace` green.

## Design system (web)
The `docs/designs/` export (Garmin-Connect-class dark theme, OKLch tokens, per-metric colors) is now the live UI. Canonical CSS = `web/src/theme/app.css` (verbatim); `tokens.css` bridges legacy `--color-*` → design tokens. Shell in `web/src/app/AppShell.tsx` (rail nav + topbar + live health dot + mobile drawer); routes via react-router under `web/src/screens/` (Launcher, Dashboard, Activities, WorkoutDetail, Wellness, Settings, ComingSoon). **Real data**: Activities table + filter, WorkoutDetail (uPlot per-metric charts + MapLibre track + multi-device fusion source picker), Settings per-metric default source priority, Dashboard recent-activities + connected-sources. **Empty states** ("No data yet · Phase N") for future modules (training load, HRV, body battery, rings, wellness trends, device battery). Map is wrapped in `ui/ErrorBoundary` (degrades to "Map unavailable" without WebGL). `npm run build` green; all screens screenshot-verified.

## Run the MVP
```sh
DATABASE_URL="sqlite://./data/ofit.db?mode=rwc" cargo run -p ofit-api   # api on :8087
cd web && npm install && npm run dev                                    # dashboard (VITE_API_BASE defaults to :8087)
# import via the dashboard, or: curl -F file=@test-data/long-run.fit http://localhost:8087/api/import
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
      `VITE_API_BASE`, default `http://localhost:8087`). API-first: `src/api/` has a
      temporary fetch wrapper + README noting the typed client is generated from
      OpenAPI (`/api-docs/openapi.json`); `gen:api` placeholder script. `npm install`
      done (67 pkgs); `npm run build` green (tsc + vite).
- [x] `docker/`: compose `simple` (SQLite binary) + `full` (api + Postgres/Timescale), Dockerfile.
      Multi-stage `Dockerfile` (rust:1.83-bookworm → debian:bookworm-slim, port 8087, `/data` VOLUME,
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
`http://localhost:8087`). Enum values are canonical ofit-core serde **snake_case**.
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
- **Sparse-metric gating — DONE ✅** (Phase-1 tie-off). WorkoutDetail excludes a resolved metric from the charts/tiles when <20% of its samples are non-zero (e.g. Stryd `stride_length` from `cycle_length16` = ~1% non-zero → gated; the other 12 metrics ≥95% are kept).
- **Streams** persist samples as a JSON blob in the `streams` table — kept as-is (no per-sample query consumer yet; charts read the blob). A normalized samples table is deferred until analytics/per-sample queries actually need it (Phase 3+).
- **Postgres — VERIFIED ✅** (Phase-1 tie-off). Ran the full tier against `timescale/timescaledb:latest-pg16`: import (7 streams→13 metrics incl running dynamics), list/detail, per-metric preference override, durable remove-recording split, and a wellness insert all behave identically to SQLite. **Bug found & fixed:** sqlx's `Any` driver does **not** translate `?` placeholders to Postgres `$1,$2,…` (Postgres errored `syntax error at or near "LIMIT"`) — so Postgres never actually worked before. `Db::p()` now rewrites placeholders for Postgres only (no-op on SQLite); applied at all 28 query sites.
- **Timescale hypertable — deferred to Phase 4** (wellness streaming), by design. `Db::apply_timescale()` enables the extension on Postgres+Timescale but does **not** convert `wellness_samples`: the portable schema stores `ts` as RFC3339 TEXT, but a hypertable must partition on a native timestamp, and TimescaleDB (verified) rejects both a `BEFORE INSERT` trigger and a GENERATED column for that partition column. The hypertable lands when the wellness write-path provides a native `ts`.
- **Auth — DONE ✅** (Phase-1 tie-off). Real single-user auth: migration `0002_auth` (users w/ argon2 hash + sessions), `POST /api/auth/{setup,login,logout}` + `GET /api/auth/{status,me}`, opaque session token in an http-only SameSite=Lax cookie, `require_auth` middleware (session → `OFIT_TOKEN` bearer for automation → first-run-open until an account exists → 401). Web: `AuthProvider` gates the app with a first-run **setup wizard** + login screen; logout in the rail user chip; `credentials: "include"` + credentialed CORS for the dev split. curl-verified end-to-end. *Note: the app now opens at the setup wizard on a fresh install (by design).*
- **web `gen:api` — DONE ✅** (Phase-1 tie-off). `npm run gen:api` = `openapi-typescript $VITE_API_BASE/api-docs/openapi.json → src/api/generated/schema.d.ts`. `src/api/schema.ts` aliases the generated component types; the **enums** (`Sport`/`StreamKind`/`SourceKind`/`SelectionReason`/`PreferenceScope`/`WellnessKind`) and `HealthResponse` are now sourced from the schema (no hand-written unions → no drift; adding a Rust `StreamKind` + re-running gen:api propagates automatically). Raw DTO aliases (`ActivityDetailDto`, `SourceDto`, …) are exported for typing fetch results.
  - *Follow-up:* `endpoints.ts` still keeps its tolerant array→map normalizers (a legit transform, not drift); they can incrementally adopt the raw DTO aliases to drop the speculative field-alias `pick()`s.
- **Need from user:** real **945 + Stryd `.fit`** files (+ an overlapping recording from another source) to verify dedup/fusion. Suggested drop dir: `samples/`.
