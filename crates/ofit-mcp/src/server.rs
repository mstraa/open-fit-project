//! The OpenFit MCP server: tool definitions + `ServerHandler`.
//!
//! Tools fall into the three Phase 8 families (PLAN.md):
//! * **catalog** — what exists: algorithms, variants, parameters, schema;
//! * **query** — read data: activities, streams, wellness, derived outputs;
//! * **run/create** — safe mutations: recompute, parameters, selections,
//!   settings, preferences.
//!
//! Plus two escape hatches for debugging: `query_sql` (read-only) and
//! `api_request` (generic passthrough, writes restricted).
//!
//! Every API-backed tool dispatches in-process through [`Dispatcher`] — the
//! exact same handlers the web UI hits. Where an endpoint returns unbounded
//! payloads (`/activities` has no pagination, `/wellness` no downsampling),
//! the tool post-processes: filter, paginate, stride-downsample. The
//! `sample_count`/`total_points` style fields always report true counts so
//! the model knows when it is looking at a thinned series.

use axum::http::Method;
use ofit_db::Db;
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::dispatch::{failure_result, internal, into_tool_result, stride_sample, with_query, Dispatcher};
use crate::sql;

/* ----------------------------------------------------------- enum mirrors */
//
// Schemars mirrors of ofit-core's serde enums, so the generated tool input
// schemas advertise the EXACT accepted strings (sp_o2, race_predict5k,
// lat_lng…) instead of a free-form string the model has to guess — the
// non-obvious renderings caused first-try 400s. ofit-core itself must not
// grow a schemars dependency, hence mirrors; a round-trip test below keeps
// them from drifting.

/// Wellness metric kinds (mirrors `ofit_core::WellnessKind`).
#[derive(Debug, Clone, Copy, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WellnessKindArg {
    HeartRate,
    SleepStage,
    RestingHeartRate,
    Hrv,
    Stress,
    BodyBattery,
    Respiration,
    SpO2,
    Steps,
    Weight,
    Calories,
    BodyFat,
    BodyWater,
    BoneMass,
    MuscleMass,
    Bmi,
    Vo2Max,
    TrainingLoad,
    FitnessAge,
    RacePredict5k,
    RacePredict10k,
    RacePredictHalf,
    RacePredictMarathon,
}

/// Activity stream kinds (mirrors `ofit_core::StreamKind`).
#[derive(Debug, Clone, Copy, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum StreamKindArg {
    HeartRate,
    Power,
    Cadence,
    Speed,
    Altitude,
    LatLng,
    Wind,
    Temperature,
    Distance,
    VerticalOscillation,
    GroundContactTime,
    StrideLength,
    VerticalRatio,
    FormPower,
    AirPower,
    LegSpringStiffness,
}

/// The serde snake_case tag of a mirror enum value (e.g. `SpO2` → "sp_o2").
fn tag<T: Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|j| j.as_str().map(str::to_string))
        .unwrap_or_default()
}

/* ------------------------------------------------------------------ state */

/// One MCP session's handler. Cheap to construct (router + pool clones); the
/// transport's factory builds a fresh one per session.
#[derive(Clone)]
pub struct OpenFitMcp {
    tool_router: ToolRouter<OpenFitMcp>,
    api: Dispatcher,
    db: Db,
}

/* -------------------------------------------------------------- tool params */

/// Filters for `list_activities`. All optional; defaults return the most
/// recent page.
#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct ListActivitiesParams {
    /// Only activities starting at/after this time (RFC3339 or YYYY-MM-DD).
    pub from: Option<String>,
    /// Only activities starting at/before this time (RFC3339 or YYYY-MM-DD,
    /// date-only means end of that day).
    pub to: Option<String>,
    /// Only this sport (snake_case tag as returned by the API, e.g. "running").
    pub sport: Option<String>,
    /// Max activities returned (default 100, max 1000). Newest first.
    pub limit: Option<u32>,
    /// Skip this many (after filtering) for pagination. Default 0.
    pub offset: Option<u32>,
}

/// Selector + shaping options for `get_activity`.
#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct GetActivityParams {
    /// Activity id (UUID, from `list_activities`).
    pub id: String,
    /// Only include these stream kinds. Omit for all resolved metrics.
    pub metrics: Option<Vec<StreamKindArg>>,
    /// Max chart points per stream/track (default 300, max 1000 — the API's
    /// own cap). `sample_count` still reports the true pre-downsample count.
    pub max_points: Option<u32>,
}

