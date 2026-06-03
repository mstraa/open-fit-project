//! Phase-3 analytics REST surface: list algorithms (built-in + WASM plugins),
//! recompute derivations over the user's data, and read them back chart-ready.
//!
//! The actual algorithms live in `ofit-analytics` (built-ins) and `ofit-plugins`
//! (sandboxed WASM); this module is the thin API seam that
//! 1. **assembles the registry** — `ofit_analytics::builtin_algorithms()` plus
//!    any plugins discovered under [`AppState::plugins_dir`] (lenient: a bad
//!    plugin is skipped, never fails the whole run);
//! 2. **marshals the DB into [`AnalyticsInput`]** — every activity with its
//!    *resolved* per-metric scalar streams (via [`resolve_activity_view`], the
//!    same best-source-per-metric path the detail view uses) + the full wellness
//!    series; and
//! 3. **persists outputs idempotently** — `Db::persist_derived` supersedes by
//!    `(plugin_id, version, subject, name)`.

use std::collections::{BTreeMap, HashMap, HashSet};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use ofit_analytics::{
    builtin_algorithms, daily_resting_hr, AnalyticsParams, AnomalyFlag, ActivityInput,
    AnalyticsInput, MetricSeries, Readiness, RunnableAlgorithm, TrainingLoad,
    WellnessPoint as AnWellnessPoint,
};
use ofit_core::{
    resolve_activity_view, Algorithm, AlgorithmInput, AlgorithmSpec, DerivedSubject,
    MetricSourcePreference, PreferenceScope, RawRecording, Sample, SourceKind, StreamKind,
    WellnessKind, WellnessSample,
};
use ofit_plugins::{PluginHost, SandboxLimits};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::AppState;

type ApiError = (StatusCode, Json<serde_json::Value>);

fn err(status: StatusCode, msg: impl Into<String>) -> ApiError {
    (status, Json(serde_json::json!({ "error": msg.into() })))
}

fn internal(e: impl std::fmt::Display) -> ApiError {
    err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

/// The wellness kinds the built-in algorithms consume; we load each once and
/// flatten into [`AnalyticsInput::wellness`].
const ANALYTICS_WELLNESS_KINDS: [WellnessKind; 5] = [
    WellnessKind::Hrv,
    WellnessKind::RestingHeartRate,
    WellnessKind::HeartRate,
    WellnessKind::SleepStage,
    WellnessKind::Stress,
];

/// Assemble the full algorithm registry: built-ins (configured with the effective
/// parameters) + any WASM plugins under the configured plugins dir (lenient — a
/// malformed/oversized plugin is skipped and logged, never failing the run).
pub fn load_algorithms(
    plugins_dir: Option<&std::path::Path>,
    params: &AnalyticsParams,
) -> Vec<Box<dyn RunnableAlgorithm>> {
    let mut algos = builtin_algorithms(params);
    if let Some(dir) = plugins_dir {
        if dir.is_dir() {
            let (host, errs) = PluginHost::load_dir_lenient(dir, SandboxLimits::default());
            for e in errs {
                tracing::warn!(error = %e, "skipping plugin");
            }
            algos.extend(host.into_runnables());
        }
    }
    algos
}

/// Enforce the built-in output-name contract: drop any metric/stream a **built-in**
/// emitted that it doesn't declare in `spec.outputs`, logging each dropped name so a
/// misdeclared built-in is loud, never silently persisted. This mirrors the WASM
/// host's `tag_validated`; WASM plugins are validated in the host, so we skip them
/// here (`AlgorithmKind::Wasm`) to avoid changing plugin behavior.
fn validate_builtin_outputs(spec: &AlgorithmSpec, out: &mut ofit_analytics::AlgorithmOutputs) {
    if spec.kind != ofit_core::analytics::AlgorithmKind::BuiltIn {
        return;
    }
    for name in out.retain_declared(spec) {
        tracing::warn!(
            plugin = %spec.id,
            version = %spec.version,
            output = %name,
            "built-in emitted an undeclared output; dropping it (not in spec.outputs)"
        );
    }
}

/// The effective analytics parameters: the registry defaults overlaid with any
/// `analytics.*` overrides from the settings store. The single source the full
/// recompute and the incremental worker both read, so they fingerprint and
/// compute identically.
pub(crate) async fn effective_params(state: &AppState) -> AnalyticsParams {
    let map: std::collections::HashMap<String, String> = state
        .db
        .list_settings()
        .await
        .unwrap_or_default()
        .into_iter()
        .collect();
    AnalyticsParams::from_settings(&map)
}

/// The effective parameters that affect `plugin_id`'s output, as a JSON object
/// `{key: value}` — stored in the derivations catalog so the UI can show what a
/// variant's parameter set actually was (and diff two variants).
fn plugin_params_json(plugin_id: &str, params: &AnalyticsParams) -> String {
    let mut obj = serde_json::Map::new();
    for d in ofit_analytics::REGISTRY {
        if d.plugins.iter().any(|p| *p == plugin_id) {
            obj.insert(d.key.to_string(), serde_json::json!(d.value(params)));
        }
    }
    serde_json::Value::Object(obj).to_string()
}

/// Stamp the parameter fingerprint onto every output (completing each derivation's
/// `(plugin_id, version, params_hash)` identity) and catalog each distinct variant.
/// Shared by the incremental paths so they write the SAME variant the full
/// recompute would, keeping incremental and full output byte-identical.
async fn finalize_variants(
    state: &AppState,
    metrics: &mut [ofit_core::DerivedMetric],
    streams: &mut [ofit_core::DerivedStream],
    params: &AnalyticsParams,
    now: DateTime<Utc>,
) {
    for m in metrics.iter_mut() {
        m.plugin.params_hash = params.fingerprint(&m.plugin.plugin_id);
    }
    for s in streams.iter_mut() {
        s.plugin.params_hash = params.fingerprint(&s.plugin.plugin_id);
    }
    let mut seen: HashSet<(String, String, String)> = HashSet::new();
    let variants: Vec<(String, String, String)> = metrics
        .iter()
        .map(|m| (m.plugin.plugin_id.clone(), m.plugin.version.clone(), m.plugin.params_hash.clone()))
        .chain(streams.iter().map(|s| {
            (s.plugin.plugin_id.clone(), s.plugin.version.clone(), s.plugin.params_hash.clone())
        }))
        .collect();
    for (pid, ver, ph) in variants {
        if seen.insert((pid.clone(), ver.clone(), ph.clone())) {
            let _ = state
                .db
                .register_derivation(&pid, &ver, &ph, &plugin_params_json(&pid, params), "", now)
                .await;
        }
    }
}

// =====================  GET /api/algorithms  =====================

/// One algorithm in the registry as exposed to the client.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AlgorithmDto {
    /// Stable id (e.g. `training_load`).
    pub id: String,
    /// Semantic version (`x.y.z`). Bump = recompute.
    pub version: String,
    /// Human-readable name.
    pub name: String,
    /// One-line description.
    pub description: String,
    /// Required inputs (stream/wellness kinds), as `"stream:heart_rate"` /
    /// `"wellness:hrv"` tags, chart-friendly for the picker UI.
    pub inputs: Vec<String>,
    /// Output names this algorithm emits (`tss`, `ctl`, `readiness`…).
    pub outputs: Vec<String>,
    /// Free-form hardware applicability tags.
    pub applicable_hardware: Vec<String>,
    /// `built_in` or `wasm`.
    pub kind: ofit_core::analytics::AlgorithmKind,
    /// Whether the algorithm is currently enabled (always true today; the field
    /// is here so the web can bind a future per-algorithm toggle).
    pub enabled: bool,
}

