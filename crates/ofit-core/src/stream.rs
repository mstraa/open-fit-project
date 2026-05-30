//! `Stream` — a per-recording time-series channel (HR, power, cadence…).
//!
//! Streams belong to a single [`crate::recording::RawRecording`]. Each carries
//! a kind and a compact, time-ordered set of samples. Storage is designed to be
//! time-series friendly (see `ofit-db`); here we keep the in-memory shape.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The metric a stream carries. This enum is also the granularity at which
/// per-metric source preferences resolve (see [`crate::preference`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamKind {
    /// Heart rate (bpm).
    HeartRate,
    /// Power (watts) — incl. Stryd running power embedded in the Garmin FIT.
    Power,
    /// Cadence (rpm / spm).
    Cadence,
    /// Speed (m/s).
    Speed,
    /// Altitude (m).
    Altitude,
    /// Geographic position (lat/lng degrees) — see [`Sample::LatLng`].
    LatLng,
    /// Wind speed (m/s) — Stryd wind.
    Wind,
    /// Air/skin/ambient temperature (°C).
    Temperature,
    /// Distance (m, cumulative).
    Distance,
}

/// A single time-stamped sample. `t_offset_ms` is milliseconds since the parent
/// recording's start, keeping samples compact and monotonic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Sample {
    /// Scalar value at `t_offset_ms`.
    Scalar {
        /// Milliseconds since recording start.
        t_offset_ms: i64,
        /// The measured value.
        value: f64,
    },
    /// Geographic position at `t_offset_ms`.
    LatLng {
        /// Milliseconds since recording start.
        t_offset_ms: i64,
        /// Latitude in degrees.
        lat: f64,
        /// Longitude in degrees.
        lng: f64,
    },
}

impl Sample {
    /// Millisecond offset of this sample from recording start.
    pub fn t_offset_ms(&self) -> i64 {
        match self {
            Sample::Scalar { t_offset_ms, .. } => *t_offset_ms,
            Sample::LatLng { t_offset_ms, .. } => *t_offset_ms,
        }
    }
}

/// A per-recording time-series channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Stream {
    /// Stable identifier.
    pub id: Uuid,
    /// Recording this stream was extracted from.
    pub recording_id: Uuid,
    /// What metric this channel carries.
    pub kind: StreamKind,
    /// Time-ordered samples.
    pub samples: Vec<Sample>,
}

impl Stream {
    /// Create an empty stream for a recording + kind.
    pub fn new(recording_id: Uuid, kind: StreamKind) -> Self {
        Self {
            id: Uuid::new_v4(),
            recording_id,
            kind,
            samples: Vec::new(),
        }
    }

    /// Number of samples in the channel.
    pub fn len(&self) -> usize {
        self.samples.len()
    }

    /// Whether the channel has no samples.
    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }
}
