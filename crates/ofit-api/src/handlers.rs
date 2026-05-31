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
    let mut summary: Option<ActivitySummaryStats> = None;
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

/// `POST /api/import/gadgetbridge` — upload an exported Gadgetbridge SQLite DB;
/// extract continuous wellness (HR / steps / stress + a derived daily resting HR)
/// and ingest it, attributed to a Gadgetbridge source named after the device.
#[utoipa::path(
    post, path = "/api/import/gadgetbridge",
    responses((status = 200, body = GadgetbridgeImportResponse))
)]
pub async fn import_gadgetbridge(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<GadgetbridgeImportResponse>, ApiError> {
    // Read the first uploaded file part.
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

    // SQLite must read from a file; stage the upload in a temp file.
    let tmp = std::env::temp_dir().join(format!("ofit-gb-{}.db", uuid::Uuid::new_v4()));
    tokio::fs::write(&tmp, &bytes).await.map_err(internal)?;
    let parsed = ofit_ingest::read_gadgetbridge_db(&tmp).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    let imp = parsed.map_err(|e| err(StatusCode::UNPROCESSABLE_ENTITY, e.to_string()))?;

    let mut results: Vec<GadgetbridgeDeviceResult> = Vec::new();
    let mut total = 0usize;

    // One source per device (Helio, 945, …); each import is idempotent per source.
    for dev in &imp.devices {
        let source_id = state
            .db
            .ensure_source(SourceKind::Gadgetbridge, &dev.name)
            .await
            .map_err(internal)?;
        state.db.delete_wellness_for_source(source_id).await.map_err(internal)?;

        let mut counts: std::collections::HashMap<ofit_core::WellnessKind, usize> = std::collections::HashMap::new();
        let samples: Vec<ofit_core::WellnessSample> = dev
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

        total += samples.len();
        results.push(GadgetbridgeDeviceResult {
            device: dev.name.clone(),
            manufacturer: dev.manufacturer.clone(),
            ingested: samples.len(),
            by_kind,
        });
    }

    Ok(Json(GadgetbridgeImportResponse { devices: results, ingested: total }))
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
        .ensure_source(SourceKind::Gadgetbridge, &imp.source_name)
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
    let mut activities_imported = 0usize;
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

    Ok(Json(ZeppImportResponse {
        source: imp.source_name,
        ingested: samples.len(),
        by_kind,
        activities_imported,
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
        .ensure_source(SourceKind::Gadgetbridge, "Live stream")
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