fn spec_to_dto(spec: &AlgorithmSpec) -> AlgorithmDto {
    let inputs = spec
        .inputs
        .iter()
        .map(|i| match i {
            AlgorithmInput::Stream(k) => format!("stream:{}", tag(k)),
            AlgorithmInput::Wellness(k) => format!("wellness:{}", tag(k)),
        })
        .collect();
    let outputs = spec
        .outputs
        .iter()
        .map(|o| match o {
            ofit_core::AlgorithmOutput::Metric(n) => n.clone(),
            ofit_core::AlgorithmOutput::Stream(n) => n.clone(),
        })
        .collect();
    AlgorithmDto {
        id: spec.id.clone(),
        version: spec.version.clone(),
        name: spec.name.clone(),
        description: spec.description.clone(),
        inputs,
        outputs,
        applicable_hardware: spec.applicable_hardware.clone(),
        kind: spec.kind,
        enabled: true,
    }
}

/// Serialize a small snake_case enum to its tag.
fn tag<T: Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|j| j.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// `GET /api/algorithms` — list available algorithms (built-in + loaded plugins).
#[utoipa::path(get, path = "/api/algorithms", responses((status = 200, body = [AlgorithmDto])))]
pub async fn list_algorithms(
    State(state): State<AppState>,
) -> Result<Json<Vec<AlgorithmDto>>, ApiError> {
    let params = effective_params(&state).await;
    let algos = load_algorithms(state.plugins_dir.as_deref(), &params);
    let out = algos.iter().map(|a| spec_to_dto(a.spec())).collect();
    Ok(Json(out))
}

// =====================  POST /api/analytics/recompute  =====================

/// Per-algorithm summary line of a recompute run.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RecomputeAlgorithmResult {
    /// Algorithm id.
    pub id: String,
    /// Algorithm version.
    pub version: String,
    /// Derived scalar metrics produced.
    pub metrics: usize,
    /// Derived time-series produced.
    pub streams: usize,
}

/// Response of `POST /api/analytics/recompute`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RecomputeResponse {
    /// How many activities were fed into the run.
    pub activities: usize,
    /// How many wellness points were fed into the run.
    pub wellness_points: usize,
    /// Per-algorithm output counts.
    pub algorithms: Vec<RecomputeAlgorithmResult>,
    /// Total derived metrics persisted.
    pub total_metrics: usize,
    /// Total derived streams persisted.
    pub total_streams: usize,
}

/// `POST /api/analytics/recompute` — run all enabled algorithms over the user's
/// data and persist the derived metrics/streams (idempotent: replace by
/// subject+plugin+version).
#[utoipa::path(
    post, path = "/api/analytics/recompute",
    responses((status = 200, body = RecomputeResponse))
)]
pub async fn recompute(
    State(state): State<AppState>,
) -> Result<Json<RecomputeResponse>, ApiError> {
    Ok(Json(run_full_recompute(&state).await?))
}

