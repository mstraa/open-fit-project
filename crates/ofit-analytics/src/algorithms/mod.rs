//! Built-in algorithms (pure Rust) — the concrete, user-visible Phase 3 wins.

pub mod anomaly;
pub mod readiness;
pub mod training_load;

pub use anomaly::AnomalyFlag;
pub use readiness::Readiness;
pub use training_load::{day_from_uuid, day_uuid, TrainingLoad, TssMethod};
