//! Garmin Connect GDPR-export parser (the one-time history backfill).
//!
//! A Garmin export is a large directory tree of JSON (plus a `.fit` firehose
//! handled separately by [`crate::pipeline::import_garmin_fit_dir`]). This module
//! reads the JSON wellness/body/performance series, gear, and personal records
//! into the canonical [`ofit_core`] types — mirroring the [`crate::zepp`] design
//! (a parser that emits a plain struct; the API layer attributes a [`Source`] and
//! persists it). Garmin is JSON where Zepp is CSV, so we use `serde_json`, but the
//! output contract + import path are deliberately the same.
//!
//! [`Source`]: ofit_core::Source
//!
//! ## What maps where (verified against a real 2019→2026 export)
//! - `DI-Connect-Aggregator/UDSFile_*.json` — daily rollups → [`WellnessKind`]:
//!   steps, active calories, current-day resting HR, daily stress avg, body
//!   battery stats, waking respiration, SpO2. Stamped at the day's UTC midnight.
//! - `DI-Connect-Wellness/*_sleepData.json` — nightly durations → per-minute
//!   [`WellnessKind::SleepStage`] approximated to sum to the real durations (the
//!   export has no per-epoch stages), plus nightly respiration.
//! - `DI-Connect-Wellness/*_userBioMetrics.json` — weight (g→kg) + body fat / BMI
//!   when the scale measured them.
//! - `DI-Connect-Metrics/` — VO2max, weekly training load, race predictions,
//!   fitness age (Firstbeat proprietary trends Open Fit can't recompute).
//! - `DI-Connect-Fitness/*_gear.json` — gear + per-activity links → real mileage
//!   by joining `*_summarizedActivities.json` distances.
//! - `DI-Connect-Fitness/*_personalRecord.json` — current personal records.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, TimeZone, Utc};
use ofit_core::{SleepStage, WellnessKind};
use serde_json::Value;

use crate::zepp::WellnessReading;

/// Errors raised while reading a Garmin export.
#[derive(Debug, thiserror::Error)]
pub enum GarminError {
    /// The path isn't a recognizable Garmin export (no `DI_CONNECT` subtree).
    #[error("not a Garmin export (no DI_CONNECT dir under {0:?})")]
    NotAGarminExport(String),
    /// IO failure reading the export.
    #[error("io error reading Garmin export: {0}")]
    Io(#[from] std::io::Error),
}

/// A gear item parsed from `gear.json`, with real mileage already joined from the
/// activity-distance summaries.
#[derive(Debug, Clone, PartialEq)]
pub struct GarminGear {
    /// Display name, e.g. `"Altra blue"`.
    pub name: String,
    /// Sub-label (the custom make/model).
    pub description: String,
    /// Activity-type label: `"Running"` | `"Cycling"` | `"Other"`.
    pub sport: String,
    /// UI icon: `"run"` | `"bike"`.
    pub icon: String,
    /// Retire-at distance (km) — the user's wear limit.
    pub retire_km: f64,
    /// Accrued mileage (km) summed from linked activities.
    pub used_km: f64,
    /// When the gear was first used.
    pub created_at: DateTime<Utc>,
    /// Whether Garmin had it retired.
    pub retired: bool,
}

/// A personal record parsed from `personalRecord.json`.
#[derive(Debug, Clone, PartialEq)]
pub struct GarminPr {
    /// Human label, e.g. `"Best 5km Run"`.
    pub record_type: String,
    /// Value in [`unit`](Self::unit).
    pub value: f64,
    /// `"seconds"` | `"meters"` | `"count"`.
    pub unit: String,
    /// When the record was set (UTC).
    pub occurred_at: DateTime<Utc>,
    /// Current holder vs. superseded.
    pub current: bool,
}

/// The parsed Garmin export (JSON portion). FIT activities are imported
/// separately (see the module docs).
#[derive(Debug, Clone)]
pub struct GarminImport {
    /// Source label all wellness is attributed to.
    pub source_name: String,
    /// All extracted wellness readings (daily + sleep + body + performance).
    pub readings: Vec<WellnessReading>,
    /// Gear with joined mileage.
    pub gear: Vec<GarminGear>,
    /// Current personal records.
    pub personal_records: Vec<GarminPr>,
    /// Per-kind reading counts (import summary).
    pub counts: BTreeMap<WellnessKind, usize>,
    /// Distinct calendar days that contributed daily wellness.
    pub days: usize,
    /// Sleep nights imported (staged).
    pub nights: usize,
    /// Notes about files/categories present but not imported (with why).
    pub skipped: Vec<String>,
}

/// Extract an uploaded Garmin export `.zip` into `dest` (traversal-safe) and
/// return the resolved export root — the directory that holds `DI_CONNECT`,
/// which is either `dest` itself or a single wrapping subdirectory (Garmin zips
/// often wrap everything in one folder). The caller owns `dest` and cleans it up.
pub fn unzip_garmin_export(zip_path: &Path, dest: &Path) -> Result<PathBuf, GarminError> {
    std::fs::create_dir_all(dest)?;
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| GarminError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| GarminError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())))?;
        // `enclosed_name` rejects path-traversal (`..`, absolute) entries.
        let Some(rel) = entry.enclosed_name() else { continue };
        let out = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
        } else {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut f = std::fs::File::create(&out)?;
            std::io::copy(&mut entry, &mut f)?;
        }
    }
    resolve_export_root(dest)
}