/// Full O(all-data) recompute: derive the resting-HR / body-battery /
/// HR-estimated-sleep gap-fills, run every algorithm, persist outputs, purge
/// orphans. Shared by the manual `POST /api/analytics/recompute` handler and the
/// one-time Garmin backfill (which runs exactly ONE of these at the end instead
/// of thousands of incremental day passes).
pub(crate) async fn run_full_recompute(
    state: &AppState,
) -> Result<RecomputeResponse, ApiError> {
    // Clear last run's HR-derived sleep estimate first, so it doesn't masquerade as
    // real staged sleep (calibration + gap-fill) and a tighter estimate replaces a
    // looser one cleanly. (Other "Computed" series upsert at stable timestamps.)
    if let Ok(src) = state.db.ensure_source(SourceKind::Unknown, "Computed").await {
        let _ = state
            .db
            .delete_wellness_kind_for_source(src, WellnessKind::SleepStage)
            .await;
    }

    let mut input = build_analytics_input(state).await?;
    let params = effective_params(state).await;
    let computed_at = Utc::now();

    // Derive a daily resting HR from the per-minute HR feed and fill any day that
    // has HR but no resting-HR reading yet — e.g. fresh BLE-synced days the Zepp
    // export doesn't cover. Upserted under a stable "Computed" source (idempotent
    // via the (source,kind,ts) unique index), so it never duplicates or clobbers
    // an imported resting HR for the same day.
    {
        let hr: Vec<(DateTime<Utc>, f64)> = input
            .wellness
            .iter()
            .filter(|w| w.kind == WellnessKind::HeartRate)
            .map(|w| (w.ts, w.value))
            .collect();
        let have_rhr: std::collections::HashSet<NaiveDate> = input
            .wellness
            .iter()
            .filter(|w| w.kind == WellnessKind::RestingHeartRate)
            .map(|w| w.ts.date_naive())
            .collect();
        let missing: Vec<(NaiveDate, f64)> = daily_resting_hr(&hr, &params)
            .into_iter()
            .filter(|(date, _)| !have_rhr.contains(date))
            .collect();
        if !missing.is_empty() {
            let src = state
                .db
                .ensure_source(SourceKind::Unknown, "Computed")
                .await
                .map_err(internal)?;
            let samples: Vec<WellnessSample> = missing
                .into_iter()
                .filter_map(|(date, value)| {
                    let ndt = date.and_hms_opt(0, 0, 0)?;
                    Some(WellnessSample::scalar(
                        src,
                        WellnessKind::RestingHeartRate,
                        value,
                        Utc.from_utc_datetime(&ndt),
                    ))
                })
                .collect();
            state
                .db
                .insert_computed_wellness(&samples)
                .await
                .map_err(internal)?;
        }
    }

    // Derive a continuous body-battery (0–100) from the stress series — Zepp's own
    // value isn't fetchable over BLE, so we model our own energy that recharges at
    // rest and drains under load. Upserted under the "Computed" source.
    {
        let stress: Vec<(DateTime<Utc>, f64)> = input
            .wellness
            .iter()
            .filter(|w| w.kind == WellnessKind::Stress)
            .map(|w| (w.ts, w.value))
            .collect();
        let pivot = pinned_body_battery_pivot(state, &stress, &params).await;
        let bb = ofit_analytics::body_battery(&stress, pivot, &params);
        if !bb.is_empty() {
            let src = state
                .db
                .ensure_source(SourceKind::Unknown, "Computed")
                .await
                .map_err(internal)?;
            let samples: Vec<WellnessSample> = bb
                .into_iter()
                .map(|(ts, v)| WellnessSample::scalar(src, WellnessKind::BodyBattery, v, ts))
                .collect();
            state
                .db
                .insert_computed_wellness(&samples)
                .await
                .map_err(internal)?;
        }
    }

    // Estimate sleep from overnight HR for nights the device/import don't stage
    // (recent HR-only nights), AND re-stage "degenerate" nights whose only stages
    // are flat (all light/awake, no deep/REM — e.g. a device that logged a sleep
    // window without staging it). Nights with real multi-stage sleep are left as-is.
    {
        let hr: Vec<(DateTime<Utc>, f64)> = input
            .wellness
            .iter()
            .filter(|w| w.kind == WellnessKind::HeartRate && w.value.is_finite())
            .map(|w| (w.ts, w.value))
            .collect();
        // Bucket each night's stage codes (across all sources) to tell REAL staged
        // sleep (has deep=2 or rem=3) from a degenerate flat block (only 0/1).
        let mut night_codes: HashMap<NaiveDate, HashSet<i32>> = HashMap::new();
        for w in input.wellness.iter().filter(|w| w.kind == WellnessKind::SleepStage) {
            night_codes
                .entry(ofit_analytics::night_of(w.ts))
                .or_default()
                .insert(w.value.round() as i32);
        }
        let has_variety = |c: &HashSet<i32>| c.contains(&2) || c.contains(&3);
        // Real nights: never re-estimate. Degenerate nights: re-derive from HR.
        let real_nights: HashSet<NaiveDate> =
            night_codes.iter().filter(|(_, c)| has_variety(c)).map(|(d, _)| *d).collect();
        let degenerate_nights: HashSet<NaiveDate> =
            night_codes.iter().filter(|(_, c)| !has_variety(c)).map(|(d, _)| *d).collect();
        // Calibrate the HR→stage thresholds from REAL staged nights only (join each
        // staged minute with its HR); flat nights would teach 0% deep/REM.
        let hr_by_min: HashMap<i64, f64> =
            hr.iter().map(|(ts, v)| (ts.timestamp() / 60, *v)).collect();
        let labeled: Vec<(DateTime<Utc>, f64, f64)> = input
            .wellness
            .iter()
            .filter(|w| w.kind == WellnessKind::SleepStage && real_nights.contains(&ofit_analytics::night_of(w.ts)))
            .filter_map(|w| hr_by_min.get(&(w.ts.timestamp() / 60)).map(|h| (w.ts, w.value, *h)))
            .collect();
        let model = ofit_analytics::calibrate(&labeled, &params);
        // Re-derive every night that isn't a real staged night (no stages, or flat).
        let derived: Vec<(DateTime<Utc>, f64)> = ofit_analytics::hr_derived_sleep(&hr, &model, &params)
            .into_iter()
            .filter(|(ts, _)| !real_nights.contains(&ofit_analytics::night_of(*ts)))
            .collect();
        // Degenerate nights we actually have an HR estimate for → REPLACE their flat
        // stages: drop them from this run's input AND from the DB (across sources),
        // so the estimate doesn't sit duplicated alongside the old flat block. Nights
        // with no HR estimate keep whatever stages they had.
        let rederived: HashSet<NaiveDate> =
            derived.iter().map(|(ts, _)| ofit_analytics::night_of(*ts)).collect();
        let to_replace: HashSet<NaiveDate> =
            degenerate_nights.intersection(&rederived).copied().collect();
        if !to_replace.is_empty() {
            input.wellness.retain(|w| {
                w.kind != WellnessKind::SleepStage || !to_replace.contains(&ofit_analytics::night_of(w.ts))
            });
            for night in &to_replace {
                // night D spans [D 18:00, D+1 18:00) UTC (matches night_of's split).
                if let Some(ndt) = night.and_hms_opt(18, 0, 0) {
                    let from = Utc.from_utc_datetime(&ndt);
                    // Propagate a failed delete: otherwise we'd insert the estimate
                    // alongside the un-deleted flat block → duplicated stages.
                    state
                        .db
                        .delete_wellness_kind_in_range(WellnessKind::SleepStage, from, from + Duration::days(1))
                        .await
                        .map_err(internal)?;
                }
            }
        }
        // Feed the estimate into THIS run's input so the sleep algorithm stages it now.
        input.wellness.extend(derived.iter().map(|(ts, code)| AnWellnessPoint {
            kind: WellnessKind::SleepStage,
            value: *code,
            ts: *ts,
        }));
        if !derived.is_empty() {
            let src = state
                .db
                .ensure_source(SourceKind::Unknown, "Computed")
                .await
                .map_err(internal)?;
            let samples: Vec<WellnessSample> = derived
                .into_iter()
                .map(|(ts, code)| WellnessSample::scalar(src, WellnessKind::SleepStage, code, ts))
                .collect();
            state
                .db
                .insert_computed_wellness(&samples)
                .await
                .map_err(internal)?;
        }
    }

    // Run every algorithm (sync) and collect owned outputs *before* any await, so
    // the non-`Send` boxed trait objects are not held across the persist awaits.
    let mut runs: Vec<(String, String, ofit_analytics::AlgorithmOutputs)> = {
        let algos = load_algorithms(state.plugins_dir.as_deref(), &params);
        algos
            .iter()
            .map(|algo| {
                let spec = algo.spec();
                let mut out = algo.compute(&input, computed_at);
                // Built-ins get the same output-name honesty check the WASM host
                // already enforces (tag_validated). WASM plugins are validated in
                // the host, so leave their outputs untouched here.
                validate_builtin_outputs(spec, &mut out);
                (spec.id.clone(), spec.version.clone(), out)
            })
            .collect()
    };

    let mut summary = Vec::new();
    let mut total_metrics = 0usize;
    let mut total_streams = 0usize;
    // Variants computed this run (incl. the legacy empty-hash line per plugin) for
    // the orphan purge — so OTHER parameter/version variants are never disturbed.
    let mut purge_targets: Vec<(String, String, String)> = Vec::new();
    for (id, version, out) in &mut runs {
        // Stamp the parameter fingerprint, completing each output's derivation
        // identity (plugin_id, version, params_hash).
        let fp = params.fingerprint(id);
        for m in &mut out.metrics {
            m.plugin.params_hash = fp.clone();
        }
        for s in &mut out.streams {
            s.plugin.params_hash = fp.clone();
        }
        state
            .db
            .persist_derived(&out.metrics, &out.streams)
            .await
            .map_err(internal)?;
        // Catalog this variant (parameter set) for the version switcher / diff UI.
        let _ = state
            .db
            .register_derivation(id, version, &fp, &plugin_params_json(id, &params), "", computed_at)
            .await;
        total_metrics += out.metrics.len();
        total_streams += out.streams.len();
        summary.push(RecomputeAlgorithmResult {
            id: id.clone(),
            version: version.clone(),
            metrics: out.metrics.len(),
            streams: out.streams.len(),
        });
        purge_targets.push((id.clone(), version.clone(), fp));
        // Also retire the pre-overhaul empty-hash line for this plugin (one-time).
        purge_targets.push((id.clone(), version.clone(), String::new()));
    }

    // Drop derived rows of THESE variants that nothing re-emitted this time — e.g.
    // a day whose bad wellness data was deleted (their `computed_at` predates this
    // run). Scoped to the current variants so OTHER variants kept for comparison
    // survive (unlike a blunt time-only purge, which would delete them).
    state
        .db
        .purge_derived_orphans(computed_at, &purge_targets)
        .await
        .map_err(internal)?;

    Ok(RecomputeResponse {
        activities: input.activities.len(),
        wellness_points: input.wellness.len(),
        algorithms: summary,
        total_metrics,
        total_streams,
    })
}

