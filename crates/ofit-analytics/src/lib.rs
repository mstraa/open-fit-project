//! # ofit-analytics
//!
//! The algorithm execution layer (PLAN.md Phase 3). It runs **built-in** pure-Rust
//! algorithms (and, in the plugin-host stage, sandboxed WASM plugins) over the
//! canonical activity + wellness data and produces **versioned, recalculable**
//! [`DerivedMetric`](ofit_core::DerivedMetric) /
//! [`DerivedStream`](ofit_core::DerivedStream), each tagged with the producing
//! algorithm's [`PluginRef`](ofit_core::PluginRef) (`id` + `version`).
//!
//! ## Shape
//! - `ofit-core` owns the **spec + trait** ([`ofit_core::AlgorithmSpec`],
//!   [`ofit_core::Algorithm`]) and the derived-output **tagging**.
//! - This crate owns the **compute** seam ([`RunnableAlgorithm`]) plus the
//!   DB-free **input structs** ([`AnalyticsInput`]) the API feeds with real data.
//! - [`builtin_algorithms`] is the registry of built-ins; [`run_for_subject`] is
//!   the orchestration entry point.
//!
//! The input structs carry **no DB dependency** — the API layer loads activities
//! (with their resolved scalar streams) and the wellness series from `ofit-db`
//! and constructs [`AnalyticsInput`]; tests construct it from synthetic data.

pub mod algorithms;
pub mod input;
pub mod params;
pub mod runner;

pub use algorithms::{AnomalyFlag, Readiness, TrainingLoad, TssMethod};
pub use input::{ActivityInput, AnalyticsInput, MetricSeries, WellnessPoint};
pub use params::{AthleteThresholds, LoadTimeConstants, ReadinessParams};
pub use runner::{AlgorithmOutputs, RunnableAlgorithm};

use chrono::{DateTime, Utc};

/// The registry of built-in algorithms (PLAN.md: "algos built-in … versionnés et
/// sélectionnables"). Each is a boxed [`RunnableAlgorithm`] carrying its
/// [`ofit_core::AlgorithmSpec`]. The API/registry list these and expose their
/// specs; the orchestrator runs them.
pub fn builtin_algorithms() -> Vec<Box<dyn RunnableAlgorithm>> {
    vec![
        Box::new(TrainingLoad::default()),
        Box::new(Readiness::default()),
        Box::new(AnomalyFlag::default()),
    ]
}

/// The specs of all built-in algorithms (cheap to list without running them).
pub fn builtin_specs() -> Vec<ofit_core::AlgorithmSpec> {
    builtin_algorithms().iter().map(|a| a.spec().clone()).collect()
}

/// Orchestration entry: run **all** built-in algorithms over one subject's
/// [`AnalyticsInput`] and collect their derived outputs.
///
/// Every output is already tagged with its algorithm's `PluginRef(id, version)`
/// and stamped `computed_at = now`, so the DB layer can upsert + supersede stale
/// derivations by `(plugin_id, version, subject, name)`. Algorithms that lack
/// their required inputs degrade gracefully (fewer/zero outputs), never panic.
pub fn run_for_subject(input: &AnalyticsInput) -> AlgorithmOutputs {
    run_for_subject_at(input, Utc::now())
}

