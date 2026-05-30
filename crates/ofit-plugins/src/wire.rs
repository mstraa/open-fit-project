//! The **data-in / data-out wire contract** crossing the sandbox boundary.
//!
//! A WASM plugin sees exactly the same logical input the built-ins consume
//! ([`AnalyticsInput`](ofit_analytics::AnalyticsInput)) — but as JSON, since the
//! sandbox is data-only. The host serializes [`PluginInput`] into the plugin's
//! input buffer, the plugin returns [`PluginOutput`] as JSON, and the host
//! deserializes + validates + re-tags it.
//!
//! `ofit-analytics`' input structs are deliberately *not* `serde`-derived (they
//! are pure, DB-free compute structs), so these wire DTOs are the explicit,
//! versioned serialization the plugin ABI commits to. The plugin author depends
//! only on this JSON shape, not on any Rust type.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use ofit_analytics::{ActivityInput, AnalyticsInput, MetricSeries, WellnessPoint};
use ofit_core::{Sport, StreamKind, WellnessKind};

/// JSON form of one `(t_offset_ms, value)` sample pair.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WireSample {
    /// Milliseconds since the activity start.
    pub t_offset_ms: i64,
    /// The scalar value.
    pub value: f64,
}

/// JSON form of [`MetricSeries`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WireMetricSeries {
    /// The metric kind (snake_case, matches [`StreamKind`]).
    pub kind: StreamKind,
    /// Time-ordered samples.
    pub samples: Vec<WireSample>,
}

/// JSON form of [`ActivityInput`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WireActivity {
    /// Activity id (becomes the `Activity` derived subject).
    pub activity_id: Uuid,
    /// Sport.
    pub sport: Sport,
    /// Effort start (RFC3339).
    pub started_at: DateTime<Utc>,
    /// Effort end (RFC3339).
    pub ended_at: DateTime<Utc>,
    /// Resolved scalar metric series for this activity.
    pub metrics: Vec<WireMetricSeries>,
}

/// JSON form of [`WellnessPoint`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WireWellness {
    /// Wellness metric kind.
    pub kind: WellnessKind,
    /// Scalar value.
    pub value: f64,
    /// Timestamp (RFC3339).
    pub ts: DateTime<Utc>,
}

/// The full input handed to a plugin: the analytics input plus the recompute
/// clock so a plugin produces the *same* `computed_at` the host will tag with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginInput {
    /// Wire-form activities.
    pub activities: Vec<WireActivity>,
    /// Wire-form wellness series.
    pub wellness: Vec<WireWellness>,
    /// The recompute clock (RFC3339). Plugins should stamp outputs with this.
    pub computed_at: DateTime<Utc>,
}

impl PluginInput {
    /// Build a [`PluginInput`] from the analytics input + clock.
    pub fn from_analytics(input: &AnalyticsInput, computed_at: DateTime<Utc>) -> Self {
        let activities = input
            .activities
            .iter()
            .map(|a| WireActivity {
                activity_id: a.activity_id,
                sport: a.sport,
                started_at: a.started_at,
                ended_at: a.ended_at,
                metrics: a
                    .metrics
                    .iter()
                    .map(|m| WireMetricSeries {
                        kind: m.kind,
                        samples: m
                            .samples
                            .iter()
                            .map(|(t, v)| WireSample { t_offset_ms: *t, value: *v })
                            .collect(),
                    })
                    .collect(),
            })
            .collect();
        let wellness = input
            .wellness
            .iter()
            .map(|w| WireWellness { kind: w.kind, value: w.value, ts: w.ts })
            .collect();
        Self { activities, wellness, computed_at }
    }

    /// Reconstruct an [`AnalyticsInput`] from the wire form (used by the in-Rust
    /// reference plugin in tests, and round-trip checks).
    pub fn to_analytics(&self) -> AnalyticsInput {
        AnalyticsInput {
            activities: self
                .activities
                .iter()
                .map(|a| ActivityInput {
                    activity_id: a.activity_id,
                    sport: a.sport,
                    started_at: a.started_at,
                    ended_at: a.ended_at,
                    metrics: a
                        .metrics
                        .iter()
                        .map(|m| {
                            MetricSeries::new(
                                m.kind,
                                m.samples.iter().map(|s| (s.t_offset_ms, s.value)).collect(),
                            )
                        })
                        .collect(),
                })
                .collect(),
            wellness: self
                .wellness
                .iter()
                .map(|w| WellnessPoint { kind: w.kind, value: w.value, ts: w.ts })
                .collect(),
        }
    }
}

/// A scalar metric a plugin emits. The plugin names the metric + subject; the
/// host tags it with the plugin's `PluginRef` and `computed_at` (the plugin's
/// declared values for those are ignored / overwritten — the host is the
/// authority on provenance).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WireOutMetric {
    /// What this metric is computed over.
    pub subject: ofit_core::DerivedSubject,
    /// Metric name — must be in the manifest's declared outputs.
    pub name: String,
    /// Computed value.
    pub value: f64,
}

/// A derived stream a plugin emits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WireOutStream {
    /// What this stream is computed over.
    pub subject: ofit_core::DerivedSubject,
    /// Stream name — must be in the manifest's declared outputs.
    pub name: String,
    /// Time-ordered scalar samples.
    pub samples: Vec<WireSample>,
}

/// The full output a plugin returns: untagged derived metrics + streams. The
/// host validates each `name` against the manifest, then tags with provenance.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PluginOutput {
    /// Emitted scalar metrics.
    #[serde(default)]
    pub metrics: Vec<WireOutMetric>,
    /// Emitted derived streams.
    #[serde(default)]
    pub streams: Vec<WireOutStream>,
}
