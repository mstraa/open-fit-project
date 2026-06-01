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
/// previous date. So 31 May 23:00 … 1 Jun 06:00 are all the "31 May" night, and
/// today stays empty until tonight. A whole night maps to ONE bucket.
pub fn night_of(ts: DateTime<Utc>) -> NaiveDate {
    if ts.hour() < 18 {
        ts.date_naive() - Duration::days(1)
    } else {
        ts.date_naive()
    }
}

/// What fraction of a night is each stage, plus the "awake" HR-offset ceiling.
/// Staging by absolute HR over-calls deep on flat nights, so we instead match the
/// stage *proportions* learned from real nights (deep = lowest-HR minutes, etc.).
#[derive(Debug, Clone, Copy)]
pub struct SleepModel {
    pub deep_frac: f64, // share of asleep minutes that are deep (lowest HR)
    pub rem_frac: f64,  // share that are rem (highest HR among asleep)
    pub rem_awake: f64, // off (bpm above floor) above which a minute is awake
}
impl Default for SleepModel {
    fn default() -> Self {
        // typical adult: deep ~16%, rem ~22%, light the rest
        Self { deep_frac: 0.16, rem_frac: 0.22, rem_awake: 20.0 }
    }
}

/// Learn the stage proportions (and awake ceiling) from labelled `(ts, stage, hr)`
/// minutes (real staged nights with matching HR). Falls back to the default mix
/// when there isn't enough clean data.
pub fn calibrate(labeled: &[(DateTime<Utc>, f64, f64)]) -> SleepModel {
    let mut by_night: BTreeMap<NaiveDate, Vec<(f64, f64)>> = BTreeMap::new();
    for (ts, stage, hr) in labeled {
        by_night.entry(night_of(*ts)).or_default().push((*stage, *hr));
    }
    let mut deep_fr = Vec::new();
    let mut rem_fr = Vec::new();
    let mut awake_offs = Vec::new();
    for (_, v) in by_night {
        if v.len() < 120 {
            continue;
        }
        let (mut deep, mut light, mut rem) = (0.0, 0.0, 0.0);
        for (s, _) in &v {
            match *s as i32 {
                2 => deep += 1.0,
                1 => light += 1.0,
                3 => rem += 1.0,
                _ => {}
            }
        }
        let asleep = deep + light + rem;
        if asleep < 60.0 {
            continue;
        }
        deep_fr.push(deep / asleep);
        rem_fr.push(rem / asleep);
        // awake-offset = how far above the night's floor the awake minutes sit
        let mut all: Vec<f64> = v.iter().map(|(_, h)| *h).collect();
        all.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let base = all[all.len() / 20];
        for (s, h) in &v {
            if *s == 0.0 {
                awake_offs.push(*h - base);
            }
        }
    }
    let avg = |v: &Vec<f64>| if v.is_empty() { None } else { Some(v.iter().sum::<f64>() / v.len() as f64) };
    let mut m = SleepModel::default();
    if deep_fr.len() >= 3 {
        if let Some(d) = avg(&deep_fr) {
            m.deep_frac = d.clamp(0.05, 0.35);
        }
        if let Some(r) = avg(&rem_fr) {
            m.rem_frac = r.clamp(0.05, 0.40);
        }
    }
    if let Some(a) = avg(&awake_offs) {
        if a > 10.0 {
            m.rem_awake = a.clamp(14.0, 30.0);
        }
    }
    m
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
        let mut night: Vec<(i64, f64)> = nblocks.into_iter().flatten().collect();
        night.sort_by_key(|x| x.0);
        if night.len() < MIN_BLOCK_MIN {
            continue;
        }
        let mut sorted: Vec<f64> = night.iter().map(|x| x.1).collect();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let base = sorted[sorted.len() / 20]; // night HR floor

        // Trim the awake EDGES: lying in bed before sleep and lounging after waking
        // keep HR low-ish but above the sleep floor. Walk in from both ends past any
        // run whose SMOOTHED HR sits above a "clearly asleep" ceiling, so the block
        // starts at true sleep onset and ends at wake-up — not at the loose ceiling.
        // Onset/offset use a TIGHT fixed band off the floor (the wake transition is
        // sharp); the calibrated thresholds are for staging WITHIN the block, where
        // they'd otherwise let post-wake lounging (HR a touch high) read as sleep.
        let sm = smooth(&night.iter().map(|x| x.1).collect::<Vec<_>>(), 9);
        let asleep_ceiling = base + 12.0;
        let mut start = 0;
        while start < night.len() && sm[start] > asleep_ceiling {
            start += 1;
        }
        let mut end = night.len();
        while end > start && sm[end - 1] > asleep_ceiling {
            end -= 1;
        }
        if end - start < MIN_BLOCK_MIN {
            continue;
        }

        // Stage by HR RANK to match the learned proportions (so a flat night can't
        // become all-deep). Minutes clearly above the floor are awake; the rest are
        // ranked low→high and split deep (lowest HR) / light / rem (highest).
        let core: Vec<usize> = (start..end).collect();
        let asleep: Vec<usize> = core
            .iter()
            .copied()
            .filter(|&k| night[k].1 - base <= model.rem_awake)
            .collect();
        let mut by_hr = asleep.clone();
        by_hr.sort_by(|&a, &b| night[a].1.partial_cmp(&night[b].1).unwrap());
        let n = by_hr.len();
        let n_deep = (n as f64 * model.deep_frac).round() as usize;
        let n_rem = (n as f64 * model.rem_frac).round() as usize;
        let mut stage: std::collections::HashMap<usize, f64> = std::collections::HashMap::new();
        for (rank, &k) in by_hr.iter().enumerate() {
            let code = if rank < n_deep {
                2.0 // deep = lowest HR
            } else if rank >= n.saturating_sub(n_rem) {
                3.0 // rem = highest HR among asleep
            } else {
                1.0 // light
            };
            stage.insert(k, code);
        }
        for &k in &core {
            let code = if night[k].1 - base > model.rem_awake {
                0.0 // awake arousal mid-sleep
            } else {
                *stage.get(&k).unwrap_or(&1.0)
            };
            if let Some(ts) = DateTime::from_timestamp(night[k].0 * 60, 0) {
                out.push((ts, code));
            }
        }
    }
    out.sort_by_key(|(ts, _)| *ts);
    out
}

/// Centered rolling mean (window `w`) to ignore single-minute HR blips when
/// finding sleep onset/offset.
fn smooth(v: &[f64], w: usize) -> Vec<f64> {
    let n = v.len();
    let half = w / 2;
    (0..n)
        .map(|i| {
            let a = i.saturating_sub(half);
            let b = (i + half + 1).min(n);
            v[a..b].iter().sum::<f64>() / (b - a) as f64
        })
        .collect()
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
        // the whole night maps to ONE bucket, labelled by bed-time date (31 Jan)
        let nights: std::collections::BTreeSet<NaiveDate> = out.iter().map(|(t, _)| night_of(*t)).collect();
        assert_eq!(nights.len(), 1);
        assert_eq!(*nights.iter().next().unwrap(), NaiveDate::from_ymd_opt(2026, 1, 31).unwrap());
    }
}
