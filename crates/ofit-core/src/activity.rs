//! `Activity` — the logical workout, i.e. the **unit of deduplication**.
//!
//! One real-world effort recorded by N devices collapses into a single
//! `Activity` that references all the contributing [`crate::recording::RawRecording`]s.
//! The raw data is always preserved; the activity is the merge anchor.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::recording::{RawRecording, Sport};

/// A logical workout grouping one or more raw recordings of the same effort.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Activity {
    /// Stable identifier.
    pub id: Uuid,
    /// Sport of the effort (all member recordings share it).
    pub sport: Sport,
    /// Earliest start across member recordings.
    pub started_at: DateTime<Utc>,
    /// Latest end across member recordings.
    pub ended_at: DateTime<Utc>,
    /// Recordings that make up this activity (the dedup members).
    pub recording_ids: Vec<Uuid>,
    /// Whether the grouping was confirmed/edited by the user (manual merge/split).
    pub user_confirmed: bool,
    /// When this activity row was created.
    pub created_at: DateTime<Utc>,
    /// Total distance in metres — a cache populated by the analytics recompute
    /// (from the resolved distance stream or a Zepp summary), so the list/totals
    /// match the detail view. `None` until computed.
    pub distance_m: Option<f64>,
    /// Energy in kcal — from a Zepp summary when present; `None` otherwise (we
    /// have no honest calorie model for stream-only activities).
    pub calories: Option<f64>,
}

impl Activity {
    /// Seed a fresh activity from a single recording.
    pub fn from_recording(rec: &RawRecording) -> Self {
        Self {
            id: Uuid::new_v4(),
            sport: rec.sport,
            started_at: rec.started_at,
            ended_at: rec.ended_at,
            recording_ids: vec![rec.id],
            user_confirmed: false,
            created_at: Utc::now(),
            distance_m: None,
            calories: None,
        }
    }

    /// Whether `rec` belongs to this activity under the dedup rule
    /// (same sport + time overlap with the activity window).
    pub fn accepts(&self, rec: &RawRecording) -> bool {
        self.sport == rec.sport
            && crate::recording::overlaps(
                (self.started_at, self.ended_at),
                (rec.started_at, rec.ended_at),
            )
    }

    /// Add a recording, widening the activity window to cover it.
    ///
    /// Returns [`crate::error::Error::SportMismatch`] if the sports differ.
    pub fn add_recording(&mut self, rec: &RawRecording) -> crate::error::Result<()> {
        if self.sport != rec.sport {
            return Err(crate::error::Error::SportMismatch {
                a: self.sport,
                b: rec.sport,
            });
        }
        self.started_at = self.started_at.min(rec.started_at);
        self.ended_at = self.ended_at.max(rec.ended_at);
        if !self.recording_ids.contains(&rec.id) {
            self.recording_ids.push(rec.id);
        }
        Ok(())
    }
}
