//! Tunable parameters for the built-in algorithms — the single source of truth
//! for every heuristic constant, its default, valid range, and the algorithm(s)
//! it affects.
//!
//! Historically each algorithm hard-coded its thresholds (LTHR, FTP, EWMA time
//! constants, the whole body-battery + HR-sleep models…). They now live here as
//! one flat [`AnalyticsParams`] so the API can (a) expose every constant as a user
//! setting, (b) build the effective params from the settings store, and (c) derive
//! a stable **fingerprint** per algorithm — the parameter half of a derivation's
//! identity `(plugin_id, code_version, params_hash)`.
//!
//! Design notes:
//! - **Flat + f64**: every parameter is an `f64` field; integer-valued ones (day
//!   counts, sample windows, percentile denominators) are rounded at the point of
//!   use. This keeps the registry uniform and the settings store (untyped TEXT)
//!   trivial to parse. Behaviour-preserving: integer divisions like `len / 20`
//!   stay integer (the denominator is a parameter, not a float fraction).
//! - **Registry-driven**: [`REGISTRY`] is the canonical list. [`AnalyticsParams::default`]
//!   holds the literal defaults; everything else (settings overlay, the
//!   value/clamp metadata, the fingerprint) is computed from the registry so the
//!   three can't drift.

use std::collections::HashMap;

/// Whether a parameter is surfaced prominently in the UI (`Curated`) or lives in
/// an "Advanced" drawer (`Advanced`). Everything is overridable either way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    /// Meaningful, everyday knob — shown prominently.
    Curated,
    /// Internal/expert knob — overridable but tucked away.
    Advanced,
}

impl Tier {
    /// Lowercase tag (`"curated"` / `"advanced"`) for the API/UI.
    pub fn as_str(&self) -> &'static str {
        match self {
            Tier::Curated => "curated",
            Tier::Advanced => "advanced",
        }
    }
}

/// A single tunable parameter: its settings key, display metadata, valid range,
/// the algorithm group it belongs to, and the derived algorithm(s) whose output
/// identity it feeds (for fingerprinting). `getter`/`setter` bind it to its field
/// in [`AnalyticsParams`].
#[derive(Clone, Copy)]
pub struct ParamDef {
    /// Settings key, e.g. `"analytics.athlete.lthr_bpm"`.
    pub key: &'static str,
    /// Short human label.
    pub label: &'static str,
    /// One-line description.
    pub description: &'static str,
    /// Unit suffix (`"bpm"`, `"days"`, `""`…).
    pub unit: &'static str,
    /// UI/algorithm grouping (`"athlete"`, `"body_battery"`…).
    pub group: &'static str,
    /// Inclusive lower bound (clamped on overlay), if any.
    pub min: Option<f64>,
    /// Inclusive upper bound (clamped on overlay), if any.
    pub max: Option<f64>,
    /// Whether the value is conceptually integer (UI hint; rounded at use site).
    pub integer: bool,
    /// Curated vs advanced surface.
    pub tier: Tier,
    /// Derived algorithm ids whose output identity this parameter affects (used to
    /// fingerprint a plugin's parameter set). Empty = affects only computed
    /// wellness (e.g. body battery), not a versioned derived output.
    pub plugins: &'static [&'static str],
    getter: fn(&AnalyticsParams) -> f64,
    setter: fn(&mut AnalyticsParams, f64),
}

impl ParamDef {
    /// This parameter's current value in `p`.
    pub fn value(&self, p: &AnalyticsParams) -> f64 {
        (self.getter)(p)
    }
    /// Set this parameter in `p` (clamped to `[min, max]`).
    pub fn apply(&self, p: &mut AnalyticsParams, v: f64) {
        let v = match (self.min, self.max) {
            (Some(lo), Some(hi)) => v.clamp(lo, hi),
            (Some(lo), None) => v.max(lo),
            (None, Some(hi)) => v.min(hi),
            (None, None) => v,
        };
        (self.setter)(p, v);
    }
    /// The factory default for this parameter.
    pub fn default_value(&self) -> f64 {
        (self.getter)(&AnalyticsParams::default())
    }
}

