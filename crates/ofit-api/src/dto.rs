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
    /// Latest data we have from this source (`max(wellness ts, recording end)`),
    /// shown as the device's "last sync". `None` if it has produced no data yet.
    pub last_synced_at: Option<DateTime<Utc>>,
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
            last_synced_at: None,
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
    /// Total distance in metres, if computed (recompute cache). `None` until the
    /// analytics recompute has run for this activity.
    pub distance_m: Option<f64>,
    /// Energy in kcal, if known (Zepp summary). `None` otherwise.
    pub calories: Option<f64>,
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

/// Totals for a **summary-only** activity (e.g. a Zepp `SPORT` workout that has
/// no per-second streams) — surfaced so the detail view shows stats, not a blank.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ActivitySummaryStats {
    /// Total distance in metres (0 when not a distance sport).
    pub distance_m: f64,
    /// Energy in kcal.
    pub calories_kcal: f64,
    /// Average pace in seconds per metre (0 when distance is 0).
    pub avg_pace_s_per_m: f64,
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
    /// Totals for a summary-only activity (no streams); absent for normal ones.
    pub summary: Option<ActivitySummaryStats>,
    /// Total steps for the effort, when a member recording reports them (e.g. a
    /// phone recording's step detector). `None` if no recording carried steps.
    pub total_steps: Option<i64>,
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

/// Response of `DELETE /api/activities/{id}/sources/{recording_id}` — the
/// **hard** per-source delete used by the activity Edit tab.
///
/// When the deleted source was the activity's *last* one, the whole activity is
/// removed (`activity_deleted = true`, `activity = null`). Otherwise the source
/// is gone and the re-resolved, re-tightened activity comes back in `activity`
/// so the detail view refreshes in place.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DeleteSourceResponse {
    /// True when removing this source emptied — and therefore deleted — the
    /// whole activity.
    pub activity_deleted: bool,
    /// The updated activity (absent when `activity_deleted`).
    pub activity: Option<ActivityDetail>,
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

/// One incoming wellness reading on the ingest path (`POST /api/wellness`).
/// A relay/device streams these (batched) — the continuous, streaming-first feed.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct WellnessIngest {
    /// Metric kind.
    pub kind: WellnessKind,
    /// Scalar value (categorical kinds use a stable code).
    pub value: f64,
    /// Timestamp (RFC3339). Defaults to now when omitted (live feed).
    pub ts: Option<String>,
    /// Source that produced it; defaults to the shared "Live stream" source.
    pub source_id: Option<Uuid>,
}

/// Response of `POST /api/wellness`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WellnessIngestResponse {
    /// Number of samples persisted.
    pub ingested: usize,
}

/// Count of ingested readings of one wellness kind.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct WellnessKindCount {
    pub kind: WellnessKind,
    pub count: usize,
}

/// Response of `POST /api/import/zepp` — a Zepp app-export (.zip) holds one
/// account's continuous wellness across several CSV categories.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ZeppImportResponse {
    /// Source the readings were attributed to (e.g. `"Zepp (mstraa)"`).
    pub source: String,
    /// Total readings ingested.
    pub ingested: usize,
    /// Per-kind breakdown.
    pub by_kind: Vec<WellnessKindCount>,
    /// Summary activities created from the `SPORT` workout table.
    pub activities_imported: usize,
    /// Summary workouts skipped because a real (streamed) activity already covers
    /// the same effort (same sport, overlapping window).
    pub activities_skipped_dup: usize,
    /// Pre-existing summary activities removed because they duplicate a real one.
    pub duplicate_summaries_removed: usize,
    /// Categories present in the export but deliberately not imported, with why.
    pub skipped: Vec<String>,
}

/// Response of `POST /api/maintenance/dedup-zepp-summaries`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DedupResponse {
    /// Number of duplicate summary activities deleted.
    pub deleted: usize,
}

/// Response of `POST /api/maintenance/remap-zepp-sports`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct RemapResponse {
    /// Number of summary recordings whose sport was corrected.
    pub updated: usize,
}

