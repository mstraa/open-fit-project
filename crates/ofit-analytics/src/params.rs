//! Tunable thresholds for the built-in algorithms, with documented defaults.
//!
//! Every heuristic threshold (LTHR, FTP, time constants, baselines) is a
//! parameter here so the API can later expose them as user settings without
//! touching algorithm code. The defaults are the standard sports-science values
//! cited inline.

/// Athlete-level thresholds used by the training-load algorithm.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AthleteThresholds {
    /// Lactate-threshold heart rate (bpm). Default **165** — a generic adult
    /// endurance default; hrTSS normalizes HR against this. (Coggan/Friel hrTSS.)
    pub lthr: f64,
    /// Functional threshold power (watts). Default **250** — used for power-based
    /// TSS when a power stream is present (Coggan TSS = duration·IF²·100/3600,
    /// IF = NP/FTP). For running power (Stryd) FTP ≈ critical power.
    pub ftp: f64,
    /// Maximum heart rate (bpm), used to clamp hrTSS intensity. Default **190**.
    pub hr_max: f64,
    /// Resting heart rate (bpm) floor for the HR-reserve fraction. Default **50**.
    pub hr_rest: f64,
}

impl Default for AthleteThresholds {
    fn default() -> Self {
        Self { lthr: 165.0, ftp: 250.0, hr_max: 190.0, hr_rest: 50.0 }
    }
}

/// Time constants for the CTL/ATL exponentially-weighted load series.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoadTimeConstants {
    /// Chronic Training Load (fitness) time constant in days. Default **42**.
    pub ctl_days: f64,
    /// Acute Training Load (fatigue) time constant in days. Default **7**.
    pub atl_days: f64,
}

impl Default for LoadTimeConstants {
    fn default() -> Self {
        Self { ctl_days: 42.0, atl_days: 7.0 }
    }
}

/// Parameters for the readiness / HRV summary algorithm.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReadinessParams {
    /// Number of trailing days forming the personal baseline. Default **7**.
    pub baseline_days: i64,
    /// Minimum HRV samples required before a readiness score is computed.
    /// Below this we degrade to "insufficient data". Default **3**.
    pub min_hrv_samples: usize,
}

impl Default for ReadinessParams {
    fn default() -> Self {
        Self { baseline_days: 7, min_hrv_samples: 3 }
    }
}