/// Find the directory holding `DI_CONNECT`: `dir` itself, or a single child.
fn resolve_export_root(dir: &Path) -> Result<PathBuf, GarminError> {
    if dir.join("DI_CONNECT").is_dir() {
        return Ok(dir.to_path_buf());
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() && p.join("DI_CONNECT").is_dir() {
                return Ok(p);
            }
        }
    }
    Err(GarminError::NotAGarminExport(dir.display().to_string()))
}

/// Read a Garmin GDPR export directory tree into a [`GarminImport`].
///
/// Lenient by design: every field is optional (the schema drifts across the
/// 2019→2026 span), unparseable records are skipped (counted in `skipped`), and a
/// missing category is simply absent — never an error.
pub fn read_garmin_export(root: &Path) -> Result<GarminImport, GarminError> {
    let di = root.join("DI_CONNECT");
    if !di.is_dir() {
        return Err(GarminError::NotAGarminExport(root.display().to_string()));
    }
    let agg = di.join("DI-Connect-Aggregator");
    let well = di.join("DI-Connect-Wellness");
    let metrics = di.join("DI-Connect-Metrics");
    let fitness = di.join("DI-Connect-Fitness");

    let mut readings: Vec<WellnessReading> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut days: BTreeSet<NaiveDate> = BTreeSet::new();
    let mut nights = 0usize;

    // --- T2a: daily wellness (UDSFile) ---
    for path in files_with(&agg, "UDSFile") {
        match read_json(&path) {
            Some(Value::Array(items)) => {
                for day in &items {
                    parse_uds_day(day, &mut readings, &mut days);
                }
            }
            _ => note(&mut skipped, &format!("{}: unreadable UDSFile", file_label(&path))),
        }
    }

    // --- T2b: sleep (per-night → approximated per-minute stages) ---
    for path in files_with(&well, "sleepData") {
        if let Some(Value::Array(items)) = read_json(&path) {
            for night in &items {
                if parse_sleep_night(night, &mut readings) {
                    nights += 1;
                }
            }
        }
    }

    // --- T2c: body (weight + composition) ---
    for path in files_with(&well, "userBioMetrics") {
        if let Some(Value::Array(items)) = read_json(&path) {
            parse_biometrics(&items, &mut readings);
        }
    }

    // --- T3: performance trends ---
    for path in files_with(&metrics, "MetricsMaxMetData") {
        if let Some(Value::Array(items)) = read_json(&path) {
            parse_max_met(&items, &mut readings);
        }
    }
    for path in files_with(&metrics, "TrainingHistory") {
        if let Some(Value::Array(items)) = read_json(&path) {
            parse_training_history(&items, &mut readings);
        }
    }
    for path in files_with(&metrics, "RunRacePredictions") {
        if let Some(Value::Array(items)) = read_json(&path) {
            parse_race_predictions(&items, &mut readings);
        }
    }
    if !files_with(&metrics, "MetricsHeatAltitudeAcclimation").is_empty() {
        note(&mut skipped, "MetricsHeatAltitudeAcclimation: niche acclimation — skipped");
    }
    if !files_with(&metrics, "ManualStressLevel").is_empty() {
        note(&mut skipped, "ManualStressLevel: effectively empty — skipped");
    }

    // --- T4: gear (mileage joined from the activity-distance summaries) ---
    let distance_cm_by_activity = activity_distances(&fitness);
    let gear = files_with(&fitness, "gear")
        .into_iter()
        .filter_map(|p| read_json(&p))
        .flat_map(|v| parse_gear(&v, &distance_cm_by_activity))
        .collect::<Vec<_>>();

    // --- T4: personal records (current holders only) ---
    let personal_records = files_with(&fitness, "personalRecord")
        .into_iter()
        .filter_map(|p| read_json(&p))
        .flat_map(|v| parse_personal_records(&v))
        .collect::<Vec<_>>();

    let mut counts: BTreeMap<WellnessKind, usize> = BTreeMap::new();
    for r in &readings {
        *counts.entry(r.kind).or_insert(0) += 1;
    }

    Ok(GarminImport {
        source_name: "Garmin (import)".to_string(),
        readings,
        gear,
        personal_records,
        counts,
        days: days.len(),
        nights,
        skipped,
    })
}

