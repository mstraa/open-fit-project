//! **Sleep summary & score** from continuous sleep-stage wellness.
//!
//! From per-minute [`WellnessKind::SleepStage`] samples (awake / light / deep /
//! REM — exactly what the Zepp/Gadgetbridge importers persist) we group minutes
//! into **nights** and, for each night, emit:
//!
//! - `sleep_total_min` — minutes asleep (light + deep + REM; awake excluded).
//! - `sleep_deep_min` / `sleep_rem_min` / `sleep_light_min` / `sleep_awake_min`.
//! - `sleep_score` — a 0–100 heuristic blending **duration** (8 h = full marks)
//!   and **quality** (share of deep+REM vs an ideal ~40 %).
//! - `sleep_available` — `1` for nights with data (so the UI can show
//!   "insufficient data" without guessing).
//!
//! ### Night attribution
//! A sleep minute timestamped at hour ≥ 18:00 belongs to the night *labelled by
//! the following morning*; earlier minutes (the small hours through the
//! afternoon) belong to the current calendar day. So an evening→morning sleep
//! that crosses midnight collapses to a single night keyed by the wake-up date —
//! the date a person would call "last night's sleep".
//!
//! ### Score heuristic (documented, not clinical)
//! `dur = min(total_min / 480, 1)·100` (8 h target); `qual = min((deep+rem)/total
//! / 0.40, 1)·100` (≈40 % deep+REM ideal). `score = clamp(0.7·dur + 0.3·qual, 0,
//! 100)`. Graceful: nights with < `min_minutes` of data are skipped; if there is
//! no sleep data at all, a single `sleep_available = 0` is emitted for today.

use std::collections::BTreeMap;

use chrono::{DateTime, Duration, NaiveDate, Timelike, Utc};
use ofit_core::analytics::{AlgorithmInput, AlgorithmKind, AlgorithmOutput, AlgorithmSpec};
use ofit_core::{Algorithm, DerivedSubject, SleepStage, WellnessKind};

use crate::algorithms::training_load::day_uuid;
use crate::input::AnalyticsInput;
use crate::runner::{AlgorithmOutputs, RunnableAlgorithm};

/// Built-in sleep-summary + sleep-score algorithm.
#[derive(Debug, Clone)]
pub struct Sleep {
    spec: AlgorithmSpec,
    /// Minimum minutes of staged data for a night to count.
    pub min_minutes: usize,
}

impl Default for Sleep {
    fn default() -> Self {
        Self {
            spec: AlgorithmSpec {
                id: "sleep".into(),
                version: "1.0.0".into(),
                name: "Sleep Summary & Score".into(),
                description: "Nightly sleep duration, stage breakdown (deep/REM/light/awake) and a \
                              0–100 sleep score from per-minute sleep-stage samples; degrades to \
                              insufficient-data when no staging is present."
                    .into(),
                inputs: vec![AlgorithmInput::Wellness(WellnessKind::SleepStage)],
                outputs: vec![
                    AlgorithmOutput::Metric("sleep_total_min".into()),
                    AlgorithmOutput::Metric("sleep_deep_min".into()),
                    AlgorithmOutput::Metric("sleep_rem_min".into()),
                    AlgorithmOutput::Metric("sleep_light_min".into()),
                    AlgorithmOutput::Metric("sleep_awake_min".into()),
                    AlgorithmOutput::Metric("sleep_score".into()),
                    AlgorithmOutput::Metric("sleep_available".into()),
                ],
                applicable_hardware: vec!["any".into(), "sleep-tracker".into()],
                kind: AlgorithmKind::BuiltIn,
            },
            min_minutes: 30,
        }
    }
}

impl Algorithm for Sleep {
    fn spec(&self) -> &AlgorithmSpec {
        &self.spec
    }
}

/// Per-night accumulator (minutes in each stage).
#[derive(Default, Clone, Copy)]
struct Night {
    light: f64,
    deep: f64,
    rem: f64,
    awake: f64,
}

impl Night {
    fn asleep(&self) -> f64 {
        self.light + self.deep + self.rem
    }
    fn staged(&self) -> f64 {
        self.asleep() + self.awake
    }
}

/// The "sleep date" a timestamp belongs to: evening (≥18:00) rolls into the next
/// morning, so a night that crosses midnight is keyed by the wake-up date.
fn sleep_date(ts: DateTime<Utc>) -> NaiveDate {
    if ts.hour() >= 18 {
        ts.date_naive() + Duration::days(1)
    } else {
        ts.date_naive()
    }
}

impl RunnableAlgorithm for Sleep {
    fn compute(&self, input: &AnalyticsInput, computed_at: DateTime<Utc>) -> AlgorithmOutputs {
        let mut out = AlgorithmOutputs::default();
        let stages = input.wellness_of(WellnessKind::SleepStage);

        if stages.is_empty() {
            let subject = DerivedSubject::Day(day_uuid(computed_at.date_naive()));
            out.metrics
                .push(self.spec.tag_metric(subject, "sleep_available", 0.0, computed_at));
            return out;
        }

        // Bucket each minute-sample into its night. Each sample represents ~1
        // minute in the named stage (the importers emit one per minute).
        let mut nights: BTreeMap<NaiveDate, Night> = BTreeMap::new();
        for p in &stages {
            let n = nights.entry(sleep_date(p.ts)).or_default();
            match decode_stage(p.value) {
                Some(SleepStage::Light) => n.light += 1.0,
                Some(SleepStage::Deep) => n.deep += 1.0,
                Some(SleepStage::Rem) => n.rem += 1.0,
                Some(SleepStage::Awake) => n.awake += 1.0,
                None => {}
            }
        }

        for (date, night) in nights {
            if (night.staged() as usize) < self.min_minutes {
                continue;
            }
            let subject = DerivedSubject::Day(day_uuid(date));
            let total = night.asleep();
            out.metrics
                .push(self.spec.tag_metric(subject, "sleep_total_min", total, computed_at));
            out.metrics
                .push(self.spec.tag_metric(subject, "sleep_deep_min", night.deep, computed_at));
            out.metrics
                .push(self.spec.tag_metric(subject, "sleep_rem_min", night.rem, computed_at));
            out.metrics
                .push(self.spec.tag_metric(subject, "sleep_light_min", night.light, computed_at));
            out.metrics
                .push(self.spec.tag_metric(subject, "sleep_awake_min", night.awake, computed_at));
            out.metrics
                .push(self.spec.tag_metric(subject, "sleep_score", score(&night), computed_at));
            out.metrics
                .push(self.spec.tag_metric(subject, "sleep_available", 1.0, computed_at));
        }
        out
    }
}

/// 0–100 sleep score: 70 % duration (8 h target) + 30 % quality (deep+REM share).
fn score(n: &Night) -> f64 {
    let total = n.asleep();
    if total <= 0.0 {
        return 0.0;
    }
    let dur = (total / 480.0).min(1.0) * 100.0;
    let qual = (((n.deep + n.rem) / total) / 0.40).min(1.0) * 100.0;
    (0.7 * dur + 0.3 * qual).clamp(0.0, 100.0)
}

/// Map a stored [`SleepStage::code`] back to the stage.
fn decode_stage(v: f64) -> Option<SleepStage> {
    match v.round() as i64 {
        0 => Some(SleepStage::Awake),
        1 => Some(SleepStage::Light),
        2 => Some(SleepStage::Deep),
        3 => Some(SleepStage::Rem),
        _ => None,
    }
}
