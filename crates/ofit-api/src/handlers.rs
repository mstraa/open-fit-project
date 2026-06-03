//! Phase-1 REST handlers (thin: map DB/core ↔ DTOs, no business logic here).
//!
//! The dedup/clustering/resolution logic lives in `ofit-core` and the import
//! orchestration in `ofit-ingest`; these handlers only translate to/from the
//! API-boundary [`crate::dto`] types and call those crates.

use std::collections::BTreeMap;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Multipart, Path, Query, State,
    },
    http::StatusCode,
    response::Response,
    Json,
};
use ofit_core::{
    resolve_activity_view, MetricSourcePreference, PreferenceScope, Sample, Source, SourceKind,
    Stream, StreamKind, WellnessSample,
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
    state.recompute_notify.notify_one();
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
    let sources = state.db.list_sources().await.map_err(internal)?;
    // Per-source "last synced" = latest data timestamp we hold for it.
    let last = state.db.last_sync_per_source().await.unwrap_or_default();
    Ok(Json(
        sources
            .into_iter()
            .map(|s| {
                let mut d = SourceDto::from(s);
                d.last_synced_at = last.get(&d.id).copied();
                d
            })
            .collect(),
    ))
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
            distance_m: a.distance_m,
            calories: a.calories,
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
    let mut summary: Option<ActivitySummaryStats> = None;
    let mut total_steps: Option<i64> = None;
    for &rid in &activity.recording_ids {
        let streams = db.streams_for_recording(rid).await.map_err(internal)?;
        let rec = db.get_recording(rid).await.map_err(internal)?;
        if summary.is_none() {
            if let Some(m) = rec.as_ref().map(|r| &r.metadata).filter(|m| m.get("summary_only").and_then(|v| v.as_bool()).unwrap_or(false)) {
                summary = Some(ActivitySummaryStats {
                    distance_m: m.get("distance_m").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    calories_kcal: m.get("calories_kcal").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    avg_pace_s_per_m: m.get("avg_pace_s_per_m").and_then(|v| v.as_f64()).unwrap_or(0.0),
                });
            }
        }
        // Steps are a session-level total (e.g. a phone recording's step detector),
        // carried in the recording metadata; take the max across member recordings.
        if let Some(s) = rec.as_ref().and_then(|r| r.metadata.get("steps")).and_then(|v| v.as_i64()) {
            total_steps = Some(total_steps.map_or(s, |cur| cur.max(s)));
        }
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
        summary,
        total_steps,
    })
}

/// Refold the cross-activity training-load (CTL/ATL/TSB) series after an activity
/// was hard-deleted, so the chart drops its now-gone TSS contribution.
///
/// Best-effort: the delete already committed, so a refold failure only leaves the
/// chart momentarily stale (the next ingest/edit re-runs the fold). We log it
/// rather than silently swallow, so the failure is observable. Note a worker
/// `notify` wouldn't help — the deleted activity is no longer dirty, and the
/// worker only refolds training load for *dirty activities*.
async fn refold_training_load_after_delete(state: &AppState) {
    if let Err(e) = crate::analytics::recompute_training_load_streams(state).await {
        tracing::error!(error = %e, "training-load refold after delete failed");
    }
}

/// `DELETE /api/activities/{id}` — **hard-delete** an entire activity.
///
/// Removes the activity, all its member recordings + streams, derived outputs,
/// gear assignments, and per-activity source preferences (irreversible). Then
/// refolds the cross-activity training-load series, since this activity's TSS no
/// longer contributes. Returns `{ ok, deleted_recordings }`.
#[utoipa::path(
    delete, path = "/api/activities/{id}",
    params(("id" = uuid::Uuid, Path, description = "activity id")),
    responses((status = 200), (status = 404, description = "activity not found"))
)]
pub async fn delete_activity(
    State(state): State<AppState>,
    Path(id): Path<uuid::Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if state.db.get_activity(id).await.map_err(internal)?.is_none() {
        return Err(err(StatusCode::NOT_FOUND, "activity not found"));
    }
    let deleted = state.db.delete_activity_cascade(id).await.map_err(internal)?;
    // This activity's TSS is gone — refold CTL/ATL/TSB so the chart drops it.
    refold_training_load_after_delete(&state).await;
    Ok(Json(serde_json::json!({ "ok": true, "deleted_recordings": deleted.len() })))
}

