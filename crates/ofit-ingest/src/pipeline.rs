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

use std::collections::{BTreeSet, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};

use ofit_core::{cluster_recordings_respecting, Activity, RawRecording, Source, SourceKind};
use ofit_db::Db;
use uuid::Uuid;

use crate::{import_bytes, import_file, ParsedRecording, Error as IngestError};

/// Garmin's `.fit` firehose mixes real workouts with daily-wellness / sleep /
/// metrics / stub blobs. Activities are ~all ≥ 21 KB and files < 15 KB are never
/// activities (validated against the export) — so we skip sub-15 KB entries
/// before the (relatively costly) FIT parse, then keep only `file_id.type`
/// `activity` records.
const MIN_ACTIVITY_FIT_BYTES: u64 = 15_000;

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
    // The parser's `session`-window fallback lets a record-less workout (no HR,
    // no GPS) still parse instead of erroring as empty. Guard the unfiltered
    // per-file import path so that only rescues a *genuine* activity through:
    // a record-less recording is kept only when its `file_id.type` says activity
    // (the workout recorder writes exactly that). Recordings WITH streams are
    // unaffected — this mirrors the batch path's `is_activity_recording` filter.
    if parsed.streams.is_empty() && !is_activity_recording(&parsed) {
        let name = parsed
            .recording
            .metadata
            .get("filename")
            .and_then(|v| v.as_str())
            .unwrap_or("recording")
            .to_string();
        return Err(PipelineError::Ingest(crate::Error::NotActivity { name }));
    }

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
    let mut source = Source::new(kind, name, priority);
    // Carry the parser-derived manufacturer (Garmin / Stryd / Z…) when present.
    source.manufacturer = rec
        .metadata
        .get("manufacturer")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
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

    // Existing activities (id + their current members) to reconcile against.
    let existing = db.list_activities().await?;

    // User-confirmed groupings are LOCKED: a manual merge/split must survive
    // re-imports. We pass them to the clustering as fixed sets so their
    // recordings are never re-merged (and new recordings never join them).
    let locked: Vec<Activity> = existing
        .iter()
        .filter(|a| a.user_confirmed)
        .cloned()
        .collect();
    let clusters = cluster_recordings_respecting(&recordings, &locked);

    // Existing membership by activity id, as sets, so we can tell which clusters
    // are genuinely new/changed. Re-upserting an *unchanged* activity would mark
    // it dirty for the analytics worker — and since a recluster re-emits EVERY
    // activity, that would dirty the whole history (e.g. all ~1800 activities) on
    // every single import and trigger a full recompute. Persist (and dirty-mark)
    // only the activities whose membership actually changed.
    let existing_members: HashMap<Uuid, BTreeSet<Uuid>> = existing
        .iter()
        .map(|a| (a.id, a.recording_ids.iter().copied().collect()))
        .collect();

    let mut target_activity: Option<Uuid> = None;
    for cluster in &clusters {
        // Resolve the activity id. Locked (user-confirmed) clusters carry their
        // real id verbatim. For the rest, reuse an existing activity's id when one
        // of this cluster's recordings is already a member (single-linkage → at
        // most one matches); locked activities are never reused so their ids stay
        // stable.
        let activity = if cluster.user_confirmed {
            cluster.clone()
        } else {
            let reuse_id = existing
                .iter()
                .filter(|a| !a.user_confirmed)
                .find(|a| {
                    a.recording_ids
                        .iter()
                        .any(|rid| cluster.recording_ids.contains(rid))
                })
                .map(|a| a.id);
            match reuse_id {
                Some(id) => Activity { id, ..cluster.clone() },
                None => cluster.clone(),
            }
        };

        if activity.recording_ids.contains(&target_recording) {
            target_activity = Some(activity.id);
        }

        // Unchanged membership → nothing about this activity changed (its sport
        // and time window derive from its members), so skip the write entirely.
        // No re-persist, no dirty mark. This keeps one import to ~one dirty unit.
        let members: BTreeSet<Uuid> = activity.recording_ids.iter().copied().collect();
        if existing_members.get(&activity.id) == Some(&members) {
            continue;
        }

        db.upsert_activity(&activity).await?;
        db.set_activity_recordings(activity.id, &activity.recording_ids)
            .await?;
    }

    Ok(target_activity.expect("target recording must land in some cluster"))
}

/// Outcome of a one-time Garmin FIT-firehose import.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GarminFitStats {
    /// New activity recordings inserted.
    pub imported: usize,
    /// Recordings already present (content-hash match) — skipped.
    pub duplicates: usize,
    /// `.fit` entries that parsed but were not `file_id.type == activity`.
    pub skipped_non_activity: usize,
    /// `.fit` entries we couldn't parse (corrupt / unsupported) — skipped.
    pub parse_errors: usize,
    /// `.fit` entries skipped by the cheap size pre-filter (< 15 KB).
    pub skipped_small: usize,
    /// Activities after the single end-of-batch reclustering.
    pub activities: usize,
}