/// Build the analytics input by loading every activity (with its resolved
/// per-metric scalar streams) and the wellness series from the DB.
async fn build_analytics_input(state: &AppState) -> Result<AnalyticsInput, ApiError> {
    let db = &state.db;
    let sources = db.list_sources().await.map_err(internal)?;

    let activities = db.list_activities().await.map_err(internal)?;

    // Batch-fetch every member recording once (kills the per-activity N+1: this
    // path previously did get_recording twice per activity).
    let all_rec_ids: Vec<_> = activities
        .iter()
        .flat_map(|a| a.recording_ids.iter().copied())
        .collect();
    let recs_by_id: BTreeMap<_, RawRecording> = db
        .get_recordings(&all_rec_ids)
        .await
        .map_err(internal)?
        .into_iter()
        .map(|r| (r.id, r))
        .collect();

    // Batch every member recording's streams once too (kills the per-activity N+1
    // that previously did one streams_for_recording query per recording). Map is
    // recording_id -> its streams (kind-ordered); a missing recording => empty.
    let streams_by_rec = db
        .streams_for_recordings(&all_rec_ids)
        .await
        .map_err(internal)?;

    // And fetch ALL source preferences once, then filter in-memory per activity to
    // the same slice `preferences_for_activity` returns (default-scope OR pinned to
    // that activity) — killing the per-activity preference query.
    let all_prefs = db.list_preferences().await.map_err(internal)?;

    let mut acts = Vec::with_capacity(activities.len());
    for activity in activities {
        // Resolve best-source-per-metric exactly like the detail view does.
        let rec_source: BTreeMap<_, _> = activity
            .recording_ids
            .iter()
            .filter_map(|rid| recs_by_id.get(rid).map(|r| (*rid, r.source_id)))
            .collect();
        // Assemble this activity's streams from the prefetched map, preserving the
        // per-recording kind order (recording order follows recording_ids).
        let mut all_streams = Vec::new();
        for rid in &activity.recording_ids {
            if let Some(streams) = streams_by_rec.get(rid) {
                all_streams.extend(streams.iter().cloned());
            }
        }
        let prefs: Vec<MetricSourcePreference> = all_prefs
            .iter()
            .filter(|p| {
                p.scope == PreferenceScope::Default || p.activity_id == Some(activity.id)
            })
            .cloned()
            .collect();
        let view = resolve_activity_view(&activity, &all_streams, &sources, &rec_source, &prefs);

        let metrics: Vec<MetricSeries> = view
            .metrics
            .into_iter()
            .filter(|m| m.kind != StreamKind::LatLng)
            .map(|m| {
                let samples: Vec<(i64, f64)> = m
                    .stream
                    .samples
                    .iter()
                    .filter_map(|s| match s {
                        Sample::Scalar { t_offset_ms, value } => Some((*t_offset_ms, *value)),
                        _ => None,
                    })
                    .collect();
                MetricSeries::new(m.kind, samples)
            })
            .collect();

        // Cache distance (m) + calories (kcal) on the activity row so the list and
        // weekly totals show the same numbers as the detail view. Match the
        // detail's precedence exactly: a Zepp summary's distance/calories first,
        // else the last sample of the resolved cumulative distance stream. No
        // calorie model for stream-only activities → calories stays None.
        let mut summary_dist: Option<f64> = None;
        let mut summary_cal: Option<f64> = None;
        for rid in &activity.recording_ids {
            if let Some(rec) = recs_by_id.get(rid) {
                let is_summary = rec
                    .metadata
                    .get("summary_only")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if is_summary {
                    summary_dist = rec.metadata.get("distance_m").and_then(|v| v.as_f64());
                    summary_cal = rec.metadata.get("calories_kcal").and_then(|v| v.as_f64());
                    break;
                }
            }
        }
        let stream_dist = metrics
            .iter()
            .find(|m| m.kind == StreamKind::Distance)
            .and_then(|m| m.samples.last().map(|(_, v)| *v));
        db.set_activity_metrics(activity.id, summary_dist.or(stream_dist), summary_cal)
            .await
            .map_err(internal)?;

        acts.push(ActivityInput {
            activity_id: activity.id,
            sport: activity.sport,
            started_at: activity.started_at,
            ended_at: activity.ended_at,
            metrics,
        });
    }

    let mut wellness = Vec::new();
    for kind in ANALYTICS_WELLNESS_KINDS {
        let samples = db
            .wellness_samples(kind, None, None)
            .await
            .map_err(internal)?;
        wellness.extend(samples.into_iter().map(|w| AnWellnessPoint {
            kind: w.kind,
            value: w.value,
            ts: w.ts,
        }));
    }

    Ok(AnalyticsInput {
        activities: acts,
        wellness,
    })
}

// =====================  incremental recompute (worker)  =====================

/// Build one activity's [`ActivityInput`] by resolving its best-source-per-metric
/// streams — the same path `build_analytics_input` uses, for a single activity.
async fn resolve_one_activity(
    db: &ofit_db::Db,
    sources: &[ofit_core::Source],
    activity: &ofit_core::Activity,
    recs_by_id: &BTreeMap<uuid::Uuid, RawRecording>,
) -> anyhow::Result<ActivityInput> {
    let rec_source: BTreeMap<_, _> = activity
        .recording_ids
        .iter()
        .filter_map(|rid| recs_by_id.get(rid).map(|r| (*rid, r.source_id)))
        .collect();
    // Batch this activity's streams in one query (instead of one per recording),
    // then assemble in recording order preserving each recording's kind ordering.
    let streams_by_rec = db.streams_for_recordings(&activity.recording_ids).await?;
    let mut all_streams = Vec::new();
    for rid in &activity.recording_ids {
        if let Some(streams) = streams_by_rec.get(rid) {
            all_streams.extend(streams.iter().cloned());
        }
    }
    let prefs = db.preferences_for_activity(activity.id).await?;
    let view = resolve_activity_view(activity, &all_streams, sources, &rec_source, &prefs);
    let metrics: Vec<MetricSeries> = view
        .metrics
        .into_iter()
        .filter(|m| m.kind != StreamKind::LatLng)
        .map(|m| {
            let samples: Vec<(i64, f64)> = m
                .stream
                .samples
                .iter()
                .filter_map(|s| match s {
                    Sample::Scalar { t_offset_ms, value } => Some((*t_offset_ms, *value)),
                    _ => None,
                })
                .collect();
            MetricSeries::new(m.kind, samples)
        })
        .collect();

    // Refresh the distance/calories cache for this activity (matches the detail's
    // precedence: Zepp summary first, else last distance-stream sample).
    let mut summary_dist: Option<f64> = None;
    let mut summary_cal: Option<f64> = None;
    for rid in &activity.recording_ids {
        if let Some(rec) = recs_by_id.get(rid) {
            if rec.metadata.get("summary_only").and_then(|v| v.as_bool()).unwrap_or(false) {
                summary_dist = rec.metadata.get("distance_m").and_then(|v| v.as_f64());
                summary_cal = rec.metadata.get("calories_kcal").and_then(|v| v.as_f64());
                break;
            }
        }
    }
    let stream_dist = metrics
        .iter()
        .find(|m| m.kind == StreamKind::Distance)
        .and_then(|m| m.samples.last().map(|(_, v)| *v));
    db.set_activity_metrics(activity.id, summary_dist.or(stream_dist), summary_cal)
        .await?;

    Ok(ActivityInput {
        activity_id: activity.id,
        sport: activity.sport,
        started_at: activity.started_at,
        ended_at: activity.ended_at,
        metrics,
    })
}

/// **Incremental, per-activity recompute** (the worker's exact path). Each
/// activity's `tss` / `training_effect_*` / `exercise_load` depend ONLY on that
/// activity's own fixed streams, so we run the algorithms over a tiny input
/// containing just these activities and persist ONLY their `Activity`-subject
/// metrics. We deliberately discard any whole-timeline streams (ctl/atl/tsb) the
/// algorithms emit from this partial input — those are EWMA outputs handled
/// separately (forward-carry). Returns how many activities were recomputed.
pub async fn incremental_activities(state: &AppState, ids: &[uuid::Uuid]) -> anyhow::Result<usize> {
    let db = &state.db;
    let sources = db.list_sources().await?;
    let all_rec_ids: Vec<_> = {
        let mut v = Vec::new();
        for &id in ids {
            if let Some(a) = db.get_activity(id).await? {
                v.extend(a.recording_ids);
            }
        }
        v
    };
    let recs_by_id: BTreeMap<_, RawRecording> = db
        .get_recordings(&all_rec_ids)
        .await?
        .into_iter()
        .map(|r| (r.id, r))
        .collect();

    let mut acts = Vec::new();
    for &id in ids {
        if let Some(activity) = db.get_activity(id).await? {
            acts.push(resolve_one_activity(db, &sources, &activity, &recs_by_id).await?);
        }
    }
    if acts.is_empty() {
        return Ok(0);
    }
    let n = acts.len();
    let input = AnalyticsInput {
        activities: acts,
        wellness: Vec::new(),
    };
    let computed_at = Utc::now();
    let id_set: HashSet<uuid::Uuid> = ids.iter().copied().collect();
    let params = effective_params(state).await;

    // Run every algorithm synchronously and collect the per-activity metrics we
    // keep BEFORE any await — the boxed `dyn RunnableAlgorithm` is not `Send`, so
    // it must not be held across the persist await (matches `recompute`).
    let mut metrics: Vec<ofit_core::DerivedMetric> = {
        let algos = load_algorithms(state.plugins_dir.as_deref(), &params);
        let mut kept = Vec::new();
        for algo in &algos {
            let mut out = algo.compute(&input, computed_at);
            // Same output-name honesty check as the full recompute (built-ins only;
            // WASM is validated in its host) so an undeclared metric can't persist.
            validate_builtin_outputs(algo.spec(), &mut out);
            // Keep only per-activity metrics for the requested activities; drop the
            // partial-input day-streams (ctl/atl/tsb) and other-subject outputs.
            kept.extend(out.metrics.into_iter().filter(
                |m| matches!(m.subject, DerivedSubject::Activity(a) if id_set.contains(&a)),
            ));
        }
        kept
    };
    // Stamp the parameter fingerprint + catalog each variant (same identity the
    // full recompute writes, so incremental lands on the same variant line).
    finalize_variants(state, &mut metrics, &mut [], &params, computed_at).await;
    if !metrics.is_empty() {
        db.persist_derived(&metrics, &[]).await?;
    }
    Ok(n)
}

