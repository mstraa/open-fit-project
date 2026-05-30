//! **Training load**: per-activity TSS + the CTL/ATL/TSB fitness/fatigue/form
//! series over the activity timeline.
//!
//! ## TSS heuristic (documented)
//! For each activity we compute a single **Training Stress Score** in [0, ~500]:
//!
//! - **Power-based** (preferred when a `Power` stream is present, e.g. Stryd
//!   running power or a bike power meter): the Coggan model
//!   `TSS = (duration_s · NP · IF) / (FTP · 3600) · 100`, where the intensity
//!   factor `IF = NP / FTP` and `NP` (normalized power) is the 4th-root of the
//!   mean of the 30 s rolling-average power raised to the 4th power. With our
//!   compact samples we approximate the 30 s rolling average over the available
//!   cadence of samples.
//! - **HR-based (hrTSS)** fallback when no power is present but HR is: we use the
//!   HR-reserve fraction against `LTHR` as the intensity, `hrTSS =
//!   duration_h · IF² · 100`, `IF = (HRavg − HRrest) / (LTHR − HRrest)`. This is
//!   the standard hrTSS approximation; an all-day easy hour at threshold ≈ 100.
//! - If neither power nor HR is present, TSS falls back to a **duration-only**
//!   estimate at an assumed easy IF of 0.65 so the activity still contributes to
//!   load (documented, conservative).
//!
//! All thresholds (LTHR, FTP, HRrest) are [`AthleteThresholds`] parameters.
//!
//! ## CTL / ATL / TSB
//! Over the **daily** timeline of activities we accumulate each day's TSS and run
//! two exponentially-weighted moving averages: CTL (42-day, "fitness") and ATL
//! (7-day, "fatigue"); TSB ("form") = CTL − ATL, lagged by one day (today's form
//! reflects yesterday's fitness/fatigue, per the standard PMC). Emitted as three
//! [`DerivedStream`]s whose samples are `(t_offset_ms_from_first_day, value)`.

use chrono::{DateTime, Datelike, NaiveDate, Utc};
use ofit_core::analytics::{
    AlgorithmInput, AlgorithmKind, AlgorithmOutput, AlgorithmSpec,
};
use ofit_core::{Algorithm, DerivedSubject, Sample, StreamKind};

use crate::input::AnalyticsInput;
use crate::params::{AthleteThresholds, LoadTimeConstants};
use crate::runner::{AlgorithmOutputs, RunnableAlgorithm};

/// Built-in training-load algorithm (TSS + CTL/ATL/TSB).
#[derive(Debug, Clone)]
pub struct TrainingLoad {
    spec: AlgorithmSpec,
    /// Athlete thresholds (LTHR/FTP…).
    pub thresholds: AthleteThresholds,
    /// CTL/ATL time constants.
    pub tc: LoadTimeConstants,
}

impl Default for TrainingLoad {
    fn default() -> Self {
        Self {
            spec: AlgorithmSpec {
                id: "training_load".into(),
                version: "1.0.0".into(),
                name: "Training Load (TSS · CTL/ATL/TSB)".into(),
                description: "Per-activity Training Stress Score (power- or HR-based) and the \
                              exponentially-weighted Fitness (CTL), Fatigue (ATL) and Form (TSB) series."
                    .into(),
                inputs: vec![
                    AlgorithmInput::Stream(StreamKind::Power),
                    AlgorithmInput::Stream(StreamKind::HeartRate),
                ],
                outputs: vec![
                    AlgorithmOutput::Metric("tss".into()),
                    AlgorithmOutput::Stream("ctl".into()),
                    AlgorithmOutput::Stream("atl".into()),
                    AlgorithmOutput::Stream("tsb".into()),
                ],
                applicable_hardware: vec!["any".into()],
                kind: AlgorithmKind::BuiltIn,
            },
            thresholds: AthleteThresholds::default(),
            tc: LoadTimeConstants::default(),
        }
    }
}