/// Time-window + shaping for `query_wellness`.
#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct QueryWellnessParams {
    /// Wellness metric kind.
    pub kind: WellnessKindArg,
    /// Window start (RFC3339 or YYYY-MM-DD). Default: 7 days before `to` —
    /// fine for high-rate kinds (heart_rate, stress, steps, ...), but sparse
    /// kinds (weight, body_fat, bmi, vo2_max, fitness_age, training_load,
    /// race_predict_*) are recorded only on scale-use/sync — often weekly or
    /// monthly — so pass an explicit wider `from` (e.g. a year back) for those.
    pub from: Option<String>,
    /// Window end (RFC3339 or YYYY-MM-DD, date-only = end of day). Default: now.
    pub to: Option<String>,
    /// Max points returned after downsampling (default 500, max 5000).
    /// `total_points` reports the true in-window count.
    pub max_points: Option<u32>,
}

/// Subject selector for `get_derived`.
#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct GetDerivedParams {
    /// "activity:{uuid}" or "day:{YYYY-MM-DD}".
    pub subject: String,
    /// "active" (default — the resolved active variant per metric) or "all"
    /// (every persisted variant, for diffing algorithm versions/params).
    pub variants: Option<String>,
    /// Max points per derived stream after downsampling (default 500, max
    /// 5000); each stream's `sample_count` reports the true length. Derived
    /// streams can span all history (and multiply under variants='all').
    pub max_points: Option<u32>,
}

/// Optional tail-slice for `get_training_load`.
#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct TrainingLoadParams {
    /// Only the last N days of the CTL/ATL/TSB series (default: all history).
    pub last_days: Option<u32>,
}

/// Plugin filter for `list_variants`.
#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct ListVariantsParams {
    /// Restrict to one plugin id (e.g. "training_load"). Omit for all.
    pub plugin: Option<String>,
}

/// One parameter override for `set_parameters`.
#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct ParamUpdate {
    /// Registry key, e.g. "analytics.athlete.lthr_bpm" (see `get_parameters`).
    pub key: String,
    /// New value (clamped server-side to the parameter's range).
    pub value: f64,
}

/// Body for `set_parameters`.
#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct SetParametersParams {
    /// Parameter overrides to apply.
    pub updates: Vec<ParamUpdate>,
    /// When true, every registry key NOT in `updates` resets to its default.
    pub reset_others: Option<bool>,
}

/// Body for `set_selection` — pin/clear which derivation variant resolves.
#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct SetSelectionParams {
    /// "default" (global) or "activity" (per-activity override).
    pub scope: String,
    /// Activity UUID; required when scope == "activity".
    pub subject_id: Option<String>,
    /// Plugin id whose output is being pinned (e.g. "training_load").
    pub plugin_id: String,
    /// Variant version to pin (required unless `clear`).
    pub version: Option<String>,
    /// Variant params fingerprint to pin (required unless `clear`).
    pub params_hash: Option<String>,
    /// True to clear the pin instead of setting one.
    pub clear: Option<bool>,
}

/// Key/value for `set_setting`.
#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct SetSettingParams {
    /// Setting key (see `get_settings` for existing keys).
    pub key: String,
    /// New value (settings are stored as strings).
    pub value: String,
}

/// Body for `set_preference` — which source wins for a metric.
#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct SetPreferenceParams {
    /// Stream kind whose winning source is being pinned.
    pub metric: StreamKindArg,
    /// "default" (global) or "activity" (one activity only).
    pub scope: String,
    /// Activity UUID; required when scope == "activity".
    pub activity_id: Option<String>,
    /// Preferred source id (UUID, from `list_sources`).
    pub source_id: String,
    /// Re-resolve history with this preference (default scope only).
    pub retroactive: Option<bool>,
}

/// Statement + cap for `query_sql`.
#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct QuerySqlParams {
    /// A single SELECT/WITH/EXPLAIN statement. Strictly read-only — write
    /// keywords are rejected even inside string literals (conservative scan).
    pub sql: String,
    /// Max rows returned (default 200, max 2000). Prefer an explicit LIMIT.
    pub limit: Option<u32>,
}

/// HTTP method allowed through `api_request` (no DELETE — destructive ops are
/// deliberately not exposed in v1).
#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "UPPERCASE")]
pub enum ApiMethod {
    Get,
    Post,
    Put,
}

/// Generic passthrough request for `api_request`.
#[derive(Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct ApiRequestParams {
    /// GET, POST or PUT.
    pub method: ApiMethod,
    /// API path with optional query string, e.g. "/activities?limit=5" or
    /// "/api/analytics/derived?subject=day:2026-06-01" (the "/api" prefix is
    /// optional). Import, maintenance and wellness-ingest routes are blocked.
    pub path: String,
    /// JSON body for POST/PUT.
    pub body: Option<Value>,
}