// ---------------------------------------------------------------------------
// Daily wellness (UDSFile)
// ---------------------------------------------------------------------------

fn parse_uds_day(day: &Value, out: &mut Vec<WellnessReading>, days: &mut BTreeSet<NaiveDate>) {
    let Some(date) = s(day, "calendarDate").and_then(|d| parse_day(&d)) else {
        return;
    };
    days.insert(date);
    let midnight = day_midnight(date);

    push(out, WellnessKind::Steps, i(day, "totalSteps").map(|v| v as f64), midnight);
    // Active (exercise) kilocalories — the meaningful daily burn, not BMR-inclusive total.
    push(out, WellnessKind::Calories, f(day, "activeKilocalories"), midnight);
    // The single-day resting HR (not the trailing-7-day `restingHeartRate`).
    push(
        out,
        WellnessKind::RestingHeartRate,
        i(day, "currentDayRestingHeartRate").filter(|&v| v > 0).map(|v| v as f64),
        midnight,
    );

    // Daily stress average (TOTAL aggregator). -1 / -2 are "no data" sentinels.
    if let Some(stress) = day
        .get("allDayStress")
        .and_then(|v| v.get("aggregatorList"))
        .and_then(|v| v.as_array())
    {
        if let Some(total) = stress.iter().find(|a| s(a, "type").as_deref() == Some("TOTAL")) {
            if let Some(avg) = f(total, "averageStressLevel").filter(|&v| v >= 0.0) {
                out.push(WellnessReading { kind: WellnessKind::Stress, value: avg, ts: midnight });
            }
        }
    }

    // Body-battery stats (a few intraday points per day, at their own timestamps).
    if let Some(bb) = day
        .get("bodyBattery")
        .and_then(|v| v.get("bodyBatteryStatList"))
        .and_then(|v| v.as_array())
    {
        for stat in bb {
            let kind = s(stat, "bodyBatteryStatType");
            // STARTOFDAY usually duplicates HIGHEST's timestamp; keep the meaningful three.
            if !matches!(kind.as_deref(), Some("HIGHEST" | "LOWEST" | "MOSTRECENT")) {
                continue;
            }
            if let (Some(v), Some(ts)) =
                (f(stat, "statsValue"), s(stat, "statTimestamp").and_then(|t| parse_ts(&t)))
            {
                out.push(WellnessReading { kind: WellnessKind::BodyBattery, value: v, ts });
            }
        }
    }

    // Waking respiration (stamped at its own time when present, else midnight).
    if let Some(resp) = day.get("respiration") {
        if let Some(v) = f(resp, "avgWakingRespirationValue").filter(|&v| v > 0.0) {
            let ts = s(resp, "latestRespirationTimeGMT")
                .and_then(|t| parse_ts(&t))
                .unwrap_or(midnight);
            out.push(WellnessReading { kind: WellnessKind::Respiration, value: v, ts });
        }
    }

    // SpO2 (often absent).
    push(out, WellnessKind::SpO2, f(day, "averageSpo2Value").filter(|&v| v > 0.0), midnight);
}

// ---------------------------------------------------------------------------
// Sleep (nightly durations → approximated per-minute stages)
// ---------------------------------------------------------------------------

