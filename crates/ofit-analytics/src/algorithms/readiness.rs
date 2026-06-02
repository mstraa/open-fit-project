//! **HRV summary + Readiness** from continuous wellness.
//!
//! From the wellness series (resting HR + HRV/RMSSD) we compute, for the most
//! recent day with data:
//!
//! - **`hrv_rmssd`**: the latest HRV reading (ms) — a passthrough summary metric.
//! - **`hrv_baseline`**: the mean HRV over the trailing `baseline_days` window.
//! - **`readiness`**: a 0–100 score blending two normalized deviations from the
//!   personal baseline:
//!     * HRV deviation: `(hrv_today − hrv_baseline) / hrv_baseline` — higher HRV
//!       than baseline → more ready.
//!     * Resting-HR deviation: `(rhr_baseline − rhr_today) / rhr_baseline` —
//!       lower resting HR than baseline → more ready.
//!   `readiness = clamp(50 + 50·(0.6·hrv_dev + 0.4·rhr_dev), 0, 100)`. The
//!   weighting (HRV-leaning) and the ±100% saturation are documented heuristics.
//!
//! **Graceful degradation**: if there are fewer than `min_hrv_samples` HRV
//! readings (sparse/empty wellness), we emit a single `readiness` metric with
//! value `NaN`-free sentinel and a companion `readiness_available = 0` metric so
//! the API can render "insufficient data" without guessing. When data exists,
//! `readiness_available = 1`.

use chrono::{DateTime, Duration, Utc};
use ofit_core::analytics::{
    AlgorithmInput, AlgorithmKind, AlgorithmOutput, AlgorithmSpec,
};
use ofit_core::{Algorithm, DerivedSubject, WellnessKind};

use crate::algorithms::training_load::day_uuid;
use crate::input::{AnalyticsInput, WellnessPoint};
use crate::params::AnalyticsParams;
use crate::runner::{AlgorithmOutputs, RunnableAlgorithm};

/// Built-in HRV-summary + readiness algorithm.
#[derive(Debug, Clone)]
pub struct Readiness {
    spec: AlgorithmSpec,
    /// Effective tunable parameters (baseline window, blend weights…).
    p: AnalyticsParams,
}

impl Default for Readiness {
    fn default() -> Self {
        Self::configured(&AnalyticsParams::default())
    }
}

impl Readiness {
    /// Build with explicit effective parameters (from the settings store).
    pub fn configured(p: &AnalyticsParams) -> Self {
        Self {
            spec: AlgorithmSpec {
                id: "readiness".into(),
                version: "1.0.0".into(),
                name: "HRV Summary & Readiness".into(),
                description: "Daily HRV summary and a 0–100 readiness score from resting HR and \
                              HRV trend vs a personal baseline; degrades to insufficient-data when \
                              wellness is sparse."
                    .into(),
                inputs: vec![
                    AlgorithmInput::Wellness(WellnessKind::Hrv),
                    AlgorithmInput::Wellness(WellnessKind::RestingHeartRate),
                ],
                outputs: vec![
                    AlgorithmOutput::Metric("hrv_rmssd".into()),
                    AlgorithmOutput::Metric("hrv_baseline".into()),
                    AlgorithmOutput::Metric("readiness".into()),
                    AlgorithmOutput::Metric("readiness_available".into()),
                ],
                applicable_hardware: vec!["any".into(), "hrv-strap".into()],
                kind: AlgorithmKind::BuiltIn,
            },
            p: p.clone(),
        }
    }
}

impl Algorithm for Readiness {
    fn spec(&self) -> &AlgorithmSpec {
        &self.spec
    }
}

impl RunnableAlgorithm for Readiness {
    fn compute(&self, input: &AnalyticsInput, computed_at: DateTime<Utc>) -> AlgorithmOutputs {
        let mut out = AlgorithmOutputs::default();
        let hrv = input.wellness_of(WellnessKind::Hrv);
        let rhr = input.wellness_of(WellnessKind::RestingHeartRate);

        // The "today" we score is the most recent HRV reading's day.
        let today_ts = match hrv.last() {
            Some(p) => p.ts,
            None => {
                // No HRV at all → insufficient data, anchored to today's clock.
                let subject = DerivedSubject::Day(day_uuid(computed_at.date_naive()));
                out.metrics.push(self.spec.tag_metric(subject, "readiness_available", 0.0, computed_at));
                return out;
            }
        };
        let subject = DerivedSubject::Day(day_uuid(today_ts.date_naive()));

        // Insufficient HRV history → emit summary if we have the latest, but flag
        // readiness as unavailable.
        if hrv.len() < (self.p.rd_min_hrv_samples as usize) {
            if let Some(latest) = hrv.last() {
                out.metrics.push(self.spec.tag_metric(subject, "hrv_rmssd", latest.value, computed_at));
            }
            out.metrics.push(self.spec.tag_metric(subject, "readiness_available", 0.0, computed_at));
            return out;
        }

        let baseline_start = today_ts - Duration::days(self.p.rd_baseline_days as i64);
        let hrv_today = hrv.last().map(|p| p.value).unwrap_or(0.0);
        let hrv_baseline = window_mean(&hrv, baseline_start, today_ts).unwrap_or(hrv_today);

        out.metrics.push(self.spec.tag_metric(subject, "hrv_rmssd", hrv_today, computed_at));
        out.metrics.push(self.spec.tag_metric(subject, "hrv_baseline", hrv_baseline, computed_at));

        let dev_clamp = self.p.rd_deviation_clamp;
        // HRV deviation: positive when today's HRV exceeds baseline.
        let hrv_dev = if hrv_baseline > 0.0 {
            ((hrv_today - hrv_baseline) / hrv_baseline).clamp(-dev_clamp, dev_clamp)
        } else {
            0.0
        };

        // Resting-HR deviation: positive when today's RHR is *below* baseline.
        let rhr_dev = if !rhr.is_empty() {
            let rhr_today = rhr.last().map(|p| p.value).unwrap_or(0.0);
            let rhr_baseline = window_mean(&rhr, baseline_start, today_ts).unwrap_or(rhr_today);
            if rhr_baseline > 0.0 {
                ((rhr_baseline - rhr_today) / rhr_baseline).clamp(-dev_clamp, dev_clamp)
            } else {
                0.0
            }
        } else {
            0.0
        };

        // Weight HRV more heavily; RHR contributes only if present (no RHR → HRV
        // carries the full weight).
        let (w_hrv, w_rhr) = if rhr.is_empty() {
            (1.0, 0.0)
        } else {
            (self.p.rd_weight_hrv, self.p.rd_weight_rhr)
        };
        let readiness = (self.p.rd_score_center
            + self.p.rd_score_span * (w_hrv * hrv_dev + w_rhr * rhr_dev))
            .clamp(0.0, 100.0);

        out.metrics.push(self.spec.tag_metric(subject, "readiness", readiness, computed_at));
        out.metrics.push(self.spec.tag_metric(subject, "readiness_available", 1.0, computed_at));
        out
    }
}

/// Mean of wellness values whose ts is within `(start, end]`.
fn window_mean(points: &[WellnessPoint], start: DateTime<Utc>, end: DateTime<Utc>) -> Option<f64> {
    let vals: Vec<f64> = points
        .iter()
        .filter(|p| p.ts > start && p.ts <= end && p.value.is_finite())
        .map(|p| p.value)
        .collect();
    if vals.is_empty() {
        None
    } else {
        Some(vals.iter().sum::<f64>() / vals.len() as f64)
    }
}