/* ------------------------------------------------------------------- tools */

#[tool_router]
impl OpenFitMcp {
    pub fn new(api_router: axum::Router, db: Db) -> Self {
        Self {
            tool_router: Self::tool_router(),
            api: Dispatcher::new(api_router),
            db,
        }
    }

    /// Plain GET dispatch → tool result (over-cap → readable tool error).
    async fn get(&self, path: &str) -> Result<CallToolResult, McpError> {
        match self.api.call(Method::GET, path, None).await {
            Ok(resp) => into_tool_result(resp),
            Err(e) => failure_result(e),
        }
    }

    /// Dispatch with a JSON body → tool result.
    async fn send(&self, method: Method, path: &str, body: Value) -> Result<CallToolResult, McpError> {
        match self.api.call(method, path, Some(&body)).await {
            Ok(resp) => into_tool_result(resp),
            Err(e) => failure_result(e),
        }
    }

    /* ------------------------------------------------------- orientation */

    #[tool(
        description = "Server + data overview: version, database backend, entity counts and \
        latest-data timestamps. Call this first to orient yourself.",
        annotations(read_only_hint = true)
    )]
    async fn get_overview(&self) -> Result<CallToolResult, McpError> {
        let version = self
            .api
            .call(Method::GET, "/version", None)
            .await
            .map_err(internal)?
            .body;

        async fn count(db: &Db, sql: &str) -> Option<i64> {
            sqlx::query_scalar::<_, i64>(sql).fetch_one(db.pool()).await.ok()
        }
        async fn max_text(db: &Db, sql: &str) -> Option<String> {
            sqlx::query_scalar::<_, Option<String>>(sql)
                .fetch_one(db.pool())
                .await
                .ok()
                .flatten()
        }

        let overview = json!({
            "server": version,
            "db_backend": format!("{:?}", self.db.backend()),
            "counts": {
                "sources": count(&self.db, "SELECT COUNT(*) FROM sources").await,
                "activities": count(&self.db, "SELECT COUNT(*) FROM activities").await,
                "wellness_samples": count(&self.db, "SELECT COUNT(*) FROM wellness_samples").await,
            },
            "latest": {
                "activity_started_at": max_text(&self.db, "SELECT MAX(started_at) FROM activities").await,
                "wellness_sample_ts": max_text(&self.db, "SELECT MAX(ts) FROM wellness_samples").await,
            },
        });
        Ok(CallToolResult::success(vec![Content::json(overview)?]))
    }

    #[tool(
        description = "Database schema: tables with columns/DDL (SQLite or Postgres). \
        Use before query_sql.",
        annotations(read_only_hint = true)
    )]
    async fn db_schema(&self) -> Result<CallToolResult, McpError> {
        let schema = sql::schema(&self.db).await.map_err(internal)?;
        Ok(CallToolResult::success(vec![Content::json(schema)?]))
    }

    /* ----------------------------------------------------------- catalog */

    #[tool(
        description = "List all loaded analytics algorithms (built-ins + WASM plugins) with \
        id, version and kind.",
        annotations(read_only_hint = true)
    )]
    async fn list_algorithms(&self) -> Result<CallToolResult, McpError> {
        self.get("/algorithms").await
    }

    #[tool(
        description = "List catalogued derivation variants (plugin × version × params), newest \
        first, flagging the active default. A variant is one parameterization of one algorithm \
        version; outputs of every variant are persisted side by side.",
        annotations(read_only_hint = true)
    )]
    async fn list_variants(
        &self,
        Parameters(p): Parameters<ListVariantsParams>,
    ) -> Result<CallToolResult, McpError> {
        let mut q = Vec::new();
        if let Some(plugin) = p.plugin {
            q.push(("plugin", plugin));
        }
        self.get(&with_query("/analytics/variants", &q)).await
    }

    #[tool(
        description = "Every tunable analytics parameter: key, label, unit, group, range, \
        factory default and current effective value.",
        annotations(read_only_hint = true)
    )]
    async fn get_parameters(&self) -> Result<CallToolResult, McpError> {
        self.get("/analytics/parameters").await
    }

    /* ------------------------------------------------------------- query */

    #[tool(
        description = "List data sources (devices/providers) with last-synced times.",
        annotations(read_only_hint = true)
    )]
    async fn list_sources(&self) -> Result<CallToolResult, McpError> {
        self.get("/sources").await
    }

    #[tool(
        description = "List activity summaries, newest first, with optional date/sport \
        filtering and pagination (the filtering happens MCP-side; the REST endpoint returns \
        everything). Returns {total_matching, offset, returned, has_more, activities}; page \
        forward with offset+returned while has_more.",
        annotations(read_only_hint = true)
    )]
    async fn list_activities(
        &self,
        Parameters(p): Parameters<ListActivitiesParams>,
    ) -> Result<CallToolResult, McpError> {
        let resp = match self.api.call(Method::GET, "/activities", None).await {
            Ok(r) => r,
            Err(e) => return failure_result(e),
        };
        if !resp.status.is_success() {
            return into_tool_result(resp);
        }
        let Value::Array(mut acts) = resp.body else {
            return Ok(CallToolResult::error(vec![Content::text(
                "unexpected /activities response shape (not an array)",
            )]));
        };

        // Compare chronologically, not lexically: chrono's serde omits
        // fractional seconds for whole-second instants but keeps them
        // otherwise, so "…T00:00:00.500Z" sorts BEFORE "…T00:00:00Z" as a
        // string while being chronologically after it.
        let parse = |s: &str| chrono::DateTime::parse_from_rfc3339(s).ok();
        let from = p.from.as_deref().map(|s| normalize_ts(s, false)).transpose()?;
        let to = p.to.as_deref().map(|s| normalize_ts(s, true)).transpose()?;
        let from_dt = from.as_deref().and_then(parse);
        let to_dt = to.as_deref().and_then(parse);
        acts.retain(|a| {
            let started = a
                .get("started_at")
                .and_then(Value::as_str)
                .and_then(parse);
            let sport_ok = p
                .sport
                .as_deref()
                .map(|s| a.get("sport").and_then(Value::as_str) == Some(s))
                .unwrap_or(true);
            let in_window = match (started, from_dt, to_dt) {
                (None, _, _) => from_dt.is_none() && to_dt.is_none(),
                (Some(s), f, t) => {
                    f.map(|f| s >= f).unwrap_or(true) && t.map(|t| s <= t).unwrap_or(true)
                }
            };
            sport_ok && in_window
        });
        acts.sort_by_cached_key(|a| {
            std::cmp::Reverse(a.get("started_at").and_then(Value::as_str).and_then(parse))
        });

        let total = acts.len();
        let offset = p.offset.unwrap_or(0) as usize;
        let limit = (p.limit.unwrap_or(100) as usize).clamp(1, 1000);
        let page: Vec<Value> = acts.into_iter().skip(offset).take(limit).collect();

        Ok(CallToolResult::success(vec![Content::json(json!({
            "total_matching": total,
            "offset": offset,
            "returned": page.len(),
            "has_more": offset + page.len() < total,
            "activities": page,
        }))?]))
    }

    #[tool(
        description = "One activity in detail: contributing recordings (with available \
        metrics), the resolved best-source-per-metric streams (chart-ready, downsampled), GPS \
        track and summary. `sample_count` is the true pre-downsample resolution. Use `metrics` \
        to fetch only specific streams and `max_points` to control payload size.",
        annotations(read_only_hint = true)
    )]
    async fn get_activity(
        &self,
        Parameters(p): Parameters<GetActivityParams>,
    ) -> Result<CallToolResult, McpError> {
        let path = format!("/activities/{}", p.id);
        let resp = match self.api.call(Method::GET, &path, None).await {
            Ok(r) => r,
            Err(e) => return failure_result(e),
        };
        if !resp.status.is_success() {
            return into_tool_result(resp);
        }
        let mut detail = resp.body;
        let max_points = (p.max_points.unwrap_or(300) as usize).clamp(10, 1000);

        if let Some(metrics) = detail.get_mut("resolved_metrics").and_then(Value::as_array_mut) {
            if let Some(only) = &p.metrics {
                let only: Vec<String> = only.iter().map(tag).collect();
                metrics.retain(|m| {
                    m.get("kind")
                        .and_then(Value::as_str)
                        .map(|k| only.iter().any(|o| o == k))
                        .unwrap_or(false)
                });
            }
            for metric in metrics.iter_mut() {
                if let Some(points) = metric.get_mut("points") {
                    stride_sample(points, max_points);
                }
            }
        }
        if let Some(track) = detail.get_mut("track") {
            let original = stride_sample(track, max_points);
            if original > 0 {
                detail["track_point_count"] = json!(original);
            }
        }

        Ok(CallToolResult::success(vec![Content::json(detail)?]))
    }

    #[tool(
        description = "Continuous wellness series for one metric kind over a time window \
        (default: last 7 days), stride-downsampled to max_points. Returns {kind, from, to, \
        total_points, returned, downsampled, points:[{ts,value,source_id}]}. For high-rate \
        kinds (heart_rate, stress, ...) the store is minute-level for years — narrow the window \
        or rely on downsampling. Sparse kinds (weight, body_fat, vo2_max, fitness_age, \
        race_predict_*) are recorded weekly/monthly or only on sync, so the 7-day default may \
        return 0–1 points: pass a wider `from` (a 0 result emits a 'note' hint).",
        annotations(read_only_hint = true)
    )]
    async fn query_wellness(
        &self,
        Parameters(p): Parameters<QueryWellnessParams>,
    ) -> Result<CallToolResult, McpError> {
        // Default window: [to - 7d, to], with `to` defaulting to now. The raw
        // endpoint would otherwise return ALL history.
        let to = match p.to.as_deref() {
            Some(s) => normalize_ts(s, true)?,
            None => chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        };
        let from_defaulted = p.from.is_none();
        let from = match p.from.as_deref() {
            Some(s) => normalize_ts(s, false)?,
            None => {
                let end = chrono::DateTime::parse_from_rfc3339(&to)
                    .map_err(|e| McpError::invalid_params(format!("bad 'to': {e}"), None))?;
                (end - chrono::Duration::days(7)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            }
        };

        let kind = tag(&p.kind);
        let q = [
            ("kind", kind.clone()),
            ("from", from.clone()),
            ("to", to.clone()),
        ];
        let resp = match self.api.call(Method::GET, &with_query("/wellness", &q), None).await {
            Ok(r) => r,
            Err(e) => return failure_result(e),
        };
        if !resp.status.is_success() {
            return into_tool_result(resp);
        }
        let mut body = resp.body;
        let max_points = (p.max_points.unwrap_or(500) as usize).clamp(10, 5000);
        let total = body
            .get_mut("points")
            .map(|pts| stride_sample(pts, max_points))
            .unwrap_or(0);
        let returned = body
            .get("points")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);

        let mut out = json!({
            "kind": body.get("kind").cloned().unwrap_or(json!(kind)),
            "from": from,
            "to": to,
            "total_points": total,
            "returned": returned,
            "downsampled": total > returned,
            "points": body.get("points").cloned().unwrap_or(json!([])),
        });
        // Empty default window: sparse kinds (weight, vo2_max, race_predict_*)
        // are recorded weekly/monthly, so 0 points here usually means the window
        // is too short, not that the metric has no data. Nudge toward a re-query.
        if total == 0 && from_defaulted {
            out["note"] = json!(
                "0 points in the default 7-day window — for sparse kinds \
                 (weight, vo2_max, fitness_age, race_predict_*) re-query with a wider 'from'"
            );
        }
        Ok(CallToolResult::success(vec![Content::json(out)?]))
    }

    #[tool(
        description = "Derived (algorithm-computed) metrics + streams for one subject: \
        'activity:{uuid}' or 'day:{YYYY-MM-DD}'. Default shows the active variant per output; \
        variants='all' returns every persisted variant for comparing parameterizations. Stream \
        points are downsampled to max_points; `sample_count` keeps the true length.",
        annotations(read_only_hint = true)
    )]
    async fn get_derived(
        &self,
        Parameters(p): Parameters<GetDerivedParams>,
    ) -> Result<CallToolResult, McpError> {
        let mut q = vec![("subject", p.subject)];
        if let Some(v) = p.variants {
            q.push(("variants", v));
        }
        let resp = match self
            .api
            .call(Method::GET, &with_query("/analytics/derived", &q), None)
            .await
        {
            Ok(r) => r,
            Err(e) => return failure_result(e),
        };
        if !resp.status.is_success() {
            return into_tool_result(resp);
        }
        // Derived streams ship their FULL point arrays (the REST endpoint has
        // no cap, and variants='all' multiplies them) — shape like the other
        // stream-bearing tools.
        let mut body = resp.body;
        let max_points = (p.max_points.unwrap_or(500) as usize).clamp(10, 5000);
        if let Some(streams) = body.get_mut("streams").and_then(Value::as_array_mut) {
            for stream in streams.iter_mut() {
                if let Some(points) = stream.get_mut("points") {
                    let original = stride_sample(points, max_points);
                    stream["sample_count"] = json!(original);
                }
            }
        }
        Ok(CallToolResult::success(vec![Content::json(body)?]))
    }

    #[tool(
        description = "Training-load dashboard series: daily CTL/ATL/TSB plus latest \
        readiness and HRV summary. Optionally only the last N days.",
        annotations(read_only_hint = true)
    )]
    async fn get_training_load(
        &self,
        Parameters(p): Parameters<TrainingLoadParams>,
    ) -> Result<CallToolResult, McpError> {
        let resp = match self.api.call(Method::GET, "/analytics/training-load", None).await {
            Ok(r) => r,
            Err(e) => return failure_result(e),
        };
        if !resp.status.is_success() {
            return into_tool_result(resp);
        }
        let mut body = resp.body;
        if let (Some(days), Some(series)) =
            (p.last_days, body.get_mut("series").and_then(Value::as_array_mut))
        {
            let keep = days as usize;
            if series.len() > keep {
                *series = series.split_off(series.len() - keep);
            }
        }
        Ok(CallToolResult::success(vec![Content::json(body)?]))
    }

    #[tool(
        description = "All imported personal records (PRs), newest first.",
        annotations(read_only_hint = true)
    )]
    async fn personal_records(&self) -> Result<CallToolResult, McpError> {
        self.get("/personal-records").await
    }

    #[tool(
        description = "Full gear state: all gear with usage km, default gear per sport, and \
        per-activity assignments.",
        annotations(read_only_hint = true)
    )]
    async fn get_gear(&self) -> Result<CallToolResult, McpError> {
        self.get("/gear").await
    }

    #[tool(
        description = "All metric→source preferences (global defaults + per-activity \
        overrides) controlling which device wins per metric.",
        annotations(read_only_hint = true)
    )]
    async fn list_preferences(&self) -> Result<CallToolResult, McpError> {
        self.get("/preferences").await
    }

    #[tool(
        description = "All app settings as a flat key→string map (step goal, max_hr_allowed, \
        analytics overrides…).",
        annotations(read_only_hint = true)
    )]
    async fn get_settings(&self) -> Result<CallToolResult, McpError> {
        self.get("/settings").await
    }

    /* ---------------------------------------------------- safe mutations */

    #[tool(
        description = "Trigger a FULL analytics recompute: every algorithm over all \
        activities + wellness history. SYNCHRONOUS and slow (can run minutes on large \
        datasets) — the result reports per-algorithm output counts when done.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn recompute(&self) -> Result<CallToolResult, McpError> {
        self.send(Method::POST, "/analytics/recompute", json!({})).await
    }

    #[tool(
        description = "Set analytics parameters (clamped to range; unknown keys rejected), \
        then run a FULL synchronous recompute materializing the new variant as active. Slow — \
        same cost as `recompute`. reset_others=true resets unlisted keys to defaults. Old \
        variants are retained, so this is reversible via set_selection.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn set_parameters(
        &self,
        Parameters(p): Parameters<SetParametersParams>,
    ) -> Result<CallToolResult, McpError> {
        let body = json!({
            "updates": p.updates,
            "reset_others": p.reset_others.unwrap_or(false),
        });
        self.send(Method::PUT, "/analytics/parameters", body).await
    }

    #[tool(
        description = "Pin (or clear) which derivation variant a plugin's outputs resolve \
        to — globally or for one activity. Use `list_variants` to find version + params_hash.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn set_selection(
        &self,
        Parameters(p): Parameters<SetSelectionParams>,
    ) -> Result<CallToolResult, McpError> {
        let mut body = json!({
            "scope": p.scope,
            "plugin_id": p.plugin_id,
            "clear": p.clear.unwrap_or(false),
        });
        if let Some(v) = p.subject_id {
            body["subject_id"] = json!(v);
        }
        if let Some(v) = p.version {
            body["version"] = json!(v);
        }
        if let Some(v) = p.params_hash {
            body["params_hash"] = json!(v);
        }
        self.send(Method::PUT, "/analytics/selection", body).await
    }

    #[tool(
        description = "Upsert one app setting (string key/value). Returns the full settings \
        map afterwards.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn set_setting(
        &self,
        Parameters(p): Parameters<SetSettingParams>,
    ) -> Result<CallToolResult, McpError> {
        self.send(Method::PUT, "/settings", json!({ "key": p.key, "value": p.value })).await
    }

    #[tool(
        description = "Set a metric→source preference: which source wins for a stream kind, \
        globally or for one activity.",
        annotations(read_only_hint = false, destructive_hint = false, idempotent_hint = true, open_world_hint = false)
    )]
    async fn set_preference(
        &self,
        Parameters(p): Parameters<SetPreferenceParams>,
    ) -> Result<CallToolResult, McpError> {
        let mut body = json!({
            "metric": tag(&p.metric),
            "scope": p.scope,
            "source_id": p.source_id,
            "retroactive": p.retroactive.unwrap_or(false),
        });
        if let Some(v) = p.activity_id {
            body["activity_id"] = json!(v);
        }
        self.send(Method::PUT, "/preferences", body).await
    }

    /* ----------------------------------------------------- escape hatches */

    #[tool(
        description = "Run a single read-only SQL statement (SELECT/WITH/EXPLAIN) against \
        the live database. Rows are streamed and capped; long cells truncated. Read-only is \
        enforced at the engine level, plus a conservative write-keyword scan (it also matches \
        inside string literals — rephrase if falsely hit). The auth tables (users, sessions) \
        are not readable. Use `db_schema` first.",
        annotations(read_only_hint = true)
    )]
    async fn query_sql(
        &self,
        Parameters(p): Parameters<QuerySqlParams>,
    ) -> Result<CallToolResult, McpError> {
        let stmt = match sql::validate_readonly(&p.sql) {
            Ok(s) => s,
            Err(reason) => return Ok(CallToolResult::error(vec![Content::text(reason)])),
        };
        let limit = (p.limit.unwrap_or(200) as usize).clamp(1, 2000);
        match sql::run_query(&self.db, &stmt, limit).await {
            Ok(result) => Ok(CallToolResult::success(vec![Content::json(result)?])),
            // SQL syntax/runtime errors are tool-level: readable + retryable.
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    #[tool(
        description = "Generic REST passthrough for endpoints without a dedicated tool \
        (GET/POST/PUT on /api/*; see /api-docs/openapi.json). Blocked: DELETE, imports, \
        maintenance ops, wellness ingest. Prefer the dedicated tools when one exists.",
        annotations(read_only_hint = false, destructive_hint = false, open_world_hint = false)
    )]
    async fn api_request(
        &self,
        Parameters(p): Parameters<ApiRequestParams>,
    ) -> Result<CallToolResult, McpError> {
        // The dispatch router sits under the /api nest, so accept both
        // spellings and strip the prefix.
        let path = p.path.strip_prefix("/api").unwrap_or(&p.path).to_string();
        if !path.starts_with('/') {
            return Ok(CallToolResult::error(vec![Content::text(
                "path must start with '/' (e.g. /activities)",
            )]));
        }
        let method = match p.method {
            ApiMethod::Get => Method::GET,
            ApiMethod::Post => Method::POST,
            ApiMethod::Put => Method::PUT,
        };
        let blocked = path.starts_with("/import")
            || path.starts_with("/maintenance")
            || path.starts_with("/auth")
            || path.contains("export.fit")
            || (method == Method::POST && path.starts_with("/wellness"));
        if blocked {
            return Ok(CallToolResult::error(vec![Content::text(
                "this path is blocked through api_request (imports, maintenance, auth, binary \
                 export and wellness ingest are not exposed via MCP v1)",
            )]));
        }
        match self.api.call(method, &path, p.body.as_ref()).await {
            Ok(resp) => into_tool_result(resp),
            Err(e) => failure_result(e),
        }
    }
}

