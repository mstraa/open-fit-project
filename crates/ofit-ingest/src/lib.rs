//! # ofit-ingest
//!
//! File-import adapter: parses initial-backfill activity files (`.fit`, `.gpx`,
//! `.tcx`) into the canonical [`ofit_core`] types. This is the **only**
//! hardware-ingest path besides the future Gadgetbridge bridge — there are no
//! vendor cloud connectors here (see PLAN.md / AGENTS.md: zero cloud).
//!
//! ## Entry points
//! - [`import_file`] — read a path, detect the format, parse.
//! - [`import_bytes`] — parse already-read bytes (the original filename is used
//!   for format detection and metadata).
//!
//! Both yield a [`ParsedRecording`] = a [`RawRecording`] plus the extracted
//! [`Stream`]s. The recording is *not yet* attached to a real [`Source`] or
//! [`Activity`]; that is the dedup/import stage's job (see
//! [`ParsedRecording::source_id`] and [`PLACEHOLDER_SOURCE_ID`]).
//!
//! ## Content hash (exact-dedup key)
//! The [`RawRecording::content_hash`] is a **real** lowercase-hex SHA-256 over
//! the original file bytes (via `sha2`), overriding the dependency-free
//! fallback documented in `ofit-core`. The DB unique-hash index relies on this.
//!
//! [`Source`]: ofit_core::Source
//! [`Activity`]: ofit_core::Activity

use std::path::Path;

use chrono::{DateTime, Utc};
use ofit_core::{ContentHash, RawRecording, Sport, Stream, StreamKind};
use sha2::{Digest, Sha256};
use uuid::Uuid;

mod builder;
mod fit;
pub mod gadgetbridge;
mod gpx;
mod pipeline;
mod tcx;

pub use builder::RecordingBuilder;
pub use gadgetbridge::{read_db as read_gadgetbridge_db, GadgetbridgeImport, GbError, WellnessReading};
pub use pipeline::{import_bytes_path, import_path, ImportOutcome, PipelineError};

/// Errors raised while importing a file.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The file extension / content did not match any supported format.
    #[error("unsupported or unrecognized format for {name:?}")]
    UnknownFormat {
        /// The file name we tried to detect from.
        name: String,
    },
    /// IO failure reading the file.
    #[error("io error reading {name:?}: {source}")]
    Io {
        /// File name being read.
        name: String,
        /// Underlying IO error.
        #[source]
        source: std::io::Error,
    },
    /// The underlying format parser failed.
    #[error("failed to parse {format} file {name:?}: {reason}")]
    Parse {
        /// Detected format label (`fit` / `gpx` / `tcx`).
        format: &'static str,
        /// File name being parsed.
        name: String,
        /// Human-readable reason.
        reason: String,
    },
    /// The file parsed but contained no time-stamped samples, so we cannot
    /// establish a `started_at`/`ended_at` window.
    #[error("no timestamped samples found in {format} file {name:?}")]
    Empty {
        /// Detected format label.
        format: &'static str,
        /// File name.
        name: String,
    },
}

/// Convenience result alias for import operations.
pub type Result<T> = std::result::Result<T, Error>;

/// Deterministic placeholder [`Source`](ofit_core::Source) id assigned to every
/// freshly parsed recording.
///
/// The import/dedup pipeline (next stage) is responsible for creating or
/// matching the real `Source` (device/provider instance) and rewriting
/// [`RawRecording::source_id`] before persistence. Until then this stable UUID
/// makes parser output reproducible and obviously-not-real.
pub const PLACEHOLDER_SOURCE_ID: Uuid = Uuid::from_u128(0x0f17_0000_0000_0000_0000_0000_0000_0001);

/// A parsed activity file: the immutable recording plus its time-series streams.
///
/// This is the unit handed to the dedup/import stage. The caller is expected to
/// (1) assign a real [`source_id`](Self::source_id), (2) run exact-dedup on
/// [`recording.content_hash`](RawRecording::content_hash), and (3) cluster into
/// an [`Activity`](ofit_core::Activity). Stream `recording_id`s already point at
/// [`recording.id`](RawRecording::id).
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedRecording {
    /// The immutable recording (sport, time window, content hash, metadata).
    pub recording: RawRecording,
    /// Extracted time-series channels (each `recording_id == recording.id`).
    pub streams: Vec<Stream>,
}

impl ParsedRecording {
    /// Convenience accessor for the recording's source id.
    pub fn source_id(&self) -> Uuid {
        self.recording.source_id
    }

    /// Total sample count across all streams.
    pub fn sample_count(&self) -> usize {
        self.streams.iter().map(Stream::len).sum()
    }

    /// The stream kinds present (in stream order).
    pub fn stream_kinds(&self) -> Vec<StreamKind> {
        self.streams.iter().map(|s| s.kind).collect()
    }
}

/// Supported import formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Fit,
    Gpx,
    Tcx,
}