/// `DELETE /api/activities/{id}/sources/{recording_id}` — **hard-delete** one
/// source (its recording + streams) from an activity.
///
/// If it was the activity's *last* source, the whole activity is deleted too
/// (`activity_deleted = true`). Otherwise the activity survives: its window is
/// re-tightened to the remaining members, it's re-resolved, and the fresh
/// detail is returned so the UI refreshes in place.
///
/// Guards (400): the recording is not a member of this activity.
#[utoipa::path(
    delete, path = "/api/activities/{id}/sources/{recording_id}",
    params(
        ("id" = uuid::Uuid, Path, description = "activity id"),
        ("recording_id" = uuid::Uuid, Path, description = "source recording to delete"),
    ),
    responses(
        (status = 200, body = DeleteSourceResponse),
        (status = 400, description = "recording is not a member of this activity"),
        (status = 404, description = "activity not found"),
    )
)]
pub async fn delete_source(
    State(state): State<AppState>,
    Path((id, recording_id)): Path<(uuid::Uuid, uuid::Uuid)>,
) -> Result<Json<DeleteSourceResponse>, ApiError> {
    let activity = state
        .db
        .get_activity(id)
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "activity not found"))?;
    if !activity.recording_ids.contains(&recording_id) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "recording is not a member of this activity",
        ));
    }

    // Last source → the activity goes with it (same as deleting the activity).
    if activity.recording_ids.len() <= 1 {
        state.db.delete_activity_cascade(id).await.map_err(internal)?;
        refold_training_load_after_delete(&state).await;
        return Ok(Json(DeleteSourceResponse {
            activity_deleted: true,
            activity: None,
        }));
    }

    // Otherwise hard-delete just this recording and re-tighten the activity.
    state.db.delete_recording(recording_id).await.map_err(internal)?;
    let remaining: Vec<uuid::Uuid> = activity
        .recording_ids
        .iter()
        .copied()
        .filter(|r| *r != recording_id)
        .collect();
    let mut updated = activity.clone();
    updated.recording_ids = remaining.clone();
    // A manual edit: pin it so re-clustering on a future import won't re-merge.
    updated.user_confirmed = true;
    // Recompute the window from the surviving members so it stays tight.
    let recs = state.db.get_recordings(&remaining).await.map_err(internal)?;
    if let Some(first) = recs.first() {
        let mut s = first.started_at;
        let mut e = first.ended_at;
        for r in &recs[1..] {
            s = s.min(r.started_at);
            e = e.max(r.ended_at);
        }
        updated.started_at = s;
        updated.ended_at = e;
    }
    // `upsert_activity` marks the activity + its day dirty for the worker.
    state.db.upsert_activity(&updated).await.map_err(internal)?;
    state
        .db
        .set_activity_recordings(id, &updated.recording_ids)
        .await
        .map_err(internal)?;
    state.recompute_notify.notify_one();

    let detail = build_activity_detail(&state, id).await?;
    Ok(Json(DeleteSourceResponse {
        activity_deleted: false,
        activity: Some(detail),
    }))
}

/// `GET /api/activities/{id}/export.fit` — export the activity as a `.fit` file.
///
/// Encodes the **resolved** per-metric streams (best source per metric, full
/// resolution) into a standards-compliant FIT activity, returned as an
/// attachment. Summary-only activities (no streams) yield a minimal file with
/// just the file/session/activity headers.
#[utoipa::path(
    get, path = "/api/activities/{id}/export.fit",
    params(("id" = uuid::Uuid, Path, description = "activity id")),
    responses(
        (status = 200, description = "FIT file", content_type = "application/octet-stream"),
        (status = 404, description = "activity not found"),
    )
)]
pub async fn export_activity_fit(
    State(state): State<AppState>,
    Path(id): Path<uuid::Uuid>,
) -> Result<Response, ApiError> {
    let bytes = build_activity_fit(&state, id).await?;
    let filename = format!("activity-{id}.fit");
    Response::builder()
        .header(axum::http::header::CONTENT_TYPE, "application/octet-stream")
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .body(axum::body::Body::from(bytes))
        .map_err(internal)
}

/// Build the FIT bytes for one activity from its resolved streams. Shared by the
/// export handler; kept separate so the byte-building stays testable/pure-ish.
async fn build_activity_fit(state: &AppState, id: uuid::Uuid) -> Result<Vec<u8>, ApiError> {
    let db = &state.db;
    let activity = db
        .get_activity(id)
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "activity not found"))?;

    let sources = db.list_sources().await.map_err(internal)?;
    let rec_source = db
        .recording_sources(&activity.recording_ids)
        .await
        .map_err(internal)?;
    // recording_id → start time, to place each sample on the absolute clock.
    let recs = db.get_recordings(&activity.recording_ids).await.map_err(internal)?;
    let start_by_rec: BTreeMap<uuid::Uuid, chrono::DateTime<chrono::Utc>> =
        recs.iter().map(|r| (r.id, r.started_at)).collect();

    let mut all_streams: Vec<Stream> = Vec::new();
    for &rid in &activity.recording_ids {
        all_streams.extend(db.streams_for_recording(rid).await.map_err(internal)?);
    }
    let prefs = db.preferences_for_activity(id).await.map_err(internal)?;
    let view = resolve_activity_view(&activity, &all_streams, &sources, &rec_source, &prefs);

    // Merge the resolved samples into one FIT record per absolute second.
    let activity_start_ms = activity.started_at.timestamp_millis();
    let mut by_sec: BTreeMap<i64, ofit_ingest::FitRecordPoint> = BTreeMap::new();
    for m in &view.metrics {
        let rec_start_ms = start_by_rec
            .get(&m.recording_id)
            .map(|d| d.timestamp_millis())
            .unwrap_or(activity_start_ms);
        for s in &m.stream.samples {
            let abs_ms = rec_start_ms + s.t_offset_ms();
            let sec = abs_ms.div_euclid(1000);
            let ts = chrono::DateTime::from_timestamp(sec, 0).unwrap_or(activity.started_at);
            let p = by_sec
                .entry(sec)
                .or_insert_with(|| ofit_ingest::FitRecordPoint::at(ts));
            match s {
                Sample::LatLng { lat, lng, .. } if m.kind == StreamKind::LatLng => {
                    p.lat = Some(*lat);
                    p.lng = Some(*lng);
                }
                Sample::Scalar { value, .. } => match m.kind {
                    StreamKind::HeartRate => p.heart_rate = Some(value.round().clamp(0.0, 254.0) as u8),
                    StreamKind::Cadence => p.cadence = Some(value.round().clamp(0.0, 254.0) as u8),
                    StreamKind::Power => p.power_w = Some(value.round().clamp(0.0, 65_534.0) as u16),
                    StreamKind::Speed => p.speed_mps = Some(*value),
                    StreamKind::Altitude => p.altitude_m = Some(*value),
                    StreamKind::Distance => p.distance_m = Some(*value),
                    StreamKind::Temperature => p.temperature_c = Some(*value),
                    _ => {}
                },
                _ => {}
            }
        }
    }
    let points: Vec<ofit_ingest::FitRecordPoint> = by_sec.into_values().collect();
    Ok(ofit_ingest::encode_activity_fit(activity.sport, activity.started_at, &points))
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

