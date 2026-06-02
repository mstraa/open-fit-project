//! Background incremental-analytics worker.
//!
//! Instead of a full O(all-data) recompute on every push, raw ingest marks the
//! touched day/activity dirty (see `ofit-db`'s `dirty_units`), and this worker —
//! woken (debounced) after a write — recomputes ONLY those units and clears them
//! as it goes. Progress is published over a broadcast channel so the UI can show
//! a live "computing…" indicator. The manual `POST /api/analytics/recompute`
//! stays as the full-rebuild escape hatch.

use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
};
use serde::Serialize;
use tokio::sync::broadcast;

use crate::analytics;
use crate::AppState;

/// Snapshot of the worker's state, pushed over `/api/analytics/status` (WS).
#[derive(Debug, Clone, Serialize)]
pub struct AnalyticsStatus {
    /// True while the worker is actively recomputing.
    pub working: bool,
    /// Units still queued (dirty) at this moment.
    pub queued: usize,
    /// Human labels of what's being computed (e.g. `"3 activities"`).
    pub current: Vec<String>,
}

/// Coalesce a burst of streamed samples into a single pass before recomputing.
const DEBOUNCE: Duration = Duration::from_secs(3);

/// Spawn the worker. Drains any pending dirty units on startup (crash recovery),
/// then wakes on `recompute_notify` (debounced) after each ingest.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        if let Err(e) = run_once(&state).await {
            tracing::error!(error = %e, "analytics worker startup drain failed");
        }
        loop {
            state.recompute_notify.notified().await;
            tokio::time::sleep(DEBOUNCE).await;
            if let Err(e) = run_once(&state).await {
                tracing::error!(error = %e, "analytics worker pass failed");
            }
        }
    });
}

fn emit(state: &AppState, status: AnalyticsStatus) {
    let _ = state.analytics_status_tx.send(status);
}

/// One worker pass: process the current dirty set, clearing each unit as done.
async fn run_once(state: &AppState) -> anyhow::Result<()> {
    let dirty = state.db.list_dirty().await?;
    if dirty.is_empty() {
        return Ok(());
    }
    let activities: Vec<uuid::Uuid> = dirty
        .iter()
        .filter(|(k, _)| k == "activity")
        .filter_map(|(_, id)| uuid::Uuid::parse_str(id).ok())
        .collect();
    let days: Vec<String> = dirty
        .iter()
        .filter(|(k, _)| k == "day")
        .map(|(_, d)| d.clone())
        .collect();

    let mut current = Vec::new();
    if !activities.is_empty() {
        current.push(format!(
            "{} activit{}",
            activities.len(),
            if activities.len() == 1 { "y" } else { "ies" }
        ));
    }
    if !days.is_empty() {
        current.push(format!("{} day{}", days.len(), if days.len() == 1 { "" } else { "s" }));
    }
    emit(
        state,
        AnalyticsStatus { working: true, queued: dirty.len(), current },
    );

    // Per-activity: exact incremental (training_effect / tss / exercise_load
    // depend only on the activity's own streams).
    if !activities.is_empty() {
        let n = analytics::incremental_activities(state, &activities).await?;
        for id in &activities {
            state.db.clear_dirty("activity", &id.to_string()).await?;
        }
        // Cheap EWMA re-fold from the now-current persisted TSS so the
        // training-load chart reflects the new activity.
        analytics::recompute_training_load_streams(state).await?;
        tracing::info!(activities = n, "incremental recompute: activities + training-load");
    }

    // Dirty DAYS (sleep / readiness / resting-HR / body-battery) — windowed,
    // per-unit-independent incremental recompute.
    if !days.is_empty() {
        let n = analytics::incremental_days(state, &days).await?;
        for d in &days {
            state.db.clear_dirty("day", d).await?;
        }
        tracing::info!(days = n, "incremental recompute: days");
    }

    let remaining = state.db.count_dirty().await.unwrap_or(0) as usize;
    emit(
        state,
        AnalyticsStatus { working: false, queued: remaining, current: Vec::new() },
    );
    Ok(())
}

/// `GET /api/analytics/status` — WebSocket streaming `AnalyticsStatus` frames.
pub async fn status_ws(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    let rx = state.analytics_status_tx.subscribe();
    ws.on_upgrade(move |socket| status_socket(socket, rx))
}

async fn status_socket(mut socket: WebSocket, mut rx: broadcast::Receiver<AnalyticsStatus>) {
    loop {
        match rx.recv().await {
            Ok(msg) => {
                let txt = serde_json::to_string(&msg).unwrap_or_default();
                if socket.send(Message::Text(txt)).await.is_err() {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}