impl Format {
    fn label(self) -> &'static str {
        match self {
            Format::Fit => "fit",
            Format::Gpx => "gpx",
            Format::Tcx => "tcx",
        }
    }

    /// Detect by extension first, then fall back to content sniffing.
    fn detect(name: &str, bytes: &[u8]) -> Option<Format> {
        if let Some(ext) = Path::new(name).extension().and_then(|e| e.to_str()) {
            match ext.to_ascii_lowercase().as_str() {
                "fit" => return Some(Format::Fit),
                "gpx" => return Some(Format::Gpx),
                "tcx" => return Some(Format::Tcx),
                _ => {}
            }
        }
        // Content sniff: FIT files carry the ASCII tag ".FIT" at byte offset 8.
        if bytes.len() >= 12 && &bytes[8..12] == b".FIT" {
            return Some(Format::Fit);
        }
        // XML formats: look for the distinguishing root element.
        let head_len = bytes.len().min(1024);
        let head = String::from_utf8_lossy(&bytes[..head_len]);
        if head.contains("TrainingCenterDatabase") {
            return Some(Format::Tcx);
        }
        if head.contains("<gpx") {
            return Some(Format::Gpx);
        }
        None
    }
}

/// Import an activity file from disk.
///
/// The format is detected from the extension (falling back to content). The
/// returned [`ParsedRecording`] carries a real SHA-256 content hash over the
/// file bytes and a [`PLACEHOLDER_SOURCE_ID`] source.
pub fn import_file(path: &Path) -> Result<ParsedRecording> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("<unknown>")
        .to_string();
    let bytes = std::fs::read(path).map_err(|source| Error::Io {
        name: name.clone(),
        source,
    })?;
    import_bytes(&name, &bytes)
}

/// Import an activity file from already-read bytes.
///
/// `name` is used for format detection (extension) and recorded in metadata.
pub fn import_bytes(name: &str, bytes: &[u8]) -> Result<ParsedRecording> {
    let format = Format::detect(name, bytes).ok_or_else(|| Error::UnknownFormat {
        name: name.to_string(),
    })?;

    let mut builder = match format {
        Format::Fit => fit::parse(name, bytes)?,
        Format::Gpx => gpx::parse(name, bytes)?,
        Format::Tcx => tcx::parse(name, bytes)?,
    };

    // Override the content hash with a real cryptographic SHA-256 over the
    // original bytes (the exact-dedup key).
    builder.set_content_hash(content_hash(bytes));
    builder.into_parsed(format)
}

/// Lowercase hex SHA-256 of the original file bytes — the canonical
/// [`ContentHash`] format (`ContentHash::ALGORITHM == "sha256"`).
fn content_hash(bytes: &[u8]) -> ContentHash {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for b in digest {
        hex.push_str(&format!("{b:02x}"));
    }
    ContentHash(hex)
}

/// Map a FIT/TCX/GPX sport string to the coarse core [`Sport`] enum.
pub(crate) fn sport_from_str(raw: &str) -> Sport {
    match raw.trim().to_ascii_lowercase().as_str() {
        "running" | "run" | "trail_running" | "treadmill_running" => Sport::Running,
        "cycling" | "biking" | "bike" | "road_biking" | "mountain_biking" | "indoor_cycling" => {
            Sport::Cycling
        }
        "swimming" | "swim" | "lap_swimming" | "open_water" => Sport::Swimming,
        "walking" | "walk" | "hiking" | "hike" => Sport::Walking,
        "strength" | "strength_training" | "training" | "weight_training" => Sport::Strength,
        _ => Sport::Other,
    }
}

/// Last-resort sport inference from filename keywords (e.g. `RUN001…` →
/// [`Sport::Running`]). Used only when a format carries no sport metadata, so a
/// recording can still cluster with siblings of the same effort.
pub(crate) fn sport_from_filename(name: &str) -> Sport {
    let f = name.to_ascii_lowercase();
    if f.contains("run") {
        Sport::Running
    } else if f.contains("bike") || f.contains("cycl") || f.contains("ride") || f.contains("velo") {
        Sport::Cycling
    } else if f.contains("swim") {
        Sport::Swimming
    } else if f.contains("walk") || f.contains("hike") {
        Sport::Walking
    } else {
        Sport::Other
    }
}

/// Helper shared by parsers: milliseconds from `start` to `ts`, clamped to >= 0.
pub(crate) fn offset_ms(start: DateTime<Utc>, ts: DateTime<Utc>) -> i64 {
    (ts - start).num_milliseconds().max(0)
}

/// Best-effort manufacturer label inferred from a free-form device/creator
/// string (GPX `creator`, TCX `Creator`/`Author`). Returns `None` when nothing
/// recognizable matches, so we never invent a vendor.
pub(crate) fn manufacturer_from_device(device: &str) -> Option<String> {
    let d = device.to_ascii_lowercase();
    if d.contains("garmin") || d.contains("forerunner") || d.contains("fenix") || d.contains("edge")
    {
        Some("Garmin".to_string())
    } else if d.contains("zepp") || d.contains("amazfit") || d.contains("huami") {
        Some("Zepp / Amazfit (Huami)".to_string())
    } else if d.contains("stryd") {
        Some("Stryd".to_string())
    } else if d.contains("wahoo") {
        Some("Wahoo".to_string())
    } else if d.contains("polar") {
        Some("Polar".to_string())
    } else if d.contains("coros") {
        Some("Coros".to_string())
    } else if d.contains("suunto") {
        Some("Suunto".to_string())
    } else {
        None
    }
}
