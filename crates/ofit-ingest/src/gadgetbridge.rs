//! Gadgetbridge export-DB import adapter (Phase 2a, cloudless).
//!
//! Reads an **exported Gadgetbridge SQLite DB** and extracts continuous wellness
//! as [`ofit_core::WellnessKind`] readings, **per device** (the DB can hold many —
//! e.g. an Amazfit Helio + a Garmin 945). The API creates one source per device
//! and ingests its readings via `POST /api/import/gadgetbridge`.
//!
//! Each Gadgetbridge device family stores samples in its own tables; we read the
//! ones present (Huami/Amazfit, Garmin, and the generic HRV/temperature tables).
//! Sleep staging is intentionally deferred (the kind→stage mapping is fuzzy).

use std::collections::BTreeMap;
use std::path::Path;

use chrono::{DateTime, TimeZone, Utc};
use ofit_core::WellnessKind;
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::{Row, SqlitePool};

/// One extracted wellness reading (the API stamps it with a source + uuid).
#[derive(Debug, Clone, PartialEq)]
pub struct WellnessReading {
    pub kind: WellnessKind,
    pub value: f64,
    pub ts: DateTime<Utc>,
}

/// One device found in the export, with its extracted readings.
#[derive(Debug, Clone)]
pub struct GadgetbridgeDevice {
    pub name: String,
    pub manufacturer: Option<String>,
    pub readings: Vec<WellnessReading>,
}

/// Result of reading a Gadgetbridge export DB.
#[derive(Debug, Clone)]
pub struct GadgetbridgeImport {
    pub devices: Vec<GadgetbridgeDevice>,
}

/// Errors reading a Gadgetbridge DB.
#[derive(Debug, thiserror::Error)]
pub enum GbError {
    #[error("gadgetbridge db: {0}")]
    Db(#[from] sqlx::Error),
}

/// A `value` column in a per-device sample table → a [`WellnessKind`], keeping
/// only values within `[lo, hi]` (sentinel/not-worn readings sit outside).
struct TableSpec {
    table: &'static str,
    column: &'static str,
    kind: WellnessKind,
    lo: f64,
    hi: f64,
}

const SPECS: &[TableSpec] = &[
    TableSpec { table: "HUAMI_STRESS_SAMPLE", column: "STRESS", kind: WellnessKind::Stress, lo: 0.0, hi: 100.0 },
    TableSpec { table: "HUAMI_SPO2_SAMPLE", column: "SPO2", kind: WellnessKind::SpO2, lo: 50.0, hi: 100.0 },
    TableSpec { table: "HUAMI_HEART_RATE_RESTING_SAMPLE", column: "HEART_RATE", kind: WellnessKind::RestingHeartRate, lo: 30.0, hi: 120.0 },
    TableSpec { table: "HUAMI_SLEEP_RESPIRATORY_RATE_SAMPLE", column: "RATE", kind: WellnessKind::Respiration, lo: 4.0, hi: 40.0 },
    TableSpec { table: "GENERIC_HRV_VALUE_SAMPLE", column: "VALUE", kind: WellnessKind::Hrv, lo: 1.0, hi: 400.0 },
    TableSpec { table: "GARMIN_STRESS_SAMPLE", column: "STRESS", kind: WellnessKind::Stress, lo: 0.0, hi: 100.0 },
    TableSpec { table: "GARMIN_BODY_ENERGY_SAMPLE", column: "ENERGY", kind: WellnessKind::BodyBattery, lo: 0.0, hi: 100.0 },
    TableSpec { table: "GARMIN_HEART_RATE_RESTING_SAMPLE", column: "HEART_RATE", kind: WellnessKind::RestingHeartRate, lo: 30.0, hi: 120.0 },
    TableSpec { table: "GARMIN_RESPIRATORY_RATE_SAMPLE", column: "RESPIRATORY_RATE", kind: WellnessKind::Respiration, lo: 4.0, hi: 40.0 },
];

/// Gadgetbridge tables are inconsistent: most store epoch **seconds**, the Huami
/// stress table **milliseconds**. Auto-normalize (a real epoch in seconds is
/// < 1e11 ≈ year 5138, so anything larger is milliseconds).
fn at(ts: i64) -> DateTime<Utc> {
    let secs = if ts > 100_000_000_000 { ts / 1000 } else { ts };
    Utc.timestamp_opt(secs, 0).single().unwrap_or_else(Utc::now)
}

async fn has_table(pool: &SqlitePool, name: &str) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .bind(name)
        .fetch_optional(pool)
        .await?
        .is_some())
}