/// How a TSS value was derived (for documentation / debugging).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TssMethod {
    /// Power-based (Coggan).
    Power,
    /// HR-reserve based (hrTSS).
    HeartRate,
    /// Duration-only fallback (no intensity stream).
    DurationOnly,
}

impl TrainingLoad {
    /// Compute a single activity's TSS and the method used.
    pub fn activity_tss(
        &self,
        act: &crate::input::ActivityInput,
    ) -> (f64, TssMethod) {
        let dur_s = act.duration_secs().max(0) as f64;
        if dur_s <= 0.0 {
            return (0.0, TssMethod::DurationOnly);
        }
        let th = self.thresholds;

        // Power-based (preferred).
        if let Some(power) = act.metric(StreamKind::Power) {
            let vals: Vec<f64> = power.samples.iter().map(|(_, v)| *v).filter(|v| v.is_finite() && *v >= 0.0).collect();
            if vals.iter().filter(|v| **v > 0.0).count() as f64 >= 0.5 * vals.len().max(1) as f64 && !vals.is_empty() {
                let np = normalized_power(&vals);
                if np > 0.0 && th.ftp > 0.0 {
                    let intensity = np / th.ftp;
                    let tss = (dur_s * np * intensity) / (th.ftp * 3600.0) * 100.0;
                    return (tss.clamp(0.0, 1000.0), TssMethod::Power);
                }
            }
        }

        // HR-based (hrTSS).
        if let Some(hr) = act.metric(StreamKind::HeartRate) {
            if let Some(avg) = hr.mean() {
                let denom = th.lthr - th.hr_rest;
                if denom > 0.0 {
                    let intensity = ((avg - th.hr_rest) / denom).clamp(0.0, 1.3);
                    let tss = (dur_s / 3600.0) * intensity * intensity * 100.0;
                    return (tss.clamp(0.0, 1000.0), TssMethod::HeartRate);
                }
            }
        }

        // Duration-only fallback at an assumed easy IF.
        let if_easy = 0.65;
        let tss = (dur_s / 3600.0) * if_easy * if_easy * 100.0;
        (tss.clamp(0.0, 1000.0), TssMethod::DurationOnly)
    }
}

/// Normalized Power: 4th root of the mean of (30 s rolling-avg power)^4.
///
/// We don't know the exact sample rate, so we use a fixed 30-sample rolling
/// window as a stand-in for the canonical 30 s window (samples are ~1 Hz in our
/// FITs). For short series this gracefully reduces toward the simple average.
fn normalized_power(vals: &[f64]) -> f64 {
    if vals.is_empty() {
        return 0.0;
    }
    let window = 30usize.min(vals.len());
    let mut rolled: Vec<f64> = Vec::with_capacity(vals.len());
    let mut sum = 0.0;
    for i in 0..vals.len() {
        sum += vals[i];
        if i >= window {
            sum -= vals[i - window];
        }
        let n = (i + 1).min(window) as f64;
        rolled.push(sum / n);
    }
    let mean4: f64 = rolled.iter().map(|p| p.powi(4)).sum::<f64>() / rolled.len() as f64;
    mean4.powf(0.25)
}

/// One day's accumulated TSS on the load timeline.
struct DayLoad {
    date: NaiveDate,
    tss: f64,
}

impl Algorithm for TrainingLoad {
    fn spec(&self) -> &AlgorithmSpec {
        &self.spec
    }
}

