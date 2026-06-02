//! `Gear` — a tracked piece of equipment (running shoes, a bike…) with mileage
//! and a retirement distance. Pure domain type; persistence lives in `ofit-db`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A piece of gear tracked for mileage + retirement (wear warning).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Gear {
    /// Stable identifier.
    pub id: Uuid,
    /// Display name, e.g. "Escalante 4".
    pub name: String,
    /// Short description / sub-label.
    pub description: String,
    /// Activity type this gear is for (e.g. "Running", "Cycling").
    pub sport: String,
    /// Mileage already on the gear at creation (km).
    pub initial_km: f64,
    /// Retire-at distance (km) — drives the amber/red wear bar.
    pub retire_km: f64,
    /// Total distance used (km) — initial plus distance accrued from activities.
    pub used_km: f64,
    /// Icon name for the UI ("run" / "bike" …).
    pub icon: String,
    /// When the gear was added.
    pub created_at: DateTime<Utc>,
}