/// Like [`run_for_subject`] but with an explicit `computed_at` clock (for
/// deterministic tests / reproducible batch recompute).
pub fn run_for_subject_at(input: &AnalyticsInput, computed_at: DateTime<Utc>) -> AlgorithmOutputs {
    let mut out = AlgorithmOutputs::default();
    for algo in builtin_algorithms() {
        out.extend(algo.compute(input, computed_at));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone};
    use ofit_core::analytics::AlgorithmKind;
    use ofit_core::{DerivedSubject, Sample, Sport, StreamKind, WellnessKind};
    use uuid::Uuid;

    fn day(y: i32, m: u32, d: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, 8, 0, 0).unwrap()
    }

    /// One ~1 Hz scalar series of length `n` with constant `value`.
    fn series(kind: StreamKind, n: usize, value: f64) -> MetricSeries {
        let samples = (0..n).map(|i| (i as i64 * 1000, value)).collect();
        MetricSeries::new(kind, samples)
    }

    fn activity(
        start: DateTime<Utc>,
        dur_min: i64,
        sport: Sport,
        metrics: Vec<MetricSeries>,
    ) -> ActivityInput {
        ActivityInput {
            activity_id: Uuid::new_v4(),
            sport,
            started_at: start,
            ended_at: start + Duration::minutes(dur_min),
            metrics,
        }
    }

    #[test]
    fn builtin_registry_specs_are_versioned_and_well_formed() {
        let specs = builtin_specs();
        assert_eq!(specs.len(), 3);
        for s in &specs {
            assert!(!s.id.is_empty());
            // version parses as semver-ish (three dot-separated numbers).
            let parts: Vec<_> = s.version.split('.').collect();
            assert_eq!(parts.len(), 3, "version {} not x.y.z", s.version);
            assert!(parts.iter().all(|p| p.parse::<u32>().is_ok()));
            assert!(!s.outputs.is_empty());
            assert_eq!(s.kind, AlgorithmKind::BuiltIn);
        }
        // ids are unique.
        let mut ids: Vec<_> = specs.iter().map(|s| s.id.clone()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 3);
    }

    #[test]
    fn hr_based_tss_is_in_sane_range() {
        // 60 min at HR 150 with default LTHR 165, rest 50:
        // IF = (150-50)/(165-50) = 0.87 → hrTSS = 1h · 0.87² · 100 ≈ 75.6.
        let tl = TrainingLoad::default();
        let act = activity(day(2024, 1, 1), 60, Sport::Running, vec![series(StreamKind::HeartRate, 3600, 150.0)]);
        let (tss, method) = tl.activity_tss(&act);
        assert_eq!(method, TssMethod::HeartRate);
        assert!((70.0..82.0).contains(&tss), "hrTSS out of range: {tss}");
    }

    #[test]
    fn power_based_tss_preferred_and_sane() {
        // 60 min at constant 250 W == FTP → IF≈1.0 → TSS≈100.
        let tl = TrainingLoad::default();
        let act = activity(
            day(2024, 1, 1),
            60,
            Sport::Cycling,
            vec![series(StreamKind::Power, 3600, 250.0), series(StreamKind::HeartRate, 3600, 150.0)],
        );
        let (tss, method) = tl.activity_tss(&act);
        assert_eq!(method, TssMethod::Power, "power must win over HR when present");
        assert!((95.0..105.0).contains(&tss), "power TSS out of range: {tss}");
    }

    #[test]
    fn duration_only_fallback_when_no_intensity_stream() {
        let tl = TrainingLoad::default();
        let act = activity(day(2024, 1, 1), 60, Sport::Running, vec![series(StreamKind::Cadence, 3600, 85.0)]);
        let (tss, method) = tl.activity_tss(&act);
        assert_eq!(method, TssMethod::DurationOnly);
        // 1h · 0.65² · 100 ≈ 42.
        assert!((38.0..46.0).contains(&tss), "fallback TSS out of range: {tss}");
    }

    #[test]
    fn ctl_atl_tsb_produced_over_timeline() {
        let tl = TrainingLoad::default();
        // Two HR activities a few days apart.
        let a1 = activity(day(2024, 1, 1), 60, Sport::Running, vec![series(StreamKind::HeartRate, 3600, 150.0)]);
        let a2 = activity(day(2024, 1, 4), 45, Sport::Running, vec![series(StreamKind::HeartRate, 2700, 155.0)]);
        let input = AnalyticsInput { activities: vec![a1, a2], wellness: vec![] };
        let out = tl.compute(&input, day(2024, 1, 5));

        // 2 per-activity TSS metrics.
        let tss: Vec<_> = out.metrics.iter().filter(|m| m.name == "tss").collect();
        assert_eq!(tss.len(), 2);
        assert!(tss.iter().all(|m| m.value > 0.0));

        // ctl/atl/tsb streams each span Jan 1..Jan 4 = 4 days.
        for name in ["ctl", "atl", "tsb"] {
            let s = out.streams.iter().find(|s| s.name == name).unwrap();
            assert_eq!(s.samples.len(), 4, "{name} should have 4 daily points");
            assert_eq!(s.plugin.plugin_id, "training_load");
            assert_eq!(s.plugin.version, "1.0.0");
            assert!(matches!(s.subject, DerivedSubject::Day(_)));
        }
        // CTL rises from 0; ATL responds faster → after load, ATL > CTL, so TSB<0.
        let ctl = out.streams.iter().find(|s| s.name == "ctl").unwrap();
        let last_ctl = match ctl.samples.last().unwrap() {
            Sample::Scalar { value, .. } => *value,
            _ => unreachable!(),
        };
        assert!(last_ctl > 0.0);
    }

    #[test]
    fn readiness_computed_with_enough_wellness() {
        let r = Readiness::default();
        // 7 days of HRV around a baseline of 60, today elevated to 75 (more ready);
        // resting HR baseline ~55, today 50 (more ready).
        let base = day(2024, 1, 1);
        let mut wellness = vec![];
        for i in 0..7 {
            let ts = base + Duration::days(i);
            let hrv = if i == 6 { 75.0 } else { 60.0 };
            let rhr = if i == 6 { 50.0 } else { 55.0 };
            wellness.push(WellnessPoint { kind: WellnessKind::Hrv, value: hrv, ts });
            wellness.push(WellnessPoint { kind: WellnessKind::RestingHeartRate, value: rhr, ts });
        }
        let input = AnalyticsInput { activities: vec![], wellness };
        let out = r.compute(&input, base + Duration::days(6));

        let avail = out.metrics.iter().find(|m| m.name == "readiness_available").unwrap();
        assert_eq!(avail.value, 1.0);
        let readiness = out.metrics.iter().find(|m| m.name == "readiness").unwrap();
        assert!((50.0..=100.0).contains(&readiness.value), "elevated HRV → ready: {}", readiness.value);
        assert_eq!(readiness.plugin.plugin_id, "readiness");
        // hrv summary metrics present.
        assert!(out.metrics.iter().any(|m| m.name == "hrv_rmssd"));
        assert!(out.metrics.iter().any(|m| m.name == "hrv_baseline"));
    }

    #[test]
    fn readiness_degrades_to_insufficient_when_sparse() {
        let r = Readiness::default();
        // Only one HRV reading → below min_hrv_samples (3).
        let input = AnalyticsInput {
            activities: vec![],
            wellness: vec![WellnessPoint { kind: WellnessKind::Hrv, value: 60.0, ts: day(2024, 1, 1) }],
        };
        let out = r.compute(&input, day(2024, 1, 1));
        let avail = out.metrics.iter().find(|m| m.name == "readiness_available").unwrap();
        assert_eq!(avail.value, 0.0, "sparse wellness → insufficient data");
        assert!(!out.metrics.iter().any(|m| m.name == "readiness"));
    }

    #[test]
    fn readiness_degrades_with_empty_wellness() {
        let r = Readiness::default();
        let input = AnalyticsInput::default();
        let out = r.compute(&input, day(2024, 1, 1));
        let avail = out.metrics.iter().find(|m| m.name == "readiness_available").unwrap();
        assert_eq!(avail.value, 0.0);
    }

    #[test]
    fn orchestrator_runs_all_builtins_and_tags_outputs() {
        let base = day(2024, 1, 1);
        let act = activity(base, 60, Sport::Running, vec![series(StreamKind::HeartRate, 3600, 150.0)]);
        let mut wellness = vec![];
        for i in 0..7 {
            let ts = base + Duration::days(i);
            wellness.push(WellnessPoint { kind: WellnessKind::Hrv, value: 60.0, ts });
            wellness.push(WellnessPoint { kind: WellnessKind::RestingHeartRate, value: 55.0, ts });
        }
        let input = AnalyticsInput { activities: vec![act], wellness };
        let out = run_for_subject_at(&input, base + Duration::days(6));

        // Outputs from multiple algorithms present, all tagged with a plugin ref.
        assert!(out.metrics.iter().any(|m| m.plugin.plugin_id == "training_load"));
        assert!(out.metrics.iter().any(|m| m.plugin.plugin_id == "readiness"));
        assert!(out.streams.iter().any(|s| s.plugin.plugin_id == "training_load"));
        for m in &out.metrics {
            assert!(!m.plugin.version.is_empty());
        }
    }

    #[test]
    fn anomaly_flags_outlier_resting_hr() {
        let a = AnomalyFlag::default();
        let base = day(2024, 1, 1);
        let mut wellness = vec![];
        // Steady ~55 then a spike to 80 (clear outlier).
        for i in 0..6 {
            wellness.push(WellnessPoint {
                kind: WellnessKind::RestingHeartRate,
                value: if i == 5 { 80.0 } else { 55.0 },
                ts: base + Duration::days(i),
            });
        }
        let input = AnalyticsInput { activities: vec![], wellness };
        let out = a.compute(&input, base + Duration::days(5));
        let flag = out.metrics.iter().find(|m| m.name == "resting_hr_anomaly").unwrap();
        assert_eq!(flag.value, 1.0, "spike should be flagged");
    }
}
