//! A continuous **body battery** (0–100 "energy") derived from the stress series.
//!
//! Zepp/Garmin compute body battery proprietarily and never expose it over BLE, so
//! we model our own from the one continuous recovery signal we DO sync — stress
//! (which the watch derives from HRV). The level recharges when stress is below a
//! rest threshold (calm wakefulness + sleep) and drains above it (effort/stress),
//! so it visibly moves through the day and is high after a restful night.

use chrono::{DateTime, Utc};

const REST_STRESS: f64 = 30.0; // below this → recharge, above → drain
const GAIN: f64 = 0.007; // per-minute rate scale (≈ full charge over a calm night)
const MAX_DT_MIN: f64 = 5.0; // cap gaps so a sync hole can't swing it
const MIN_EMIT_MIN: f64 = 10.0; // thin stored output to ~1 per 10 min

/// Body battery (0–100, rounded) at ~10-minute resolution, ascending by time.
/// Integrated at full resolution from the start of history so the arbitrary
/// starting value washes out well before recent days.
pub fn body_battery(stress: &[(DateTime<Utc>, f64)]) -> Vec<(DateTime<Utc>, f64)> {
    if stress.is_empty() {
        return Vec::new();
    }
    let mut s = stress.to_vec();
    s.sort_by(|a, b| a.0.cmp(&b.0));

    let mut bb = 50.0_f64;
    let mut prev: Option<DateTime<Utc>> = None;
    let mut last_emit: Option<DateTime<Utc>> = None;
    let mut out = Vec::new();
    for (ts, stress_v) in s {
        if let Some(p) = prev {
            let dt = ((ts - p).num_seconds() as f64 / 60.0).clamp(0.0, MAX_DT_MIN);
            bb = (bb + (REST_STRESS - stress_v) * GAIN * dt).clamp(0.0, 100.0);
        }
        prev = Some(ts);
        let emit = match last_emit {
            Some(le) => (ts - le).num_seconds() as f64 / 60.0 >= MIN_EMIT_MIN,
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
        let out = body_battery(&pts);
        // peaks near full by end of the calm stretch …
        let peak = out.iter().take_while(|(t, _)| *t <= ts(480)).map(|(_, v)| *v).fold(0.0, f64::max);
        assert!(peak >= 95.0, "peak={peak}");
        // … and drops under the stressful stretch.
        let end = out.last().unwrap().1;
        assert!(end < peak - 20.0, "end={end} peak={peak}");
    }
}
