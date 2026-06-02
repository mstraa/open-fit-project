//! `DerivedMetric` / `DerivedStream` — outputs of algorithm plugins.
//!
//! Algorithms (built-in or WASM plugins) produce derived results that are tied
//! to a **plugin id + version** so they are fully recalculable: bump the version
//! or re-run, and the old derivation can be regenerated or replaced. These are
//! the "interpretations" layer over the canonical data.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::stream::Sample;

/// Identifies the derivation that produced an output: the algorithm, its code
/// version, AND a fingerprint of the parameter set it ran with. The triple
/// `(plugin_id, version, params_hash)` is a derivation's full identity — bumping
/// the version OR changing any tunable parameter yields a new, side-by-side
/// derivation rather than overwriting the old one, so they can be compared and
/// switched between.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PluginRef {
    /// Plugin identifier (built-in name or registry id).
    pub plugin_id: String,
    /// Semantic version of the plugin that produced the output.
    pub version: String,
    /// Fingerprint of the effective parameter set (empty = unknown/pre-overhaul,
    /// or a parameter-free plugin). Stamped by the orchestrator from the
    /// algorithm's effective `AnalyticsParams`.
    #[serde(default)]
    pub params_hash: String,
}

impl PluginRef {
    /// Construct a plugin reference with no parameter fingerprint (set later by
    /// the orchestrator via [`PluginRef::with_params_hash`]).
    pub fn new(plugin_id: impl Into<String>, version: impl Into<String>) -> Self {
        Self {
            plugin_id: plugin_id.into(),
            version: version.into(),
            params_hash: String::new(),
        }
    }

    /// Set the parameter-set fingerprint, completing the derivation identity.
    pub fn with_params_hash(mut self, params_hash: impl Into<String>) -> Self {
        self.params_hash = params_hash.into();
        self
    }
}

/// What a derived result is attached to (its computation subject).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "id")]
pub enum DerivedSubject {
    /// Tied to one activity (e.g. training load for a workout).
    Activity(Uuid),
    /// Tied to a calendar day / wellness window (e.g. daily HRV, readiness).
    Day(Uuid),
}

/// A single scalar derived metric (e.g. TSS, readiness score).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DerivedMetric {
    /// Stable identifier.
    pub id: Uuid,
    /// Algorithm + version that produced this metric.
    pub plugin: PluginRef,
    /// What the metric is computed over.
    pub subject: DerivedSubject,
    /// Metric name (e.g. "tss", "readiness", "rmssd").
    pub name: String,
    /// Computed value.
    pub value: f64,
    /// When this derivation was computed (drives recalculation/staleness).
    pub computed_at: DateTime<Utc>,
}

/// A derived time-series (e.g. smoothed power, sleep-stage probabilities).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DerivedStream {
    /// Stable identifier.
    pub id: Uuid,
    /// Algorithm + version that produced this stream.
    pub plugin: PluginRef,
    /// What the stream is computed over.
    pub subject: DerivedSubject,
    /// Stream name (e.g. "power_smoothed").
    pub name: String,
    /// Time-ordered derived samples.
    pub samples: Vec<Sample>,
    /// When this derivation was computed.
    pub computed_at: DateTime<Utc>,
}
