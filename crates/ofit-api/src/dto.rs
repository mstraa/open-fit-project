//! API-boundary DTOs (the web client is generated from these).
//!
//! Every type here derives `serde` + `utoipa::ToSchema` (AGENTS.md: types that
//! cross the API boundary). They are deliberately *flat and chart-friendly* —
//! handlers map the canonical [`ofit_core`] entities into these shapes so the
//! generated TS client binds directly to what uPlot / MapLibre need.

use chrono::{DateTime, Utc};
use ofit_core::{SelectionReason, Source, SourceKind, Sport, StreamKind, WellnessKind};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

/// Outcome of importing a single uploaded file.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ImportFileResult {
    /// Original filename from the multipart part.
    pub filename: String,
    /// Whether parsing/persisting succeeded.
    pub ok: bool,
    /// The persisted (or pre-existing) recording id, when known.
    pub recording_id: Option<Uuid>,
    /// The activity the recording was clustered into (absent on duplicate/error).
    pub activity_id: Option<Uuid>,
    /// True when the exact bytes were already present (content-hash match).
    pub deduped: bool,
    /// Number of time-series streams found/stored.
    pub streams_found: usize,
    /// Error message when `ok == false`.
    pub error: Option<String>,
}

/// Response of `POST /api/import` — one result per uploaded part.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ImportResponse {
    /// Per-file outcomes, in upload order.
    pub files: Vec<ImportFileResult>,
}

/// A data source (device/provider) as exposed to the client.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SourceDto {
    /// Stable id.
    pub id: Uuid,
    /// Broad origin kind.
    pub kind: SourceKind,
    /// Human-readable name.
    pub name: String,
    /// Optional manufacturer label.
    pub manufacturer: Option<String>,
    /// Default per-metric resolution priority (higher = preferred).
    pub default_priority: i32,
    /// First time we saw this source.
    pub created_at: DateTime<Utc>,
}

impl From<Source> for SourceDto {
    fn from(s: Source) -> Self {
        Self {
            id: s.id,
            kind: s.kind,
            name: s.name,
            manufacturer: s.manufacturer,
            default_priority: s.default_priority,
            created_at: s.created_at,
        }
    }
}

/// One row in the activities list.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ActivitySummary {
    /// Stable id.
    pub id: Uuid,
    /// Sport of the effort.
    pub sport: Sport,
    /// Earliest start across member recordings (UTC).
    pub started_at: DateTime<Utc>,
    /// Latest end across member recordings (UTC).
    pub ended_at: DateTime<Utc>,
    /// How many raw recordings make up this activity.
    pub recording_count: usize,
    /// Duration of the activity window in seconds.
    pub duration_secs: i64,
}

/// A contributing recording within an activity detail view.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RecordingDto {
    /// Recording id.
    pub id: Uuid,
    /// Id of the source it came from.
    pub source_id: Uuid,
    /// Human-readable source name.
    pub source_name: String,
    /// File format (`fit` / `gpx` / `tcx`) from ingest metadata, if known.
    pub format: Option<String>,
    /// Metric kinds this recording provides.
    pub available_metrics: Vec<StreamKind>,
}

/// A scalar sample point, ready for charting (`[x, y]`-ish, but named).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ScalarPoint {
    /// Milliseconds since the recording start.
    pub t_offset_ms: i64,
    /// Value at that offset.
    pub value: f64,
}

/// A geographic point for the map track.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct TrackPoint {
    /// Milliseconds since the recording start.
    pub t_offset_ms: i64,
    /// Latitude in degrees.
    pub lat: f64,
    /// Longitude in degrees.
    pub lng: f64,
}

/// A resolved scalar metric (best source per kind), downsampled for charts.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ResolvedScalarMetric {
    /// Metric kind.
    pub kind: StreamKind,
    /// Source chosen for this metric.
    pub source_id: Uuid,
    /// Source name (for the per-metric picker UI).
    pub source_name: String,
    /// Recording the chosen stream came from.
    pub recording_id: Uuid,
    /// Why this source was selected (override / default / priority).
    pub selected_by: SelectionReason,
    /// Total sample count before downsampling.
    pub sample_count: usize,
    /// Downsampled chart points.
    pub points: Vec<ScalarPoint>,
}