/// The full effective parameter set fed to every built-in algorithm and gap-fill
/// function. All fields are `f64`; see module docs.
#[derive(Debug, Clone, PartialEq)]
pub struct AnalyticsParams {
    // ---- athlete thresholds (shared by training_load + training_effect) ----
    pub lthr: f64,
    pub ftp: f64,
    pub hr_max: f64,
    pub hr_rest: f64,
    // ---- training load ----
    pub ctl_days: f64,
    pub atl_days: f64,
    pub tl_fallback_if: f64,
    pub tl_hr_intensity_max: f64,
    pub tl_power_cov_min: f64,
    pub tl_tss_clamp_max: f64,
    pub tl_np_window: f64,
    // ---- training effect ----
    pub te_trimp_a: f64,
    pub te_trimp_b: f64,
    pub te_anaerobic_hrr: f64,
    pub te_aerobic_scale: f64,
    pub te_anaerobic_scale: f64,
    pub te_scale_max: f64,
    pub te_max_gap_min: f64,
    pub te_min_hr_samples: f64,
    // ---- readiness ----
    pub rd_baseline_days: f64,
    pub rd_min_hrv_samples: f64,
    pub rd_weight_hrv: f64,
    pub rd_weight_rhr: f64,
    pub rd_score_center: f64,
    pub rd_score_span: f64,
    pub rd_deviation_clamp: f64,
    // ---- sleep summary/score ----
    pub sl_min_minutes: f64,
    pub sl_duration_target: f64,
    pub sl_ideal_deep_rem: f64,
    pub sl_weight_duration: f64,
    pub sl_weight_quality: f64,
    // ---- anomaly ----
    pub an_z: f64,
    pub an_min_samples: f64,
    pub an_flat_tol: f64,
    // ---- body battery (gap-fill → BodyBattery wellness) ----
    pub bb_gain: f64,
    pub bb_revert: f64,
    pub bb_center: f64,
    pub bb_max_dt_min: f64,
    pub bb_min_emit_min: f64,
    pub bb_pivot_min: f64,
    pub bb_pivot_max: f64,
    pub bb_initial: f64,
    pub bb_median_fallback: f64,
    // ---- resting HR (gap-fill → RestingHeartRate wellness → readiness/anomaly) ----
    pub rhr_hr_min: f64,
    pub rhr_hr_max: f64,
    pub rhr_min_readings: f64,
    pub rhr_low_decile_denom: f64,
    pub rhr_low_decile_floor: f64,
    // ---- HR-derived sleep (gap-fill → SleepStage wellness → sleep) ----
    pub hs_min_block_min: f64,
    pub hs_max_gap_min: f64,
    pub hs_default_deep_frac: f64,
    pub hs_default_rem_frac: f64,
    pub hs_default_awake_off: f64,
    pub hs_valid_hr_min: f64,
    pub hs_valid_hr_max: f64,
    pub hs_global_floor_denom: f64,
    pub hs_awake_breakout_margin: f64,
    pub hs_min_blip_min: f64,
    pub hs_night_floor_denom: f64,
    pub hs_edge_trim_offset: f64,
    pub hs_smooth_window: f64,
    pub hs_night_start_hour: f64,
    pub hs_night_end_hour: f64,
    pub hs_calib_min_night_minutes: f64,
    pub hs_calib_min_asleep_minutes: f64,
    pub hs_calib_floor_denom: f64,
    pub hs_calib_min_nights: f64,
    pub hs_deep_frac_min: f64,
    pub hs_deep_frac_max: f64,
    pub hs_rem_frac_min: f64,
    pub hs_rem_frac_max: f64,
    pub hs_awake_off_min_apply: f64,
    pub hs_awake_off_min: f64,
    pub hs_awake_off_max: f64,
}