/// **Forward-carry the training-load EWMA cheaply.** The expensive part of
/// CTL/ATL (computing per-activity TSS from resolved streams) is already done +
/// persisted incrementally; the fold itself is O(days). So we re-fold the
/// CTL/ATL/TSB streams straight from the persisted `tss` metrics — no stream
/// resolution, no full wellness load — and re-persist them. Run after activities
/// change so the dashboard's training-load chart updates without a full recompute.
pub async fn recompute_training_load_streams(state: &AppState) -> anyhow::Result<()> {
    let db = &state.db;
    let params = effective_params(state).await;
    let fp = params.fingerprint("training_load");
    let activities = db.list_activities().await?;
    // Read the `tss` metrics of THIS variant only — otherwise a second parameter
    // variant's tss rows would be summed in alongside, double-counting the fold.
    let tss_metrics = db
        .derived_metrics_for_plugin("training_load", "1.0.0", Some(&fp), Some("tss"))
        .await?;
    let tss_by_act: HashMap<uuid::Uuid, f64> = tss_metrics
        .iter()
        .filter_map(|m| match m.subject {
            DerivedSubject::Activity(a) => Some((a, m.value)),
            _ => None,
        })
        .collect();
    let daily: Vec<(NaiveDate, f64)> = activities
        .iter()
        .filter_map(|a| tss_by_act.get(&a.id).map(|t| (a.started_at.date_naive(), *t)))
        .collect();
    let computed_at = Utc::now();
    let mut streams = TrainingLoad::configured(&params).streams_from_daily_tss(&daily, computed_at);
    finalize_variants(state, &mut [], &mut streams, &params, computed_at).await;
    if !streams.is_empty() {
        db.persist_derived(&[], &streams).await?;
    }
    Ok(())
}

/// The pinned body-battery rest/drain pivot: reuse the stored value once it
/// exists (so the curve is forward-carryable and stops re-pivoting as data
/// grows), else compute the median and pin it once there's ≥14 days of stress.
async fn pinned_body_battery_pivot(
    state: &AppState,
    stress: &[(DateTime<Utc>, f64)],
    params: &AnalyticsParams,
) -> f64 {
    if let Ok(Some(s)) = state.db.get_setting("body_battery_pivot").await {
        if let Ok(p) = s.trim().parse::<f64>() {
            return p;
        }
    }
    let pivot = ofit_analytics::pivot_of(stress, params);
    let days: HashSet<NaiveDate> = stress.iter().map(|(ts, _)| ts.date_naive()).collect();
    if days.len() >= 14 {
        let _ = state
            .db
            .set_setting("body_battery_pivot", &pivot.to_string(), Utc::now())
            .await;
    }
    pivot
}

/// **Incremental, per-day recompute** for dirty days. Recomputes only the
/// per-day-independent wellness outputs over a bounded window — no full HR load,
/// no activity-stream resolution: resting-HR gap-fill (windowed), body battery
/// (pinned pivot, integrated over the sparse full stress series), and the
/// readiness + anomaly latest-day snapshot. (Sleep stays on the full
/// `/recompute` — its HR-derived gap-fill needs global calibration; that's a
/// later refinement.) Returns the number of dirty days handled.
pub async fn incremental_days(state: &AppState, days: &[String]) -> anyhow::Result<usize> {
    let db = &state.db;
    let dates: Vec<NaiveDate> = days
        .iter()
        .filter_map(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .collect();
    if dates.is_empty() {
        return Ok(0);
    }
    let min = *dates.iter().min().unwrap();
    // 14-day lookback covers the readiness/RHR baseline window; load only this
    // slice of HR/HRV/RHR (the bulk feed), not all of history.
    let from = Utc
        .from_utc_datetime(&(min - Duration::days(14)).and_hms_opt(0, 0, 0).unwrap())
        .to_rfc3339();
    let to = Utc::now().to_rfc3339();
    let computed_at = Utc::now();
    let params = effective_params(state).await;
    let computed_src = db.ensure_source(SourceKind::Unknown, "Computed").await?;

    let hr = db.wellness_samples(WellnessKind::HeartRate, Some(&from), Some(&to)).await?;
    let hrv = db.wellness_samples(WellnessKind::Hrv, Some(&from), Some(&to)).await?;
    let rhr = db.wellness_samples(WellnessKind::RestingHeartRate, Some(&from), Some(&to)).await?;
    // Body battery integrates over the (sparse) stress series; needs continuity
    // from before the window, so load it whole — cheap relative to the HR bulk.
    let stress = db.wellness_samples(WellnessKind::Stress, None, None).await?;

    // 1. Resting-HR gap-fill (windowed; per-day independent → matches a full run).
    let hr_pairs: Vec<(DateTime<Utc>, f64)> = hr.iter().map(|w| (w.ts, w.value)).collect();
    let have_rhr: HashSet<NaiveDate> = rhr.iter().map(|w| w.ts.date_naive()).collect();
    let missing: Vec<WellnessSample> = daily_resting_hr(&hr_pairs, &params)
        .into_iter()
        .filter(|(date, _)| !have_rhr.contains(date))
        .filter_map(|(date, value)| {
            let ndt = date.and_hms_opt(0, 0, 0)?;
            Some(WellnessSample::scalar(
                computed_src,
                WellnessKind::RestingHeartRate,
                value,
                Utc.from_utc_datetime(&ndt),
            ))
        })
        .collect();
    if !missing.is_empty() {
        // Persist the gap-filled RHR for next time, but do NOT feed it into THIS
        // run's readiness — the full recompute reads RHR as it was at load time
        // (its own gap-fill lands a run later), so we mirror that to stay
        // byte-consistent with a full recompute.
        db.insert_computed_wellness(&missing).await?;
    }

    // 2. Body battery — pinned pivot, integrated over full stress (deterministic).
    let stress_pairs: Vec<(DateTime<Utc>, f64)> = stress.iter().map(|w| (w.ts, w.value)).collect();
    let pivot = pinned_body_battery_pivot(state, &stress_pairs, &params).await;
    let bb = ofit_analytics::body_battery(&stress_pairs, pivot, &params);
    if !bb.is_empty() {
        let samples: Vec<WellnessSample> = bb
            .into_iter()
            .map(|(ts, v)| WellnessSample::scalar(computed_src, WellnessKind::BodyBattery, v, ts))
            .collect();
        db.insert_computed_wellness(&samples).await?;
    }

    // 3. Readiness + anomaly (latest-day snapshot; baseline ⊆ the 14-day window).
    let mut metrics: Vec<ofit_core::DerivedMetric> = {
        let wellness: Vec<AnWellnessPoint> = hrv
            .iter()
            .chain(rhr.iter())
            .map(|w| AnWellnessPoint { kind: w.kind, value: w.value, ts: w.ts })
            .collect();
        let input = AnalyticsInput { activities: Vec::new(), wellness };
        let mut kept = Vec::new();
        // Output-name honesty check (built-ins) — parity with the full recompute.
        let readiness = Readiness::configured(&params);
        let mut rd_out = readiness.compute(&input, computed_at);
        validate_builtin_outputs(readiness.spec(), &mut rd_out);
        kept.extend(rd_out.metrics);
        let anomaly = AnomalyFlag::configured(&params);
        let mut an_out = anomaly.compute(&input, computed_at);
        validate_builtin_outputs(anomaly.spec(), &mut an_out);
        kept.extend(an_out.metrics);
        kept
    };
    finalize_variants(state, &mut metrics, &mut [], &params, computed_at).await;
    if !metrics.is_empty() {
        db.persist_derived(&metrics, &[]).await?;
    }
    Ok(dates.len())
}

// =====================  GET /api/analytics/derived  =====================

/// A derived scalar metric for a subject (chart/tile ready).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DerivedMetricDto {
    /// Producing algorithm id.
    pub plugin_id: String,
    /// Producing algorithm version.
    pub version: String,
    /// Parameter-set fingerprint (the third part of the derivation identity).
    pub params_hash: String,
    /// Metric name (`tss`, `readiness`, `hrv_rmssd`…).
    pub name: String,
    /// Computed value.
    pub value: f64,
    /// When it was computed (UTC, RFC3339).
    pub computed_at: DateTime<Utc>,
}

