//! `Stream` — a per-recording time-series channel (HR, power, cadence…).
//!
//! Streams belong to a single [`crate::recording::RawRecording`]. Each carries
//! a kind and a compact, time-ordered set of samples. Storage is designed to be
//! time-series friendly (see `ofit-db`); here we keep the in-memory shape.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The metric a stream carries. This enum is also the granularity at which
/// per-metric source preferences resolve (see [`crate::preference`]).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
    utoipa::ToSchema,
)]
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
    /// Vertical oscillation (mm) — running dynamics (Stryd / Garmin).
    VerticalOscillation,
    /// Ground contact time / stance time (ms) — running dynamics.
    GroundContactTime,
    /// Stride / step length (mm) — running dynamics.
    StrideLength,
    /// Vertical ratio (%) — vertical oscillation as a fraction of step length.
    VerticalRatio,
    /// Form power (watts) — Stryd: power "wasted" on vertical/braking motion.
    FormPower,
    /// Air power (watts) — Stryd: power spent overcoming air resistance (wind).
    AirPower,
    /// Leg spring stiffness (kN/m) — Stryd running dynamics.
    LegSpringStiffness,
}

impl StreamKind {
    /// Every variant, in declaration order. Handy for catalogs/iteration.
    pub const ALL: [StreamKind; 16] = [
        StreamKind::HeartRate,
        StreamKind::Power,
        StreamKind::Cadence,
        StreamKind::Speed,
        StreamKind::Altitude,
        StreamKind::LatLng,
        StreamKind::Wind,
        StreamKind::Temperature,
        StreamKind::Distance,
        StreamKind::VerticalOscillation,
        StreamKind::GroundContactTime,
        StreamKind::StrideLength,
        StreamKind::VerticalRatio,
        StreamKind::FormPower,
        StreamKind::AirPower,
        StreamKind::LegSpringStiffness,
    ];

    /// Canonical unit string for the scalar values this kind carries.
    ///
    /// [`StreamKind::LatLng`] has no scalar unit (it carries paired degrees) and
    /// returns an empty string. These units are the contract the API/web rely on
    /// for axis labels — the ingest parsers scale raw values to match them.
    pub fn unit(self) -> &'static str {
        match self {
            StreamKind::HeartRate => "bpm",
            StreamKind::Power | StreamKind::FormPower | StreamKind::AirPower => "W",
            StreamKind::Cadence => "rpm",
            StreamKind::Speed | StreamKind::Wind => "m/s",
            StreamKind::Altitude => "m",
            StreamKind::LatLng => "",
            StreamKind::Temperature => "°C",
            StreamKind::Distance => "m",
            StreamKind::VerticalOscillation | StreamKind::StrideLength => "mm",
            StreamKind::GroundContactTime => "ms",
            StreamKind::VerticalRatio => "%",
            StreamKind::LegSpringStiffness => "kN/m",
        }
    }

    /// Short human label for this kind (English; the web may localize/override).
    pub fn label(self) -> &'static str {
        match self {
            StreamKind::HeartRate => "Heart rate",
            StreamKind::Power => "Power",
            StreamKind::Cadence => "Cadence",
            StreamKind::Speed => "Speed",
            StreamKind::Altitude => "Altitude",
            StreamKind::LatLng => "Position",
            StreamKind::Wind => "Wind",
            StreamKind::Temperature => "Temperature",
            StreamKind::Distance => "Distance",
            StreamKind::VerticalOscillation => "Vertical oscillation",
            StreamKind::GroundContactTime => "Ground contact time",
            StreamKind::StrideLength => "Stride length",
            StreamKind::VerticalRatio => "Vertical ratio",
            StreamKind::FormPower => "Form power",
            StreamKind::AirPower => "Air power",
            StreamKind::LegSpringStiffness => "Leg spring stiffness",
        }
    }
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