/// Returns `true` if the night was imported (staged).
fn parse_sleep_night(night: &Value, out: &mut Vec<WellnessReading>) -> bool {
    // Skip nights the watch couldn't confirm / measure.
    if let Some(conf) = s(night, "sleepWindowConfirmationType") {
        let c = conf.to_ascii_uppercase();
        if c.contains("UNCONFIRMED") || c.contains("OFF_WRIST") {
            return false;
        }
    }
    let Some(start) = s(night, "sleepStartTimestampGMT").and_then(|t| parse_ts(&t)) else {
        return false;
    };
    let deep = i(night, "deepSleepSeconds").unwrap_or(0).max(0);
    let light = i(night, "lightSleepSeconds").unwrap_or(0).max(0);
    let rem = i(night, "remSleepSeconds").unwrap_or(0).max(0);
    let awake = i(night, "awakeSleepSeconds").unwrap_or(0).max(0);
    if deep + light + rem + awake == 0 {
        return false;
    }

    // The export carries only nightly durations, not per-epoch stages. We lay out
    // one [`WellnessKind::SleepStage`] sample per minute that sums to the real
    // durations (order within the night is synthetic, but the sleep algorithm only
    // sums per-stage minutes per night, so totals are faithful).
    let mut minute = 0i64;
    let emit = |out: &mut Vec<WellnessReading>, stage: SleepStage, secs: i64, minute: &mut i64| {
        for _ in 0..(secs / 60) {
            let ts = start + Duration::minutes(*minute);
            out.push(WellnessReading { kind: WellnessKind::SleepStage, value: stage.code(), ts });
            *minute += 1;
        }
    };
    emit(out, SleepStage::Deep, deep, &mut minute);
    emit(out, SleepStage::Rem, rem, &mut minute);
    emit(out, SleepStage::Light, light, &mut minute);
    emit(out, SleepStage::Awake, awake, &mut minute);

    // Nightly average respiration (stamped at the night's midpoint).
    if let Some(v) = f(night, "averageRespiration").filter(|&v| v > 0.0) {
        let mid = start + Duration::minutes(minute / 2);
        out.push(WellnessReading { kind: WellnessKind::Respiration, value: v, ts: mid });
    }
    // Overnight SpO2 average (rare in this export, but present in later years).
    if let Some(v) = night
        .get("spo2SleepSummary")
        .and_then(|s2| f(s2, "averageSPO2"))
        .filter(|&v| v > 0.0)
    {
        let mid = start + Duration::minutes(minute / 2);
        out.push(WellnessReading { kind: WellnessKind::SpO2, value: v, ts: mid });
    }
    true
}

// ---------------------------------------------------------------------------
// Body composition (userBioMetrics)
// ---------------------------------------------------------------------------

fn parse_biometrics(items: &[Value], out: &mut Vec<WellnessReading>) {
    // Versioned snapshots → dedup weight by its measurement timestamp.
    let mut seen: BTreeSet<i64> = BTreeSet::new();
    for rec in items {
        let Some(w) = rec.get("weight") else { continue };
        let Some(ts) = s(w, "timestampGMT").and_then(|t| parse_ts(&t)) else { continue };
        if !seen.insert(ts.timestamp()) {
            continue;
        }
        // Weight is in grams.
        if let Some(grams) = f(w, "weight").filter(|&v| v > 0.0) {
            out.push(WellnessReading { kind: WellnessKind::Weight, value: grams / 1000.0, ts });
        }
        // Body fat % and BMI ride inside `weight`; 0.0 means "not measured".
        if let Some(bf) = f(w, "bodyFat").filter(|&v| v > 0.0) {
            out.push(WellnessReading { kind: WellnessKind::BodyFat, value: bf, ts });
        }
        if let Some(bmi) = f(w, "bmi").filter(|&v| v > 0.0) {
            out.push(WellnessReading { kind: WellnessKind::Bmi, value: bmi, ts });
        }
    }
}

// ---------------------------------------------------------------------------
// Performance trends (DI-Connect-Metrics)
// ---------------------------------------------------------------------------