/* ---------------------------------------------------------------- handler */

// `router = self.tool_router` reuses the per-handler router; the macro's
// default would rebuild it on every call_tool/list_tools.
#[tool_handler(router = self.tool_router)]
impl ServerHandler for OpenFitMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_protocol_version(ProtocolVersion::V_2025_06_18)
            .with_server_info(
                Implementation::new("openfit", env!("CARGO_PKG_VERSION")).with_title("OpenFit"),
            )
            .with_instructions(
                "OpenFit: self-hosted fitness platform (activities + continuous wellness + \
                 pluggable analytics). Data model: Sources (devices/providers) produce raw \
                 recordings, clustered into Activities with per-metric streams (best source per \
                 metric resolved via preferences); continuous WellnessSamples (HR, HRV, sleep, \
                 stress…) accumulate independently; analytics algorithms (built-ins + WASM \
                 plugins) compute derived metrics/streams, persisted per VARIANT \
                 (plugin × version × params fingerprint) so parameterizations coexist and are \
                 switchable via selections. Start with get_overview. Timestamps are RFC3339 \
                 UTC; enum tags snake_case. recompute/set_parameters are synchronous and can \
                 run minutes. query_sql is read-only (auth tables excluded); db_schema shows \
                 the tables.",
            )
    }
}