impl RunnableAlgorithm for TrainingLoad {
    fn compute(&self, input: &AnalyticsInput, computed_at: DateTime<Utc>) -> AlgorithmOutputs {
        let mut out = AlgorithmOutputs::default();
        let acts = input.activities_sorted();
        if acts.is_empty() {
            return out;
        }

        // Per-activity TSS metric.
        let mut per_day: Vec<DayLoad> = Vec::new();
        for act in &acts {
            let (tss, _method) = self.activity_tss(act);
            out.metrics.push(self.spec.tag_metric(
                DerivedSubject::Activity(act.activity_id),
                "tss",
                tss,
                computed_at,
            ));
            let date = act.started_at.date_naive();
            match per_day.last_mut() {
                Some(d) if d.date == date => d.tss += tss,
                _ => per_day.push(DayLoad { date, tss }),
            }
        }

        // Build a dense daily TSS timeline from first to last activity day so the
        // EWMA decays correctly across rest days.
        let first = per_day.first().map(|d| d.date).unwrap();
        let last = per_day.last().map(|d| d.date).unwrap();
        let total_days = (last - first).num_days().max(0) as usize + 1;
        let mut daily = vec![0.0f64; total_days];
        for d in &per_day {
            let idx = (d.date - first).num_days() as usize;
            daily[idx] += d.tss;
        }

        let ctl_alpha = 1.0 - (-1.0 / self.tc.ctl_days).exp();
        let atl_alpha = 1.0 - (-1.0 / self.tc.atl_days).exp();
        let mut ctl = 0.0;
        let mut atl = 0.0;
        let mut ctl_pts: Vec<Sample> = Vec::with_capacity(total_days);
        let mut atl_pts: Vec<Sample> = Vec::with_capacity(total_days);
        let mut tsb_pts: Vec<Sample> = Vec::with_capacity(total_days);

        for (i, tss) in daily.iter().enumerate() {
            // TSB (form) uses *yesterday's* CTL/ATL (PMC lag).
            let tsb = ctl - atl;
            ctl += ctl_alpha * (tss - ctl);
            atl += atl_alpha * (tss - atl);
            // Offset is days-since-first-day expressed in ms (the stream's epoch
            // is the first activity day at 00:00 UTC).
            let off = (i as i64) * 86_400_000;
            ctl_pts.push(Sample::Scalar { t_offset_ms: off, value: ctl });
            atl_pts.push(Sample::Scalar { t_offset_ms: off, value: atl });
            tsb_pts.push(Sample::Scalar { t_offset_ms: off, value: tsb });
        }

        // The CTL/ATL/TSB streams describe the whole timeline → attach to the day
        // subject of the first activity day. (Day subject id is derived from the
        // date so it is stable/recomputable.)
        let day_subject = DerivedSubject::Day(day_uuid(first));
        out.streams.push(self.spec.tag_stream(day_subject, "ctl", ctl_pts, computed_at));
        out.streams.push(self.spec.tag_stream(day_subject, "atl", atl_pts, computed_at));
        out.streams.push(self.spec.tag_stream(day_subject, "tsb", tsb_pts, computed_at));

        out
    }
}

/// Deterministic UUID for a calendar day (so a `DerivedSubject::Day` is stable
/// across recomputes). Encodes the ordinal day number into a v4-shaped UUID.
pub fn day_uuid(date: NaiveDate) -> uuid::Uuid {
    let n = date.num_days_from_ce() as u128;
    // Namespace the value so day subjects don't collide with random v4 ids.
    uuid::Uuid::from_u128(0xDA17_0000_0000_0000_0000_0000_0000_0000 | n)
}

/// Mask isolating the ordinal-day payload bits of a [`day_uuid`].
const DAY_UUID_MASK: u128 = 0x0000_FFFF_FFFF_FFFF_FFFF_FFFF_FFFF_FFFF;
const DAY_UUID_NS: u128 = 0xDA17_0000_0000_0000_0000_0000_0000_0000;

/// Inverse of [`day_uuid`]: recover the [`NaiveDate`] from a `DerivedSubject::Day`
/// id, or `None` if the id was not produced by [`day_uuid`]. Lets the API turn
/// the offset-from-first-day CTL/ATL/TSB samples back into absolute calendar
/// dates for a chart-ready series.
pub fn day_from_uuid(id: uuid::Uuid) -> Option<NaiveDate> {
    let v = id.as_u128();
    if v & !DAY_UUID_MASK != DAY_UUID_NS {
        return None;
    }
    let n = (v & DAY_UUID_MASK) as i32;
    NaiveDate::from_num_days_from_ce_opt(n)
}
