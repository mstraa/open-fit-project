//! Phase-1 REST handlers (thin: map DB/core ↔ DTOs, no business logic here).
//!
//! The dedup/clustering/resolution logic lives in `ofit-core` and the import
//! orchestration in `ofit-ingest`; these handlers only translate to/from the
//! API-boundary [`crate::dto`] types and call those crates.

use std::collections::BTreeMap;

use axum::{
    extract::{Multipart, Path, Query, State},
    http::StatusCode,
    Json,
};
use ofit_core::{
    resolve_activity_view, MetricSourcePreference, PreferenceScope, Sample, Source, Stream,
    StreamKind,
};

use crate::dto::*;
use crate::AppState;

/// Max chart points returned per scalar/track stream. Streams are downsampled by
/// uniform stride so the dashboard stays responsive without losing shape.
const MAX_CHART_POINTS: usize = 1000;

/// Uniform-stride downsample: keep at most `max` evenly spaced samples, always
/// preserving the first and last (so the chart/track spans the full window).
fn downsample<T: Clone>(items: &[T], max: usize) -> Vec<T> {
    if items.len() <= max || max == 0 {
        return items.to_vec();
    }
    let n = items.len();
    let mut out = Vec::with_capacity(max);
    // step in fixed-point to spread picks across the whole range.
    for i in 0..max {
        let idx = (i * (n - 1)) / (max - 1);
        out.push(items[idx].clone());
    }
    out
}

/// A standard JSON error body.
fn err(status: StatusCode, msg: impl Into<String>) -> (StatusCode, Json<serde_json::Value>) {
    (status, Json(serde_json::json!({ "error": msg.into() })))
}

type ApiError = (StatusCode, Json<serde_json::Value>);

/// `POST /api/import` — multipart upload; import each part via the pipeline.
#[utoipa::path(
    post, path = "/api/import",
    request_body(content = inline(String), description = "multipart/form-data file parts", content_type = "multipart/form-data"),
    responses((status = 200, body = ImportResponse))
)]
pub async fn import(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<ImportResponse>, ApiError> {
    let mut files = Vec::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| err(StatusCode::BAD_REQUEST, format!("multipart error: {e}")))?
    {
        let filename = field
            .file_name()
            .map(str::to_string)
            .unwrap_or_else(|| "<unnamed>".to_string());
        let bytes = match field.bytes().await {
            Ok(b) => b,
            Err(e) => {
                files.push(ImportFileResult {
                    filename,
                    ok: false,
                    recording_id: None,
                    activity_id: None,
                    deduped: false,
                    streams_found: 0,
                    error: Some(format!("read part: {e}")),
                });
                continue;
            }
        };
        files.push(import_one(&state, &filename, &bytes).await);
    }
    Ok(Json(ImportResponse { files }))
}

/// Run the import pipeline for one in-memory file part.
async fn import_one(state: &AppState, filename: &str, bytes: &[u8]) -> ImportFileResult {
    match ofit_ingest::import_bytes_path(&state.db, filename, bytes).await {
        Ok(ofit_ingest::ImportOutcome::Imported {
            recording_id,
            activity_id,
            stream_count,
            ..
        }) => ImportFileResult {
            filename: filename.to_string(),
            ok: true,
            recording_id: Some(recording_id),
            activity_id: Some(activity_id),
            deduped: false,
            streams_found: stream_count,
            error: None,
        },
        Ok(ofit_ingest::ImportOutcome::Duplicate { recording_id }) => ImportFileResult {
            filename: filename.to_string(),
            ok: true,
            recording_id: Some(recording_id),
            activity_id: None,
            deduped: true,
            streams_found: 0,
            error: None,
        },
        Err(e) => ImportFileResult {
            filename: filename.to_string(),
            ok: false,
            recording_id: None,
            activity_id: None,
            deduped: false,
            streams_found: 0,
            error: Some(e.to_string()),
        },
    }
}

/// `GET /api/sources` — list all sources.
#[utoipa::path(get, path = "/api/sources", responses((status = 200, body = [SourceDto])))]
pub async fn list_sources(State(state): State<AppState>) -> Result<Json<Vec<SourceDto>>, ApiError> {
    let sources = state
        .db
        .list_sources()
        .await
        .map_err(internal)?;
    Ok(Json(sources.into_iter().map(SourceDto::from).collect()))
}

/// `GET /api/activities` — list activity summaries.
#[utoipa::path(get, path = "/api/activities", responses((status = 200, body = [ActivitySummary])))]
pub async fn list_activities(
    State(state): State<AppState>,
) -> Result<Json<Vec<ActivitySummary>>, ApiError> {
    let acts = state.db.list_activities().await.map_err(internal)?;
    let out = acts
        .into_iter()
        .map(|a| ActivitySummary {
            id: a.id,
            sport: a.sport,
            started_at: a.started_at,
            ended_at: a.ended_at,
            recording_count: a.recording_ids.len(),
            duration_secs: (a.ended_at - a.started_at).num_seconds().max(0),
        })
        .collect();
    Ok(Json(out))
}

