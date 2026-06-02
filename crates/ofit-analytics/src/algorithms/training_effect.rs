//! **Training Effect**: per-activity **aerobic** and **anaerobic** training effect
//! (0–5) plus an **exercise-load** number, from the heart-rate stream.
//!
//! Garmin's Training Effect is a proprietary EPOC model and isn't fetchable over
//! BLE, so — like body battery — we model our own from the signal we DO have: the
//! activity's resolved HR stream. We use the **Banister TRIMP** dose, integrating
//! the HR-reserve fraction over time:
//!
//! - `HRr(t) = clamp((HR − HRrest) / (HRmax − HRrest), 0, 1)`
//! - per-minute dose `= HRr · 0.64 · e^(1.92·HRr)` (Banister, men); we integrate
//!   it across consecutive samples (gaps clamped to ≤ 1 min so a sync hole can't
//!   inflate it).
//! - **Aerobic TE** maps the whole-effort TRIMP onto 0–5 via
//!   `5·(1 − e^(−TRIMP/80))` (≈ 4 for a solid hour at tempo).
//! - **Anaerobic TE** maps only the *high-intensity* dose (the part above
//!   `HRr > 0.85`) via `5·(1 − e^(−TRIMPhi/8))`, so steady aerobic work scores
//!   near 0 and repeated hard surges push it up.
//! - **Exercise load** = the rounded TRIMP (a Garmin-style "load" number).
//!
//! HRmax/HRrest come from [`AthleteThresholds`]. With no HR stream the activity
//! produces no Training-Effect outputs (graceful — never panics).

use chrono::{DateTime, Utc};
use ofit_core::analytics::{AlgorithmInput, AlgorithmKind, AlgorithmOutput, AlgorithmSpec};
use ofit_core::{Algorithm, DerivedSubject, StreamKind};

use crate::input::{ActivityInput, AnalyticsInput};
use crate::params::AnalyticsParams;
use crate::runner::{AlgorithmOutputs, RunnableAlgorithm};

/// Built-in per-activity Training Effect (aerobic/anaerobic + load).
#[derive(Debug, Clone)]
pub struct TrainingEffect {
    spec: AlgorithmSpec,
    /// Effective tunable parameters (HRmax/HRrest, TRIMP coefficients…).
    p: AnalyticsParams,
}

impl Default for TrainingEffect {
    fn default() -> Self {
        Self::configured(&AnalyticsParams::default())
    }
}

impl TrainingEffect {
    /// Build with explicit effective parameters (from the settings store).
    pub fn configured(p: &AnalyticsParams) -> Self {
        Self {
            spec: AlgorithmSpec {
                id: "training_effect".into(),
                version: "1.0.0".into(),
                name: "Training Effect (aerobic · anaerobic)".into(),
                description: "Per-activity aerobic and anaerobic Training Effect (0–5) plus an \
                              exercise-load number, from the Banister HR-reserve TRIMP model."
                    .into(),
                inputs: vec![AlgorithmInput::Stream(StreamKind::HeartRate)],
                outputs: vec![
                    AlgorithmOutput::Metric("training_effect_aerobic".into()),
                    AlgorithmOutput::Metric("training_effect_anaerobic".into()),
                    AlgorithmOutput::Metric("exercise_load".into()),
                ],
                applicable_hardware: vec!["any".into()],
                kind: AlgorithmKind::BuiltIn,
            },
            p: p.clone(),
        }
    }
}

/// One activity's Training Effect result.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EffortTe {
    /// Aerobic Training Effect (0–5).
    pub aerobic: f64,
    /// Anaerobic Training Effect (0–5).
    pub anaerobic: f64,
    /// Exercise load (rounded TRIMP).
    pub load: f64,
}

