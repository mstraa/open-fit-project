//! Gadgetbridge export-DB import adapter (Phase 2a, cloudless).
//!
//! Reads an **exported Gadgetbridge SQLite DB** and extracts continuous wellness
//! as [`ofit_core::WellnessKind`] readings the API attributes to a Gadgetbridge
//! [`Source`](ofit_core::Source) and ingests via `POST /api/import/gadgetbridge`.
//!
//! Targets the **Huami/Amazfit** sample tables (`HUAMI_EXTENDED_ACTIVITY_SAMPLE`,
//! `HUAMI_STRESS_SAMPLE`) — i.e. the Amazfit Helio. Each Gadgetbridge device
//! family stores samples in its own table; add a branch per family as needed.
//!
//! v1 maps: heart rate, steps, stress, and a **derived daily resting HR**
//! (per-day minimum valid HR). Sleep staging from `RAW_KIND` is intentionally
//! deferred (the kind→stage mapping is device-specific and fuzzy — Phase 4).

use std::collections::BTreeMap;
use std::path::Path;

use chrono::{DateTime, TimeZone, Utc};
use ofit_core::WellnessKind;
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::Row;

/// Plausible human HR band; outside this is a sentinel / not-worn reading.
const HR_MIN: i64 = 30;
const HR_MAX: i64 = 220;

/// One extracted wellness reading (the API stamps it with a source + uuid).
#[derive(Debug, Clone, PartialEq)]
pub struct WellnessReading {
    pub kind: WellnessKind,
    pub value: f64,
    pub ts: DateTime<Utc>,
}

/// Result of reading a Gadgetbridge export DB.
#[derive(Debug, Clone)]
pub struct GadgetbridgeImport {
    /// Device name from the GB `DEVICE` table (e.g. "Amazfit Helio Strap").
    pub device_name: String,
    /// Manufacturer, if recorded.
    pub manufacturer: Option<String>,
    /// Extracted continuous-wellness readings.
    pub readings: Vec<WellnessReading>,
}

/// Errors reading a Gadgetbridge DB.
#[derive(Debug, thiserror::Error)]
pub enum GbError {
    /// Underlying SQLite/sqlx failure.
    #[error("gadgetbridge db: {0}")]
    Db(#[from] sqlx::Error),
}

/// Gadgetbridge tables are inconsistent: the Huami activity table stores epoch
/// **seconds**, the stress table **milliseconds**. Auto-normalize (a real epoch
/// in seconds is < 1e11 ≈ year 5138, so anything larger is milliseconds).
fn at(ts: i64) -> DateTime<Utc> {
    let secs = if ts > 100_000_000_000 { ts / 1000 } else { ts };
    Utc.timestamp_opt(secs, 0).single().unwrap_or_else(Utc::now)
}

async fn has_table(pool: &sqlx::SqlitePool, name: &str) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .bind(name)
        .fetch_optional(pool)
        .await?
        .is_some())
}

/// Read an exported Gadgetbridge SQLite DB at `path` (opened read-only).
pub async fn read_db(path: &Path) -> Result<GadgetbridgeImport, GbError> {
    let url = format!("sqlite://{}?mode=ro", path.display());
    let pool = SqlitePoolOptions::new().max_connections(1).connect(&url).await?;

    let (device_name, manufacturer) = match sqlx::query("SELECT NAME, MANUFACTURER FROM DEVICE LIMIT 1")
        .fetch_optional(&pool)
        .await?
    {
        Some(r) => (
            r.try_get::<String, _>("NAME").unwrap_or_else(|_| "Gadgetbridge device".into()),
            r.try_get::<String, _>("MANUFACTURER").ok(),
        ),
        None => ("Gadgetbridge device".into(), None),
    };

    let mut readings: Vec<WellnessReading> = Vec::new();

    // Huami extended activity samples: HR + steps (+ derive daily resting HR).
    if has_table(&pool, "HUAMI_EXTENDED_ACTIVITY_SAMPLE").await? {
        let rows = sqlx::query(
            "SELECT TIMESTAMP, HEART_RATE, STEPS FROM HUAMI_EXTENDED_ACTIVITY_SAMPLE ORDER BY TIMESTAMP",
        )
        .fetch_all(&pool)
        .await?;

        // day (unix-day) -> (min valid HR, ts of that reading)
        let mut day_min_hr: BTreeMap<i64, (i64, i64)> = BTreeMap::new();
        for r in &rows {
            let ts: i64 = r.try_get("TIMESTAMP").unwrap_or(0);
            let hr: i64 = r.try_get("HEART_RATE").unwrap_or(0);
            let steps: i64 = r.try_get("STEPS").unwrap_or(0);
            if (HR_MIN..=HR_MAX).contains(&hr) {
                readings.push(WellnessReading { kind: WellnessKind::HeartRate, value: hr as f64, ts: at(ts) });
                let day = ts.div_euclid(86_400);
                let e = day_min_hr.entry(day).or_insert((hr, ts));
                if hr < e.0 {
                    *e = (hr, ts);
                }
            }
            if steps > 0 {
                readings.push(WellnessReading { kind: WellnessKind::Steps, value: steps as f64, ts: at(ts) });
            }
        }
        // Derived resting HR = per-day minimum HR (≈ overnight rest), at its time.
        for (hr, ts) in day_min_hr.into_values() {
            readings.push(WellnessReading {
                kind: WellnessKind::RestingHeartRate,
                value: hr as f64,
                ts: at(ts),
            });
        }
    }

    // Huami stress samples.
    if has_table(&pool, "HUAMI_STRESS_SAMPLE").await? {
        let rows = sqlx::query("SELECT TIMESTAMP, STRESS FROM HUAMI_STRESS_SAMPLE WHERE STRESS BETWEEN 0 AND 100")
            .fetch_all(&pool)
            .await?;
        for r in &rows {
            let ts: i64 = r.try_get("TIMESTAMP").unwrap_or(0);
            let stress: i64 = r.try_get("STRESS").unwrap_or(0);
            readings.push(WellnessReading { kind: WellnessKind::Stress, value: stress as f64, ts: at(ts) });
        }
    }

    pool.close().await;
    Ok(GadgetbridgeImport { device_name, manufacturer, readings })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs only when a real export is present locally (gitignored test fixture).
    #[tokio::test]
    async fn reads_real_export_when_present() {
        let path = Path::new("../../test-data/Gadgetbridge.db");
        if !path.exists() {
            eprintln!("skip: no test-data/Gadgetbridge.db");
            return;
        }
        let imp = read_db(path).await.expect("read gadgetbridge db");
        let mut by_kind: BTreeMap<String, usize> = BTreeMap::new();
        for r in &imp.readings {
            *by_kind.entry(format!("{:?}", r.kind)).or_default() += 1;
        }
        eprintln!("device={} manufacturer={:?}", imp.device_name, imp.manufacturer);
        eprintln!("readings by kind: {by_kind:?}");
        assert!(!imp.readings.is_empty());
        assert!(by_kind.contains_key("HeartRate"));
    }
}