/// Import the activity `.fit` files from a Garmin GDPR export's
/// `DI-Connect-Uploaded-Files/UploadedFiles_*.zip` firehose.
///
/// This is the batch counterpart to [`import_bytes_path`]: it parses + exact-
/// dedups + inserts **all** activities first, then reclusters **once** at the
/// end (instead of the per-file O(N²) recluster), and upserts activities
/// **silently** (no per-activity dirty marking — a one-time backfill runs a
/// single full recompute afterwards). Non-activity blobs (monitoring / sleep /
/// metrics / stubs) are filtered out by size + `file_id.type`.
pub async fn import_garmin_fit_dir(
    db: &Db,
    export_root: &Path,
) -> Result<GarminFitStats, PipelineError> {
    let zip_dir = export_root
        .join("DI_CONNECT")
        .join("DI-Connect-Uploaded-Files");
    let mut zips: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&zip_dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("zip")
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.contains("UploadedFiles"))
                    .unwrap_or(false)
            {
                zips.push(p);
            }
        }
    }
    zips.sort();

    let mut stats = GarminFitStats::default();
    for zip_path in zips {
        // Parse one zip's activity FITs off the async runtime (CPU-bound), which
        // also bounds peak memory to a single archive's worth of streams.
        let batch = tokio::task::spawn_blocking(move || parse_activity_fits_in_zip(&zip_path))
            .await
            .map_err(|e| PipelineError::Db(ofit_db::DbError::Config(format!("join: {e}"))))?;
        stats.skipped_small += batch.skipped_small;
        stats.skipped_non_activity += batch.skipped_non_activity;
        stats.parse_errors += batch.parse_errors;
        // `into_iter` drops each parsed recording (freeing its streams) as we go.
        for parsed in batch.activities {
            let hash = parsed.recording.content_hash.as_str().to_string();
            if db.recording_id_by_hash(&hash).await?.is_some() {
                stats.duplicates += 1;
                continue;
            }
            let source = ensure_source(db, &parsed.recording).await?;
            let mut recording = parsed.recording;
            recording.source_id = source.id;
            db.insert_recording(&recording).await?;
            db.insert_streams(&parsed.streams).await?;
            stats.imported += 1;
        }
    }

    // One reclustering over the full set (silent — no dirty marking).
    stats.activities = recluster_all_silent(db).await?;
    Ok(stats)
}

/// Per-zip parse result (synchronous; produced inside `spawn_blocking`).
struct ZipBatch {
    activities: Vec<ParsedRecording>,
    skipped_small: usize,
    skipped_non_activity: usize,
    parse_errors: usize,
}

/// Parse the activity `.fit` entries out of one `UploadedFiles_*.zip`.
fn parse_activity_fits_in_zip(zip_path: &Path) -> ZipBatch {
    let mut batch = ZipBatch {
        activities: Vec::new(),
        skipped_small: 0,
        skipped_non_activity: 0,
        parse_errors: 0,
    };
    let Ok(file) = std::fs::File::open(zip_path) else {
        return batch;
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return batch;
    };
    for idx in 0..archive.len() {
        let Ok(mut entry) = archive.by_index(idx) else {
            batch.parse_errors += 1;
            continue;
        };
        if !entry.is_file() {
            continue;
        }
        // Cheap size pre-filter before parsing.
        if entry.size() < MIN_ACTIVITY_FIT_BYTES {
            batch.skipped_small += 1;
            continue;
        }
        let name = entry.name().to_string();
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        if entry.read_to_end(&mut bytes).is_err() {
            batch.parse_errors += 1;
            continue;
        }
        match import_bytes(&name, &bytes) {
            Ok(parsed) => {
                if is_activity_recording(&parsed) {
                    batch.activities.push(parsed);
                } else {
                    batch.skipped_non_activity += 1;
                }
            }
            // Non-activity FITs (monitoring/sleep/metrics) carry no `Record`
            // messages → no timestamped samples → an `Empty` parse error here,
            // which is exactly the signal to skip them.
            Err(_) => batch.skipped_non_activity += 1,
        }
    }
    batch
}

/// Whether a parsed FIT is a real activity: its `file_id.type` says so, or (when
/// the type field didn't decode) it parsed with streams — non-activities never do.
fn is_activity_recording(parsed: &ParsedRecording) -> bool {
    match parsed
        .recording
        .metadata
        .get("file_type")
        .and_then(|v| v.as_str())
    {
        Some(ft) => {
            let ft = ft.to_ascii_lowercase();
            ft.contains("activity") || ft == "4"
        }
        // Type didn't decode: treat it as an activity only if it carried samples
        // (a record-less recording with no `file_id.type` is not a known activity).
        None => !parsed.streams.is_empty(),
    }
}

/// Recluster ALL recordings once and persist the activities **silently** (no
/// dirty marking). Returns the resulting activity count. Mirrors the reconcile
/// logic of [`recluster_and_persist`] but batch-wide and without a target.
async fn recluster_all_silent(db: &Db) -> Result<usize, ofit_db::DbError> {
    let recordings = db.list_recordings().await?;
    let existing = db.list_activities().await?;
    let locked: Vec<Activity> = existing
        .iter()
        .filter(|a| a.user_confirmed)
        .cloned()
        .collect();
    let clusters = cluster_recordings_respecting(&recordings, &locked);

    for cluster in &clusters {
        if cluster.user_confirmed {
            db.upsert_activity_silent(cluster).await?;
            db.set_activity_recordings(cluster.id, &cluster.recording_ids)
                .await?;
            continue;
        }
        let reuse_id = existing
            .iter()
            .filter(|a| !a.user_confirmed)
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
        db.upsert_activity_silent(&activity).await?;
        db.set_activity_recordings(activity.id, &activity.recording_ids)
            .await?;
    }
    Ok(clusters.len())
}
