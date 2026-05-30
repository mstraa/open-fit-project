//! Clean, DB-free input structs the built-in algorithms compute over.
//!
//! The API layer (which *does* talk to `ofit-db`) is responsible for loading
//! real activities, their resolved scalar streams, and the wellness series, then
//! feeding them in here. Keeping these structs free of any DB dependency makes
//! the algorithms pure, unit-testable on synthetic data, and identical to what a
//! WASM plugin would receive.

use chrono::{DateTime, Utc};
use uuid::Uuid;

use ofit_core::{Sport, StreamKind, WellnessKind};

/// One scalar metric series resolved for an activity (already best-source-picked
/// by the dedup/fusion layer). `samples` are `(t_offset_ms, value)` pairs.
#[derive(Debug, Clone, PartialEq)]
pub struct MetricSeries {
    /// The metric this series carries.
    pub kind: StreamKind,
    /// Time-ordered `(ms-since-start, value)` samples.
    pub samples: Vec<(i64, f64)>,
}

impl MetricSeries {
    /// Build from raw `(t_offset_ms, value)` pairs.
    pub fn new(kind: StreamKind, samples: Vec<(i64, f64)>) -> Self {
        Self { kind, samples }
    }

    /// Whether the series has any samples.
    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    /// Mean of the non-NaN sample values (`None` if empty).
    pub fn mean(&self) -> Option<f64> {
        let vals: Vec<f64> = self.samples.iter().map(|(_, v)| *v).filter(|v| v.is_finite()).collect();
        if vals.is_empty() {
            return None;
        }
        Some(vals.iter().sum::<f64>() / vals.len() as f64)
    }

    /// Duration of the series in seconds, from first to last sample offset.
    pub fn span_secs(&self) -> i64 {
        match (self.samples.first(), self.samples.last()) {
            (Some((a, _)), Some((b, _))) => ((b - a) / 1000).max(0),
            _ => 0,
        }
    }
}

/// A single activity's analytics input: its identity, sport, timing, and the
/// resolved scalar metric series available for it.
#[derive(Debug, Clone, PartialEq)]
pub struct ActivityInput {
    /// The activity id (becomes the [`DerivedSubject::Activity`] of its outputs).
    pub activity_id: Uuid,
    /// Sport (drives sport-specific heuristics).
    pub sport: Sport,
    /// Start of the effort (drives the CTL/ATL/TSB timeline).
    pub started_at: DateTime<Utc>,
    /// End of the effort.
    pub ended_at: DateTime<Utc>,
    /// Resolved scalar metric series for this activity (one per available kind).
    pub metrics: Vec<MetricSeries>,
}

impl ActivityInput {
    /// Duration of the activity window in seconds (clamped to >= 0).
    pub fn duration_secs(&self) -> i64 {
        (self.ended_at - self.started_at).num_seconds().max(0)
    }

    /// The resolved series for `kind`, if present.
    pub fn metric(&self, kind: StreamKind) -> Option<&MetricSeries> {
        self.metrics.iter().find(|m| m.kind == kind)
    }
}

/// One continuous wellness reading (flattened from `ofit_core::WellnessSample`,
/// without the source/id the algorithms don't need).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WellnessPoint {
    /// Metric kind.
    pub kind: WellnessKind,
    /// Scalar value.
    pub value: f64,
    /// Wall-clock timestamp (UTC).
    pub ts: DateTime<Utc>,
}

/// The full input for a subject's analytics run: their activities (with resolved
/// metrics) and their continuous wellness series.
///
/// This is what the orchestration entry point consumes. The API builds it from
/// `ofit-db`; tests build it from synthetic data.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AnalyticsInput {
    /// Activities in (any) order; the orchestrator sorts by `started_at`.
    pub activities: Vec<ActivityInput>,
    /// Continuous wellness points (resting HR, HRV, …) in (any) order.
    pub wellness: Vec<WellnessPoint>,
}

impl AnalyticsInput {
    /// Wellness points of a given kind, sorted ascending by timestamp.
    pub fn wellness_of(&self, kind: WellnessKind) -> Vec<WellnessPoint> {
        let mut v: Vec<WellnessPoint> = self.wellness.iter().copied().filter(|w| w.kind == kind).collect();
        v.sort_by_key(|w| w.ts);
        v
    }

    /// Activities sorted ascending by `started_at` (stable, then by id).
    pub fn activities_sorted(&self) -> Vec<&ActivityInput> {
        let mut v: Vec<&ActivityInput> = self.activities.iter().collect();
        v.sort_by(|a, b| a.started_at.cmp(&b.started_at).then(a.activity_id.cmp(&b.activity_id)));
        v
    }
}
