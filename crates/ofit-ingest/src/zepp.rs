//! Zepp / Amazfit **app-export** import adapter (cloudless, on-device export).
//!
//! The Zepp app's "Export data" produces a folder of CSV files (one directory
//! per category: `HEARTRATE_AUTO/`, `SLEEP_MINUTE/`, `ACTIVITY/`, `BODY/`,
//! `USER/`, …) under an account-id subfolder. This reads that tree and extracts
//! the continuous, trend-worthy series as [`WellnessKind`] readings — the same
//! shape the Gadgetbridge adapter yields, so the API ingests both identically.
//!
//! What we import (everything usable for trends/analytics):
//! - `HEARTRATE_AUTO` → [`WellnessKind::HeartRate`] (all-day auto HR).
//! - `SLEEP_MINUTE` → [`WellnessKind::SleepStage`] (+ in-sleep HR & respiration);
//!   the `sleep` built-in algorithm turns these into nightly summaries + score.
//! - `ACTIVITY` (daily) → [`WellnessKind::Steps`] + [`WellnessKind::Calories`].
//! - `BODY` → [`WellnessKind::Weight`].
//!
//! Intentionally skipped (noted in [`ZeppImport::skipped`]): `SPORT` (workout
//! *summaries* with no streams — real workouts come from FIT/GPX/TCX),
//! `ACTIVITY_MINUTE`/`ACTIVITY_STAGE` (intraday steps, would double-count the
//! daily totals), `SLEEP` daily (derived by the sleep algorithm from minutes),
//! and empty exports (`HEALTH_DATA`, `HEARTRATE`).
//!
//! Timestamps in the minute/auto tables are local wall-clock with no zone; we
//! treat them as UTC, which keeps night-attribution (evening→morning) correct
//! since sleep is anchored to local night. `BODY`/`SPORT` carry an explicit
//! `+0000` offset and are parsed with it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use ofit_core::{SleepStage, Sport, WellnessKind};

/// A single timestamped wellness sample produced by an import adapter.
#[derive(Debug, Clone, PartialEq)]
pub struct WellnessReading {
    pub kind: WellnessKind,
    pub value: f64,
    pub ts: chrono::DateTime<chrono::Utc>,
}

/// One workout summary from the Zepp `SPORT` table. These carry no per-second
/// streams or GPS — just totals — so the API imports them as **summary
/// activities** (a stream-less recording whose stats live in its metadata).
#[derive(Debug, Clone, PartialEq)]
pub struct ZeppWorkout {
    pub sport: Sport,
    /// Raw Zepp sport-type code (kept in metadata for traceability).
    pub zepp_type: i64,
    pub started_at: DateTime<Utc>,
    pub ended_at: DateTime<Utc>,
    pub distance_m: f64,
    pub calories_kcal: f64,
    /// Average pace in seconds per metre (0 when distance is 0).
    pub avg_pace_s_per_m: f64,
}

/// Light user-profile facts pulled from `USER/` (names the created source).
#[derive(Debug, Clone, Default)]
pub struct ZeppUser {
    pub nickname: Option<String>,
}

/// Result of reading a Zepp export folder.
#[derive(Debug, Clone)]
pub struct ZeppImport {
    /// Source label, e.g. `"Zepp (mstraa)"`.
    pub source_name: String,
    /// All extracted readings (the API stamps each with a source + uuid).
    pub readings: Vec<WellnessReading>,
    /// Workout summaries from `SPORT` (imported as summary activities).
    pub workouts: Vec<ZeppWorkout>,
    /// Per-kind counts (for the import summary UI).
    pub counts: BTreeMap<WellnessKind, usize>,
    /// Categories present but deliberately not imported (with a reason).
    pub skipped: Vec<String>,
}