/// Body of `PUT /api/settings` — set one app-level key/value setting.
#[derive(Debug, serde::Deserialize, utoipa::ToSchema)]
pub struct SetSettingRequest {
    pub key: String,
    pub value: String,
}

/// `GET /api/settings` — all app settings as a `{ key: value }` map. These are
/// account/server-bound preferences (e.g. the daily step goal) shared across
/// every device, as opposed to per-device localStorage.
#[utoipa::path(get, path = "/api/settings", responses((status = 200)))]
pub async fn get_settings(
    State(state): State<AppState>,
) -> Result<Json<std::collections::BTreeMap<String, String>>, ApiError> {
    let pairs = state.db.list_settings().await.map_err(internal)?;
    Ok(Json(pairs.into_iter().collect()))
}

/// `PUT /api/settings` — upsert one setting; returns the full settings map.
#[utoipa::path(
    put, path = "/api/settings",
    request_body = SetSettingRequest,
    responses((status = 200))
)]
pub async fn set_setting(
    State(state): State<AppState>,
    Json(req): Json<SetSettingRequest>,
) -> Result<Json<std::collections::BTreeMap<String, String>>, ApiError> {
    state
        .db
        .set_setting(&req.key, &req.value, chrono::Utc::now())
        .await
        .map_err(internal)?;
    let pairs = state.db.list_settings().await.map_err(internal)?;
    Ok(Json(pairs.into_iter().collect()))
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

/// Windows `(sport, start, end)` of **real** (non summary-only) activities — a
/// Zepp summary overlapping one of these (same sport) is a duplicate of a real
/// recorded effort. An activity is "real" if it has ≥1 non-summary recording.
async fn real_activity_windows(
    db: &ofit_db::Db,
) -> Result<Vec<(ofit_core::Sport, chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>)>, ofit_db::DbError>
{
    let acts = db.list_activities().await?;
    let recs = db.list_recordings().await?;
    let summary_only: std::collections::HashSet<uuid::Uuid> = recs
        .iter()
        .filter(|r| r.metadata.get("summary_only").and_then(|v| v.as_bool()).unwrap_or(false))
        .map(|r| r.id)
        .collect();
    Ok(acts
        .into_iter()
        .filter(|a| a.recording_ids.iter().any(|rid| !summary_only.contains(rid)))
        .map(|a| (a.sport, a.started_at, a.ended_at))
        .collect())
}

/// Delete summary-only activities that duplicate a real streamed activity (same
/// sport, overlapping window). A summary-only activity is one whose every member
/// recording is `summary_only`. Idempotent: only the activity grouping is removed
/// (the `RawRecording`s are preserved), so re-running is a no-op. Returns count.
async fn cleanup_duplicate_summary_activities(db: &ofit_db::Db) -> Result<usize, ofit_db::DbError> {
    let acts = db.list_activities().await?;
    let recs = db.list_recordings().await?;
    let summary_only: std::collections::HashSet<uuid::Uuid> = recs
        .iter()
        .filter(|r| r.metadata.get("summary_only").and_then(|v| v.as_bool()).unwrap_or(false))
        .map(|r| r.id)
        .collect();
    let real: Vec<(ofit_core::Sport, chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>)> = acts
        .iter()
        .filter(|a| a.recording_ids.iter().any(|rid| !summary_only.contains(rid)))
        .map(|a| (a.sport, a.started_at, a.ended_at))
        .collect();
    let mut deleted = 0usize;
    for a in &acts {
        let is_summary_only =
            !a.recording_ids.is_empty() && a.recording_ids.iter().all(|rid| summary_only.contains(rid));
        if !is_summary_only {
            continue;
        }
        if real
            .iter()
            .any(|(sport, s, e)| *sport == a.sport && ofit_core::overlaps((a.started_at, a.ended_at), (*s, *e)))
        {
            db.delete_activity(a.id).await?;
            deleted += 1;
        }
    }
    Ok(deleted)
}

/// `POST /api/maintenance/dedup-zepp-summaries` — one-shot cleanup of summary
/// activities that duplicate a real streamed activity. Returns `{ deleted }`.
#[utoipa::path(post, path = "/api/maintenance/dedup-zepp-summaries", responses((status = 200, body = DedupResponse)))]
pub async fn dedup_zepp_summaries(
    State(state): State<AppState>,
) -> Result<Json<DedupResponse>, ApiError> {
    let deleted = cleanup_duplicate_summary_activities(&state.db).await.map_err(internal)?;
    Ok(Json(DedupResponse { deleted }))
}

/// `POST /api/maintenance/clamp-hr` — delete heart-rate wellness samples above
/// the "Max HR Allowed" setting (default 200), scrubbing device-artifact spikes
/// (e.g. a Garmin 255 bpm). Ingest already rejects new ones; this cleans history.
pub async fn clamp_hr(State(state): State<AppState>) -> Result<Json<serde_json::Value>, ApiError> {
    let max = state
        .db
        .get_setting("max_hr_allowed")
        .await
        .map_err(internal)?
        .and_then(|s| s.trim().parse::<f64>().ok())
        .unwrap_or(200.0);
    let deleted = state
        .db
        .delete_wellness_above(ofit_core::WellnessKind::HeartRate, max)
        .await
        .map_err(internal)?;
    Ok(Json(serde_json::json!({ "deleted": deleted, "max_hr": max })))
}

/// `POST /api/maintenance/remap-zepp-sports` — re-derive the sport of every
/// already-imported Zepp **summary** activity from its stored raw type code
/// (`metadata.zepp_type`) using the current mapping, fixing both the recording
/// and its activity in place. Idempotent. Returns `{ updated }`.
#[utoipa::path(post, path = "/api/maintenance/remap-zepp-sports", responses((status = 200, body = RemapResponse)))]
pub async fn remap_zepp_sports(State(state): State<AppState>) -> Result<Json<RemapResponse>, ApiError> {
    let recs = state.db.list_recordings().await.map_err(internal)?;
    let acts = state.db.list_activities().await.map_err(internal)?;

    // Correct sport per summary recording id, from its raw zepp_type.
    let mut correct_for: std::collections::HashMap<uuid::Uuid, ofit_core::Sport> = std::collections::HashMap::new();
    let mut updated = 0usize;
    for r in &recs {
        if !r.metadata.get("summary_only").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        let Some(zt) = r.metadata.get("zepp_type").and_then(|v| v.as_i64()) else {
            continue;
        };
        let correct = ofit_ingest::zepp::map_sport(zt);
        correct_for.insert(r.id, correct);
        if correct != r.sport {
            state.db.update_recording_sport(r.id, correct).await.map_err(internal)?;
            updated += 1;
        }
    }

    // Fix each summary-only activity's sport to match its (single) recording.
    for a in &acts {
        let derived = a
            .recording_ids
            .iter()
            .find_map(|rid| correct_for.get(rid).copied());
        let all_summary = !a.recording_ids.is_empty()
            && a.recording_ids.iter().all(|rid| correct_for.contains_key(rid));
        if let (true, Some(sport)) = (all_summary, derived) {
            if sport != a.sport {
                let mut fixed = a.clone();
                fixed.sport = sport;
                state.db.upsert_activity(&fixed).await.map_err(internal)?;
            }
        }
    }

    Ok(Json(RemapResponse { updated }))
}

/// `POST /api/import/zepp` — upload a **zipped** Zepp/Amazfit app export; extract
/// the continuous wellness (all-day HR, sleep staging, daily steps/calories,
/// weight) and ingest it, attributed to one Zepp source for the account. The
/// import is idempotent per source (re-uploading replaces, never duplicates).
#[utoipa::path(
    post, path = "/api/import/zepp",
    responses((status = 200, body = ZeppImportResponse))
)]
pub async fn import_zepp(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<ZeppImportResponse>, ApiError> {
    let mut data: Option<Vec<u8>> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| err(StatusCode::BAD_REQUEST, format!("multipart error: {e}")))?
    {
        if let Ok(b) = field.bytes().await {
            data = Some(b.to_vec());
            break;
        }
    }
    let bytes = data.ok_or_else(|| err(StatusCode::BAD_REQUEST, "no file uploaded".to_string()))?;

    // Unzip + parse off the async runtime (CPU-bound, ~0.8M rows).
    let imp = tokio::task::spawn_blocking(move || ofit_ingest::read_zepp_zip(&bytes))
        .await
        .map_err(internal)?
        .map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e.to_string()))?;

    let source_id = state
        .db
        .ensure_source(SourceKind::Device, &imp.source_name)
        .await
        .map_err(internal)?;
    state.db.delete_wellness_for_source(source_id).await.map_err(internal)?;

    let mut counts: std::collections::HashMap<ofit_core::WellnessKind, usize> = std::collections::HashMap::new();
    let samples: Vec<ofit_core::WellnessSample> = imp
        .readings
        .iter()
        .map(|r| {
            *counts.entry(r.kind).or_default() += 1;
            ofit_core::WellnessSample::scalar(source_id, r.kind, r.value, r.ts)
        })
        .collect();
    for chunk in samples.chunks(5_000) {
        state.db.insert_wellness_samples(chunk).await.map_err(internal)?;
    }

    let mut by_kind: Vec<WellnessKindCount> = counts
        .into_iter()
        .map(|(kind, count)| WellnessKindCount { kind, count })
        .collect();
    by_kind.sort_by(|a, b| b.count.cmp(&a.count));

    // Workout summaries (SPORT) → stream-less "summary activities": one recording
    // per workout whose totals live in metadata. Idempotent by a stable hash.
    // Real (non-summary) activity windows, loaded once: a summary overlapping a
    // real streamed activity of the same sport is a duplicate of the .fit import.
    let real_windows = real_activity_windows(&state.db).await.map_err(internal)?;
    let mut activities_imported = 0usize;
    let mut activities_skipped_dup = 0usize;
    for w in &imp.workouts {
        let hash = format!(
            "zepp-sport:{}:{}:{}",
            w.zepp_type,
            w.started_at.timestamp(),
            w.distance_m as i64
        );
        if state
            .db
            .recording_id_by_hash(&hash)
            .await
            .map_err(internal)?
            .is_some()
        {
            continue;
        }
        // Skip summaries that duplicate a real streamed activity (same sport,
        // overlapping window); keep genuinely-new summaries standalone.
        if real_windows
            .iter()
            .any(|(sport, s, e)| *sport == w.sport && ofit_core::overlaps((w.started_at, w.ended_at), (*s, *e)))
        {
            activities_skipped_dup += 1;
            continue;
        }
        let metadata = serde_json::json!({
            "source": "zepp-sport",
            "format": "zepp",
            "summary_only": true,
            "zepp_type": w.zepp_type,
            "distance_m": w.distance_m,
            "calories_kcal": w.calories_kcal,
            "avg_pace_s_per_m": w.avg_pace_s_per_m,
        });
        let rec = ofit_core::RawRecording {
            id: uuid::Uuid::new_v4(),
            source_id,
            content_hash: ofit_core::ContentHash(hash),
            sport: w.sport,
            started_at: w.started_at,
            ended_at: w.ended_at,
            metadata,
            ingested_at: chrono::Utc::now(),
        };
        state.db.insert_recording(&rec).await.map_err(internal)?;
        let activity = ofit_core::Activity::from_recording(&rec);
        state.db.upsert_activity(&activity).await.map_err(internal)?;
        state
            .db
            .set_activity_recordings(activity.id, &activity.recording_ids)
            .await
            .map_err(internal)?;
        activities_imported += 1;
    }

    // Self-heal: also remove any pre-existing summary activities that duplicate a
    // real activity (e.g. imported before this guard existed).
    let duplicate_summaries_removed =
        cleanup_duplicate_summary_activities(&state.db).await.map_err(internal)?;

    state.recompute_notify.notify_one();
    Ok(Json(ZeppImportResponse {
        source: imp.source_name,
        ingested: samples.len(),
        by_kind,
        activities_imported,
        activities_skipped_dup,
        duplicate_summaries_removed,
        skipped: imp.skipped,
    }))
}