/// `GET /api/activities/{id}` — detail with recordings + resolved view.
#[utoipa::path(
    get, path = "/api/activities/{id}",
    params(("id" = uuid::Uuid, Path, description = "activity id")),
    responses((status = 200, body = ActivityDetail), (status = 404))
)]
pub async fn get_activity(
    State(state): State<AppState>,
    Path(id): Path<uuid::Uuid>,
) -> Result<Json<ActivityDetail>, ApiError> {
    let detail = build_activity_detail(&state, id).await?;
    Ok(Json(detail))
}

/// `DELETE /api/activities/{id}/recordings/{recording_id}` — remove (detach) a
/// recording from an activity.
///
/// The recording is **not** deleted: it is split into its own new
/// single-recording activity (a durable manual split). Both the trimmed
/// original and the new activity are marked `user_confirmed`, so re-importing or
/// re-running clustering will not auto-merge them back
/// ([`ofit_db::Db::detach_recording_from_activity`]).
///
/// On success returns **200** with the *updated* (re-resolved) detail of the
/// activity the recording was removed from — so the remove UI can refresh
/// in place (the per-metric source view is recomputed, since one contributing
/// source is now gone). The newly created activity id is also returned.
///
/// Guards (return **400**, no-op): the recording is not a member of the
/// activity, or it is the activity's *only* recording (removing it would leave
/// an empty activity).
#[utoipa::path(
    delete, path = "/api/activities/{id}/recordings/{recording_id}",
    params(
        ("id" = uuid::Uuid, Path, description = "activity id"),
        ("recording_id" = uuid::Uuid, Path, description = "recording to detach"),
    ),
    responses(
        (status = 200, body = RemoveRecordingResponse),
        (status = 400, description = "recording is not a member, or is the only recording"),
        (status = 404, description = "activity not found"),
    )
)]
pub async fn remove_recording(
    State(state): State<AppState>,
    Path((id, recording_id)): Path<(uuid::Uuid, uuid::Uuid)>,
) -> Result<Json<RemoveRecordingResponse>, ApiError> {
    // 404 if the activity does not exist at all (distinct from the 400 guards).
    if state.db.get_activity(id).await.map_err(internal)?.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "activity not found"));
    }

    let detached_activity_id = match state
        .db
        .detach_recording_from_activity(id, recording_id)
        .await
    {
        Ok(new_id) => new_id,
        // Domain guards (not-a-member / only-recording) → 400 no-op.
        Err(ofit_db::DbError::Conflict(msg)) => return Err(err(StatusCode::BAD_REQUEST, msg)),
        Err(e) => return Err(internal(e)),
    };

    // Re-resolve and return the updated detail of the original activity (a source
    // is now gone, so the per-metric resolution may change).
    let activity = build_activity_detail(&state, id).await?;
    Ok(Json(RemoveRecordingResponse {
        activity,
        detached_activity_id,
    }))
}

/// Build the full [`ActivityDetail`] (recordings + re-resolved per-metric view)
/// for one activity. Shared by `GET /activities/{id}` and the remove endpoint.
async fn build_activity_detail(
    state: &AppState,
    id: uuid::Uuid,
) -> Result<ActivityDetail, ApiError> {
    let db = &state.db;
    let activity = db
        .get_activity(id)
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "activity not found"))?;

    // Gather sources, member recordings, and all their streams.
    let sources = db.list_sources().await.map_err(internal)?;
    let source_by_id: BTreeMap<_, &Source> = sources.iter().map(|s| (s.id, s)).collect();
    let rec_source = db
        .recording_sources(&activity.recording_ids)
        .await
        .map_err(internal)?;

    let mut all_streams: Vec<Stream> = Vec::new();
    let mut recordings: Vec<RecordingDto> = Vec::new();
    for &rid in &activity.recording_ids {
        let streams = db.streams_for_recording(rid).await.map_err(internal)?;
        let rec = db.get_recording(rid).await.map_err(internal)?;
        let (source_id, format) = match &rec {
            Some(r) => (
                r.source_id,
                r.metadata
                    .get("format")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            ),
            None => (*rec_source.get(&rid).unwrap_or(&uuid::Uuid::nil()), None),
        };
        let source_name = source_by_id
            .get(&source_id)
            .map(|s| s.name.clone())
            .unwrap_or_default();
        recordings.push(RecordingDto {
            id: rid,
            source_id,
            source_name,
            format,
            available_metrics: streams.iter().map(|s| s.kind).collect(),
        });
        all_streams.extend(streams);
    }

    // Resolve best source per metric using the core resolver.
    let prefs = db.preferences_for_activity(id).await.map_err(internal)?;
    let view = resolve_activity_view(&activity, &all_streams, &sources, &rec_source, &prefs);

    let mut resolved_metrics: Vec<ResolvedScalarMetric> = Vec::new();
    let mut track: Vec<TrackPoint> = Vec::new();
    let mut track_source_id: Option<uuid::Uuid> = None;

    for m in view.metrics {
        let source_name = source_by_id
            .get(&m.source_id)
            .map(|s| s.name.clone())
            .unwrap_or_default();
        if m.kind == StreamKind::LatLng {
            let pts: Vec<TrackPoint> = m
                .stream
                .samples
                .iter()
                .filter_map(|s| match s {
                    Sample::LatLng { t_offset_ms, lat, lng } => Some(TrackPoint {
                        t_offset_ms: *t_offset_ms,
                        lat: *lat,
                        lng: *lng,
                    }),
                    _ => None,
                })
                .collect();
            track = downsample(&pts, MAX_CHART_POINTS);
            track_source_id = Some(m.source_id);
        } else {
            let pts: Vec<ScalarPoint> = m
                .stream
                .samples
                .iter()
                .filter_map(|s| match s {
                    Sample::Scalar { t_offset_ms, value } => Some(ScalarPoint {
                        t_offset_ms: *t_offset_ms,
                        value: *value,
                    }),
                    _ => None,
                })
                .collect();
            resolved_metrics.push(ResolvedScalarMetric {
                kind: m.kind,
                source_id: m.source_id,
                source_name,
                recording_id: m.recording_id,
                selected_by: m.selected_by,
                sample_count: pts.len(),
                points: downsample(&pts, MAX_CHART_POINTS),
            });
        }
    }

    Ok(ActivityDetail {
        id: activity.id,
        sport: activity.sport,
        started_at: activity.started_at,
        ended_at: activity.ended_at,
        duration_secs: (activity.ended_at - activity.started_at).num_seconds().max(0),
        recordings,
        resolved_metrics,
        track,
        track_source_id,
    })
}