impl Default for AnalyticsParams {
    fn default() -> Self {
        // The literal factory defaults (the standard sports-science values that
        // these algorithms shipped with). Single source of defaults — the registry
        // derives `default_value()` from here.
        Self {
            lthr: 165.0,
            ftp: 250.0,
            hr_max: 190.0,
            hr_rest: 50.0,
            ctl_days: 42.0,
            atl_days: 7.0,
            tl_fallback_if: 0.65,
            tl_hr_intensity_max: 1.3,
            tl_power_cov_min: 0.5,
            tl_tss_clamp_max: 1000.0,
            tl_np_window: 30.0,
            te_trimp_a: 0.64,
            te_trimp_b: 1.92,
            te_anaerobic_hrr: 0.85,
            te_aerobic_scale: 80.0,
            te_anaerobic_scale: 8.0,
            te_scale_max: 5.0,
            te_max_gap_min: 1.0,
            te_min_hr_samples: 2.0,
            rd_baseline_days: 7.0,
            rd_min_hrv_samples: 3.0,
            rd_weight_hrv: 0.6,
            rd_weight_rhr: 0.4,
            rd_score_center: 50.0,
            rd_score_span: 50.0,
            rd_deviation_clamp: 1.0,
            sl_min_minutes: 30.0,
            sl_duration_target: 480.0,
            sl_ideal_deep_rem: 0.40,
            sl_weight_duration: 0.7,
            sl_weight_quality: 0.3,
            an_z: 2.5,
            an_min_samples: 5.0,
            an_flat_tol: 5.0,
            bb_gain: 0.004,
            bb_revert: 0.003,
            bb_center: 65.0,
            bb_max_dt_min: 5.0,
            bb_min_emit_min: 10.0,
            bb_pivot_min: 25.0,
            bb_pivot_max: 45.0,
            bb_initial: 50.0,
            bb_median_fallback: 30.0,
            rhr_hr_min: 30.0,
            rhr_hr_max: 220.0,
            rhr_min_readings: 20.0,
            rhr_low_decile_denom: 10.0,
            rhr_low_decile_floor: 5.0,
            hs_min_block_min: 150.0,
            hs_max_gap_min: 15.0,
            hs_default_deep_frac: 0.16,
            hs_default_rem_frac: 0.22,
            hs_default_awake_off: 20.0,
            hs_valid_hr_min: 30.0,
            hs_valid_hr_max: 210.0,
            hs_global_floor_denom: 10.0,
            hs_awake_breakout_margin: 8.0,
            hs_min_blip_min: 20.0,
            hs_night_floor_denom: 20.0,
            hs_edge_trim_offset: 12.0,
            hs_smooth_window: 9.0,
            hs_night_start_hour: 21.0,
            hs_night_end_hour: 11.0,
            hs_calib_min_night_minutes: 120.0,
            hs_calib_min_asleep_minutes: 60.0,
            hs_calib_floor_denom: 20.0,
            hs_calib_min_nights: 3.0,
            hs_deep_frac_min: 0.05,
            hs_deep_frac_max: 0.35,
            hs_rem_frac_min: 0.05,
            hs_rem_frac_max: 0.40,
            hs_awake_off_min_apply: 10.0,
            hs_awake_off_min: 14.0,
            hs_awake_off_max: 30.0,
        }
    }
}

/// Convenience: build a [`ParamDef`] binding to a field by name.
macro_rules! pdef {
    ($key:literal, $field:ident, $group:literal, $tier:expr, $int:expr,
     $min:expr, $max:expr, $plugins:expr, $unit:literal, $label:literal, $desc:literal) => {
        ParamDef {
            key: $key,
            label: $label,
            description: $desc,
            unit: $unit,
            group: $group,
            min: $min,
            max: $max,
            integer: $int,
            tier: $tier,
            plugins: $plugins,
            getter: |p| p.$field,
            setter: |p, v| p.$field = v,
        }
    };
}

use Tier::{Advanced, Curated};

