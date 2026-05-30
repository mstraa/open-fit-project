//! `Source` — an instance of a device/provider that produces data.
//!
//! Sources carry a *default* priority that seeds per-metric preference
//! resolution (see [`crate::preference`]). The actual hardware support is
//! delegated to Gadgetbridge; a `Source` here is just the logical origin we
//! attribute recordings and wellness samples to.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Broad kind of data origin. Hardware specifics live in Gadgetbridge, not here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    /// A wearable/device (watch, strap, footpod…).
    Device,
    /// The one-time initial file/zip import channel.
    FileImport,
    /// The Gadgetbridge bridge (BLE / exported DB / Health Connect).
    Gadgetbridge,
    /// Something we could not classify.
    Unknown,
}

/// A logical data origin we attribute recordings and wellness to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    /// Stable identifier.
    pub id: Uuid,
    /// What kind of origin this is.
    pub kind: SourceKind,
    /// Human-readable name, e.g. "Garmin Forerunner 945".
    pub name: String,
    /// Optional vendor/manufacturer label (free-form, informational).
    pub manufacturer: Option<String>,
    /// Default priority used to seed per-metric resolution. Higher = preferred.
    pub default_priority: i32,
    /// When we first saw this source.
    pub created_at: DateTime<Utc>,
}

impl Source {
    /// Construct a new source with a generated id and `created_at = now`.
    pub fn new(kind: SourceKind, name: impl Into<String>, default_priority: i32) -> Self {
        Self {
            id: Uuid::new_v4(),
            kind,
            name: name.into(),
            manufacturer: None,
            default_priority,
            created_at: Utc::now(),
        }
    }
}