impl TrainingEffect {
    /// Compute one activity's Training Effect from its HR stream, if present.
    pub fn activity_te(&self, act: &ActivityInput) -> Option<EffortTe> {
        let hr = act.metric(StreamKind::HeartRate)?;
        let p = &self.p;
        if hr.samples.len() < (p.te_min_hr_samples as usize).max(1) {
            return None;
        }
        let reserve = (p.hr_max - p.hr_rest).max(1.0);
        let s = &hr.samples;
        let mut trimp = 0.0f64;
        let mut trimp_hi = 0.0f64;
        for i in 1..s.len() {
            // Minutes since the previous sample (gaps clamped so a sync hole can't
            // inflate the dose).
            let dt_min = (((s[i].0 - s[i - 1].0) as f64) / 1000.0 / 60.0).clamp(0.0, p.te_max_gap_min);
            let hr_v = s[i].1;
            if dt_min <= 0.0 || !hr_v.is_finite() {
                continue;
            }
            let hrr = ((hr_v - p.hr_rest) / reserve).clamp(0.0, 1.0);
            let dose = hrr * p.te_trimp_a * (p.te_trimp_b * hrr).exp();
            trimp += dt_min * dose;
            if hrr > p.te_anaerobic_hrr {
                trimp_hi += dt_min * (hrr - p.te_anaerobic_hrr) * p.te_trimp_a * (p.te_trimp_b * hrr).exp();
            }
        }
        if trimp <= 0.0 {
            return None;
        }
        let aerobic = (p.te_scale_max * (1.0 - (-trimp / p.te_aerobic_scale).exp())).clamp(0.0, p.te_scale_max);
        let anaerobic = (p.te_scale_max * (1.0 - (-trimp_hi / p.te_anaerobic_scale).exp())).clamp(0.0, p.te_scale_max);
        Some(EffortTe {
            aerobic: (aerobic * 10.0).round() / 10.0,
            anaerobic: (anaerobic * 10.0).round() / 10.0,
            load: trimp.round(),
        })
    }
}

impl Algorithm for TrainingEffect {
    fn spec(&self) -> &AlgorithmSpec {
        &self.spec
    }
}

impl RunnableAlgorithm for TrainingEffect {
    fn compute(&self, input: &AnalyticsInput, computed_at: DateTime<Utc>) -> AlgorithmOutputs {
        let mut out = AlgorithmOutputs::default();
        for act in input.activities_sorted() {
            if let Some(te) = self.activity_te(act) {
                let subj = DerivedSubject::Activity(act.activity_id);
                out.metrics.push(self.spec.tag_metric(subj, "training_effect_aerobic", te.aerobic, computed_at));
                out.metrics.push(self.spec.tag_metric(subj, "training_effect_anaerobic", te.anaerobic, computed_at));
                out.metrics.push(self.spec.tag_metric(subj, "exercise_load", te.load, computed_at));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::MetricSeries;
    use chrono::{Duration, TimeZone};
    use ofit_core::Sport;
    use uuid::Uuid;

    fn act_hr(dur_min: i64, hr: f64) -> ActivityInput {
        let start = Utc.with_ymd_and_hms(2024, 1, 1, 8, 0, 0).unwrap();
        let n = (dur_min * 60) as usize;
        let samples = (0..n).map(|i| (i as i64 * 1000, hr)).collect();
        ActivityInput {
            activity_id: Uuid::new_v4(),
            sport: Sport::Running,
            started_at: start,
            ended_at: start + Duration::minutes(dur_min),
            metrics: vec![MetricSeries::new(StreamKind::HeartRate, samples)],
        }
    }

    #[test]
    fn aerobic_te_in_range_and_anaerobic_low_for_steady_tempo() {
        let te = TrainingEffect::default();
        // 60 min steady at HR 150 (HRr ≈ 0.71 with max190/rest50) — solidly aerobic.
        let r = te.activity_te(&act_hr(60, 150.0)).unwrap();
        assert!((2.5..=5.0).contains(&r.aerobic), "aerobic {}", r.aerobic);
        assert!(r.anaerobic < 1.0, "steady tempo should be low anaerobic: {}", r.anaerobic);
        assert!(r.load > 0.0);
    }

    #[test]
    fn hard_effort_raises_anaerobic() {
        let te = TrainingEffect::default();
        // 30 min near max (HR 182 → HRr ≈ 0.94) — pushes anaerobic up.
        let r = te.activity_te(&act_hr(30, 182.0)).unwrap();
        assert!(r.anaerobic > 1.0, "hard effort anaerobic: {}", r.anaerobic);
    }

    #[test]
    fn no_hr_no_output() {
        let te = TrainingEffect::default();
        let start = Utc.with_ymd_and_hms(2024, 1, 1, 8, 0, 0).unwrap();
        let act = ActivityInput {
            activity_id: Uuid::new_v4(),
            sport: Sport::Running,
            started_at: start,
            ended_at: start + Duration::minutes(30),
            metrics: vec![],
        };
        assert!(te.activity_te(&act).is_none());
    }
}