/// `POST /api/wellness` — batch-ingest continuous wellness samples (the
/// streaming/relay write path). Persists them and fans each out live to the
/// `/api/wellness/live` subscribers.
#[utoipa::path(
    post, path = "/api/wellness",
    request_body = Vec<WellnessIngest>,
    responses((status = 200, body = WellnessIngestResponse))
)]
pub async fn ingest_wellness(
    State(state): State<AppState>,
    Json(items): Json<Vec<WellnessIngest>>,
) -> Result<Json<WellnessIngestResponse>, ApiError> {
    if items.is_empty() {
        return Ok(Json(WellnessIngestResponse { ingested: 0 }));
    }
    // Samples without an explicit source are attributed to a shared stream source.
    let default_source = state
        .db
        .ensure_source(SourceKind::Device, "Live stream")
        .await
        .map_err(internal)?;

    let mut samples = Vec::with_capacity(items.len());
    for it in items {
        let ts = it
            .ts
            .as_deref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&chrono::Utc))
            .unwrap_or_else(chrono::Utc::now);
        let source_id = it.source_id.unwrap_or(default_source);
        samples.push(WellnessSample::scalar(source_id, it.kind, it.value, ts));
    }
    state
        .db
        .insert_wellness_samples(&samples)
        .await
        .map_err(internal)?;
    // Wake the incremental-analytics worker (debounced; recomputes the affected day).
    state.recompute_notify.notify_one();

    // Fan out live (best-effort; no-op when there are no subscribers).
    for s in &samples {
        let _ = state.wellness_tx.send(LiveWellness {
            kind: s.kind,
            value: s.value,
            ts: s.ts,
            source_id: s.source_id,
        });
    }
    Ok(Json(WellnessIngestResponse {
        ingested: samples.len(),
    }))
}

