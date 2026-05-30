//! **Anomaly flag** (optional, cheap): flags a resting-HR reading that deviates
//! more than `k` standard deviations from the trailing series — a simple early
//! warning (illness / overreaching) over continuous wellness.
//!
//! Emits one `resting_hr_anomaly` metric for the latest day: `1.0` if the most
//! recent resting-HR reading is an outlier (|z| > `z_threshold`), else `0.0`.
//! Degrades to no output when there are too few readings to estimate a spread.

use chrono::{DateTime, Utc};
use ofit_core::analytics::{
    AlgorithmInput, AlgorithmKind, AlgorithmOutput, AlgorithmSpec,
};
use ofit_core::{Algorithm, DerivedSubject, WellnessKind};

use crate::algorithms::training_load::day_uuid;
use crate::input::AnalyticsInput;
use crate::runner::{AlgorithmOutputs, RunnableAlgorithm};

/// Built-in resting-HR anomaly detector.
#[derive(Debug, Clone)]
pub struct AnomalyFlag {
    spec: AlgorithmSpec,
    /// z-score threshold above which the latest reading is flagged. Default 2.5.
    pub z_threshold: f64,
    /// Minimum readings before a spread can be estimated. Default 5.
    pub min_samples: usize,
    /// Absolute bpm departure that counts as anomalous when the baseline has no
    /// spread (degenerate/flat history). Default 5 bpm.
    pub flat_tolerance_bpm: f64,
}

impl Default for AnomalyFlag {
    fn default() -> Self {
        Self {
            spec: AlgorithmSpec {
                id: "anomaly".into(),
                version: "1.0.0".into(),
                name: "Resting-HR Anomaly".into(),
                description: "Flags the latest resting-HR reading when it deviates beyond a \
                              z-score threshold from the recent series (illness / overreaching cue)."
                    .into(),
                inputs: vec![AlgorithmInput::Wellness(WellnessKind::RestingHeartRate)],
                outputs: vec![AlgorithmOutput::Metric("resting_hr_anomaly".into())],
                applicable_hardware: vec!["any".into()],
                kind: AlgorithmKind::BuiltIn,
            },
            z_threshold: 2.5,
            min_samples: 5,
            flat_tolerance_bpm: 5.0,
        }
    }
}

impl Algorithm for AnomalyFlag {
    fn spec(&self) -> &AlgorithmSpec {
        &self.spec
    }
}

impl RunnableAlgorithm for AnomalyFlag {
    fn compute(&self, input: &AnalyticsInput, computed_at: DateTime<Utc>) -> AlgorithmOutputs {
        let mut out = AlgorithmOutputs::default();
        let rhr = input.wellness_of(WellnessKind::RestingHeartRate);
        if rhr.len() < self.min_samples {
            return out;
        }
        let vals: Vec<f64> = rhr.iter().map(|p| p.value).filter(|v| v.is_finite()).collect();
        if vals.len() < self.min_samples {
            return out;
        }
        // Estimate the baseline mean/sd over the *prior* readings (exclude the
        // latest) so a fresh outlier doesn't inflate the spread that judges it.
        let latest = *vals.last().unwrap();
        let prior = &vals[..vals.len() - 1];
        let n = prior.len() as f64;
        let mean = prior.iter().sum::<f64>() / n;
        let var = prior.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n;
        let sd = var.sqrt();
        // Degenerate (flat) baseline: any departure beyond a small absolute
        // tolerance is anomalous (no spread to form a z-score against).
        let flagged = if sd > 1e-6 {
            ((latest - mean) / sd).abs() > self.z_threshold
        } else {
            (latest - mean).abs() > self.flat_tolerance_bpm
        };
        let flagged = if flagged { 1.0 } else { 0.0 };

        let subject = DerivedSubject::Day(day_uuid(rhr.last().unwrap().ts.date_naive()));
        out.metrics.push(self.spec.tag_metric(subject, "resting_hr_anomaly", flagged, computed_at));
        out
    }
}
