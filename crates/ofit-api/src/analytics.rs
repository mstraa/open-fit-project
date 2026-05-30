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

use std::collections::BTreeMap;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use chrono::{DateTime, Datelike, NaiveDate, TimeZone, Utc};
use ofit_analytics::{
    builtin_algorithms, ActivityInput, AnalyticsInput, MetricSeries, RunnableAlgorithm,
    WellnessPoint as AnWellnessPoint,
};
use ofit_core::{
    resolve_activity_view, AlgorithmInput, AlgorithmSpec, DerivedSubject, Sample, StreamKind,
    WellnessKind,
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
const ANALYTICS_WELLNESS_KINDS: [WellnessKind; 3] = [
    WellnessKind::Hrv,
    WellnessKind::RestingHeartRate,
    WellnessKind::HeartRate,
];

/// Assemble the full algorithm registry: built-ins + any WASM plugins under the
/// configured plugins dir (lenient — a malformed/oversized plugin is skipped and
/// logged, never failing the run).
pub fn load_algorithms(plugins_dir: Option<&std::path::Path>) -> Vec<Box<dyn RunnableAlgorithm>> {
    let mut algos = builtin_algorithms();
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
    let algos = load_algorithms(state.plugins_dir.as_deref());
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
    let input = build_analytics_input(&state).await?;
    let computed_at = Utc::now();

    // Run every algorithm (sync) and collect owned outputs *before* any await, so
    // the non-`Send` boxed trait objects are not held across the persist awaits.
    let runs: Vec<(String, String, ofit_analytics::AlgorithmOutputs)> = {
        let algos = load_algorithms(state.plugins_dir.as_deref());
        algos
            .iter()
            .map(|algo| {
                let spec = algo.spec();
                (
                    spec.id.clone(),
                    spec.version.clone(),
                    algo.compute(&input, computed_at),
                )
            })
            .collect()
    };

    let mut summary = Vec::new();
    let mut total_metrics = 0usize;
    let mut total_streams = 0usize;
    for (id, version, out) in &runs {
        state
            .db
            .persist_derived(&out.metrics, &out.streams)
            .await
            .map_err(internal)?;
        total_metrics += out.metrics.len();
        total_streams += out.streams.len();
        summary.push(RecomputeAlgorithmResult {
            id: id.clone(),
            version: version.clone(),
            metrics: out.metrics.len(),
            streams: out.streams.len(),
        });
    }

    Ok(Json(RecomputeResponse {
        activities: input.activities.len(),
        wellness_points: input.wellness.len(),
        algorithms: summary,
        total_metrics,
        total_streams,
    }))
}

/// Build the analytics input by loading every activity (with its resolved
/// per-metric scalar streams) and the wellness series from the DB.
async fn build_analytics_input(state: &AppState) -> Result<AnalyticsInput, ApiError> {
    let db = &state.db;
    let sources = db.list_sources().await.map_err(internal)?;

    let activities = db.list_activities().await.map_err(internal)?;
    let mut acts = Vec::with_capacity(activities.len());
    for activity in activities {
        // Resolve best-source-per-metric exactly like the detail view does.
        let rec_source = db
            .recording_sources(&activity.recording_ids)
            .await
            .map_err(internal)?;
        let mut all_streams = Vec::new();
        for &rid in &activity.recording_ids {
            all_streams.extend(db.streams_for_recording(rid).await.map_err(internal)?);
        }
        let prefs = db
            .preferences_for_activity(activity.id)
            .await
            .map_err(internal)?;
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

// =====================  GET /api/analytics/derived  =====================

/// A derived scalar metric for a subject (chart/tile ready).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DerivedMetricDto {
    /// Producing algorithm id.
    pub plugin_id: String,
    /// Producing algorithm version.
    pub version: String,
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
    let metrics = state
        .db
        .derived_metrics_for_subject(subject)
        .await
        .map_err(internal)?;
    let streams = state
        .db
        .derived_streams_for_subject(subject)
        .await
        .map_err(internal)?;

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
        name: m.name,
        value: m.value,
        computed_at: m.computed_at,
    }
}

fn stream_to_dto(s: ofit_core::DerivedStream) -> DerivedStreamDto {
    DerivedStreamDto {
        plugin_id: s.plugin.plugin_id,
        version: s.plugin.version,
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

    // Gather training_load's ctl/atl/tsb day-streams (one set per recompute; the
    // newest by computed_at wins).
    let ctl = latest_stream(db, "training_load", "1.0.0", "ctl").await?;
    let atl = latest_stream(db, "training_load", "1.0.0", "atl").await?;
    let tsb = latest_stream(db, "training_load", "1.0.0", "tsb").await?;

    let series = build_training_load_series(ctl.as_ref(), atl.as_ref(), tsb.as_ref());

    // Latest readiness/HRV (newest computed_at across day subjects).
    let readiness = latest_metric(db, "readiness", "1.0.0", "readiness").await?;
    let readiness_available =
        latest_metric(db, "readiness", "1.0.0", "readiness_available").await?
            .map(|v| v >= 0.5)
            .unwrap_or(false);
    let hrv_rmssd = latest_metric(db, "readiness", "1.0.0", "hrv_rmssd").await?;
    let hrv_baseline = latest_metric(db, "readiness", "1.0.0", "hrv_baseline").await?;

    Ok(Json(TrainingLoadResponse {
        series,
        readiness,
        readiness_available,
        hrv_rmssd,
        hrv_baseline,
    }))
}

/// The most-recently-computed derived stream for `(plugin, version, name)`.
async fn latest_stream(
    db: &ofit_db::Db,
    plugin: &str,
    version: &str,
    name: &str,
) -> Result<Option<ofit_core::DerivedStream>, ApiError> {
    let mut streams = db
        .derived_streams_for_plugin(plugin, version, Some(name))
        .await
        .map_err(internal)?;
    // ordered by computed_at asc → last is newest.
    Ok(streams.pop())
}

/// The value of the most-recently-computed derived metric for
/// `(plugin, version, name)`.
async fn latest_metric(
    db: &ofit_db::Db,
    plugin: &str,
    version: &str,
    name: &str,
) -> Result<Option<f64>, ApiError> {
    let metrics = db
        .derived_metrics_for_plugin(plugin, version, Some(name))
        .await
        .map_err(internal)?;
    // ordered by computed_at asc → last is newest.
    Ok(metrics.last().map(|m| m.value))
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