/// Body of `POST /api/import/garmin` — point at a Garmin GDPR export already on
/// the server's disk (a 195 MB tree; uploading it would be impractical).
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct GarminImportRequest {
    /// Absolute or repo-relative path to the unzipped export root (the `…_1`
    /// directory that contains `DI_CONNECT/`).
    pub path: String,
}

/// Response of `POST /api/import/garmin` — a full one-time backfill summary.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct GarminImportResponse {
    /// Source the wellness was attributed to (`"Garmin (import)"`).
    pub source: String,
    /// Total wellness readings ingested (daily + sleep + body + performance).
    pub wellness_ingested: usize,
    /// Per-kind breakdown.
    pub by_kind: Vec<WellnessKindCount>,
    /// Distinct calendar days of daily wellness.
    pub days: usize,
    /// Sleep nights staged.
    pub nights: usize,
    /// Gear items imported (with mileage joined from activity distances).
    pub gear_imported: usize,
    /// Current personal records imported.
    pub personal_records: usize,
    /// Activity `.fit` files imported from the upload firehose.
    pub fit_activities_imported: usize,
    /// `.fit` activities already present (content-hash match), skipped.
    pub fit_duplicates: usize,
    /// `.fit` entries skipped because they weren't activities.
    pub fit_skipped_non_activity: usize,
    /// `.fit` entries that failed to parse, skipped.
    pub fit_parse_errors: usize,
    /// Activities present after the final reclustering.
    pub activities_total: usize,
    /// Activities seen by the single full recompute at the end.
    pub recompute_activities: usize,
    /// Wellness points seen by that recompute.
    pub recompute_wellness_points: usize,
    /// Categories/files present but deliberately not imported, with why.
    pub skipped: Vec<String>,
}

/// Composite gear state for the UI store: all gear, the default gear per
/// activity type, and per-activity assignments.
#[derive(Debug, Clone, Serialize)]
pub struct GearStateDto {
    /// All gear, oldest first.
    pub gears: Vec<ofit_core::Gear>,
    /// Default gear per activity type (`sport → gear_id`).
    pub defaults: std::collections::BTreeMap<String, Uuid>,
    /// Per-activity gear assignments (`activity_id → [gear_id]`).
    pub assignments: std::collections::BTreeMap<Uuid, Vec<Uuid>>,
}

/// Body of `POST /api/gear` — create a piece of gear.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateGearRequest {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Activity type label (e.g. "Running").
    pub sport: String,
    #[serde(default)]
    pub initial_km: f64,
    #[serde(default)]
    pub retire_km: f64,
    #[serde(default)]
    pub icon: Option<String>,
}

/// Body of `PUT /api/gear/{id}` — patch editable fields (all optional).
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateGearRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub sport: Option<String>,
    pub retire_km: Option<f64>,
    pub used_km: Option<f64>,
    pub icon: Option<String>,
}

/// Body of `PUT /api/gear/defaults` — set/clear the default gear for a type.
#[derive(Debug, Clone, Deserialize)]
pub struct SetGearDefaultRequest {
    pub sport: String,
    /// `None` clears the default for this type.
    pub gear_id: Option<Uuid>,
}

/// Body of `PUT /api/activities/{id}/gear` — replace the activity's gear set.
#[derive(Debug, Clone, Deserialize)]
pub struct SetActivityGearRequest {
    pub gear_ids: Vec<Uuid>,
}

/// A live wellness sample pushed over the `/api/wellness/live` WebSocket as a
/// JSON text frame — the real-time fan-out of the ingest path to the dashboard.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct LiveWellness {
    /// Metric kind.
    pub kind: WellnessKind,
    /// Value at `ts`.
    pub value: f64,
    /// Wall-clock timestamp (UTC).
    pub ts: DateTime<Utc>,
    /// Source that produced it.
    pub source_id: Uuid,
}
