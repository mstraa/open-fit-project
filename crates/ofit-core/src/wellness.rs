//! Continuous wellness — high-rate, streaming-first samples.
//!
//! Unlike [`crate::stream::Stream`] (bound to a workout recording), wellness is
//! a continuous, always-on time-series: live HR, sleep staging, resting HR, HRV,
//! stress, body battery. This is the model PLAN.md mandates be "designed for
//! streaming from day 1" — a single flat sample row keyed by `(ts, kind)` so it
//! ingests cheaply at high rate and stores compactly (`ofit-db` indexes by ts).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Sleep stage, the categorical payload for [`WellnessKind::SleepStage`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SleepStage {
    /// Awake.
    Awake,
    /// Light sleep.
    Light,
    /// Deep sleep.
    Deep,
    /// REM sleep.
    Rem,
}

impl SleepStage {
    /// Stable numeric code for compact storage (REAL/INTEGER `value` column).
    pub fn code(self) -> f64 {
        match self {
            SleepStage::Awake => 0.0,
            SleepStage::Light => 1.0,
            SleepStage::Deep => 2.0,
            SleepStage::Rem => 3.0,
        }
    }
}

/// The kind of continuous wellness metric a sample carries.
///
/// Each variant maps to a scalar `value` in [`WellnessSample`]; categorical
/// kinds (sleep stage) encode via a stable numeric code, keeping the hot path
/// a single numeric column for high-rate streaming.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum WellnessKind {
    /// Live/continuous heart rate (bpm).
    HeartRate,
    /// Sleep stage (value = [`SleepStage::code`]).
    SleepStage,
    /// Resting heart rate (bpm).
    RestingHeartRate,
    /// Heart-rate variability (ms, e.g. RMSSD).
    Hrv,
    /// Stress score (device scale).
    Stress,
    /// Body battery / energy reserve (0–100).
    BodyBattery,
    /// Respiration rate (breaths/min).
    Respiration,
    /// SpO2 / blood-oxygen (%).
    SpO2,
    /// Steps in the sample interval (count).
    Steps,
    /// Body weight (kg).
    Weight,
    /// Energy burned in the sample interval (kcal).
    Calories,
}

/// One continuous wellness reading.
///
/// Intentionally flat and narrow: `(ts, kind, value, source_id)` is all the hot
/// path needs, so a streaming HR feed is a tight loop of inserts. The same row
/// shape works for SQLite and Postgres/Timescale (see `ofit-db`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WellnessSample {
    /// Stable identifier (optional in streaming hot paths; kept for addressability).
    pub id: Uuid,
    /// Source that produced the reading.
    pub source_id: Uuid,
    /// Metric kind.
    pub kind: WellnessKind,
    /// Scalar value (categorical kinds use a stable code).
    pub value: f64,
    /// Wall-clock timestamp of the reading (UTC). Primary index key.
    pub ts: DateTime<Utc>,
}

impl WellnessSample {
    /// Build a scalar wellness sample at `ts`.
    pub fn scalar(source_id: Uuid, kind: WellnessKind, value: f64, ts: DateTime<Utc>) -> Self {
        Self {
            id: Uuid::new_v4(),
            source_id,
            kind,
            value,
            ts,
        }
    }

    /// Build a sleep-stage sample at `ts`.
    pub fn sleep_stage(source_id: Uuid, stage: SleepStage, ts: DateTime<Utc>) -> Self {
        Self::scalar(source_id, WellnessKind::SleepStage, stage.code(), ts)
    }
}