/// Push readings of one spec into the per-device map.
async fn read_spec(pool: &SqlitePool, spec: &TableSpec, by_device: &mut BTreeMap<i64, Vec<WellnessReading>>) -> Result<(), sqlx::Error> {
    if !has_table(pool, spec.table).await? {
        return Ok(());
    }
    // `table`/`column` come from the const SPECS list — never user input.
    let sql = format!("SELECT TIMESTAMP, DEVICE_ID, {} AS v FROM {}", spec.column, spec.table);
    for r in sqlx::query(&sql).fetch_all(pool).await? {
        let ts: i64 = r.try_get("TIMESTAMP").unwrap_or(0);
        let dev: i64 = r.try_get("DEVICE_ID").unwrap_or(0);
        let v: f64 = r.try_get::<i64, _>("v").map(|n| n as f64).or_else(|_| r.try_get::<f64, _>("v")).unwrap_or(f64::NAN);
        if v.is_finite() && v >= spec.lo && v <= spec.hi {
            by_device.entry(dev).or_default().push(WellnessReading { kind: spec.kind, value: v, ts: at(ts) });
        }
    }
    Ok(())
}

/// Read an exported Gadgetbridge SQLite DB at `path` (opened read-only).
pub async fn read_db(path: &Path) -> Result<GadgetbridgeImport, GbError> {
    let url = format!("sqlite://{}?mode=ro", path.display());
    let pool = SqlitePoolOptions::new().max_connections(1).connect(&url).await?;

    // device_id → (name, manufacturer)
    let mut devices: BTreeMap<i64, (String, Option<String>)> = BTreeMap::new();
    for r in sqlx::query("SELECT _id, NAME, MANUFACTURER FROM DEVICE").fetch_all(&pool).await? {
        let id: i64 = r.try_get("_id").unwrap_or(0);
        let name: String = r.try_get("NAME").unwrap_or_else(|_| "Gadgetbridge device".into());
        let mfr: Option<String> = r.try_get("MANUFACTURER").ok();
        devices.insert(id, (name, mfr));
    }

    let mut by_device: BTreeMap<i64, Vec<WellnessReading>> = BTreeMap::new();

    // Huami extended activity samples carry HR + steps in one table.
    if has_table(&pool, "HUAMI_EXTENDED_ACTIVITY_SAMPLE").await? {
        for r in sqlx::query("SELECT TIMESTAMP, DEVICE_ID, HEART_RATE, STEPS FROM HUAMI_EXTENDED_ACTIVITY_SAMPLE")
            .fetch_all(&pool)
            .await?
        {
            let ts: i64 = r.try_get("TIMESTAMP").unwrap_or(0);
            let dev: i64 = r.try_get("DEVICE_ID").unwrap_or(0);
            let hr: i64 = r.try_get("HEART_RATE").unwrap_or(0);
            let steps: i64 = r.try_get("STEPS").unwrap_or(0);
            let v = by_device.entry(dev).or_default();
            if (30..=220).contains(&hr) {
                v.push(WellnessReading { kind: WellnessKind::HeartRate, value: hr as f64, ts: at(ts) });
            }
            if steps > 0 {
                v.push(WellnessReading { kind: WellnessKind::Steps, value: steps as f64, ts: at(ts) });
            }
        }
    }

    for spec in SPECS {
        read_spec(&pool, spec, &mut by_device).await?;
    }

    pool.close().await;

    let out = by_device
        .into_iter()
        .filter(|(_, r)| !r.is_empty())
        .map(|(dev, readings)| {
            let (name, manufacturer) = devices
                .get(&dev)
                .cloned()
                .unwrap_or_else(|| (format!("Device {dev}"), None));
            GadgetbridgeDevice { name, manufacturer, readings }
        })
        .collect();

    Ok(GadgetbridgeImport { devices: out })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_real_export_when_present() {
        let path = Path::new("../../test-data/Gadgetbridge.db");
        if !path.exists() {
            eprintln!("skip: no test-data/Gadgetbridge.db");
            return;
        }
        let imp = read_db(path).await.expect("read gadgetbridge db");
        for d in &imp.devices {
            let mut by: BTreeMap<String, usize> = BTreeMap::new();
            for r in &d.readings {
                *by.entry(format!("{:?}", r.kind)).or_default() += 1;
            }
            eprintln!("device={} ({:?}): {by:?}", d.name, d.manufacturer);
        }
        assert!(!imp.devices.is_empty());
    }
}