/// The canonical list of every tunable parameter. Order is the display order.
pub static REGISTRY: &[ParamDef] = &[
    // ---- athlete ----
    pdef!("analytics.athlete.lthr_bpm", lthr, "athlete", Curated, false, Some(80.0), Some(220.0), &["training_load"], "bpm", "Lactate-threshold HR", "HR ceiling used to normalize hrTSS intensity."),
    pdef!("analytics.athlete.ftp_watts", ftp, "athlete", Curated, false, Some(50.0), Some(600.0), &["training_load"], "W", "Functional threshold power", "Power threshold for power-based (Coggan) TSS."),
    pdef!("analytics.athlete.hr_max_bpm", hr_max, "athlete", Curated, false, Some(120.0), Some(230.0), &["training_effect"], "bpm", "Maximum HR", "Top of the HR-reserve scale for Training Effect."),
    pdef!("analytics.athlete.hr_rest_bpm", hr_rest, "athlete", Curated, false, Some(30.0), Some(90.0), &["training_load", "training_effect"], "bpm", "Resting HR (reserve floor)", "Floor of the HR-reserve scale for hrTSS and TE."),
    // ---- training load ----
    pdef!("analytics.training_load.ctl_days", ctl_days, "training_load", Curated, true, Some(7.0), Some(84.0), &["training_load"], "days", "Fitness time constant (CTL)", "Chronic-load EWMA time constant."),
    pdef!("analytics.training_load.atl_days", atl_days, "training_load", Curated, true, Some(3.0), Some(28.0), &["training_load"], "days", "Fatigue time constant (ATL)", "Acute-load EWMA time constant."),
    pdef!("analytics.training_load.fallback_if", tl_fallback_if, "training_load", Advanced, false, Some(0.3), Some(1.0), &["training_load"], "IF", "Duration-only intensity", "Assumed easy IF when neither power nor HR is present."),
    pdef!("analytics.training_load.hr_intensity_max", tl_hr_intensity_max, "training_load", Advanced, false, Some(1.0), Some(2.0), &["training_load"], "", "hrTSS intensity cap", "Caps the HR-reserve intensity factor before squaring."),
    pdef!("analytics.training_load.power_coverage_min_frac", tl_power_cov_min, "training_load", Advanced, false, Some(0.0), Some(1.0), &["training_load"], "frac", "Min power coverage", "Fraction of non-zero power samples required to use power TSS."),
    pdef!("analytics.training_load.tss_clamp_max", tl_tss_clamp_max, "training_load", Advanced, false, Some(100.0), Some(2000.0), &["training_load"], "TSS", "Per-activity TSS cap", "Hard cap on a single activity's TSS."),
    pdef!("analytics.training_load.np_window_samples", tl_np_window, "training_load", Advanced, true, Some(1.0), Some(120.0), &["training_load"], "samples", "Normalized-power window", "Rolling-average window for Normalized Power."),
    // ---- training effect ----
    pdef!("analytics.training_effect.trimp_coeff_a", te_trimp_a, "training_effect", Advanced, false, Some(0.1), Some(2.0), &["training_effect"], "", "TRIMP scale coeff (a)", "Banister per-minute TRIMP scale coefficient."),
    pdef!("analytics.training_effect.trimp_coeff_b", te_trimp_b, "training_effect", Advanced, false, Some(0.5), Some(4.0), &["training_effect"], "", "TRIMP exponent coeff (b)", "Banister TRIMP exponential weighting coefficient."),
    pdef!("analytics.training_effect.anaerobic_hrr_threshold", te_anaerobic_hrr, "training_effect", Curated, false, Some(0.5), Some(1.0), &["training_effect"], "frac", "Anaerobic HRr threshold", "HR-reserve fraction above which a minute counts as anaerobic."),
    pdef!("analytics.training_effect.aerobic_trimp_scale", te_aerobic_scale, "training_effect", Advanced, false, Some(10.0), Some(300.0), &["training_effect"], "", "Aerobic TE scale", "Denominator mapping TRIMP onto the 0–5 aerobic TE."),
    pdef!("analytics.training_effect.anaerobic_trimp_scale", te_anaerobic_scale, "training_effect", Advanced, false, Some(1.0), Some(50.0), &["training_effect"], "", "Anaerobic TE scale", "Denominator mapping high-intensity TRIMP onto anaerobic TE."),
    pdef!("analytics.training_effect.te_scale_max", te_scale_max, "training_effect", Advanced, false, Some(1.0), Some(10.0), &["training_effect"], "", "TE scale maximum", "Upper bound of the aerobic/anaerobic TE scale."),
    pdef!("analytics.training_effect.max_gap_min", te_max_gap_min, "training_effect", Advanced, false, Some(0.1), Some(10.0), &["training_effect"], "min", "Inter-sample gap cap", "Caps per-sample dt so a sync hole can't inflate TRIMP."),
    pdef!("analytics.training_effect.min_hr_samples", te_min_hr_samples, "training_effect", Advanced, true, Some(2.0), Some(100.0), &["training_effect"], "", "Min HR samples", "Minimum HR samples before Training Effect is produced."),
    // ---- readiness ----
    pdef!("analytics.readiness.baseline_days", rd_baseline_days, "readiness", Curated, true, Some(3.0), Some(60.0), &["readiness"], "days", "Baseline window", "Trailing days forming the personal HRV/RHR baseline."),
    pdef!("analytics.readiness.min_hrv_samples", rd_min_hrv_samples, "readiness", Advanced, true, Some(1.0), Some(30.0), &["readiness"], "", "Min HRV samples", "Below this many HRV readings, readiness degrades."),
    pdef!("analytics.readiness.weight_hrv", rd_weight_hrv, "readiness", Curated, false, Some(0.0), Some(1.0), &["readiness"], "", "HRV weight", "Weight of the HRV deviation in the readiness blend."),
    pdef!("analytics.readiness.weight_rhr", rd_weight_rhr, "readiness", Curated, false, Some(0.0), Some(1.0), &["readiness"], "", "Resting-HR weight", "Weight of the resting-HR deviation in the blend."),
    pdef!("analytics.readiness.score_center", rd_score_center, "readiness", Advanced, false, Some(0.0), Some(100.0), &["readiness"], "", "Score center", "Neutral-day readiness score."),
    pdef!("analytics.readiness.score_span", rd_score_span, "readiness", Advanced, false, Some(0.0), Some(100.0), &["readiness"], "", "Score span", "Full-scale sensitivity of the readiness score."),
    pdef!("analytics.readiness.deviation_clamp", rd_deviation_clamp, "readiness", Advanced, false, Some(0.1), Some(5.0), &["readiness"], "", "Deviation clamp", "Caps each normalized HRV/RHR deviation."),
    // ---- sleep summary/score ----
    pdef!("analytics.sleep.min_minutes", sl_min_minutes, "sleep", Curated, true, Some(0.0), Some(240.0), &["sleep"], "min", "Min staged minutes/night", "Nights with fewer staged minutes are skipped."),
    pdef!("analytics.sleep.duration_target_min", sl_duration_target, "sleep", Curated, true, Some(240.0), Some(720.0), &["sleep"], "min", "Sleep-duration target", "Duration that earns full duration credit in the score."),
    pdef!("analytics.sleep.ideal_deep_rem_frac", sl_ideal_deep_rem, "sleep", Advanced, false, Some(0.1), Some(0.8), &["sleep"], "frac", "Ideal deep+REM share", "Target deep+REM fraction for full quality credit."),
    pdef!("analytics.sleep.weight_duration", sl_weight_duration, "sleep", Curated, false, Some(0.0), Some(1.0), &["sleep"], "", "Score duration weight", "Weight of duration in the sleep score."),
    pdef!("analytics.sleep.weight_quality", sl_weight_quality, "sleep", Curated, false, Some(0.0), Some(1.0), &["sleep"], "", "Score quality weight", "Weight of quality in the sleep score."),
    // ---- anomaly ----
    pdef!("analytics.anomaly.z_threshold", an_z, "anomaly", Curated, false, Some(1.0), Some(6.0), &["anomaly"], "σ", "Anomaly z-threshold", "|z| above this flags the latest resting HR."),
    pdef!("analytics.anomaly.min_samples", an_min_samples, "anomaly", Advanced, true, Some(2.0), Some(60.0), &["anomaly"], "", "Min samples", "Readings needed before a spread is estimated."),
    pdef!("analytics.anomaly.flat_tolerance_bpm", an_flat_tol, "anomaly", Advanced, false, Some(1.0), Some(20.0), &["anomaly"], "bpm", "Flat-baseline tolerance", "Absolute departure that flags when the baseline is flat."),
    // ---- body battery ----
    pdef!("analytics.body_battery.gain", bb_gain, "body_battery", Curated, false, Some(0.0001), Some(0.05), &[], "", "Stress-drive gain", "Sensitivity of body-battery rate to the stress gap."),
    pdef!("analytics.body_battery.revert", bb_revert, "body_battery", Curated, false, Some(0.0001), Some(0.05), &[], "", "Mean-reversion rate", "Pull toward the neutral level."),
    pdef!("analytics.body_battery.center", bb_center, "body_battery", Curated, false, Some(0.0), Some(100.0), &[], "", "Neutral level", "Resting equilibrium body-battery level."),
    pdef!("analytics.body_battery.max_dt_min", bb_max_dt_min, "body_battery", Advanced, false, Some(1.0), Some(60.0), &[], "min", "Gap cap", "Caps per-step dt so a sync hole can't swing the level."),
    pdef!("analytics.body_battery.emit_interval_min", bb_min_emit_min, "body_battery", Advanced, false, Some(1.0), Some(60.0), &[], "min", "Output thinning interval", "Minimum spacing between stored body-battery points."),
    pdef!("analytics.body_battery.pivot_min", bb_pivot_min, "body_battery", Advanced, false, Some(0.0), Some(100.0), &[], "", "Pivot clamp min", "Lower clamp on the self-calibrating rest/drain pivot."),
    pdef!("analytics.body_battery.pivot_max", bb_pivot_max, "body_battery", Advanced, false, Some(0.0), Some(100.0), &[], "", "Pivot clamp max", "Upper clamp on the self-calibrating rest/drain pivot."),
    pdef!("analytics.body_battery.initial_level", bb_initial, "body_battery", Advanced, false, Some(0.0), Some(100.0), &[], "", "Initial seed", "Starting integrator value before any history."),
    pdef!("analytics.body_battery.median_fallback", bb_median_fallback, "body_battery", Advanced, false, Some(0.0), Some(100.0), &[], "", "Empty-stress fallback pivot", "Pivot used when there are no finite stress values."),
    // ---- resting HR ----
    pdef!("analytics.resting_hr.valid_hr_min", rhr_hr_min, "resting_hr", Advanced, false, Some(20.0), Some(60.0), &["readiness", "anomaly"], "bpm", "Valid HR floor", "Readings below this are dropped as artifacts."),
    pdef!("analytics.resting_hr.valid_hr_max", rhr_hr_max, "resting_hr", Advanced, false, Some(120.0), Some(255.0), &["readiness", "anomaly"], "bpm", "Valid HR ceiling", "Readings above this are dropped as artifacts."),
    pdef!("analytics.resting_hr.min_readings", rhr_min_readings, "resting_hr", Curated, true, Some(1.0), Some(200.0), &["readiness", "anomaly"], "", "Min readings/day", "Valid HR readings a day needs to estimate resting HR."),
    pdef!("analytics.resting_hr.low_decile_denom", rhr_low_decile_denom, "resting_hr", Advanced, true, Some(2.0), Some(50.0), &["readiness", "anomaly"], "", "Low-plateau denominator", "Resting HR = mean of the lowest 1/N readings."),
    pdef!("analytics.resting_hr.low_decile_floor", rhr_low_decile_floor, "resting_hr", Advanced, true, Some(1.0), Some(50.0), &["readiness", "anomaly"], "", "Low-plateau floor", "Minimum readings averaged for the low plateau."),
    // ---- HR-derived sleep ----
    pdef!("analytics.hr_sleep.min_block_min", hs_min_block_min, "hr_sleep", Curated, true, Some(30.0), Some(600.0), &["sleep"], "min", "Min main-block length", "Minimum length of a night's restful main block."),
    pdef!("analytics.hr_sleep.max_gap_min", hs_max_gap_min, "hr_sleep", Advanced, true, Some(1.0), Some(120.0), &["sleep"], "min", "Intra-block gap bridge", "Largest dropout bridged within a restful block."),
    pdef!("analytics.hr_sleep.default_deep_frac", hs_default_deep_frac, "hr_sleep", Advanced, false, Some(0.0), Some(0.5), &["sleep"], "frac", "Default deep fraction", "Deep share before calibration."),
    pdef!("analytics.hr_sleep.default_rem_frac", hs_default_rem_frac, "hr_sleep", Advanced, false, Some(0.0), Some(0.6), &["sleep"], "frac", "Default REM fraction", "REM share before calibration."),
    pdef!("analytics.hr_sleep.default_awake_offset_bpm", hs_default_awake_off, "hr_sleep", Advanced, false, Some(5.0), Some(60.0), &["sleep"], "bpm", "Default awake HR offset", "bpm above floor that reads as awake (uncalibrated)."),
    pdef!("analytics.hr_sleep.valid_hr_min", hs_valid_hr_min, "hr_sleep", Advanced, false, Some(20.0), Some(60.0), &["sleep"], "bpm", "Valid HR floor", "HR below this is dropped before staging."),
    pdef!("analytics.hr_sleep.valid_hr_max", hs_valid_hr_max, "hr_sleep", Advanced, false, Some(120.0), Some(255.0), &["sleep"], "bpm", "Valid HR ceiling", "HR above this is dropped before staging."),
    pdef!("analytics.hr_sleep.global_floor_denom", hs_global_floor_denom, "hr_sleep", Advanced, true, Some(2.0), Some(100.0), &["sleep"], "", "Global floor percentile denom", "Night-hour HR floor = sorted[len/N]."),
    pdef!("analytics.hr_sleep.awake_breakout_margin", hs_awake_breakout_margin, "hr_sleep", Advanced, false, Some(1.0), Some(40.0), &["sleep"], "bpm", "Awake break-out margin", "Sustained bpm above ceiling that breaks a block."),
    pdef!("analytics.hr_sleep.min_blip_min", hs_min_blip_min, "hr_sleep", Advanced, true, Some(1.0), Some(120.0), &["sleep"], "min", "Min restful blip", "Restful blocks shorter than this are ignored."),
    pdef!("analytics.hr_sleep.night_floor_denom", hs_night_floor_denom, "hr_sleep", Advanced, true, Some(2.0), Some(100.0), &["sleep"], "", "Night floor percentile denom", "Per-night HR floor = sorted[len/N]."),
    pdef!("analytics.hr_sleep.edge_trim_offset_bpm", hs_edge_trim_offset, "hr_sleep", Advanced, false, Some(1.0), Some(40.0), &["sleep"], "bpm", "Edge-trim asleep offset", "bpm off the floor used to trim awake edges."),
    pdef!("analytics.hr_sleep.smooth_window", hs_smooth_window, "hr_sleep", Advanced, true, Some(1.0), Some(61.0), &["sleep"], "samples", "Edge-trim smoothing window", "Centered rolling-mean window for onset/offset."),
    pdef!("analytics.hr_sleep.night_start_hour", hs_night_start_hour, "hr_sleep", Advanced, true, Some(0.0), Some(23.0), &["sleep"], "h", "Night window start hour (UTC)", "Hour at/after which minutes count as night."),
    pdef!("analytics.hr_sleep.night_end_hour", hs_night_end_hour, "hr_sleep", Advanced, true, Some(0.0), Some(23.0), &["sleep"], "h", "Night window end hour (UTC)", "Hour before which minutes count as night."),
    pdef!("analytics.hr_sleep.calib_min_night_minutes", hs_calib_min_night_minutes, "hr_sleep", Advanced, true, Some(0.0), Some(600.0), &["sleep"], "min", "Calib min night minutes", "Labelled minutes a night needs to calibrate."),
    pdef!("analytics.hr_sleep.calib_min_asleep_minutes", hs_calib_min_asleep_minutes, "hr_sleep", Advanced, true, Some(0.0), Some(600.0), &["sleep"], "min", "Calib min asleep minutes", "Staged-asleep minutes a night needs to calibrate."),
    pdef!("analytics.hr_sleep.calib_floor_denom", hs_calib_floor_denom, "hr_sleep", Advanced, true, Some(2.0), Some(100.0), &["sleep"], "", "Calib floor percentile denom", "Calibration night HR base = sorted[len/N]."),
    pdef!("analytics.hr_sleep.calib_min_nights", hs_calib_min_nights, "hr_sleep", Advanced, true, Some(1.0), Some(60.0), &["sleep"], "", "Calib min nights", "Labelled nights before learned fractions apply."),
    pdef!("analytics.hr_sleep.deep_frac_min", hs_deep_frac_min, "hr_sleep", Advanced, false, Some(0.0), Some(0.5), &["sleep"], "", "Deep fraction clamp min", "Lower clamp on the learned deep fraction."),
    pdef!("analytics.hr_sleep.deep_frac_max", hs_deep_frac_max, "hr_sleep", Advanced, false, Some(0.0), Some(0.6), &["sleep"], "", "Deep fraction clamp max", "Upper clamp on the learned deep fraction."),
    pdef!("analytics.hr_sleep.rem_frac_min", hs_rem_frac_min, "hr_sleep", Advanced, false, Some(0.0), Some(0.5), &["sleep"], "", "REM fraction clamp min", "Lower clamp on the learned REM fraction."),
    pdef!("analytics.hr_sleep.rem_frac_max", hs_rem_frac_max, "hr_sleep", Advanced, false, Some(0.0), Some(0.6), &["sleep"], "", "REM fraction clamp max", "Upper clamp on the learned REM fraction."),
    pdef!("analytics.hr_sleep.awake_offset_min_apply_bpm", hs_awake_off_min_apply, "hr_sleep", Advanced, false, Some(0.0), Some(40.0), &["sleep"], "bpm", "Awake-offset min to apply", "Learned awake-offset applies only if it exceeds this."),
    pdef!("analytics.hr_sleep.awake_offset_clamp_min_bpm", hs_awake_off_min, "hr_sleep", Advanced, false, Some(1.0), Some(40.0), &["sleep"], "bpm", "Awake-offset clamp min", "Lower clamp on the learned awake HR-offset."),
    pdef!("analytics.hr_sleep.awake_offset_clamp_max_bpm", hs_awake_off_max, "hr_sleep", Advanced, false, Some(1.0), Some(60.0), &["sleep"], "bpm", "Awake-offset clamp max", "Upper clamp on the learned awake HR-offset."),
];

