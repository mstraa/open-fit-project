//! Estimate sleep from the overnight heart-rate series.
//!
//! The Helio only writes per-minute *sleep-stage* classifications while the Zepp
//! app drives it; in our direct-BLE realtime mode it records raw HR but no stages.
//! So for recent nights we estimate sleep ourselves from the HR pattern: a long
//! restful (low, stable) overnight stretch is the sleep block, and HR depth within
//! it approximates the stage. Rough vs the watch, but real — and it fills the
//! nights the device can't. Emits per-minute SleepStage codes (0 awake / 1 light /
//! 2 deep / 3 rem), gap-filled only for nights with no device/import sleep.

use chrono::{DateTime, Utc};
use std::collections::BTreeMap;

const MIN_BLOCK_MIN: usize = 120; // a real sleep block is ≥ 2 h
const MAX_GAP_MIN: i64 = 15; // bridge short HR dropouts within a block

/// Per-minute `(ts, stage_code)` for detected sleep, ascending by time.
pub fn hr_derived_sleep(hr: &[(DateTime<Utc>, f64)]) -> Vec<(DateTime<Utc>, f64)> {
    // one bpm per clock-minute
    let mut by_min: BTreeMap<i64, f64> = BTreeMap::new();
    for (ts, v) in hr {
        if *v >= 30.0 && *v <= 210.0 {
            by_min.insert(ts.timestamp() / 60, *v);
        }
    }
    if by_min.len() < MIN_BLOCK_MIN {
        return Vec::new();
    }
    let mins: Vec<(i64, f64)> = by_min.into_iter().collect();

    // "restful" threshold: 10th-percentile HR + a margin
    let mut vals: Vec<f64> = mins.iter().map(|m| m.1).collect();
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p10 = vals[vals.len() / 10];
    let restful_max = p10 + 14.0;

    let mut out = Vec::new();
    let mut i = 0;
    while i < mins.len() {
        let (m0, v0) = mins[i];
        if v0 > restful_max || !is_night_minute(m0) {
            i += 1;
            continue;
        }
        // grow a contiguous block of restful night minutes (tolerating brief arousals)
        let mut block: Vec<(i64, f64)> = vec![(m0, v0)];
        let mut j = i + 1;
        while j < mins.len() {
            let (mj, vj) = mins[j];
            if mj - block.last().unwrap().0 > MAX_GAP_MIN {
                break;
            }
            if vj > restful_max + 14.0 {
                break; // sustained high HR → awake / out of sleep
            }
            block.push((mj, vj));
            j += 1;
        }
        if block.len() >= MIN_BLOCK_MIN {
            let mut bvals: Vec<f64> = block.iter().map(|b| b.1).collect();
            bvals.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let base = bvals[bvals.len() / 20]; // ~5th pct = the night's floor
            for (m, v) in &block {
                let code = if *v >= base + 22.0 {
                    0.0 // awake
                } else if *v >= base + 13.0 {
                    3.0 // rem (HR elevated/variable)
                } else if *v <= base + 3.0 {
                    2.0 // deep (HR floor)
                } else {
                    1.0 // light
                };
                if let Some(ts) = DateTime::from_timestamp(*m * 60, 0) {
                    out.push((ts, code));
                }
            }
        }
        i = j.max(i + 1);
    }
    out
}

/// UTC hour ∈ [21, 11) — a generous overnight window (HR depth does the real work).
fn is_night_minute(minute_epoch: i64) -> bool {
    let hour = ((minute_epoch / 60) % 24 + 24) % 24;
    hour >= 21 || hour < 11
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Timelike};

    #[test]
    fn finds_an_overnight_block_and_stages_it() {
        // 23:00 → 06:00: low HR (asleep) with a deep dip; daytime ~80 around it.
        let mut hr = Vec::new();
        let base = Utc.with_ymd_and_hms(2026, 1, 1, 12, 0, 0).unwrap();
        for m in 0..(18 * 60) {
            let t = base + chrono::Duration::minutes(m);
            let h = t.hour();
            let bpm = if h >= 23 || h < 6 {
                if (300i64..360).contains(&(m % 720)) { 48.0 } else { 54.0 } // sleeping, deep dips
            } else {
                80.0 // awake
            };
            hr.push((t, bpm));
        }
        let out = hr_derived_sleep(&hr);
        assert!(out.len() >= MIN_BLOCK_MIN, "block too short: {}", out.len());
        // mostly light/deep, not awake
        let asleep = out.iter().filter(|(_, c)| *c != 0.0).count();
        assert!(asleep as f64 / out.len() as f64 > 0.8);
    }
}
