//! `PersonalRecord` — a best-ever performance (fastest 5 km, farthest ride,
//! most steps in a day…). Pure domain type; persistence lives in `ofit-db`.
//!
//! Imported from a Garmin export (`personalRecord.json`). The `value` unit is
//! **record-type dependent** and carried explicitly in [`PersonalRecord::unit`]
//! because Garmin stores it unlabelled: time records are seconds, distance
//! records are metres, "most steps" is a count, "max elevation" is metres.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// One personal record (a best-ever value for a record type).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PersonalRecord {
    /// Stable identifier.
    pub id: Uuid,
    /// Human label of the record type, e.g. `"Best 5km Run"`, `"Farthest Run"`,
    /// `"Most Steps in a Day"` (kept verbatim from the source).
    pub record_type: String,
    /// The record value, in [`unit`](Self::unit).
    pub value: f64,
    /// Unit of [`value`](Self::value): `"seconds"` | `"meters"` | `"count"`.
    pub unit: String,
    /// When the record was set (UTC).
    pub occurred_at: DateTime<Utc>,
    /// Where it came from, e.g. `"Garmin"` — informational provenance.
    pub source: String,
    /// Whether this is the *current* holder (vs. a superseded historical PR).
    pub current: bool,
}