fn parse_max_met(items: &[Value], out: &mut Vec<WellnessReading>) {
    // One VO2max + fitness-age per day; prefer the RUNNING record.
    let mut vo2_by_day: BTreeMap<NaiveDate, f64> = BTreeMap::new();
    let mut age_by_day: BTreeMap<NaiveDate, f64> = BTreeMap::new();
    for rec in items {
        let Some(date) = s(rec, "calendarDate").and_then(|d| parse_day(&d)) else { continue };
        let is_running = s(rec, "sport").as_deref() == Some("RUNNING");
        if let Some(v) = f(rec, "vo2MaxValue").filter(|&v| v > 0.0) {
            if is_running || !vo2_by_day.contains_key(&date) {
                vo2_by_day.insert(date, v);
            }
        }
        // fitnessAge is a string like "20".
        if let Some(age) = s(rec, "fitnessAge").and_then(|a| a.trim().parse::<f64>().ok()).filter(|&v| v > 0.0) {
            if is_running || !age_by_day.contains_key(&date) {
                age_by_day.insert(date, age);
            }
        }
    }
    for (date, v) in vo2_by_day {
        out.push(WellnessReading { kind: WellnessKind::Vo2Max, value: v, ts: day_midnight(date) });
    }
    for (date, v) in age_by_day {
        out.push(WellnessReading { kind: WellnessKind::FitnessAge, value: v, ts: day_midnight(date) });
    }
}

fn parse_training_history(items: &[Value], out: &mut Vec<WellnessReading>) {
    // weeklyTrainingLoadSum is per-sport-per-day; keep the day's dominant (max) load.
    let mut load_by_day: BTreeMap<NaiveDate, f64> = BTreeMap::new();
    for rec in items {
        let Some(date) = s(rec, "calendarDate").and_then(|d| parse_day(&d)) else { continue };
        if let Some(load) = f(rec, "weeklyTrainingLoadSum").filter(|&v| v > 0.0) {
            let e = load_by_day.entry(date).or_insert(0.0);
            if load > *e {
                *e = load;
            }
        }
    }
    for (date, v) in load_by_day {
        out.push(WellnessReading { kind: WellnessKind::TrainingLoad, value: v, ts: day_midnight(date) });
    }
}

