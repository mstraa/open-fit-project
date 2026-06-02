//! A continuous **body battery** (0–100 "energy") derived from the stress series.
//!
//! Zepp/Garmin compute body battery proprietarily and never expose it over BLE, so
//! we model our own from the one continuous recovery signal we DO sync — stress
//! (which the watch derives from HRV). The level recharges when stress is below a
//! rest threshold (calm wakefulness + sleep) and drains above it (effort/stress),
//! so it visibly moves through the day and is high after a restful night.

use chrono::{DateTime, Utc};

use crate::params::AnalyticsParams;

// Calibrated against the Zepp BioCharge reference (oscillates ~52→89→60, never
// pegs at 100). Two terms: a stress drive `(pivot−stress)·gain` that charges at
// rest / drains under load, and a mean-reversion `revert·(center−bb)` that pulls
// toward a neutral level so it can't saturate at the 0/100 clamp (the old free
// integrator pegged at 100 overnight). At a held stress the level asymptotes to
// `center + (pivot−stress)·gain/revert`. All coefficients are [`AnalyticsParams`].

/// Median of the finite values (or `fallback` when none) — the self-calibrating
/// rest/drain pivot base.
fn median(vals: &[f64], fallback: f64) -> f64 {
    let mut v: Vec<f64> = vals.iter().copied().filter(|x| x.is_finite()).collect();
    if v.is_empty() {
        return fallback;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    }
}

/// The self-calibrating rest/drain pivot: the user's own median stress, clamped
/// to a sane band. Exposed so the caller can compute it once and **pin** it
/// (persist it) — a stable pivot makes body battery forward-carryable instead of
/// re-pivoting (and shifting all of history) every time new stress arrives.
pub fn pivot_of(stress: &[(DateTime<Utc>, f64)], p: &AnalyticsParams) -> f64 {
    median(&stress.iter().map(|(_, v)| *v).collect::<Vec<_>>(), p.bb_median_fallback)
        .clamp(p.bb_pivot_min, p.bb_pivot_max)
}

/// Body battery (0–100, rounded) at the thinning resolution, ascending by time.
/// Integrated at full resolution from the start of history so the arbitrary
/// starting value washes out well before recent days. `pivot` is the rest/drain
/// threshold (see [`pivot_of`]); pass a pinned value to keep it stable.
pub fn body_battery(stress: &[(DateTime<Utc>, f64)], pivot: f64, p: &AnalyticsParams) -> Vec<(DateTime<Utc>, f64)> {
    if stress.is_empty() {
        return Vec::new();
    }
    let mut s = stress.to_vec();
    s.sort_by(|a, b| a.0.cmp(&b.0));

    let pivot = pivot.clamp(p.bb_pivot_min, p.bb_pivot_max);

    let mut bb = p.bb_initial;
    let mut prev: Option<DateTime<Utc>> = None;
    let mut last_emit: Option<DateTime<Utc>> = None;
    let mut out = Vec::new();
    for (ts, stress_v) in s {
        if let Some(pt) = prev {
            let dt = ((ts - pt).num_seconds() as f64 / 60.0).clamp(0.0, p.bb_max_dt_min);
            bb = (bb + ((pivot - stress_v) * p.bb_gain + p.bb_revert * (p.bb_center - bb)) * dt).clamp(0.0, 100.0);
        }
        prev = Some(ts);
        let emit = match last_emit {
            Some(le) => (ts - le).num_seconds() as f64 / 60.0 >= p.bb_min_emit_min,
            None => true,
        };
        if emit {
            out.push((ts, bb.round()));
            last_emit = Some(ts);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn ts(min: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap() + chrono::Duration::minutes(min)
    }

    #[test]
    fn recharges_at_rest_drains_under_stress() {
        // 8h calm (stress 10) then 2h high stress (stress 90).
        let mut pts = Vec::new();
        for m in (0..480).step_by(5) {
            pts.push((ts(m), 10.0));
        }
        for m in (480..600).step_by(5) {
            pts.push((ts(m), 90.0));
        }
        let p = AnalyticsParams::default();
        let out = body_battery(&pts, pivot_of(&pts, &p), &p);
        // recharges strongly over the calm stretch. (The mean-reverting model
        // asymptotes toward CENTER + gap·GAIN/REVERT and no longer pegs at 100;
        // with this synthetic clamped pivot 8h reaches the high 70s — real
        // restful nights, with a wider stress↔pivot gap, reach the mid-80s.) …
        let peak = out.iter().take_while(|(t, _)| *t <= ts(480)).map(|(_, v)| *v).fold(0.0, f64::max);
        assert!(peak >= 74.0, "peak={peak}");
        // … and drops under the stressful stretch.
        let end = out.last().unwrap().1;
        assert!(end < peak - 20.0, "end={end} peak={peak}");
    }
}
