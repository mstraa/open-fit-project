//! The runnable-algorithm seam: [`ofit_core::Algorithm`] (spec) + a `compute`
//! method that takes the rich [`AnalyticsInput`] and returns derived outputs.
//!
//! `ofit-core` owns the *spec* + the [`DerivedMetric`]/[`DerivedStream`] tagging;
//! the compute signature lives here because it needs the analytics-layer input
//! structs. WASM plugins (Phase 3 plugin-host stage) implement the same
//! [`RunnableAlgorithm`] trait by marshalling [`AnalyticsInput`] across the
//! sandbox boundary.

use ofit_core::analytics::{AlgorithmOutput, AlgorithmSpec};
use ofit_core::{Algorithm, DerivedMetric, DerivedStream};

use crate::input::AnalyticsInput;

/// The outputs of one algorithm run over an [`AnalyticsInput`]: scalar metrics
/// and/or time-series, every one already tagged with the algorithm's
/// `PluginRef(id, version)` (via [`ofit_core::AlgorithmSpec::tag_metric`] /
/// [`ofit_core::AlgorithmSpec::tag_stream`]).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AlgorithmOutputs {
    /// Scalar derived metrics (e.g. per-activity TSS, daily readiness).
    pub metrics: Vec<DerivedMetric>,
    /// Derived time-series (e.g. the CTL/ATL/TSB curves).
    pub streams: Vec<DerivedStream>,
}

impl AlgorithmOutputs {
    /// Merge another set of outputs into this one.
    pub fn extend(&mut self, other: AlgorithmOutputs) {
        self.metrics.extend(other.metrics);
        self.streams.extend(other.streams);
    }

    /// Total number of derived items produced.
    pub fn len(&self) -> usize {
        self.metrics.len() + self.streams.len()
    }

    /// Whether nothing was produced.
    pub fn is_empty(&self) -> bool {
        self.metrics.is_empty() && self.streams.is_empty()
    }

    /// Drop any output whose name is NOT declared in `spec.outputs`, keeping the
    /// built-in registry honest the same way the WASM host's `tag_validated` does
    /// (an undeclared output is a bug — it must not be persisted). A metric named
    /// `N` is kept only if `spec.outputs` contains `AlgorithmOutput::Metric(N)`;
    /// a stream only if it contains `AlgorithmOutput::Stream(N)`. Returns the names
    /// that were dropped so the caller (which has a logger) can `warn` about them.
    ///
    /// Pure + dependency-free on purpose: `ofit-analytics` has no `tracing`, so the
    /// logging is left to the orchestration layer that owns one.
    #[must_use = "the dropped output names should be logged by the caller"]
    pub fn retain_declared(&mut self, spec: &AlgorithmSpec) -> Vec<String> {
        let metric_ok = |name: &str| {
            spec.outputs
                .iter()
                .any(|o| matches!(o, AlgorithmOutput::Metric(n) if n == name))
        };
        let stream_ok = |name: &str| {
            spec.outputs
                .iter()
                .any(|o| matches!(o, AlgorithmOutput::Stream(n) if n == name))
        };
        let mut dropped = Vec::new();
        self.metrics.retain(|m| {
            let keep = metric_ok(&m.name);
            if !keep {
                dropped.push(m.name.clone());
            }
            keep
        });
        self.streams.retain(|s| {
            let keep = stream_ok(&s.name);
            if !keep {
                dropped.push(s.name.clone());
            }
            keep
        });
        dropped
    }
}

/// A built-in (or, later, WASM) algorithm that can be *run* over the analytics
/// input. Extends [`ofit_core::Algorithm`] (which provides the versioned spec)
/// with the compute step.
pub trait RunnableAlgorithm: Algorithm {
    /// Compute this algorithm's derived outputs over `input`.
    ///
    /// `computed_at` is the recompute clock stamped onto every output so
    /// staleness is comparable across a batch run. Implementations must degrade
    /// gracefully (emit fewer/zero outputs) when required inputs are absent —
    /// never panic on sparse or empty data.
    fn compute(
        &self,
        input: &AnalyticsInput,
        computed_at: chrono::DateTime<chrono::Utc>,
    ) -> AlgorithmOutputs;
}