fn parse_race_predictions(items: &[Value], out: &mut Vec<WellnessReading>) {
    // Dedup by day (sync bursts repeat); keep the last record seen for the day.
    let mut by_day: BTreeMap<NaiveDate, [Option<f64>; 4]> = BTreeMap::new();
    for rec in items {
        let Some(date) = s(rec, "calendarDate").and_then(|d| parse_day(&d)) else { continue };
        let e = by_day.entry(date).or_default();
        for (idx, key) in ["raceTime5K", "raceTime10K", "raceTimeHalf", "raceTimeMarathon"].iter().enumerate() {
            if let Some(v) = f(rec, key).filter(|&v| v > 0.0) {
                e[idx] = Some(v);
            }
        }
    }
    let kinds = [
        WellnessKind::RacePredict5k,
        WellnessKind::RacePredict10k,
        WellnessKind::RacePredictHalf,
        WellnessKind::RacePredictMarathon,
    ];
    for (date, vals) in by_day {
        let ts = day_midnight(date);
        for (idx, v) in vals.iter().enumerate() {
            if let Some(v) = v {
                out.push(WellnessReading { kind: kinds[idx], value: *v, ts });
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Gear + personal records (DI-Connect-Fitness)
// ---------------------------------------------------------------------------

/// Build `activityId → distance (cm)` from the summarized-activities files.
fn activity_distances(fitness: &Path) -> HashMap<i64, f64> {
    let mut map = HashMap::new();
    for path in files_with(fitness, "summarizedActivities") {
        let Some(v) = read_json(&path) else { continue };
        // Shape: [{ "summarizedActivitiesExport": [ {…} ] }]
        let acts = v
            .as_array()
            .and_then(|a| a.first())
            .and_then(|w| w.get("summarizedActivitiesExport"))
            .and_then(|a| a.as_array());
        if let Some(acts) = acts {
            for a in acts {
                if let (Some(id), Some(dist)) = (i(a, "activityId"), f(a, "distance")) {
                    map.insert(id, dist);
                }
            }
        }
    }
    map
}

fn parse_gear(v: &Value, distance_cm: &HashMap<i64, f64>) -> Vec<GarminGear> {
    let Some(root) = v.as_array().and_then(|a| a.first()) else {
        return Vec::new();
    };
    // gearActivityDTOs is a MAP keyed by gearPk-string → [{ activityId }].
    let links = root.get("gearActivityDTOs");
    let mut out = Vec::new();
    let Some(gears) = root.get("gearDTOS").and_then(|g| g.as_array()) else {
        return out;
    };
    for g in gears {
        let Some(name) = s(g, "displayName").filter(|n| !n.trim().is_empty()) else { continue };
        let pk = i(g, "gearPk");
        // Sum linked-activity distances (cm) → km.
        let used_km = pk
            .and_then(|pk| links.and_then(|l| l.get(pk.to_string())))
            .and_then(|arr| arr.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|link| i(link, "activityId"))
                    .filter_map(|aid| distance_cm.get(&aid))
                    .sum::<f64>()
                    / 100_000.0
            })
            .unwrap_or(0.0);
        let type_name = s(g, "gearTypeName").unwrap_or_default();
        let (sport, icon) = match type_name.to_ascii_lowercase().as_str() {
            t if t.contains("shoe") => ("Running".to_string(), "run".to_string()),
            t if t.contains("bike") || t.contains("cycle") => ("Cycling".to_string(), "bike".to_string()),
            _ => ("Other".to_string(), "run".to_string()),
        };
        let created_at = s(g, "dateBegin")
            .or_else(|| s(g, "createDate"))
            .and_then(|d| parse_day(&d))
            .map(day_midnight)
            .unwrap_or_else(Utc::now);
        out.push(GarminGear {
            name,
            description: s(g, "customMakeModel").unwrap_or_default(),
            sport,
            icon,
            retire_km: f(g, "maximumMeters").map(|m| m / 1000.0).filter(|&v| v > 0.0).unwrap_or(1000.0),
            used_km,
            created_at,
            retired: s(g, "gearStatusName").as_deref() == Some("retired"),
        });
    }
    out
}

fn parse_personal_records(v: &Value) -> Vec<GarminPr> {
    let Some(prs) = v
        .as_array()
        .and_then(|a| a.first())
        .and_then(|r| r.get("personalRecords"))
        .and_then(|p| p.as_array())
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for pr in prs {
        // Only the current holders (the meaningful set).
        if !pr.get("current").and_then(|c| c.as_bool()).unwrap_or(false) {
            continue;
        }
        let Some(rtype) = s(pr, "personalRecordType") else { continue };
        let Some(value) = f(pr, "value") else { continue };
        let unit = pr_unit(&rtype);
        let occurred_at = s(pr, "prStartTimeGMT")
            .and_then(|t| parse_pr_ts(&t))
            .or_else(|| s(pr, "createdDate").and_then(|d| parse_day(&d)).map(day_midnight))
            .unwrap_or_else(Utc::now);
        out.push(GarminPr { record_type: rtype, value, unit, occurred_at, current: true });
    }
    out
}

/// Map a Garmin record-type label to the unit of its (unlabelled) value.
fn pr_unit(record_type: &str) -> String {
    let t = record_type.to_ascii_lowercase();
    if t.starts_with("best") {
        "seconds".to_string() // "Best 5km Run" etc. are times
    } else if t.contains("steps") || t.contains("streak") {
        "count".to_string()
    } else {
        // "Farthest Run/Cycle", "Max Elevation Gain" → metres
        "meters".to_string()
    }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn push(out: &mut Vec<WellnessReading>, kind: WellnessKind, value: Option<f64>, ts: DateTime<Utc>) {
    if let Some(value) = value {
        out.push(WellnessReading { kind, value, ts });
    }
}

fn note(skipped: &mut Vec<String>, msg: &str) {
    if !skipped.iter().any(|s| s == msg) {
        skipped.push(msg.to_string());
    }
}

/// Files in `dir` whose name contains `needle` (Garmin names vary by date range).
fn files_with(dir: &Path, needle: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.contains(needle))
                    .unwrap_or(false)
            {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

fn file_label(p: &Path) -> String {
    p.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string()
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn f(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64())
}

fn i(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_i64().or_else(|| x.as_u64().map(|u| u as i64)))
}

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|x| x.to_string())
}

/// Parse a `YYYY-MM-DD` calendar date (also tolerates a trailing `Txx:xx:xx…`).
fn parse_day(s: &str) -> Option<NaiveDate> {
    let head = s.get(0..10)?;
    NaiveDate::parse_from_str(head, "%Y-%m-%d").ok()
}

fn day_midnight(date: NaiveDate) -> DateTime<Utc> {
    Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
}

/// Parse a Garmin GMT timestamp like `2025-12-24T09:50:00.0` (ISO, fractional
/// seconds, **no zone** → interpreted as UTC).
fn parse_ts(s: &str) -> Option<DateTime<Utc>> {
    NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f")
        .ok()
        .map(|ndt| Utc.from_utc_datetime(&ndt))
}

/// Parse the personal-record time format `Tue Jun 02 16:32:07 GMT 2020`.
fn parse_pr_ts(s: &str) -> Option<DateTime<Utc>> {
    NaiveDateTime::parse_from_str(s, "%a %b %d %H:%M:%S GMT %Y")
        .ok()
        .map(|ndt| Utc.from_utc_datetime(&ndt))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sleep_night_sums_to_durations() {
        let night = serde_json::json!({
            "sleepStartTimestampGMT": "2025-03-26T23:08:00.0",
            "sleepEndTimestampGMT": "2025-03-27T06:11:00.0",
            "calendarDate": "2025-03-27",
            "sleepWindowConfirmationType": "ENHANCED_CONFIRMED_FINAL",
            "deepSleepSeconds": 6900,   // 115 min
            "lightSleepSeconds": 13500, // 225 min
            "remSleepSeconds": 3480,    // 58 min
            "awakeSleepSeconds": 1500,  // 25 min
            "averageRespiration": 15.0
        });
        let mut out = Vec::new();
        assert!(parse_sleep_night(&night, &mut out));
        let stages: Vec<_> = out.iter().filter(|r| r.kind == WellnessKind::SleepStage).collect();
        assert_eq!(stages.len(), 115 + 225 + 58 + 25);
        let deep = stages.iter().filter(|r| r.value == SleepStage::Deep.code()).count();
        assert_eq!(deep, 115);
        assert_eq!(out.iter().filter(|r| r.kind == WellnessKind::Respiration).count(), 1);
    }

    #[test]
    fn pr_units_by_type() {
        assert_eq!(pr_unit("Best 5km Run"), "seconds");
        assert_eq!(pr_unit("Farthest Run"), "meters");
        assert_eq!(pr_unit("Most Steps in a Day"), "count");
        assert_eq!(pr_unit("Current Goal Streak"), "count");
        assert_eq!(pr_unit("Max Elevation Gain"), "meters");
    }

    #[test]
    fn parses_garmin_timestamps() {
        assert!(parse_ts("2025-12-24T09:50:00.0").is_some());
        assert!(parse_ts("2019-11-27T07:33:19.223").is_some());
        assert!(parse_pr_ts("Tue Jun 02 16:32:07 GMT 2020").is_some());
        assert_eq!(parse_day("2019-11-27T08:33:19.223"), NaiveDate::from_ymd_opt(2019, 11, 27));
    }

    #[test]
    fn uds_day_extracts_core_metrics() {
        let day = serde_json::json!({
            "calendarDate": "2025-12-24",
            "totalSteps": 7767,
            "activeKilocalories": 537.0,
            "currentDayRestingHeartRate": 89,
            "allDayStress": { "aggregatorList": [{ "type": "TOTAL", "averageStressLevel": 33 }] },
            "bodyBattery": { "bodyBatteryStatList": [
                { "bodyBatteryStatType": "HIGHEST", "statsValue": 66, "statTimestamp": "2025-12-24T09:50:00.0" }
            ]},
            "respiration": { "avgWakingRespirationValue": 14.0 }
        });
        let mut out = Vec::new();
        let mut days = BTreeSet::new();
        parse_uds_day(&day, &mut out, &mut days);
        assert_eq!(days.len(), 1);
        assert!(out.iter().any(|r| r.kind == WellnessKind::Steps && r.value == 7767.0));
        assert!(out.iter().any(|r| r.kind == WellnessKind::Stress && r.value == 33.0));
        assert!(out.iter().any(|r| r.kind == WellnessKind::BodyBattery && r.value == 66.0));
        assert!(out.iter().any(|r| r.kind == WellnessKind::RestingHeartRate && r.value == 89.0));
    }
}