/// `GET /api/wellness/live` — WebSocket pushing live wellness samples as JSON
/// text frames (the real-time fan-out of the ingest path to the dashboard).
pub async fn wellness_live(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    let rx = state.wellness_tx.subscribe();
    ws.on_upgrade(move |socket| live_socket(socket, rx))
}

async fn live_socket(
    mut socket: WebSocket,
    mut rx: tokio::sync::broadcast::Receiver<LiveWellness>,
) {
    loop {
        match rx.recv().await {
            Ok(msg) => {
                let txt = serde_json::to_string(&msg).unwrap_or_default();
                if socket.send(Message::Text(txt)).await.is_err() {
                    break; // client gone
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
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

// ---- gear (equipment mileage tracking) ----

/// `GET /api/gear` — full gear state for the UI store (gear + defaults + assignments).
pub async fn get_gear(State(state): State<AppState>) -> Result<Json<GearStateDto>, ApiError> {
    let gears = state.db.list_gear().await.map_err(internal)?;
    let defaults = state
        .db
        .list_gear_defaults()
        .await
        .map_err(internal)?
        .into_iter()
        .collect();
    let mut assignments: std::collections::BTreeMap<uuid::Uuid, Vec<uuid::Uuid>> =
        std::collections::BTreeMap::new();
    for (activity_id, gear_id) in state.db.list_activity_gear().await.map_err(internal)? {
        assignments.entry(activity_id).or_default().push(gear_id);
    }
    Ok(Json(GearStateDto {
        gears,
        defaults,
        assignments,
    }))
}

/// `POST /api/gear` — create a piece of gear. `used_km` starts at `initial_km`.
pub async fn create_gear(
    State(state): State<AppState>,
    Json(req): Json<CreateGearRequest>,
) -> Result<Json<ofit_core::Gear>, ApiError> {
    let gear = ofit_core::Gear {
        id: uuid::Uuid::new_v4(),
        name: req.name,
        description: req.description,
        sport: req.sport,
        initial_km: req.initial_km,
        retire_km: if req.retire_km > 0.0 { req.retire_km } else { 1000.0 },
        used_km: req.initial_km,
        icon: req.icon.unwrap_or_else(|| "run".to_string()),
        created_at: chrono::Utc::now(),
    };
    state.db.insert_gear(&gear).await.map_err(internal)?;
    Ok(Json(gear))
}

/// `PUT /api/gear/{id}` — patch editable fields; returns the updated gear.
pub async fn update_gear(
    State(state): State<AppState>,
    Path(id): Path<uuid::Uuid>,
    Json(req): Json<UpdateGearRequest>,
) -> Result<Json<ofit_core::Gear>, ApiError> {
    let cur = state
        .db
        .get_gear(id)
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "gear not found"))?;
    let name = req.name.unwrap_or(cur.name);
    let description = req.description.unwrap_or(cur.description);
    let sport = req.sport.unwrap_or(cur.sport);
    let retire_km = req.retire_km.unwrap_or(cur.retire_km);
    let used_km = req.used_km.unwrap_or(cur.used_km);
    let icon = req.icon.unwrap_or(cur.icon);
    state
        .db
        .update_gear(id, &name, &description, &sport, retire_km, used_km, &icon)
        .await
        .map_err(internal)?;
    let updated = state
        .db
        .get_gear(id)
        .await
        .map_err(internal)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "gear not found"))?;
    Ok(Json(updated))
}

/// `DELETE /api/gear/{id}` — remove a gear and its defaults/assignments.
pub async fn delete_gear(
    State(state): State<AppState>,
    Path(id): Path<uuid::Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state.db.remove_gear(id).await.map_err(internal)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// `PUT /api/gear/defaults` — set (or clear) the default gear for an activity type.
pub async fn set_gear_default(
    State(state): State<AppState>,
    Json(req): Json<SetGearDefaultRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state
        .db
        .set_gear_default(&req.sport, req.gear_id)
        .await
        .map_err(internal)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// `PUT /api/activities/{id}/gear` — replace the gear set assigned to an activity.
pub async fn set_activity_gear(
    State(state): State<AppState>,
    Path(id): Path<uuid::Uuid>,
    Json(req): Json<SetActivityGearRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    state
        .db
        .set_activity_gear(id, &req.gear_ids)
        .await
        .map_err(internal)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ---- Garmin one-time history import + personal records ----

/// Live status of the (single) one-time Garmin import job, polled by the UI.
///
/// The import takes minutes (parse ~4k FITs + ~1M wellness rows + one full
/// recompute), so it runs as a **background task**: the POST returns immediately
/// and the client polls `GET /api/import/garmin/status`. This sidesteps HTTP /
/// client timeouts entirely.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct GarminJobState {
    /// True while a job is running.
    pub running: bool,
    /// Has any job been started this session? (idle vs. done/error).
    pub started: bool,
    /// Human phase label, e.g. `"Importing activities (FIT)…"`.
    pub phase: String,
    /// Final summary when the last job succeeded.
    pub result: Option<GarminImportResponse>,
    /// Error message when the last job failed.
    pub error: Option<String>,
}

/// Where a Garmin import reads from.
enum GarminSource {
    /// An export directory already on the server's disk.
    Path(std::path::PathBuf),
    /// An uploaded export `.zip` (a temp file we extract then delete).
    Zip(std::path::PathBuf),
}

fn garmin_status(state: &AppState) -> GarminJobState {
    state.garmin_import.lock().map(|g| g.clone()).unwrap_or_default()
}

fn garmin_set(state: &AppState, f: impl FnOnce(&mut GarminJobState)) {
    if let Ok(mut g) = state.garmin_import.lock() {
        f(&mut g);
    }
}

/// Mark a job running and spawn it. Refuses a second concurrent job (409).
fn start_garmin_job(state: AppState, source: GarminSource) -> Result<GarminJobState, ApiError> {
    {
        let mut g = state
            .garmin_import
            .lock()
            .map_err(|_| internal("import-status lock poisoned"))?;
        if g.running {
            return Err(err(StatusCode::CONFLICT, "a Garmin import is already running"));
        }
        *g = GarminJobState {
            running: true,
            started: true,
            phase: "Starting…".to_string(),
            result: None,
            error: None,
        };
    }
    let st = state.clone();
    tokio::spawn(async move {
        let outcome = run_garmin_job(&st, source).await;
        garmin_set(&st, |g| {
            g.running = false;
            match outcome {
                Ok(resp) => {
                    g.phase = "Done".to_string();
                    g.result = Some(resp);
                    g.error = None;
                }
                Err(e) => {
                    g.phase = "Error".to_string();
                    g.error = Some(e);
                }
            }
        });
    });
    Ok(garmin_status(&state))
}

/// Resolve the source to an export root (extracting an uploaded zip), run the
/// import, and clean up any temp files.
async fn run_garmin_job(state: &AppState, source: GarminSource) -> Result<GarminImportResponse, String> {
    match source {
        GarminSource::Path(root) => do_garmin_import(state, &root).await,
        GarminSource::Zip(zip_path) => {
            garmin_set(state, |g| g.phase = "Unzipping export…".to_string());
            let dest = std::env::temp_dir().join(format!("ofit-garmin-{}", uuid::Uuid::new_v4()));
            let (zp, dp) = (zip_path.clone(), dest.clone());
            let root = tokio::task::spawn_blocking(move || ofit_ingest::unzip_garmin_export(&zp, &dp))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string());
            let res = match root {
                Ok(root) => do_garmin_import(state, &root).await,
                Err(e) => Err(e),
            };
            let _ = std::fs::remove_dir_all(&dest);
            let _ = std::fs::remove_file(&zip_path);
            res
        }
    }
}

/// The actual import (shared by path + zip sources). Updates the job phase as it
/// goes. Imports the JSON wellness / body / performance series, gear (mileage
/// joined from activity distances), personal records, and the activity `.fit`
/// firehose, then runs ONE full recompute — a 6-year backfill would otherwise
/// mark thousands of days dirty and thrash the incremental worker.
///
/// Idempotent per source: wellness + personal records are replace-on-reimport,
/// FIT activities exact-dedup by content hash, gear updates-or-inserts by name.
async fn do_garmin_import(state: &AppState, root: &std::path::Path) -> Result<GarminImportResponse, String> {
    if !root.join("DI_CONNECT").is_dir() {
        return Err(format!("not a Garmin export (no DI_CONNECT dir under {root:?})"));
    }

    garmin_set(state, |g| g.phase = "Parsing export…".to_string());
    let root_for_parse = root.to_path_buf();
    let imp = tokio::task::spawn_blocking(move || ofit_ingest::read_garmin_export(&root_for_parse))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    // Attribute all wellness to one Garmin source (idempotent: replace).
    let source_id = state
        .db
        .ensure_source(SourceKind::Device, &imp.source_name)
        .await
        .map_err(|e| e.to_string())?;
    state.db.delete_wellness_for_source(source_id).await.map_err(|e| e.to_string())?;

    let mut counts: std::collections::HashMap<ofit_core::WellnessKind, usize> =
        std::collections::HashMap::new();
    let samples: Vec<WellnessSample> = imp
        .readings
        .iter()
        .map(|r| {
            *counts.entry(r.kind).or_default() += 1;
            WellnessSample::scalar(source_id, r.kind, r.value, r.ts)
        })
        .collect();
    let wellness_ingested = samples.len();
    garmin_set(state, |g| g.phase = format!("Importing {wellness_ingested} wellness readings…"));
    // Backfill insert: applies the max-HR filter but does NOT mark days dirty.
    for chunk in samples.chunks(5_000) {
        state.db.insert_wellness_backfill(chunk).await.map_err(|e| e.to_string())?;
    }
    let mut by_kind: Vec<WellnessKindCount> = counts
        .into_iter()
        .map(|(kind, count)| WellnessKindCount { kind, count })
        .collect();
    by_kind.sort_by(|a, b| b.count.cmp(&a.count));

    // Gear → the existing Gear entity. Update mileage on an existing name,
    // else insert — so a re-import refreshes rather than duplicates.
    garmin_set(state, |g| g.phase = "Importing gear & personal records…".to_string());
    let existing_gear: std::collections::HashMap<String, ofit_core::Gear> = state
        .db
        .list_gear()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|g| (g.name.clone(), g))
        .collect();
    let mut gear_imported = 0usize;
    for g in &imp.gear {
        if let Some(cur) = existing_gear.get(&g.name) {
            state
                .db
                .update_gear(cur.id, &g.name, &g.description, &g.sport, g.retire_km, g.used_km, &g.icon)
                .await
                .map_err(|e| e.to_string())?;
        } else {
            let gear = ofit_core::Gear {
                id: uuid::Uuid::new_v4(),
                name: g.name.clone(),
                description: g.description.clone(),
                sport: g.sport.clone(),
                initial_km: g.used_km,
                retire_km: g.retire_km,
                used_km: g.used_km,
                icon: g.icon.clone(),
                created_at: g.created_at,
            };
            state.db.insert_gear(&gear).await.map_err(|e| e.to_string())?;
            gear_imported += 1;
        }
    }

    // Personal records (replace the Garmin set — idempotent).
    state
        .db
        .delete_personal_records_for_source("Garmin")
        .await
        .map_err(|e| e.to_string())?;
    for pr in &imp.personal_records {
        let rec = ofit_core::PersonalRecord {
            id: uuid::Uuid::new_v4(),
            record_type: pr.record_type.clone(),
            value: pr.value,
            unit: pr.unit.clone(),
            occurred_at: pr.occurred_at,
            source: "Garmin".to_string(),
            current: pr.current,
        };
        state.db.insert_personal_record(&rec).await.map_err(|e| e.to_string())?;
    }
    let personal_records = imp.personal_records.len();

    // The activity `.fit` firehose (the heavy part) → silent activities, one
    // reclustering at the end. Exact-dedup by content hash makes it idempotent.
    garmin_set(state, |g| g.phase = "Importing activities (FIT)…".to_string());
    let fit = ofit_ingest::import_garmin_fit_dir(&state.db, root)
        .await
        .map_err(|e| e.to_string())?;

    // ONE full recompute over everything (distance/calories caches, training
    // load, readiness, sleep, body battery, …), then drop any dirty units the
    // inserts queued — the recompute already covered them.
    garmin_set(state, |g| g.phase = "Recomputing analytics…".to_string());
    let summary = crate::analytics::run_full_recompute(state)
        .await
        .map_err(|(code, body)| format!("recompute failed ({code}): {}", body.0))?;
    let _ = state.db.clear_all_dirty().await;

    let activities_total = state.db.count_activities().await.map_err(|e| e.to_string())? as usize;

    Ok(GarminImportResponse {
        source: imp.source_name,
        wellness_ingested,
        by_kind,
        days: imp.days,
        nights: imp.nights,
        gear_imported,
        personal_records,
        fit_activities_imported: fit.imported,
        fit_duplicates: fit.duplicates,
        fit_skipped_non_activity: fit.skipped_non_activity,
        fit_parse_errors: fit.parse_errors,
        activities_total,
        recompute_activities: summary.activities,
        recompute_wellness_points: summary.wellness_points,
        skipped: imp.skipped,
    })
}

/// `POST /api/import/garmin` — start a one-time backfill from a Garmin export
/// **directory already on the server's disk** (`{"path": "…"}`). Returns
/// immediately (202); poll `GET /api/import/garmin/status`.
pub async fn import_garmin(
    State(state): State<AppState>,
    Json(req): Json<GarminImportRequest>,
) -> Result<(StatusCode, Json<GarminJobState>), ApiError> {
    let root = std::path::PathBuf::from(&req.path);
    if !root.join("DI_CONNECT").is_dir() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            format!("not a Garmin export (no DI_CONNECT dir under {:?})", req.path),
        ));
    }
    let status = start_garmin_job(state, GarminSource::Path(root))?;
    Ok((StatusCode::ACCEPTED, Json(status)))
}