/// A derived time-series for a subject (chart ready).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DerivedStreamDto {
    /// Producing algorithm id.
    pub plugin_id: String,
    /// Producing algorithm version.
    pub version: String,
    /// Parameter-set fingerprint (the third part of the derivation identity).
    pub params_hash: String,
    /// Stream name (`ctl`, `atl`, `tsb`…).
    pub name: String,
    /// Samples as `(t_offset_ms, value)` chart points.
    pub points: Vec<DerivedPoint>,
    /// When it was computed (UTC, RFC3339).
    pub computed_at: DateTime<Utc>,
}

/// One derived stream point.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DerivedPoint {
    /// Millisecond offset from the stream epoch (see the algorithm's docs; for
    /// CTL/ATL/TSB the epoch is the first activity day at 00:00 UTC).
    pub t_offset_ms: i64,
    /// Value at that offset.
    pub value: f64,
}

/// Response of `GET /api/analytics/derived`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DerivedResponse {
    /// The subject these derivations are attached to (`activity:{id}` or
    /// `day:{date}`), echoed back as given.
    pub subject: String,
    /// Derived scalar metrics for the subject.
    pub metrics: Vec<DerivedMetricDto>,
    /// Derived time-series for the subject.
    pub streams: Vec<DerivedStreamDto>,
}

/// Query for `GET /api/analytics/derived`.
#[derive(Debug, Clone, Deserialize, ToSchema, utoipa::IntoParams)]
pub struct DerivedQuery {
    /// `activity:{uuid}` or `day:{YYYY-MM-DD}`.
    pub subject: String,
    /// `active` (default) returns only the resolved active variant per metric;
    /// `all` returns every persisted variant (for the old-vs-new diff view).
    pub variants: Option<String>,
}

/// Read just enough of a derived row to resolve its active variant.
trait DerivedRow {
    fn plugin_id(&self) -> &str;
    fn version(&self) -> &str;
    fn params_hash(&self) -> &str;
    fn name(&self) -> &str;
    fn computed_at(&self) -> DateTime<Utc>;
}
impl DerivedRow for ofit_core::DerivedMetric {
    fn plugin_id(&self) -> &str { &self.plugin.plugin_id }
    fn version(&self) -> &str { &self.plugin.version }
    fn params_hash(&self) -> &str { &self.plugin.params_hash }
    fn name(&self) -> &str { &self.name }
    fn computed_at(&self) -> DateTime<Utc> { self.computed_at }
}
impl DerivedRow for ofit_core::DerivedStream {
    fn plugin_id(&self) -> &str { &self.plugin.plugin_id }
    fn version(&self) -> &str { &self.plugin.version }
    fn params_hash(&self) -> &str { &self.plugin.params_hash }
    fn name(&self) -> &str { &self.name }
    fn computed_at(&self) -> DateTime<Utc> { self.computed_at }
}

/// Collapse a list of selections into `plugin_id -> (version, params_hash)`, with
/// per-activity overrides taking precedence over global defaults.
fn active_variant_map(
    selections: &[ofit_db::DerivationSelection],
) -> HashMap<String, (String, String)> {
    let mut m = HashMap::new();
    for s in selections.iter().filter(|s| s.scope == "default") {
        m.insert(s.plugin_id.clone(), (s.version.clone(), s.params_hash.clone()));
    }
    for s in selections.iter().filter(|s| s.scope == "activity") {
        m.insert(s.plugin_id.clone(), (s.version.clone(), s.params_hash.clone()));
    }
    m
}

/// Filter rows to the single active variant of each `(plugin_id, name)`:
/// the pinned selection if present (and present in the data), else newest by
/// `computed_at`.
fn resolve_active<T: DerivedRow>(rows: Vec<T>, sel: &HashMap<String, (String, String)>) -> Vec<T> {
    let mut groups: std::collections::BTreeMap<(String, String), Vec<T>> = Default::default();
    for r in rows {
        groups
            .entry((r.plugin_id().to_string(), r.name().to_string()))
            .or_default()
            .push(r);
    }
    let mut out = Vec::new();
    for ((pid, _name), mut group) in groups {
        // Pinned variant, if both selected AND present in the data.
        let pinned = sel.get(&pid).and_then(|(ver, ph)| {
            group.iter().position(|r| r.version() == ver && r.params_hash() == ph)
        });
        let idx = pinned.unwrap_or_else(|| {
            let mut best = 0;
            for i in 1..group.len() {
                if group[i].computed_at() > group[best].computed_at() {
                    best = i;
                }
            }
            best
        });
        out.push(group.swap_remove(idx));
    }
    out
}

/// Parse a `activity:{uuid}` / `day:{YYYY-MM-DD}` subject selector.
fn parse_subject(s: &str) -> Result<DerivedSubject, ApiError> {
    let (kind, rest) = s
        .split_once(':')
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "subject must be 'activity:{id}' or 'day:{date}'"))?;
    match kind {
        "activity" => {
            let id = uuid::Uuid::parse_str(rest)
                .map_err(|_| err(StatusCode::BAD_REQUEST, "bad activity uuid"))?;
            Ok(DerivedSubject::Activity(id))
        }
        "day" => {
            let date = NaiveDate::parse_from_str(rest, "%Y-%m-%d")
                .map_err(|_| err(StatusCode::BAD_REQUEST, "day must be YYYY-MM-DD"))?;
            Ok(DerivedSubject::Day(ofit_analytics::algorithms::day_uuid(date)))
        }
        _ => Err(err(StatusCode::BAD_REQUEST, "subject kind must be 'activity' or 'day'")),
    }
}

/// `GET /api/analytics/derived?subject=activity:{id}|day:{date}` — derived
/// metrics/streams for a subject, chart-ready.
#[utoipa::path(
    get, path = "/api/analytics/derived",
    params(DerivedQuery),
    responses((status = 200, body = DerivedResponse), (status = 400))
)]
pub async fn derived(
    State(state): State<AppState>,
    Query(q): Query<DerivedQuery>,
) -> Result<Json<DerivedResponse>, ApiError> {
    let subject = parse_subject(&q.subject)?;
    let mut metrics = state
        .db
        .derived_metrics_for_subject(subject)
        .await
        .map_err(internal)?;
    let mut streams = state
        .db
        .derived_streams_for_subject(subject)
        .await
        .map_err(internal)?;

    // Default: resolve each metric to its ACTIVE variant (per-activity override →
    // global default → newest). `?variants=all` returns every variant for diffing.
    if q.variants.as_deref() != Some("all") {
        let activity_id = match subject {
            DerivedSubject::Activity(id) => Some(id.to_string()),
            DerivedSubject::Day(_) => None,
        };
        let selections = state
            .db
            .list_derivation_selections(activity_id.as_deref())
            .await
            .map_err(internal)?;
        let sel = active_variant_map(&selections);
        metrics = resolve_active(metrics, &sel);
        streams = resolve_active(streams, &sel);
    }

    Ok(Json(DerivedResponse {
        subject: q.subject,
        metrics: metrics.into_iter().map(metric_to_dto).collect(),
        streams: streams.into_iter().map(stream_to_dto).collect(),
    }))
}

fn metric_to_dto(m: ofit_core::DerivedMetric) -> DerivedMetricDto {
    DerivedMetricDto {
        plugin_id: m.plugin.plugin_id,
        version: m.plugin.version,
        params_hash: m.plugin.params_hash,
        name: m.name,
        value: m.value,
        computed_at: m.computed_at,
    }
}