/// Errors reading a Zepp export.
#[derive(Debug, thiserror::Error)]
pub enum ZeppError {
    #[error("zepp export: no recognised category folders under {0}")]
    NotAZeppExport(String),
    #[error("zepp export io: {0}")]
    Io(#[from] std::io::Error),
    #[error("zepp export zip: {0}")]
    Zip(#[from] zip::result::ZipError),
}

/// Read a **zipped** Zepp export (what the app's "Export data" produces): the
/// bytes are extracted to a scratch dir, parsed via [`read_zepp_export`], and
/// the scratch dir is removed. The whole tree is extracted (CSV files are read
/// from disk), but only category CSVs are interpreted.
pub fn read_zepp_zip(bytes: &[u8]) -> Result<ZeppImport, ZeppError> {
    let scratch = std::env::temp_dir().join(format!("ofit-zepp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&scratch)?;
    let res = (|| {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)?;
            // `enclosed_name` rejects path-traversal (`..`, absolute) entries.
            let Some(rel) = entry.enclosed_name() else { continue };
            let dest = scratch.join(rel);
            if entry.is_dir() {
                std::fs::create_dir_all(&dest)?;
            } else {
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let mut out = std::fs::File::create(&dest)?;
                std::io::copy(&mut entry, &mut out)?;
            }
        }
        read_zepp_export(&scratch)
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    res
}

/// Read a Zepp export folder (recursively locating the category subdirectories)
/// and extract all usable wellness series.
pub fn read_zepp_export(root: &Path) -> Result<ZeppImport, ZeppError> {
    // Map category-folder name → the CSV files found under it.
    let mut by_category: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    collect_csvs(root, &mut by_category)?;
    if by_category.is_empty() {
        return Err(ZeppError::NotAZeppExport(root.display().to_string()));
    }

    let mut readings: Vec<WellnessReading> = Vec::new();
    let mut workouts: Vec<ZeppWorkout> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut nickname: Option<String> = None;

    for (category, files) in &by_category {
        for file in files {
            let text = std::fs::read_to_string(file)?;
            match category.as_str() {
                "HEARTRATE_AUTO" => parse_heartrate_auto(&text, &mut readings),
                "SLEEP_MINUTE" => parse_sleep_minute(&text, &mut readings),
                "ACTIVITY" => parse_activity_daily(&text, &mut readings),
                "BODY" => parse_body(&text, &mut readings),
                "SPORT" => parse_sport(&text, &mut workouts),
                "USER" => {
                    if let Some(n) = parse_user_nickname(&text) {
                        nickname = Some(n);
                    }
                }
                // Present-but-skipped categories — record why, once each.
                "ACTIVITY_MINUTE" | "ACTIVITY_STAGE" => {
                    note(&mut skipped, "ACTIVITY_MINUTE/STAGE: intraday steps skipped (daily ACTIVITY used instead)")
                }
                "SLEEP" => note(&mut skipped, "SLEEP daily: derived from SLEEP_MINUTE by the sleep algorithm"),
                other => note(&mut skipped, &format!("{other}: not mapped / empty")),
            }
        }
    }

    let mut counts: BTreeMap<WellnessKind, usize> = BTreeMap::new();
    for r in &readings {
        *counts.entry(r.kind).or_insert(0) += 1;
    }

    let source_name = match &nickname {
        Some(n) => format!("Zepp ({n})"),
        None => "Zepp export".to_string(),
    };

    Ok(ZeppImport { source_name, readings, workouts, counts, skipped })
}

/// `SPORT`: `type,startTime,sportTime(s),maxPace,minPace,distance(m),avgPace,calories`.
/// `startTime` carries an explicit `+0000` offset.
fn parse_sport(text: &str, out: &mut Vec<ZeppWorkout>) {
    for line in text.lines().skip(1) {
        let c = cells(line);
        if c.len() < 8 {
            continue;
        }
        let Some(start) = DateTime::parse_from_str(c[1].trim(), "%Y-%m-%d %H:%M:%S%z")
            .ok()
            .map(|t| t.with_timezone(&Utc))
        else {
            continue;
        };
        let secs = c[2].trim().parse::<i64>().unwrap_or(0).max(0);
        let distance_m = c[5].trim().parse::<f64>().unwrap_or(0.0);
        let avg_pace = c[6].trim().parse::<f64>().unwrap_or(0.0);
        let calories = c[7].trim().parse::<f64>().unwrap_or(0.0);
        let zepp_type = c[0].trim().parse::<i64>().unwrap_or(0);
        out.push(ZeppWorkout {
            sport: map_sport(zepp_type),
            zepp_type,
            started_at: start,
            ended_at: start + Duration::seconds(secs),
            distance_m,
            calories_kcal: calories,
            avg_pace_s_per_m: avg_pace,
        });
    }
}

/// Map Zepp/Huami sport-type codes to the canonical [`Sport`]. Verified against
/// real exports by average speed: type 1 ≈ 10.7 km/h (run), type 6 ≈ 4.1 km/h
/// (walk), type 9 ≈ 17.6 km/h (cycling). The raw code is preserved in the
/// recording metadata so this mapping can be re-derived later.
pub fn map_sport(code: i64) -> Sport {
    match code {
        1 | 8 => Sport::Running,  // outdoor run / treadmill
        6 => Sport::Walking,      // walking (~4 km/h)
        9 | 10 => Sport::Cycling, // outdoor / indoor cycling (~17 km/h)
        _ => Sport::Other,        // 16/52/59/111/130 etc. are no-GPS indoor efforts
    }
}

fn note(skipped: &mut Vec<String>, msg: &str) {
    if !skipped.iter().any(|s| s == msg) {
        skipped.push(msg.to_string());
    }
}

/// Recursively collect `*.csv` files, grouped by their immediate parent folder
/// name (the Zepp category). The export nests them under an account-id dir.
fn collect_csvs(dir: &Path, out: &mut BTreeMap<String, Vec<PathBuf>>) -> Result<(), std::io::Error> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_csvs(&path, out)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("csv") {
            if let Some(parent) = path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()) {
                out.entry(parent.to_string()).or_default().push(path.clone());
            }
        }
    }
    Ok(())
}

/// Split a CSV line, trimming a leading UTF-8 BOM and CR.
fn cells(line: &str) -> Vec<&str> {
    line.trim_start_matches('\u{feff}').trim_end_matches('\r').split(',').collect()
}

/// Naive local `YYYY-MM-DD` + `HH:MM` (no zone) → UTC (treated as wall-clock).
fn at_local(date: &str, time: &str) -> Option<DateTime<Utc>> {
    let d = NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d").ok()?;
    let t = NaiveTime::parse_from_str(time.trim(), "%H:%M")
        .or_else(|_| NaiveTime::parse_from_str(time.trim(), "%H:%M:%S"))
        .ok()?;
    Some(Utc.from_utc_datetime(&NaiveDateTime::new(d, t)))
}

/// Naive local date at midnight → UTC (for daily aggregates).
fn at_midnight(date: &str) -> Option<DateTime<Utc>> {
    let d = NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d").ok()?;
    Some(Utc.from_utc_datetime(&d.and_hms_opt(0, 0, 0)?))
}

/// `HEARTRATE_AUTO`: `date,time,heartRate`.
fn parse_heartrate_auto(text: &str, out: &mut Vec<WellnessReading>) {
    for line in text.lines().skip(1) {
        let c = cells(line);
        if c.len() < 3 {
            continue;
        }
        let (Some(ts), Some(hr)) = (at_local(c[0], c[1]), c[2].trim().parse::<f64>().ok()) else {
            continue;
        };
        if (30.0..=220.0).contains(&hr) {
            out.push(WellnessReading { kind: WellnessKind::HeartRate, value: hr, ts });
        }
    }
}

/// `SLEEP_MINUTE`: `date,time,stage,hr,respiratory_rate`.
fn parse_sleep_minute(text: &str, out: &mut Vec<WellnessReading>) {
    for line in text.lines().skip(1) {
        let c = cells(line);
        if c.len() < 3 {
            continue;
        }
        let Some(ts) = at_local(c[0], c[1]) else { continue };
        if let Some(stage) = parse_stage(c[2]) {
            out.push(WellnessReading { kind: WellnessKind::SleepStage, value: stage.code(), ts });
        }
        if let Some(hr) = c.get(3).and_then(|s| s.trim().parse::<f64>().ok()) {
            if (30.0..=220.0).contains(&hr) {
                out.push(WellnessReading { kind: WellnessKind::HeartRate, value: hr, ts });
            }
        }
        if let Some(rr) = c.get(4).and_then(|s| s.trim().parse::<f64>().ok()) {
            if (4.0..=40.0).contains(&rr) {
                out.push(WellnessReading { kind: WellnessKind::Respiration, value: rr, ts });
            }
        }
    }
}

/// Map Zepp sleep-stage labels to the canonical [`SleepStage`].
fn parse_stage(s: &str) -> Option<SleepStage> {
    match s.trim().to_ascii_uppercase().as_str() {
        "DEEP" => Some(SleepStage::Deep),
        "LIGHT" | "SHALLOW" => Some(SleepStage::Light),
        "REM" => Some(SleepStage::Rem),
        "WAKE" | "AWAKE" => Some(SleepStage::Awake),
        _ => None,
    }
}

/// `ACTIVITY` (daily): `date,steps,distance,runDistance,calories`.
fn parse_activity_daily(text: &str, out: &mut Vec<WellnessReading>) {
    for line in text.lines().skip(1) {
        let c = cells(line);
        if c.len() < 5 {
            continue;
        }
        let Some(ts) = at_midnight(c[0]) else { continue };
        if let Some(steps) = c[1].trim().parse::<f64>().ok().filter(|v| *v > 0.0) {
            out.push(WellnessReading { kind: WellnessKind::Steps, value: steps, ts });
        }
        if let Some(cal) = c[4].trim().parse::<f64>().ok().filter(|v| *v > 0.0) {
            out.push(WellnessReading { kind: WellnessKind::Calories, value: cal, ts });
        }
    }
}

/// `BODY`: `time,weight,height,bmi,…` where `time` is `YYYY-MM-DD HH:MM:SS+0000`.
fn parse_body(text: &str, out: &mut Vec<WellnessReading>) {
    for line in text.lines().skip(1) {
        let c = cells(line);
        if c.len() < 2 {
            continue;
        }
        let Some(ts) = DateTime::parse_from_str(c[0].trim(), "%Y-%m-%d %H:%M:%S%z")
            .ok()
            .map(|t| t.with_timezone(&Utc))
        else {
            continue;
        };
        if let Some(w) = c[1].trim().parse::<f64>().ok().filter(|v| (20.0..=400.0).contains(v)) {
            out.push(WellnessReading { kind: WellnessKind::Weight, value: w, ts });
        }
    }
}

/// `USER`: `userId,gender,height,weight,nickName,avatar,birthday`.
fn parse_user_nickname(text: &str) -> Option<String> {
    let line = text.lines().nth(1)?;
    let c = cells(line);
    c.get(4).map(|s| s.trim()).filter(|s| !s.is_empty() && *s != "null").map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_zepp_export_if_present() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../imports/Zepp full Export");
        if !root.exists() {
            eprintln!("skip: no local Zepp export");
            return;
        }
        let imp = read_zepp_export(&root).expect("read zepp");
        eprintln!("source={} skipped={:?}", imp.source_name, imp.skipped);
        for (k, n) in &imp.counts {
            eprintln!("  {:?}: {}", k, n);
        }
        assert!(!imp.readings.is_empty());
        assert!(imp.counts.contains_key(&WellnessKind::HeartRate));
        assert!(imp.counts.contains_key(&WellnessKind::SleepStage));
    }
}