/* ----------------------------------------------------------------- helpers */

/// Accept RFC3339 (any offset) or a bare `YYYY-MM-DD` (start of day, or end of
/// day when `end` — for inclusive "to" bounds), returning normalized UTC
/// RFC3339. Errors become invalid-params so the model can fix its input.
fn normalize_ts(s: &str, end: bool) -> Result<String, McpError> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Ok(dt
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    }
    if let Ok(d) = s.parse::<chrono::NaiveDate>() {
        let t = if end {
            d.and_hms_opt(23, 59, 59).expect("valid hms")
        } else {
            d.and_hms_opt(0, 0, 0).expect("valid hms")
        };
        return Ok(chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(t, chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    }
    Err(McpError::invalid_params(
        format!("invalid timestamp '{s}': use RFC3339 or YYYY-MM-DD"),
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Date-only inputs expand to day bounds; RFC3339 normalizes to UTC.
    #[test]
    fn normalize_ts_accepts_dates_and_rfc3339() {
        assert_eq!(normalize_ts("2026-06-01", false).unwrap(), "2026-06-01T00:00:00Z");
        assert_eq!(normalize_ts("2026-06-01", true).unwrap(), "2026-06-01T23:59:59Z");
        assert_eq!(
            normalize_ts("2026-06-01T12:00:00+02:00", false).unwrap(),
            "2026-06-01T10:00:00Z"
        );
        assert!(normalize_ts("yesterday", false).is_err());
    }

    // The schemars mirror enums must stay in lock-step with ofit-core's serde
    // enums: every mirror tag must parse into the core enum (catches renames /
    // tag drift), and the counts must match (catches added core variants).
    #[test]
    fn wellness_kind_mirror_round_trips_into_ofit_core() {
        let mirrors = [
            WellnessKindArg::HeartRate, WellnessKindArg::SleepStage,
            WellnessKindArg::RestingHeartRate, WellnessKindArg::Hrv,
            WellnessKindArg::Stress, WellnessKindArg::BodyBattery,
            WellnessKindArg::Respiration, WellnessKindArg::SpO2,
            WellnessKindArg::Steps, WellnessKindArg::Weight,
            WellnessKindArg::Calories, WellnessKindArg::BodyFat,
            WellnessKindArg::BodyWater, WellnessKindArg::BoneMass,
            WellnessKindArg::MuscleMass, WellnessKindArg::Bmi,
            WellnessKindArg::Vo2Max, WellnessKindArg::TrainingLoad,
            WellnessKindArg::FitnessAge, WellnessKindArg::RacePredict5k,
            WellnessKindArg::RacePredict10k, WellnessKindArg::RacePredictHalf,
            WellnessKindArg::RacePredictMarathon,
        ];
        for m in &mirrors {
            let t = tag(m);
            let parsed: Result<ofit_core::WellnessKind, _> =
                serde_json::from_value(serde_json::json!(t));
            assert!(parsed.is_ok(), "mirror tag '{t}' no longer parses into ofit_core::WellnessKind");
        }
        // Non-obvious renderings the schema must advertise verbatim.
        assert_eq!(tag(&WellnessKindArg::SpO2), "sp_o2");
        assert_eq!(tag(&WellnessKindArg::RacePredict5k), "race_predict5k");
        assert_eq!(tag(&WellnessKindArg::Vo2Max), "vo2_max");
    }

    #[test]
    fn stream_kind_mirror_round_trips_into_ofit_core() {
        let mirrors = [
            StreamKindArg::HeartRate, StreamKindArg::Power, StreamKindArg::Cadence,
            StreamKindArg::Speed, StreamKindArg::Altitude, StreamKindArg::LatLng,
            StreamKindArg::Wind, StreamKindArg::Temperature, StreamKindArg::Distance,
            StreamKindArg::VerticalOscillation, StreamKindArg::GroundContactTime,
            StreamKindArg::StrideLength, StreamKindArg::VerticalRatio,
            StreamKindArg::FormPower, StreamKindArg::AirPower,
            StreamKindArg::LegSpringStiffness,
        ];
        assert_eq!(
            mirrors.len(),
            ofit_core::StreamKind::ALL.len(),
            "ofit_core::StreamKind gained/lost variants — update StreamKindArg"
        );
        for m in &mirrors {
            let t = tag(m);
            let parsed: Result<ofit_core::StreamKind, _> =
                serde_json::from_value(serde_json::json!(t));
            assert!(parsed.is_ok(), "mirror tag '{t}' no longer parses into ofit_core::StreamKind");
        }
        assert_eq!(tag(&StreamKindArg::LatLng), "lat_lng");
    }
}
