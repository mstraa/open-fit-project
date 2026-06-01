//! Estimate sleep from the overnight heart-rate series, CALIBRATED against the
//! nights we already have real stages for (the Zepp import / device fetch).
//!
//! In direct-BLE realtime mode the Helio records overnight HR but no sleep stages
//! (that's the Zepp app's job), so device sleep freezes at the realtime cutover.
//! For recent nights we estimate sleep ourselves: find the night's main restful
//! HR block and stage it by HR depth. Rather than hardcode the depth thresholds,
//! [`calibrate`] learns them from the labelled nights — what HR (relative to the
//! night's floor) actually corresponds to deep / light / rem / awake — so the
//! estimate tracks *this* person's physiology.
//!
//! Stage codes match `SleepStage`: 0 awake, 1 light, 2 deep, 3 rem.

use chrono::{DateTime, Duration, NaiveDate, Timelike, Utc};
use std::collections::BTreeMap;

const MIN_BLOCK_MIN: usize = 150; // a real night's main block is ≥ 2.5 h
const MAX_GAP_MIN: i64 = 15; // bridge short HR dropouts within a block

/// The night a timestamp belongs to, labelled by **bed-time date** (the evening
/// you fell asleep): evening (≥18:00) → that date; small hours (<18:00) → the
/// previous date. So 31 May 23:00 … 1 Jun 06:00 are all the "31 May" night.
pub fn night_of(ts: DateTime<Utc>) -> NaiveDate {
    if ts.hour() < 18 {
        ts.date_naive() - Duration::days(1)
    } else {
        ts.date_naive()
    }
}

/// HR-offset (bpm above the night's floor) boundaries between stages.
#[derive(Debug, Clone, Copy)]
pub struct SleepModel {
    pub deep_light: f64, // ≤ → deep
    pub light_rem: f64,  // ≤ → light
    pub rem_awake: f64,  // ≤ → rem, else awake (also the "still asleep" ceiling)
}
impl Default for SleepModel {
    fn default() -> Self {
        Self { deep_light: 4.0, light_rem: 11.0, rem_awake: 18.0 }
    }
}