/// `GET /api/preferences` — list all preferences (defaults + overrides).
#[utoipa::path(get, path = "/api/preferences", responses((status = 200, body = [PreferenceDto])))]
pub async fn list_preferences(
    State(state): State<AppState>,
) -> Result<Json<Vec<PreferenceDto>>, ApiError> {
    let prefs = state.db.list_preferences().await.map_err(internal)?;
    Ok(Json(prefs.into_iter().map(pref_to_dto).collect()))
}

/// `PUT /api/preferences` — set a default or per-activity preference.
///
/// Retroactive semantics: when a retroactive *default* is set
/// ([`ofit_core::should_reresolve_history`]), the resolved view of historical
/// activities reflects it immediately (resolution is computed at read time from
/// the stored preferences), which is exactly what the dashboard re-renders.
#[utoipa::path(
    put, path = "/api/preferences",
    request_body = SetPreferenceRequest,
    responses((status = 200, body = PreferenceDto), (status = 400))
)]
pub async fn set_preference(
    State(state): State<AppState>,
    Json(req): Json<SetPreferenceRequest>,
) -> Result<Json<PreferenceDto>, ApiError> {
    let pref = match req.scope {
        PreferenceScopeDto::Default => {
            MetricSourcePreference::default_for(req.metric, req.source_id, req.retroactive)
        }
        PreferenceScopeDto::Activity => {
            let act = req.activity_id.ok_or_else(|| {
                err(
                    StatusCode::BAD_REQUEST,
                    "activity_id is required when scope == activity",
                )
            })?;
            MetricSourcePreference::override_for(req.metric, act, req.source_id)
        }
    };
    state.db.insert_preference(&pref).await.map_err(internal)?;
    Ok(Json(pref_to_dto(pref)))
}

/// `GET /api/wellness?kind=&from=&to=` — continuous wellness trend.
#[utoipa::path(
    get, path = "/api/wellness",
    params(WellnessQuery),
    responses((status = 200, body = WellnessResponse))
)]
pub async fn wellness(
    State(state): State<AppState>,
    Query(q): Query<WellnessQuery>,
) -> Result<Json<WellnessResponse>, ApiError> {
    let samples = state
        .db
        .wellness_samples(q.kind, q.from.as_deref(), q.to.as_deref())
        .await
        .map_err(internal)?;
    let points = samples
        .into_iter()
        .map(|w| WellnessPoint {
            ts: w.ts,
            value: w.value,
            source_id: w.source_id,
        })
        .collect();
    Ok(Json(WellnessResponse {
        kind: q.kind,
        points,
    }))
}

// ---- small mappers ----

fn pref_to_dto(p: MetricSourcePreference) -> PreferenceDto {
    PreferenceDto {
        id: p.id,
        metric: p.metric,
        scope: match p.scope {
            PreferenceScope::Default => PreferenceScopeDto::Default,
            PreferenceScope::Activity => PreferenceScopeDto::Activity,
        },
        activity_id: p.activity_id,
        source_id: p.source_id,
        retroactive: p.retroactive,
        updated_at: p.updated_at,
    }
}

fn internal(e: impl std::fmt::Display) -> ApiError {
    err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}