impl AnalyticsParams {
    /// Build the effective parameters by overlaying a settings map onto the
    /// defaults. Unknown keys are ignored; unparseable/out-of-range values are
    /// clamped (or skipped if not a number). The map is the `(key, value)` store
    /// from `Db::list_settings`.
    pub fn from_settings(settings: &HashMap<String, String>) -> Self {
        let mut p = AnalyticsParams::default();
        for d in REGISTRY {
            if let Some(raw) = settings.get(d.key) {
                if let Ok(v) = raw.trim().parse::<f64>() {
                    if v.is_finite() {
                        d.apply(&mut p, v);
                    }
                }
            }
        }
        p
    }

    /// All `(key, value)` pairs in registry order.
    pub fn pairs(&self) -> Vec<(&'static str, f64)> {
        REGISTRY.iter().map(|d| (d.key, d.value(self))).collect()
    }

    /// A stable short fingerprint of the parameters that affect `plugin_id`'s
    /// output (the parameter half of a derivation's identity). Two parameter sets
    /// that differ only in keys irrelevant to `plugin_id` fingerprint identically.
    pub fn fingerprint(&self, plugin_id: &str) -> String {
        let mut keyed: Vec<(&'static str, f64)> = REGISTRY
            .iter()
            .filter(|d| d.plugins.contains(&plugin_id))
            .map(|d| (d.key, d.value(self)))
            .collect();
        keyed.sort_by(|a, b| a.0.cmp(b.0));
        let canon = keyed
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join(";");
        format!("{:016x}", fnv1a64(canon.as_bytes()))
    }
}

/// FNV-1a 64-bit — a tiny, dependency-free, deterministic hash (stable across
/// runs and builds, unlike `DefaultHasher`), used for parameter fingerprints.
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x00000100000001B3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_registry_bounds() {
        let p = AnalyticsParams::default();
        for d in REGISTRY {
            let v = d.value(&p);
            if let Some(lo) = d.min {
                assert!(v >= lo, "{} default {} < min {}", d.key, v, lo);
            }
            if let Some(hi) = d.max {
                assert!(v <= hi, "{} default {} > max {}", d.key, v, hi);
            }
            assert_eq!(v, d.default_value(), "{} default_value mismatch", d.key);
        }
    }