fn stream_to_dto(s: ofit_core::DerivedStream) -> DerivedStreamDto {
    DerivedStreamDto {
        plugin_id: s.plugin.plugin_id,
        version: s.plugin.version,
        params_hash: s.plugin.params_hash,
        name: s.name,
        points: s
            .samples
            .iter()
            .filter_map(|p| match p {
                Sample::Scalar { t_offset_ms, value } => Some(DerivedPoint {
                    t_offset_ms: *t_offset_ms,
                    value: *value,
                }),
                _ => None,
            })
            .collect(),
        computed_at: s.computed_at,
    }
}

// =====================  GET /api/analytics/training-load  =====================

/// One CTL/ATL/TSB point with an **absolute date** (chart-ready for the
/// dashboard's PMC chart).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TrainingLoadPoint {
    /// Calendar date (UTC, `YYYY-MM-DD`).
    pub date: String,
    /// Chronic Training Load (fitness, 42-day EWMA).
    pub ctl: f64,
    /// Acute Training Load (fatigue, 7-day EWMA).
    pub atl: f64,
    /// Training Stress Balance (form, CTL − ATL).
    pub tsb: f64,
}

/// Response of `GET /api/analytics/training-load`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TrainingLoadResponse {
    /// The daily CTL/ATL/TSB series with absolute dates (empty when not yet
    /// computed).
    pub series: Vec<TrainingLoadPoint>,
    /// Latest readiness score (0–100), if computed.
    pub readiness: Option<f64>,
    /// Whether readiness had enough data to be meaningful (the
    /// `readiness_available` flag of the latest day).
    pub readiness_available: bool,
    /// Latest HRV RMSSD summary, if computed.
    pub hrv_rmssd: Option<f64>,
    /// Latest HRV baseline, if computed.
    pub hrv_baseline: Option<f64>,
}

/// `GET /api/analytics/training-load` — the CTL/ATL/TSB series + latest
/// readiness/HRV, dashboard-ready; empty when nothing is computed.
#[utoipa::path(
    get, path = "/api/analytics/training-load",
    responses((status = 200, body = TrainingLoadResponse))
)]
pub async fn training_load(
    State(state): State<AppState>,
) -> Result<Json<TrainingLoadResponse>, ApiError> {
    let db = &state.db;

    // Honor the global default variant selection (else newest-by-computed_at wins,
    // which auto-activates a freshly edited setting).
    let sel = active_variant_map(&db.list_derivation_selections(None).await.map_err(internal)?);

    // Gather training_load's ctl/atl/tsb day-streams for the active variant.
    let ctl = active_stream(db, &sel, "training_load", "ctl").await?;
    let atl = active_stream(db, &sel, "training_load", "atl").await?;
    let tsb = active_stream(db, &sel, "training_load", "tsb").await?;

    let series = build_training_load_series(ctl.as_ref(), atl.as_ref(), tsb.as_ref());

    // Latest readiness/HRV (active variant; newest computed_at among its rows).
    let readiness = active_metric(db, &sel, "readiness", "readiness").await?;
    let readiness_available = active_metric(db, &sel, "readiness", "readiness_available")
        .await?
        .map(|v| v >= 0.5)
        .unwrap_or(false);
    let hrv_rmssd = active_metric(db, &sel, "readiness", "hrv_rmssd").await?;
    let hrv_baseline = active_metric(db, &sel, "readiness", "hrv_baseline").await?;

    Ok(Json(TrainingLoadResponse {
        series,
        readiness,
        readiness_available,
        hrv_rmssd,
        hrv_baseline,
    }))
}

/// The newest derived stream for `plugin`'s ACTIVE variant + `name`: the pinned
/// default variant if selected, else the newest across variants.
async fn active_stream(
    db: &ofit_db::Db,
    sel: &HashMap<String, (String, String)>,
    plugin: &str,
    name: &str,
) -> Result<Option<ofit_core::DerivedStream>, ApiError> {
    if let Some((ver, ph)) = sel.get(plugin) {
        let mut rows = db
            .derived_streams_for_plugin(plugin, ver, Some(ph), Some(name))
            .await
            .map_err(internal)?;
        Ok(rows.pop()) // ordered by computed_at asc → last is newest of the variant
    } else {
        db.latest_derived_stream(plugin, "1.0.0", name).await.map_err(internal)
    }
}

/// The newest value for `plugin`'s ACTIVE variant + `name` (pinned default else
/// newest across variants).
async fn active_metric(
    db: &ofit_db::Db,
    sel: &HashMap<String, (String, String)>,
    plugin: &str,
    name: &str,
) -> Result<Option<f64>, ApiError> {
    if let Some((ver, ph)) = sel.get(plugin) {
        let rows = db
            .derived_metrics_for_plugin(plugin, ver, Some(ph), Some(name))
            .await
            .map_err(internal)?;
        Ok(rows.into_iter().last().map(|m| m.value))
    } else {
        db.latest_derived_metric(plugin, "1.0.0", name).await.map_err(internal)
    }
}