/// Activity detail: contributing recordings + the resolved (merged) view.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ActivityDetail {
    /// Activity id.
    pub id: Uuid,
    /// Sport.
    pub sport: Sport,
    /// Window start (UTC).
    pub started_at: DateTime<Utc>,
    /// Window end (UTC).
    pub ended_at: DateTime<Utc>,
    /// Duration in seconds.
    pub duration_secs: i64,
    /// The recordings that make up this activity.
    pub recordings: Vec<RecordingDto>,
    /// Resolved scalar metrics (one per kind, best source), chart-ready.
    pub resolved_metrics: Vec<ResolvedScalarMetric>,
    /// The resolved LatLng track for the map (best source), downsampled.
    pub track: Vec<TrackPoint>,
    /// Source of the resolved track, if any.
    pub track_source_id: Option<Uuid>,
}

/// Response of `DELETE /api/activities/{id}/recordings/{recording_id}`.
///
/// Carries the re-resolved detail of the activity the recording was removed
/// from (so the UI refreshes in place) plus the id of the new single-recording
/// activity the detached recording now lives in.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RemoveRecordingResponse {
    /// The updated (re-resolved) activity the recording was removed from.
    pub activity: ActivityDetail,
    /// Id of the new single-recording activity that now owns the detached
    /// recording (the durable manual split).
    pub detached_activity_id: Uuid,
}

/// Scope a preference applies to (mirrors `ofit_core::PreferenceScope`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PreferenceScopeDto {
    /// Persistent default for a metric.
    Default,
    /// Per-activity override.
    Activity,
}

/// A metric→source preference as exposed to the client.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PreferenceDto {
    /// Preference id.
    pub id: Uuid,
    /// Metric this preference resolves.
    pub metric: StreamKind,
    /// Scope (default vs activity override).
    pub scope: PreferenceScopeDto,
    /// Activity pinned when `scope == activity`.
    pub activity_id: Option<Uuid>,
    /// Chosen source for this metric in this scope.
    pub source_id: Uuid,
    /// Retroactive toggle (meaningful only for defaults).
    pub retroactive: bool,
    /// Last time this preference changed (UTC).
    pub updated_at: DateTime<Utc>,
}

/// Body of `PUT /api/preferences` — set a default or per-activity preference.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct SetPreferenceRequest {
    /// Metric to pin a source for.
    pub metric: StreamKind,
    /// Scope: `default` (all activities) or `activity` (one activity).
    pub scope: PreferenceScopeDto,
    /// Required when `scope == activity`.
    pub activity_id: Option<Uuid>,
    /// Source to prefer for this metric.
    pub source_id: Uuid,
    /// Retroactive toggle for defaults (re-resolve history when true).
    #[serde(default)]
    pub retroactive: bool,
}

/// One wellness trend sample.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WellnessPoint {
    /// Wall-clock timestamp (UTC).
    pub ts: DateTime<Utc>,
    /// Value (categorical kinds use a stable numeric code).
    pub value: f64,
    /// Source that produced the reading.
    pub source_id: Uuid,
}

/// Response of `GET /api/wellness`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WellnessResponse {
    /// The requested metric kind.
    pub kind: WellnessKind,
    /// Trend samples, ascending by time (may be empty for this dataset).
    pub points: Vec<WellnessPoint>,
}

/// Query params for `GET /api/wellness`.
#[derive(Debug, Clone, Deserialize, ToSchema, utoipa::IntoParams)]
pub struct WellnessQuery {
    /// Metric kind (e.g. `heart_rate`, `hrv`, `body_battery`).
    pub kind: WellnessKind,
    /// Inclusive lower bound (RFC3339), optional.
    pub from: Option<String>,
    /// Inclusive upper bound (RFC3339), optional.
    pub to: Option<String>,
}