/// Learn stage thresholds from labelled `(ts, stage, hr)` minutes (real staged
/// nights with matching HR). Falls back to [`SleepModel::default`] when there
/// isn't enough clean data or the learned order is implausible.
pub fn calibrate(labeled: &[(DateTime<Utc>, f64, f64)]) -> SleepModel {
    let mut by_night: BTreeMap<NaiveDate, Vec<(f64, f64)>> = BTreeMap::new();
    for (ts, stage, hr) in labeled {
        by_night.entry(night_of(*ts)).or_default().push((*stage, *hr));
    }
    // per stage code (0..3): collected (hr - night_floor) offsets
    let mut offs: [Vec<f64>; 4] = [Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    for (_, v) in by_night {
        if v.len() < 60 {
            continue;
        }
        let mut asleep: Vec<f64> = v.iter().filter(|(s, _)| *s != 0.0).map(|(_, h)| *h).collect();
        if asleep.len() < 30 {
            continue;
        }
        asleep.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let base = asleep[asleep.len() / 20]; // 5th pct = the night's HR floor
        for (s, h) in v {
            let idx = s as usize;
            if idx < 4 {
                offs[idx].push(h - base);
            }
        }
    }
    let mean = |v: &Vec<f64>| {
        if v.len() < 30 {
            None
        } else {
            Some(v.iter().sum::<f64>() / v.len() as f64)
        }
    };
    if let (Some(d), Some(l), Some(r)) = (mean(&offs[2]), mean(&offs[1]), mean(&offs[3])) {
        let dl = (d + l) / 2.0;
        let lr = (l + r) / 2.0;
        let ra = match mean(&offs[0]) {
            Some(a) => (r + a) / 2.0,
            None => r + 6.0,
        };
        if dl < lr && lr < ra && ra > 2.0 {
            return SleepModel { deep_light: dl.max(1.0), light_rem: lr, rem_awake: ra };
        }
    }
    SleepModel::default()
}

/// Per-minute `(ts, stage_code)` for the estimated main sleep block of each night.
pub fn hr_derived_sleep(hr: &[(DateTime<Utc>, f64)], model: &SleepModel) -> Vec<(DateTime<Utc>, f64)> {
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

    // global night-hour HR floor → the "still asleep" ceiling (learned)
    let mut night_hr: Vec<f64> = mins.iter().filter(|(m, _)| is_night(*m)).map(|(_, h)| *h).collect();
    if night_hr.len() < MIN_BLOCK_MIN {
        return Vec::new();
    }
    night_hr.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let gbase = night_hr[night_hr.len() / 10];
    let ceiling = gbase + model.rem_awake;

    // candidate restful night blocks
    let mut blocks: Vec<Vec<(i64, f64)>> = Vec::new();
    let mut i = 0;
    while i < mins.len() {
        let (m, v) = mins[i];
        if v > ceiling || !is_night(m) {
            i += 1;
            continue;
        }
        let mut block = vec![(m, v)];
        let mut j = i + 1;
        while j < mins.len() {
            let (mj, vj) = mins[j];
            if mj - block.last().unwrap().0 > MAX_GAP_MIN {
                break;
            }
            if vj > ceiling + 8.0 {
                break; // sustained well above ceiling → awake
            }
            block.push((mj, vj));
            j += 1;
        }
        blocks.push(block);
        i = j.max(i + 1);
    }

    // Group ALL of a night's restful blocks together (real sleep is often
    // fragmented by brief arousals); ignore tiny blips. Awake gaps between blocks
    // simply aren't staged. A night counts only if its blocks total ≥ a real night.
    let mut by_night: BTreeMap<NaiveDate, Vec<Vec<(i64, f64)>>> = BTreeMap::new();
    for b in blocks {
        if b.len() < 20 {
            continue; // ignore short restful blips (water break, brief lie-down)
        }
        let night = night_of(DateTime::from_timestamp(b[0].0 * 60, 0).unwrap_or_default());
        by_night.entry(night).or_default().push(b);
    }

    let mut out = Vec::new();
    for (_, nblocks) in by_night {
        let total: usize = nblocks.iter().map(|b| b.len()).sum();
        if total < MIN_BLOCK_MIN {
            continue;
        }
        let mut allvals: Vec<f64> = nblocks.iter().flatten().map(|x| x.1).collect();
        allvals.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let base = allvals[allvals.len() / 20]; // night floor across the whole night
        for (m, v) in nblocks.iter().flatten() {
            let off = v - base;
            let code = if off <= model.deep_light {
                2.0
            } else if off <= model.light_rem {
                1.0
            } else if off <= model.rem_awake {
                3.0
            } else {
                0.0
            };
            if let Some(ts) = DateTime::from_timestamp(*m * 60, 0) {
                out.push((ts, code));
            }
        }
    }
    out.sort_by_key(|(ts, _)| *ts);
    out
}

/// UTC hour ∈ [21, 11) — a generous overnight window (HR depth does the real work).
fn is_night(minute_epoch: i64) -> bool {
    let hour = ((minute_epoch / 60) % 24 + 24) % 24;
    hour >= 21 || hour < 11
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Timelike};

    #[test]
    fn finds_one_overnight_block_labelled_by_bedtime() {
        // Sleep 23:00 (31 Jan) → 06:00 (1 Feb): low HR with deep dips; awake ~80.
        let mut hr = Vec::new();
        let base = Utc.with_ymd_and_hms(2026, 1, 31, 12, 0, 0).unwrap();
        for m in 0..(20 * 60) {
            let t = base + chrono::Duration::minutes(m);
            let h = t.hour();
            let bpm = if h >= 23 || h < 6 {
                if (300i64..360).contains(&(m % 720)) { 48.0 } else { 54.0 }
            } else {
                80.0
            };
            hr.push((t, bpm));
        }
        let out = hr_derived_sleep(&hr, &SleepModel::default());
        assert!(out.len() >= MIN_BLOCK_MIN, "block too short: {}", out.len());
        // the whole night is labelled 31 Jan (bedtime), not 1 Feb
        let nights: std::collections::BTreeSet<NaiveDate> = out.iter().map(|(t, _)| night_of(*t)).collect();
        assert_eq!(nights.len(), 1);
        assert_eq!(*nights.iter().next().unwrap(), NaiveDate::from_ymd_opt(2026, 1, 31).unwrap());
    }
}
