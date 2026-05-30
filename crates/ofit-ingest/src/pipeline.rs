//! Import orchestration: parse → exact-dedup → persist → cluster.
//!
//! [`import_path`] is the single entry the API/CLI calls to bring a file into
//! the store. It ties together this crate (parsing) and [`ofit_db`]
//! (persistence + clustering reconciliation), implementing the three dedup
//! layers from PLAN.md:
//!
//! 1. **Exact dedup** — SHA-256 [`content_hash`](ofit_core::RawRecording) is the
//!    unique key; an identical file already present is a no-op
//!    ([`ImportOutcome::Duplicate`]).
//! 2. **Logical dedup (clustering)** — after persisting the recording we re-run
//!    [`ofit_core::cluster_recordings`] over **all** recordings and reconcile the
//!    activities/membership so the new recording joins a new or existing
//!    [`Activity`](ofit_core::Activity).
//! 3. **Per-metric resolution** — handled at read time by
//!    [`ofit_core::resolve_activity_view`] (not here).
//!
//! ## Source strategy (documented choice)
//! We create **one [`Source`] per detected device**: the device label from the
//! parser metadata (`metadata.device`) identifies the instance (e.g. a Garmin
//! Forerunner 945). All three file formats of the *same* effort report the same
//! device, so they attribute to one source — which is what lets per-metric
//! resolution pick between truly different devices later. When a file carries no
//! device label we fall back to a per-format source (`"File import (fit)"`,
//! kind [`SourceKind::FileImport`]) so attribution is still stable and
//! reproducible. Sources are matched by `(kind, name)` and reused, never
//! duplicated.

use std::path::Path;

use ofit_core::{cluster_recordings, Activity, RawRecording, Source, SourceKind};
use ofit_db::Db;
use uuid::Uuid;

use crate::{import_bytes, import_file, ParsedRecording, Error as IngestError};

/// What happened when importing a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportOutcome {
    /// A new recording was stored and assigned to an activity.
    Imported {
        /// The persisted recording's id.
        recording_id: Uuid,
        /// The source it was attributed to.
        source_id: Uuid,
        /// The activity it was clustered into.
        activity_id: Uuid,
        /// Number of streams stored.
        stream_count: usize,
    },
    /// The exact bytes were already present (content-hash match) — no-op.
    Duplicate {
        /// The existing recording id with this content hash.
        recording_id: Uuid,
    },
}

/// Errors from the import pipeline (parsing + persistence).
#[derive(Debug, thiserror::Error)]
pub enum PipelineError {
    /// A parsing/ingest error.
    #[error(transparent)]
    Ingest(#[from] IngestError),
    /// A database error.
    #[error(transparent)]
    Db(#[from] ofit_db::DbError),
}

/// Import a file at `path` into the store `db`.
///
/// See the module docs for the dedup layers and source strategy.
pub async fn import_path(db: &Db, path: &Path) -> Result<ImportOutcome, PipelineError> {
    let parsed = import_file(path)?;
    persist_parsed(db, parsed).await
}

/// Import already-read bytes (e.g. a multipart upload part) into the store.
///
/// Same dedup/cluster pipeline as [`import_path`]; `name` is used for format
/// detection and recorded in metadata. This is the entry the API's
/// `POST /api/import` multipart handler calls.
pub async fn import_bytes_path(
    db: &Db,
    name: &str,
    bytes: &[u8],
) -> Result<ImportOutcome, PipelineError> {
    let parsed = import_bytes(name, bytes)?;
    persist_parsed(db, parsed).await
}

/// Shared orchestration for both file- and bytes-sourced imports.
async fn persist_parsed(db: &Db, parsed: ParsedRecording) -> Result<ImportOutcome, PipelineError> {
    let hash = parsed.recording.content_hash.as_str().to_string();

    // (1) Exact dedup: identical bytes ingest once.
    if let Some(existing) = db.recording_id_by_hash(&hash).await? {
        return Ok(ImportOutcome::Duplicate {
            recording_id: existing,
        });
    }

    // Create/reuse the real Source and stamp it on the recording (replacing the
    // ingest crate's PLACEHOLDER_SOURCE_ID).
    let source = ensure_source(db, &parsed.recording).await?;
    let mut recording = parsed.recording.clone();
    recording.source_id = source.id;

    // Persist recording + its streams (streams already carry recording.id).
    db.insert_recording(&recording).await?;
    db.insert_streams(&parsed.streams).await?;

    // (2) Re-cluster over all recordings and reconcile activities.
    let activity_id = recluster_and_persist(db, recording.id).await?;

    Ok(ImportOutcome::Imported {
        recording_id: recording.id,
        source_id: source.id,
        activity_id,
        stream_count: parsed.streams.len(),
    })
}

/// Create or reuse the [`Source`] for a parsed recording per the documented
/// strategy (device label → one source per device; else per-format file-import).
async fn ensure_source(db: &Db, rec: &RawRecording) -> Result<Source, ofit_db::DbError> {
    let device = rec
        .metadata
        .get("device")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let format = rec
        .metadata
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or("file");

    let (kind, name, priority) = match device {
        Some(dev) => (SourceKind::Device, dev.to_string(), 50),
        None => (SourceKind::FileImport, format!("File import ({format})"), 0),
    };

    if let Some(existing) = db.find_source_by_identity(kind, &name).await? {
        return Ok(existing);
    }
    let source = Source::new(kind, name, priority);
    db.insert_source(&source).await?;
    Ok(source)
}

/// Re-run clustering across all stored recordings and persist the resulting
/// activities + membership, returning the activity id that now contains
/// `target_recording`.
///
/// Reconciliation keeps the existing activity id when a recluster cluster maps
/// onto an already-persisted activity (so external references stay stable),
/// and only inserts a new activity for genuinely new clusters. Membership is
/// rewritten to match the recluster result.
async fn recluster_and_persist(db: &Db, target_recording: Uuid) -> Result<Uuid, ofit_db::DbError> {
    let recordings = db.list_recordings().await?;
    let clusters = cluster_recordings(&recordings);

    // Existing activities (id + their current members) to reconcile against.
    let existing = db.list_activities().await?;

    let mut target_activity: Option<Uuid> = None;
    for cluster in &clusters {
        // Reuse an existing activity id if any of this cluster's recordings is
        // already a member of it (single-linkage means at most one matches).
        let reuse_id = existing
            .iter()
            .find(|a| {
                a.recording_ids
                    .iter()
                    .any(|rid| cluster.recording_ids.contains(rid))
            })
            .map(|a| a.id);

        let activity = match reuse_id {
            Some(id) => Activity {
                id,
                ..cluster.clone()
            },
            None => cluster.clone(),
        };

        db.upsert_activity(&activity).await?;
        db.set_activity_recordings(activity.id, &activity.recording_ids)
            .await?;

        if activity.recording_ids.contains(&target_recording) {
            target_activity = Some(activity.id);
        }
    }

    Ok(target_activity.expect("target recording must land in some cluster"))
}