/// Fuse the ctl/atl/tsb streams (aligned by `t_offset_ms`) into dated points.
/// The streams' epoch is the first activity day (recovered from the Day subject
/// id via `day_from_uuid`), and each sample's `t_offset_ms` is whole days from
/// that epoch.
fn build_training_load_series(
    ctl: Option<&ofit_core::DerivedStream>,
    atl: Option<&ofit_core::DerivedStream>,
    tsb: Option<&ofit_core::DerivedStream>,
) -> Vec<TrainingLoadPoint> {
    let Some(ctl) = ctl else { return Vec::new() };
    // Epoch date = the first activity day, encoded in the stream's Day subject.
    let epoch = match ctl.subject {
        DerivedSubject::Day(id) => ofit_analytics::algorithms::day_from_uuid(id),
        _ => None,
    };

    let to_map = |s: Option<&ofit_core::DerivedStream>| -> BTreeMap<i64, f64> {
        s.map(|st| {
            st.samples
                .iter()
                .filter_map(|p| match p {
                    Sample::Scalar { t_offset_ms, value } => Some((*t_offset_ms, *value)),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
    };
    let ctl_m = to_map(Some(ctl));
    let atl_m = to_map(atl);
    let tsb_m = to_map(tsb);

    ctl_m
        .iter()
        .map(|(&off, &ctl_v)| {
            let date = epoch
                .map(|e| e + chrono::Duration::days(off / 86_400_000))
                .map(|d| d.format("%Y-%m-%d").to_string())
                .unwrap_or_else(|| offset_fallback_date(off));
            TrainingLoadPoint {
                date,
                ctl: ctl_v,
                atl: atl_m.get(&off).copied().unwrap_or(0.0),
                tsb: tsb_m.get(&off).copied().unwrap_or(0.0),
            }
        })
        .collect()
}

/// Fallback date label when the epoch can't be recovered (should not happen for
/// training_load output): use the Unix epoch + offset days.
fn offset_fallback_date(off: i64) -> String {
    let dt = Utc.timestamp_millis_opt(off).single().unwrap_or_else(Utc::now);
    NaiveDate::from_ymd_opt(dt.year(), dt.month(), dt.day())
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

// =====================  GET/PUT /api/analytics/parameters  =====================

/// One tunable analytics parameter: its registry metadata + current effective
/// value (the default overlaid with any settings override).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ParameterDto {
    /// Settings key, e.g. `"analytics.athlete.lthr_bpm"`.
    pub key: String,
    /// Short human label.
    pub label: String,
    /// One-line description.
    pub description: String,
    /// Unit suffix.
    pub unit: String,
    /// Algorithm group (`"athlete"`, `"body_battery"`…).
    pub group: String,
    /// `"curated"` or `"advanced"`.
    pub tier: String,
    /// Whether the value is conceptually integer (UI hint).
    pub integer: bool,
    /// Inclusive lower bound, if any.
    pub min: Option<f64>,
    /// Inclusive upper bound, if any.
    pub max: Option<f64>,
    /// Factory default.
    pub default: f64,
    /// Current effective value.
    pub value: f64,
    /// Derived algorithm ids whose output identity this parameter affects.
    pub plugins: Vec<String>,
}

/// `GET /api/analytics/parameters` — every tunable analytics parameter with its
/// metadata, default, and current effective value (drives the settings UI).
pub async fn list_parameters(
    State(state): State<AppState>,
) -> Result<Json<Vec<ParameterDto>>, ApiError> {
    let params = effective_params(&state).await;
    let out = ofit_analytics::REGISTRY
        .iter()
        .map(|d| ParameterDto {
            key: d.key.to_string(),
            label: d.label.to_string(),
            description: d.description.to_string(),
            unit: d.unit.to_string(),
            group: d.group.to_string(),
            tier: d.tier.as_str().to_string(),
            integer: d.integer,
            min: d.min,
            max: d.max,
            default: d.default_value(),
            value: d.value(&params),
            plugins: d.plugins.iter().map(|p| p.to_string()).collect(),
        })
        .collect();
    Ok(Json(out))
}

/// One parameter override in a `PUT /api/analytics/parameters` request.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct ParamUpdate {
    /// Registry key.
    pub key: String,
    /// New value (clamped to the parameter's range; ignored if the key is unknown).
    pub value: f64,
}

/// Body of `PUT /api/analytics/parameters`.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct SetParametersRequest {
    /// Parameter overrides to apply.
    pub updates: Vec<ParamUpdate>,
    /// If true, also reset every other parameter to its default (a clean re-base).
    #[serde(default)]
    pub reset_others: bool,
}

/// Response of `PUT /api/analytics/parameters`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SetParametersResponse {
    /// Keys that were applied (known + clamped).
    pub applied: Vec<String>,
    /// Keys that were rejected (unknown).
    pub rejected: Vec<String>,
    /// The recompute that ran to produce the new variant(s).
    pub recompute: RecomputeResponse,
}

/// `PUT /api/analytics/parameters` — set one or more analytics parameters, then
/// run a full recompute so the new parameter set's derivation variant exists (and
/// becomes the newest = active). Old variants are retained for comparison.
pub async fn set_parameters(
    State(state): State<AppState>,
    Json(req): Json<SetParametersRequest>,
) -> Result<Json<SetParametersResponse>, ApiError> {
    let now = Utc::now();
    let mut applied = Vec::new();
    let mut rejected = Vec::new();

    if req.reset_others {
        // Clear every analytics.* override not in this request (revert to default).
        let keep: HashSet<&str> = req.updates.iter().map(|u| u.key.as_str()).collect();
        for d in ofit_analytics::REGISTRY {
            if !keep.contains(d.key) {
                let _ = state.db.set_setting(d.key, &d.default_value().to_string(), now).await;
            }
        }
    }

    for u in &req.updates {
        match ofit_analytics::REGISTRY.iter().find(|d| d.key == u.key) {
            Some(d) => {
                let v = match (d.min, d.max) {
                    (Some(lo), Some(hi)) => u.value.clamp(lo, hi),
                    (Some(lo), None) => u.value.max(lo),
                    (None, Some(hi)) => u.value.min(hi),
                    (None, None) => u.value,
                };
                state
                    .db
                    .set_setting(&u.key, &v.to_string(), now)
                    .await
                    .map_err(internal)?;
                applied.push(u.key.clone());
            }
            None => rejected.push(u.key.clone()),
        }
    }

    // Produce the new parameter set's derivation variant(s) across all history.
    let recompute = run_full_recompute(&state).await?;
    Ok(Json(SetParametersResponse { applied, rejected, recompute }))
}

// =====================  GET /api/analytics/variants  =====================

/// One catalogued derivation variant of a plugin, with whether it's the active
/// global default.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct VariantDto {
    /// Producing algorithm id.
    pub plugin_id: String,
    /// Code version.
    pub version: String,
    /// Parameter fingerprint.
    pub params_hash: String,
    /// The effective parameters as a JSON object `{key: value}`.
    pub params: serde_json::Value,
    /// Optional human label.
    pub label: String,
    /// First computed (RFC3339).
    pub first_computed_at: String,
    /// Last computed (RFC3339).
    pub last_computed_at: String,
    /// Whether this variant is the active global default (pinned, or newest when
    /// nothing is pinned).
    pub active_default: bool,
}

/// Query for `GET /api/analytics/variants`.
#[derive(Debug, Clone, Deserialize, utoipa::IntoParams)]
pub struct VariantsQuery {
    /// Restrict to one plugin id.
    pub plugin: Option<String>,
}

/// `GET /api/analytics/variants?plugin=training_load` — list a plugin's catalogued
/// derivation variants (newest first), flagging the active default.
pub async fn list_variants(
    State(state): State<AppState>,
    Query(q): Query<VariantsQuery>,
) -> Result<Json<Vec<VariantDto>>, ApiError> {
    let derivations = state
        .db
        .list_derivations(q.plugin.as_deref())
        .await
        .map_err(internal)?;
    let sel = active_variant_map(
        &state.db.list_derivation_selections(None).await.map_err(internal)?,
    );

    // For each plugin with no pinned default, the active default is its newest
    // (list_derivations is ordered last_computed_at DESC per plugin).
    let mut newest_seen: HashSet<String> = HashSet::new();
    let out = derivations
        .into_iter()
        .map(|d| {
            let active_default = match sel.get(&d.plugin_id) {
                Some((ver, ph)) => *ver == d.version && *ph == d.params_hash,
                None => newest_seen.insert(d.plugin_id.clone()), // first (newest) per plugin
            };
            VariantDto {
                params: serde_json::from_str(&d.params_json).unwrap_or(serde_json::json!({})),
                plugin_id: d.plugin_id,
                version: d.version,
                params_hash: d.params_hash,
                label: d.label,
                first_computed_at: d.first_computed_at,
                last_computed_at: d.last_computed_at,
                active_default,
            }
        })
        .collect();
    Ok(Json(out))
}

// =====================  PUT /api/analytics/selection  =====================

/// Body of `PUT /api/analytics/selection` — pin (or clear) which derivation
/// variant a plugin's outputs resolve to.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct SetSelectionRequest {
    /// `"default"` (global) or `"activity"`.
    pub scope: String,
    /// Activity uuid for `scope = "activity"`; ignored for default.
    pub subject_id: Option<String>,
    /// Plugin to pin.
    pub plugin_id: String,
    /// Code version of the chosen variant (required unless `clear`).
    pub version: Option<String>,
    /// Parameter fingerprint of the chosen variant (required unless `clear`).
    pub params_hash: Option<String>,
    /// If true, remove the pin (revert to the resolution fallback).
    #[serde(default)]
    pub clear: bool,
}

/// `PUT /api/analytics/selection` — set or clear the active-variant pin.
pub async fn set_selection(
    State(state): State<AppState>,
    Json(req): Json<SetSelectionRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if req.scope != "default" && req.scope != "activity" {
        return Err(err(StatusCode::BAD_REQUEST, "scope must be 'default' or 'activity'"));
    }
    let subject_id = if req.scope == "activity" {
        req.subject_id
            .clone()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| err(StatusCode::BAD_REQUEST, "activity scope needs subject_id"))?
    } else {
        String::new()
    };
    if req.clear {
        state
            .db
            .clear_derivation_selection(&req.scope, &subject_id, &req.plugin_id)
            .await
            .map_err(internal)?;
        return Ok(Json(serde_json::json!({ "cleared": true })));
    }
    let version = req
        .version
        .clone()
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "version required"))?;
    let params_hash = req
        .params_hash
        .clone()
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "params_hash required"))?;
    state
        .db
        .set_derivation_selection(&req.scope, &subject_id, &req.plugin_id, &version, &params_hash, Utc::now())
        .await
        .map_err(internal)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}
