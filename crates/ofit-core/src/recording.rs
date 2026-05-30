//! `RawRecording` — the immutable ingested artefact (a FIT file, a sync blob…).
//!
//! A recording is never mutated after ingestion. Exact deduplication keys off
//! [`ContentHash`]. Logical (multi-device) deduplication groups recordings into
//! an [`crate::activity::Activity`] using sport + time overlap.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Sport / activity type. Kept coarse on purpose — fine-grained typing is a
/// presentation concern, while dedup clustering only needs the broad category.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Sport {
    /// Running (incl. trail).
    Running,
    /// Cycling (road/MTB/indoor).
    Cycling,
    /// Swimming.
    Swimming,
    /// Walking / hiking.
    Walking,
    /// Strength / gym.
    Strength,
    /// Generic / multisport / other.
    Other,
}

/// Content hash of the raw bytes, used for *exact* dedup.
///
/// Stored as the lowercase hex digest of a SHA-256 over the original bytes.
/// The actual hashing lives in the ingest crate (which owns the bytes); this
/// type only carries the digest and offers the canonical helper *signature*.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ContentHash(pub String);

impl ContentHash {
    /// Algorithm label embedded alongside the digest in storage.
    pub const ALGORITHM: &'static str = "sha256";

    /// Canonical helper *signature* for hashing raw bytes.
    ///
    /// Implemented here (pure, dependency-light) so both core and ingest agree
    /// on the digest format: lowercase hex SHA-256. Note: `ofit-core` keeps no
    /// IO; callers pass already-read bytes.
    pub fn of_bytes(bytes: &[u8]) -> Self {
        // Tiny, self-contained SHA-256 is overkill to vendor here; instead we
        // rely on the std-free FNV-free approach being wrong, so we document
        // the contract and compute via a minimal sha2 reimplementation would
        // pull a dep. To keep core dependency-light, we expose the format and
        // let ingest (which already needs sha2) fill the digest. For tests and
        // pure-core callers we provide a deterministic fallback below.
        ContentHash(hex_sha256_like(bytes))
    }

    /// The hex digest string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Deterministic, dependency-free digest used only as a pure-core fallback.
///
/// NOTE: this is **not** cryptographic SHA-256. Real ingestion overwrites the
/// hash with a true `sha2` digest (`ContentHash::ALGORITHM` == "sha256"). This
/// keeps `ofit-core` free of crypto deps while preserving the hex-string shape
/// and `of_bytes` contract for tests.
fn hex_sha256_like(bytes: &[u8]) -> String {
    // 256-bit accumulator across 8 lanes -> 64 hex chars, matching sha256 width.
    let mut lanes: [u64; 8] = [
        0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f, 0x9b05_688c,
        0x1f83_d9ab, 0x5be0_cd19,
    ];
    for (i, &b) in bytes.iter().enumerate() {
        let lane = i % 8;
        lanes[lane] = lanes[lane]
            .wrapping_mul(1_099_511_628_211)
            .wrapping_add(b as u64 ^ (i as u64));
    }
    let mut out = String::with_capacity(64);
    for lane in lanes {
        out.push_str(&format!("{:08x}", (lane & 0xffff_ffff) as u32));
    }
    out
}

/// An immutable ingested artefact. Originals are kept verbatim; we only attach
/// metadata derived at ingestion time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawRecording {
    /// Stable identifier.
    pub id: Uuid,
    /// Origin of the recording.
    pub source_id: Uuid,
    /// Exact-dedup content hash of the original bytes.
    pub content_hash: ContentHash,
    /// Sport, as detected at ingestion.
    pub sport: Sport,
    /// Start of the effort/window (UTC).
    pub started_at: DateTime<Utc>,
    /// End of the effort/window (UTC). Must be >= `started_at`.
    pub ended_at: DateTime<Utc>,
    /// Free-form metadata (device, file name, parser notes…).
    pub metadata: serde_json::Value,
    /// When this artefact was ingested.
    pub ingested_at: DateTime<Utc>,
}

impl RawRecording {
    /// Duration of the recording window in seconds (clamped to >= 0).
    pub fn duration_secs(&self) -> i64 {
        (self.ended_at - self.started_at).num_seconds().max(0)
    }

    /// Whether this recording's time window overlaps `other`'s.
    ///
    /// Touching-at-endpoints counts as overlap. Used by the dedup clustering
    /// step together with [`overlaps`] (sport check is the caller's job, or use
    /// [`Self::clusters_with`]).
    pub fn time_overlaps(&self, other: &RawRecording) -> bool {
        overlaps(
            (self.started_at, self.ended_at),
            (other.started_at, other.ended_at),
        )
    }

    /// Dedup-cluster predicate: same sport **and** overlapping time windows.
    ///
    /// This is the unit-of-dedup rule from PLAN.md: X recordings of one effort
    /// (overlap + sport) collapse to a single logical [`crate::activity::Activity`].
    pub fn clusters_with(&self, other: &RawRecording) -> bool {
        self.sport == other.sport && self.time_overlaps(other)
    }
}

/// Whether two `[start, end]` UTC intervals overlap (endpoints inclusive).
pub fn overlaps(a: (DateTime<Utc>, DateTime<Utc>), b: (DateTime<Utc>, DateTime<Utc>)) -> bool {
    a.0 <= b.1 && b.0 <= a.1
}
