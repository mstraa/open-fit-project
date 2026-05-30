//! # ofit-core
//!
//! Canonical domain entities for Open Fit — pure types, no IO/DB.
//! See [PLAN.md] "Modèle de données canonique" and AGENTS.md.
//!
//! Module-per-concept; the common types are re-exported at the crate root:
//!
//! - [`Source`] — a device/provider instance (default priorities).
//! - [`RawRecording`] — immutable ingested artefact, content-hashed for exact dedup.
//! - [`Activity`] — logical workout; the **unit of dedup** (sport + time overlap).
//! - [`Stream`] — per-recording time-series channel ([`StreamKind`]).
//! - [`WellnessSample`] — continuous, streaming-first wellness ([`WellnessKind`]).
//! - [`MetricSourcePreference`] — per-metric resolver (default + override + retroactive).
//! - [`DerivedMetric`] / [`DerivedStream`] — algo outputs tied to a [`PluginRef`].
//!
//! [PLAN.md]: ../../../PLAN.md

pub mod activity;
pub mod analytics;
pub mod dedup;
pub mod derived;
pub mod error;
pub mod preference;
pub mod recording;
pub mod source;
pub mod stream;
pub mod wellness;

pub use activity::Activity;
pub use analytics::{
    Algorithm, AlgorithmInput, AlgorithmKind, AlgorithmOutput, AlgorithmSpec,
};
pub use dedup::{
    cluster_recordings, cluster_recordings_respecting, detach_recording, resolve_activity_view,
    DetachResult, ResolvedActivityView, ResolvedMetric, SelectionReason,
};
pub use derived::{DerivedMetric, DerivedStream, DerivedSubject, PluginRef};
pub use error::{Error, Result};
pub use preference::{resolve_source, MetricSourcePreference, PreferenceScope};
pub use recording::{overlaps, ContentHash, RawRecording, Sport};
pub use source::{Source, SourceKind};
pub use stream::{Sample, Stream, StreamKind};
pub use wellness::{SleepStage, WellnessKind, WellnessSample};

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use uuid::Uuid;

    fn rec(sport: Sport, start_min: i64, dur_min: i64) -> RawRecording {
        let started = Utc::now() + Duration::minutes(start_min);
        RawRecording {
            id: Uuid::new_v4(),
            source_id: Uuid::new_v4(),
            content_hash: ContentHash::of_bytes(b"x"),
            sport,
            started_at: started,
            ended_at: started + Duration::minutes(dur_min),
            metadata: serde_json::Value::Null,
            ingested_at: Utc::now(),
        }
    }

    #[test]
    fn overlapping_same_sport_clusters() {
        let a = rec(Sport::Running, 0, 30);
        let b = rec(Sport::Running, 10, 30);
        assert!(a.clusters_with(&b));
    }

    #[test]
    fn different_sport_does_not_cluster() {
        let a = rec(Sport::Running, 0, 30);
        let b = rec(Sport::Cycling, 10, 30);
        assert!(!a.clusters_with(&b));
    }

    #[test]
    fn activity_widens_window() {
        let a = rec(Sport::Running, 0, 30);
        let b = rec(Sport::Running, 10, 40);
        let mut act = Activity::from_recording(&a);
        assert!(act.accepts(&b));
        act.add_recording(&b).unwrap();
        assert_eq!(act.recording_ids.len(), 2);
        assert_eq!(act.ended_at, b.ended_at);
    }

    #[test]
    fn preference_override_beats_default() {
        let metric = StreamKind::HeartRate;
        let act = Uuid::new_v4();
        let default_src = Uuid::new_v4();
        let override_src = Uuid::new_v4();
        let prefs = vec![
            MetricSourcePreference::default_for(metric, default_src, true),
            MetricSourcePreference::override_for(metric, act, override_src),
        ];
        assert_eq!(resolve_source(metric, act, &prefs), Some(override_src));
        assert_eq!(
            resolve_source(metric, Uuid::new_v4(), &prefs),
            Some(default_src)
        );
    }
}
