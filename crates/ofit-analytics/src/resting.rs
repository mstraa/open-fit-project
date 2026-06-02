//! Derive a daily **resting heart rate** from the continuous per-minute HR feed.
//!
//! We don't have RR-intervals here (so no HRV), but resting HR is well-defined
//! from the HR series alone: a person's resting HR is the low plateau they sit
//! at when still (typically overnight). The robust, gap-tolerant estimator used
//! here is the **average of the lowest decile** of the day's valid HR readings —
//! it ignores brief dips/artifacts (needs several low readings to move) and
//! doesn't require contiguous minutes the way a rolling-window minimum would.

use chrono::{DateTime, NaiveDate, Utc};
use std::collections::BTreeMap;

use crate::params::AnalyticsParams;

/// Daily resting HR (bpm, rounded) from `(ts, hr)` points, ascending by date.
/// Days with too little coverage are omitted rather than guessed. Tunables
/// (valid HR band, minimum readings, low-plateau denominator/floor) come from
/// [`AnalyticsParams`].
pub fn daily_resting_hr(points: &[(DateTime<Utc>, f64)], p: &AnalyticsParams) -> Vec<(NaiveDate, f64)> {
    let hr_min = p.rhr_hr_min;
    let hr_max = p.rhr_hr_max;
    let min_readings = (p.rhr_min_readings as usize).max(1);
    let denom = (p.rhr_low_decile_denom as usize).max(1);
    let floor = (p.rhr_low_decile_floor as usize).max(1);

    let mut by_day: BTreeMap<NaiveDate, Vec<f64>> = BTreeMap::new();
    for (ts, hr) in points {
        if *hr >= hr_min && *hr <= hr_max {
            by_day.entry(ts.date_naive()).or_default().push(*hr);
        }
    }

    by_day
        .into_iter()
        .filter_map(|(date, mut vals)| {
            if vals.len() < min_readings {
                return None;
            }
            vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
            // Lowest 1/denom of the day (at least `floor` readings) → average = resting HR.
            let n = (vals.len() / denom).max(floor).min(vals.len());
            let rhr = vals[..n].iter().sum::<f64>() / n as f64;
            Some((date, rhr.round()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn ts(day: u32, minute: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 1, day, 0, 0, 0).unwrap() + chrono::Duration::minutes(minute)
    }

    #[test]
    fn resting_hr_is_the_low_plateau_not_the_min_or_mean() {
        // A day: mostly active (~120), a long quiet plateau at ~50, one artifact dip.
        let mut pts = Vec::new();
        for m in 0..200 {
            pts.push((ts(1, m), 120.0));
        }
        for m in 200..260 {
            pts.push((ts(1, m), 50.0)); // resting plateau
        }
        pts.push((ts(1, 260), 10.0)); // artifact, dropped (< HR_MIN)
        let out = daily_resting_hr(&pts, &AnalyticsParams::default());
        assert_eq!(out.len(), 1);
        let (_, rhr) = out[0];
        // ~50 (the plateau), not 120 (mean) and not 10 (artifact).
        assert!((rhr - 50.0).abs() <= 2.0, "rhr={rhr}");
    }

    #[test]
    fn sparse_days_are_skipped() {
        let pts: Vec<_> = (0..5).map(|m| (ts(2, m), 60.0)).collect();
        assert!(daily_resting_hr(&pts, &AnalyticsParams::default()).is_empty());
    }
}