/// `POST /api/import/garmin/upload` — start a backfill from an **uploaded export
/// `.zip`** (multipart). The zip is streamed to a temp file, extracted, imported,
/// then deleted. Returns immediately (202); poll the status endpoint.
pub async fn import_garmin_upload(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<GarminJobState>), ApiError> {
    let tmp = std::env::temp_dir().join(format!("ofit-garmin-upload-{}.zip", uuid::Uuid::new_v4()));
    let mut wrote = false;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| err(StatusCode::BAD_REQUEST, format!("multipart error: {e}")))?
    {
        if let Ok(bytes) = field.bytes().await {
            std::fs::write(&tmp, &bytes).map_err(internal)?;
            wrote = true;
            break;
        }
    }
    if !wrote {
        return Err(err(StatusCode::BAD_REQUEST, "no file uploaded".to_string()));
    }
    let status = start_garmin_job(state, GarminSource::Zip(tmp))?;
    Ok((StatusCode::ACCEPTED, Json(status)))
}

/// `GET /api/import/garmin/status` — current background-import status.
pub async fn garmin_import_status(State(state): State<AppState>) -> Json<GarminJobState> {
    Json(garmin_status(&state))
}

/// `GET /api/personal-records` — all imported personal records, newest first.
pub async fn personal_records(
    State(state): State<AppState>,
) -> Result<Json<Vec<ofit_core::PersonalRecord>>, ApiError> {
    let prs = state.db.list_personal_records().await.map_err(internal)?;
    Ok(Json(prs))
}