    #[test]
    fn registry_keys_unique() {
        let mut keys: Vec<_> = REGISTRY.iter().map(|d| d.key).collect();
        let n = keys.len();
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), n, "duplicate parameter keys");
    }

    #[test]
    fn from_settings_overlays_and_clamps() {
        let mut s = HashMap::new();
        s.insert("analytics.athlete.lthr_bpm".into(), "170".into());
        s.insert("analytics.training_load.ctl_days".into(), "1000".into()); // over max → clamp
        s.insert("analytics.athlete.ftp_watts".into(), "garbage".into()); // ignored
        let p = AnalyticsParams::from_settings(&s);
        assert_eq!(p.lthr, 170.0);
        assert_eq!(p.ctl_days, 84.0); // clamped to max
        assert_eq!(p.ftp, 250.0); // unchanged default
    }

    #[test]
    fn fingerprint_changes_only_for_relevant_params() {
        let base = AnalyticsParams::default();
        let mut other = base.clone();
        other.sl_min_minutes = 45.0; // a sleep-only param
        // training_load fingerprint is unaffected by a sleep param…
        assert_eq!(base.fingerprint("training_load"), other.fingerprint("training_load"));
        // …but the sleep fingerprint changes.
        assert_ne!(base.fingerprint("sleep"), other.fingerprint("sleep"));

        let mut tl = base.clone();
        tl.lthr = 170.0;
        assert_ne!(base.fingerprint("training_load"), tl.fingerprint("training_load"));
    }
}
