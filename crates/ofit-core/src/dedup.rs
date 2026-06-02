//! Dedup / fusion engine — pure clustering + per-metric source resolution.
//!
//! This is the in-memory heart of one of the project's two innovations
//! (PLAN.md): N recordings of one effort collapse into a single
//! [`Activity`](crate::activity::Activity), while the *best source per metric*
//! is chosen from the contributing recordings' [`Stream`]s.
//!
//! Two pure functions live here, both IO/DB-free (persistence is `ofit-db`):
//!
//! 1. [`cluster_recordings`] — single-linkage clustering of a set of
//!    [`RawRecording`]s into [`Activity`]s, using the existing
//!    [`RawRecording::clusters_with`] / [`Activity::accepts`] /
//!    [`Activity::add_recording`] rules (sport + time-overlap).
//! 2. [`resolve_activity_view`] — given an activity, the streams of all its
//!    member recordings, the sources those recordings came from, and the
//!    [`MetricSourcePreference`]s, pick the winning source **per
//!    [`StreamKind`]** and return the resolved [`Stream`] for each metric.
//!
//! Resolution precedence per metric (highest wins):
//!   per-activity override → persistent default → highest `Source.default_priority`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::activity::Activity;
use crate::preference::{resolve_source, MetricSourcePreference, PreferenceScope};
use crate::recording::RawRecording;
use crate::source::Source;
use crate::stream::{Stream, StreamKind};

/// Single-linkage clustering of recordings into [`Activity`]s.
///
/// Recordings are processed in deterministic order (sorted by `started_at`,
/// then `id`). Each recording joins the first existing activity that
/// [`Activity::accepts`] it (same sport + overlapping the activity's *widened*
/// window); otherwise it seeds a new activity. Because [`Activity::add_recording`]
/// widens the window, this yields transitive (single-linkage) grouping: A–B and
/// B–C land in one activity even if A and C do not directly overlap.
///
/// Pure: no IDs are persisted, `Activity`s get fresh `Uuid`s. The caller
/// (import pipeline) reconciles these against the DB.
pub fn cluster_recordings(recordings: &[RawRecording]) -> Vec<Activity> {
    cluster_recordings_respecting(recordings, &[])
}

/// Like [`cluster_recordings`], but **respects user-confirmed groupings**.
///
/// `locked` are activities the user has explicitly curated (a manual merge or
/// split, [`Activity::user_confirmed`] == `true`). Their membership is treated
/// as fixed: those activities are emitted verbatim (with their existing ids and
/// recordings), and any recording that belongs to a locked activity is **never**
/// re-clustered — so re-running clustering after a manual split does not silently
/// merge the recordings back together.
///
/// Recordings not claimed by any locked activity are clustered normally
/// (single-linkage, sport + time overlap) and, crucially, are **not** allowed to
/// join a locked activity either — locked groupings are closed sets. The result
/// is the locked activities followed by the freshly clustered ones, in
/// deterministic order.
pub fn cluster_recordings_respecting(
    recordings: &[RawRecording],
    locked: &[Activity],
) -> Vec<Activity> {
    use std::collections::BTreeSet;

    // Recording ids already owned by a user-confirmed activity are off-limits.
    let claimed: BTreeSet<Uuid> = locked
        .iter()
        .flat_map(|a| a.recording_ids.iter().copied())
        .collect();

    // Emit the locked activities verbatim (preserve id + confirmed membership).
    let mut activities: Vec<Activity> = locked.to_vec();

    let mut order: Vec<&RawRecording> = recordings
        .iter()
        .filter(|r| !claimed.contains(&r.id))
        .collect();
    order.sort_by(|a, b| a.started_at.cmp(&b.started_at).then(a.id.cmp(&b.id)));

    // Cluster only the free recordings amongst themselves; never let them join a
    // locked activity (those are closed). We track how many free activities we've
    // appended so the locked ones stay untouched.
    let locked_len = activities.len();
    for rec in order {
        if let Some(act) = activities
            .iter_mut()
            .skip(locked_len)
            .find(|a| a.accepts(rec))
        {
            // Same sport guaranteed by `accepts`, so this cannot error.
            let _ = act.add_recording(rec);
        } else {
            activities.push(Activity::from_recording(rec));
        }
    }
    activities
}

/// Detach `recording_id` from `activity`, returning the *split off* recording as
/// its own fresh single-recording [`Activity`].
///
/// This is the durable manual-split primitive (PLAN.md: "fusion/split manuel").
/// Both the trimmed original and the new single-recording activity are marked
/// [`Activity::user_confirmed`] so subsequent clustering
/// ([`cluster_recordings_respecting`]) will not merge them back together.
///
/// Returns `None` when the recording is not a member of `activity`, or when it
/// is the *only* recording (removing it would leave an empty activity — the
/// caller should treat that as a no-op / error rather than orphan data).
///
/// The recording's [`RawRecording`] row and its [`Stream`]s are untouched; only
/// the activity grouping changes (the raw data is never lost).
pub fn detach_recording(activity: &Activity, recording_id: Uuid) -> Option<DetachResult> {
    if !activity.recording_ids.contains(&recording_id) {
        return None;
    }
    if activity.recording_ids.len() <= 1 {
        return None;
    }

    let mut remaining = activity.clone();
    remaining.recording_ids.retain(|&r| r != recording_id);
    remaining.user_confirmed = true;

    let detached = Activity {
        id: Uuid::new_v4(),
        sport: activity.sport,
        // Window is recomputed by the caller from the recording's own times if
        // desired; default to the original window, which the caller narrows.
        started_at: activity.started_at,
        ended_at: activity.ended_at,
        recording_ids: vec![recording_id],
        user_confirmed: true,
        created_at: chrono::Utc::now(),
        distance_m: None,
        calories: None,
    };

    Some(DetachResult { remaining, detached })
}

/// Outcome of [`detach_recording`]: the trimmed original activity and the new
/// single-recording activity that now owns the removed recording. Both are
/// `user_confirmed` so the split is durable across re-imports.
#[derive(Debug, Clone, PartialEq)]
pub struct DetachResult {
    /// The original activity with the recording removed (now user-confirmed).
    pub remaining: Activity,
    /// A fresh single-recording activity owning the detached recording.
    pub detached: Activity,
}

/// The resolved canonical view of an activity: the winning source per metric
/// plus the [`Stream`] that source contributed for that metric.
///
/// This is the "merged workout" the API/dashboard renders — one stream per
/// [`StreamKind`], each from the best available source under the active
/// preferences.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedActivityView {
    /// The activity this view resolves.
    pub activity_id: Uuid,
    /// Per-metric resolution: which source won and the stream it provided.
    /// Ordered by [`StreamKind`] for stable output.
    pub metrics: Vec<ResolvedMetric>,
}

/// One resolved metric within a [`ResolvedActivityView`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedMetric {
    /// The metric kind.
    pub kind: StreamKind,
    /// The source chosen for this metric.
    pub source_id: Uuid,
    /// The recording the chosen stream came from.
    pub recording_id: Uuid,
    /// How this source was selected (override / default / priority).
    pub selected_by: SelectionReason,
    /// The resolved stream for this metric (clone of the winning recording's).
    pub stream: Stream,
}

/// Why a particular source was chosen for a metric — useful for the UI to show
/// whether a choice is an explicit preference or a fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SelectionReason {
    /// A per-activity override pinned this source for this metric.
    ActivityOverride,
    /// A persistent default preference chose this source.
    Default,
    /// No matching preference; fell back to highest `Source.default_priority`.
    Priority,
}

/// Resolve the best stream per [`StreamKind`] for one activity.
///
/// Inputs:
/// - `activity`: the activity being resolved (its `id` is used for overrides).
/// - `streams`: streams of **all** member recordings (extra streams are
///   ignored; only those whose `recording_id` is in `activity.recording_ids`
///   are considered).
/// - `sources`: the [`Source`]s the member recordings came from, keyed via
///   `recording_source` below.
/// - `recording_source`: map from `recording_id` → `source_id` (the import
///   pipeline knows this; passed in so this stays pure).
/// - `prefs`: the active [`MetricSourcePreference`]s (defaults + this
///   activity's overrides).
///
/// For each metric present in `streams`, candidate streams are grouped by the
/// source that produced them. The winning source is chosen by
/// [`resolve_source`] (override > default); if neither matches, the source with
/// the highest [`Source::default_priority`] (ties broken by source id) wins.
pub fn resolve_activity_view(
    activity: &Activity,
    streams: &[Stream],
    sources: &[Source],
    recording_source: &BTreeMap<Uuid, Uuid>,
    prefs: &[MetricSourcePreference],
) -> ResolvedActivityView {
    let source_by_id: BTreeMap<Uuid, &Source> = sources.iter().map(|s| (s.id, s)).collect();

    // metric -> candidate streams (only from this activity's recordings).
    let mut by_metric: BTreeMap<StreamKind, Vec<&Stream>> = BTreeMap::new();
    for st in streams {
        if !activity.recording_ids.contains(&st.recording_id) {
            continue;
        }
        by_metric.entry(st.kind).or_default().push(st);
    }

    let mut metrics: Vec<ResolvedMetric> = Vec::new();
    for (kind, candidates) in by_metric {
        // Which source ids are actually available for this metric?
        let available: Vec<Uuid> = candidates
            .iter()
            .filter_map(|st| recording_source.get(&st.recording_id).copied())
            .collect();
        if available.is_empty() {
            continue;
        }

        // Decide the winning source for this metric.
        let (winner_source, reason) =
            pick_source(kind, activity.id, &available, &source_by_id, prefs);

        // Find the candidate stream from the winning source. Sorting keeps the
        // pick deterministic if a source contributed the same kind twice.
        let mut winning: Vec<&Stream> = candidates
            .iter()
            .filter(|st| recording_source.get(&st.recording_id).copied() == Some(winner_source))
            .copied()
            .collect();
        winning.sort_by_key(|st| st.recording_id);
        let chosen = match winning.first() {
            Some(st) => *st,
            // Resolver pointed at a source with no stream for this metric; fall
            // back to the first available candidate (by recording id).
            None => {
                let mut all = candidates.clone();
                all.sort_by_key(|st| st.recording_id);
                all[0]
            }
        };
        let chosen_source = recording_source
            .get(&chosen.recording_id)
            .copied()
            .unwrap_or(winner_source);

        metrics.push(ResolvedMetric {
            kind,
            source_id: chosen_source,
            recording_id: chosen.recording_id,
            selected_by: reason,
            stream: chosen.clone(),
        });
    }

    ResolvedActivityView {
        activity_id: activity.id,
        metrics,
    }
}

/// Pick the winning source id for a metric among the `available` sources.
fn pick_source(
    metric: StreamKind,
    activity_id: Uuid,
    available: &[Uuid],
    source_by_id: &BTreeMap<Uuid, &Source>,
    prefs: &[MetricSourcePreference],
) -> (Uuid, SelectionReason) {
    // 1) preference resolution (override > default), but only if the resolved
    //    source actually has a stream for this metric here.
    if let Some(pref_src) = resolve_source(metric, activity_id, prefs) {
        if available.contains(&pref_src) {
            let reason = prefs
                .iter()
                .find(|p| {
                    p.metric == metric
                        && p.scope == PreferenceScope::Activity
                        && p.activity_id == Some(activity_id)
                        && p.source_id == pref_src
                })
                .map(|_| SelectionReason::ActivityOverride)
                .unwrap_or(SelectionReason::Default);
            return (pref_src, reason);
        }
    }

    // 2) fallback: highest Source.default_priority (ties → smallest source id).
    let mut best = available[0];
    let mut best_prio = source_by_id.get(&best).map(|s| s.default_priority).unwrap_or(0);
    for &sid in &available[1..] {
        let prio = source_by_id.get(&sid).map(|s| s.default_priority).unwrap_or(0);
        if prio > best_prio || (prio == best_prio && sid < best) {
            best = sid;
            best_prio = prio;
        }
    }
    (best, SelectionReason::Priority)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recording::{ContentHash, Sport};
    use crate::source::SourceKind;
    use crate::stream::Sample;
    use chrono::{Duration, TimeZone, Utc};

    fn rec(id_byte: u8, sport: Sport, start_min: i64, dur_min: i64) -> RawRecording {
        let started = Utc.with_ymd_and_hms(2024, 1, 1, 8, 0, 0).unwrap() + Duration::minutes(start_min);
        RawRecording {
            id: Uuid::from_u128(id_byte as u128),
            source_id: Uuid::from_u128(0x5000 + id_byte as u128),
            content_hash: ContentHash(format!("{id_byte:064x}")),
            sport,
            started_at: started,
            ended_at: started + Duration::minutes(dur_min),
            metadata: serde_json::Value::Null,
            ingested_at: Utc::now(),
        }
    }

    fn source(id_byte: u8, prio: i32) -> Source {
        Source {
            id: Uuid::from_u128(0x5000 + id_byte as u128),
            kind: SourceKind::Device,
            name: format!("src-{id_byte}"),
            manufacturer: None,
            default_priority: prio,
            created_at: Utc::now(),
        }
    }

    fn scalar_stream(rec_id: Uuid, kind: StreamKind, v: f64) -> Stream {
        let mut s = Stream::new(rec_id, kind);
        s.samples.push(Sample::Scalar { t_offset_ms: 0, value: v });
        s
    }

    #[test]
    fn clusters_three_overlapping_into_one_activity() {
        // Three recordings of one run (chained overlaps) + one separate ride.
        let r1 = rec(1, Sport::Running, 0, 30);
        let r2 = rec(2, Sport::Running, 10, 30); // overlaps r1
        let r3 = rec(3, Sport::Running, 35, 20); // overlaps r2's widened window
        let bike = rec(4, Sport::Cycling, 5, 40); // different sport → own activity
        let acts = cluster_recordings(&[r3.clone(), bike.clone(), r1.clone(), r2.clone()]);
        assert_eq!(acts.len(), 2);
        let run = acts.iter().find(|a| a.sport == Sport::Running).unwrap();
        assert_eq!(run.recording_ids.len(), 3);
        let ride = acts.iter().find(|a| a.sport == Sport::Cycling).unwrap();
        assert_eq!(ride.recording_ids.len(), 1);
    }

    #[test]
    fn detach_splits_into_own_confirmed_activity() {
        // Two overlapping running recordings → one activity → detach one →
        // a 2-recording (well, 1) remaining + 1 detached, both user_confirmed.
        let r1 = rec(1, Sport::Running, 0, 30);
        let r2 = rec(2, Sport::Running, 10, 30);
        let mut act = Activity::from_recording(&r1);
        act.add_recording(&r2).unwrap();
        assert_eq!(act.recording_ids.len(), 2);

        let res = detach_recording(&act, r2.id).expect("detach a member");
        assert_eq!(res.remaining.recording_ids, vec![r1.id]);
        assert_eq!(res.detached.recording_ids, vec![r2.id]);
        assert!(res.remaining.user_confirmed);
        assert!(res.detached.user_confirmed);
        assert_eq!(res.remaining.id, act.id, "original id preserved");
        assert_ne!(res.detached.id, act.id, "detached gets a fresh id");

        // Guard: detaching the last/only recording is a no-op.
        assert!(detach_recording(&res.detached, r2.id).is_none());
        // Guard: detaching a non-member is a no-op.
        assert!(detach_recording(&act, Uuid::from_u128(999)).is_none());
    }

    #[test]
    fn reclustering_respects_user_confirmed_split() {
        // The two overlapping run recordings would normally merge into 1
        // activity. After a manual split (2 user-confirmed activities), running
        // clustering again must KEEP them split.
        let r1 = rec(1, Sport::Running, 0, 30);
        let r2 = rec(2, Sport::Running, 10, 30);

        // Plain clustering merges them.
        assert_eq!(cluster_recordings(&[r1.clone(), r2.clone()]).len(), 1);

        // Manual split → two locked single-recording activities.
        let mut act = Activity::from_recording(&r1);
        act.add_recording(&r2).unwrap();
        let res = detach_recording(&act, r2.id).unwrap();
        let locked = vec![res.remaining.clone(), res.detached.clone()];

        // Re-clustering while respecting the locked groupings keeps 2 activities.
        let out = cluster_recordings_respecting(&[r1.clone(), r2.clone()], &locked);
        assert_eq!(out.len(), 2, "user-confirmed split survives re-clustering");
        // Each locked activity is emitted verbatim with a single recording.
        for a in &out {
            assert_eq!(a.recording_ids.len(), 1);
            assert!(a.user_confirmed);
        }

        // A genuinely new, overlapping recording does NOT get pulled into a
        // locked activity; it forms its own free activity.
        let r3 = rec(3, Sport::Running, 5, 30);
        let out = cluster_recordings_respecting(&[r1, r2, r3.clone()], &locked);
        assert_eq!(out.len(), 3, "new recording stays out of locked groupings");
        let free = out.iter().find(|a| a.recording_ids.contains(&r3.id)).unwrap();
        assert_eq!(free.recording_ids, vec![r3.id]);
    }

    #[test]
    fn non_overlapping_same_sport_split() {
        let a = rec(1, Sport::Running, 0, 20);
        let b = rec(2, Sport::Running, 100, 20); // far apart → separate activities
        let acts = cluster_recordings(&[a, b]);
        assert_eq!(acts.len(), 2);
    }

    #[test]
    fn resolution_override_beats_default_beats_priority() {
        // Two sources recorded HR for the same activity.
        let src_low = source(1, 10); // lower priority
        let src_high = source(2, 50); // higher priority
        let r_low = rec(1, Sport::Running, 0, 30);
        let mut r_high = rec(2, Sport::Running, 0, 30);
        r_high.source_id = src_high.id;
        let mut r_low = r_low;
        r_low.source_id = src_low.id;

        let mut act = Activity::from_recording(&r_low);
        act.add_recording(&r_high).unwrap();

        let mut rec_src = BTreeMap::new();
        rec_src.insert(r_low.id, src_low.id);
        rec_src.insert(r_high.id, src_high.id);

        let streams = vec![
            scalar_stream(r_low.id, StreamKind::HeartRate, 120.0),
            scalar_stream(r_high.id, StreamKind::HeartRate, 130.0),
        ];
        let sources = vec![src_low.clone(), src_high.clone()];

        // (a) No prefs → highest priority source (src_high) wins by Priority.
        let v = resolve_activity_view(&act, &streams, &sources, &rec_src, &[]);
        let hr = v.metrics.iter().find(|m| m.kind == StreamKind::HeartRate).unwrap();
        assert_eq!(hr.source_id, src_high.id);
        assert_eq!(hr.selected_by, SelectionReason::Priority);

        // (b) Default pref points at src_low → Default wins over priority.
        let prefs_default = vec![MetricSourcePreference::default_for(
            StreamKind::HeartRate,
            src_low.id,
            true,
        )];
        let v = resolve_activity_view(&act, &streams, &sources, &rec_src, &prefs_default);
        let hr = v.metrics.iter().find(|m| m.kind == StreamKind::HeartRate).unwrap();
        assert_eq!(hr.source_id, src_low.id);
        assert_eq!(hr.selected_by, SelectionReason::Default);

        // (c) Per-activity override points at src_high → override wins.
        let mut prefs_override = prefs_default.clone();
        prefs_override.push(MetricSourcePreference::override_for(
            StreamKind::HeartRate,
            act.id,
            src_high.id,
        ));
        let v = resolve_activity_view(&act, &streams, &sources, &rec_src, &prefs_override);
        let hr = v.metrics.iter().find(|m| m.kind == StreamKind::HeartRate).unwrap();
        assert_eq!(hr.source_id, src_high.id);
        assert_eq!(hr.selected_by, SelectionReason::ActivityOverride);
    }

    #[test]
    fn retroactive_flag_semantics() {
        // The retroactive flag governs whether a *default* applies to history.
        // A retroactive default re-resolves an existing activity; a
        // non-retroactive default still resolves (it is the active default),
        // but the import pipeline only re-runs resolution for past activities
        // when retroactive == true. Here we assert the flag is carried and that
        // resolution itself honors whatever default is present.
        let src_a = source(1, 10);
        let src_b = source(2, 20);
        let r_a = rec(1, Sport::Cycling, 0, 30);
        let mut r_b = rec(2, Sport::Cycling, 0, 30);
        r_b.source_id = src_b.id;
        let mut r_a = r_a;
        r_a.source_id = src_a.id;
        let mut act = Activity::from_recording(&r_a);
        act.add_recording(&r_b).unwrap();

        let mut rec_src = BTreeMap::new();
        rec_src.insert(r_a.id, src_a.id);
        rec_src.insert(r_b.id, src_b.id);
        let streams = vec![
            scalar_stream(r_a.id, StreamKind::Power, 200.0),
            scalar_stream(r_b.id, StreamKind::Power, 210.0),
        ];
        let sources = vec![src_a.clone(), src_b.clone()];

        let retro = MetricSourcePreference::default_for(StreamKind::Power, src_a.id, true);
        assert!(retro.retroactive);
        let non_retro = MetricSourcePreference::default_for(StreamKind::Power, src_a.id, false);
        assert!(!non_retro.retroactive);

        // Both resolve to src_a here (resolution is flag-agnostic); the flag is
        // a pipeline policy signal, surfaced via `should_reresolve`.
        for pref in [retro.clone(), non_retro.clone()] {
            let v = resolve_activity_view(&act, &streams, &sources, &rec_src, &[pref]);
            let p = v.metrics.iter().find(|m| m.kind == StreamKind::Power).unwrap();
            assert_eq!(p.source_id, src_a.id);
        }
        assert!(should_reresolve_history(&retro));
        assert!(!should_reresolve_history(&non_retro));
    }
}

/// Policy helper: should changing this preference re-resolve historical
/// activities? Only retroactive *default* preferences do; per-activity
/// overrides and non-retroactive defaults only affect their own / future scope.
pub fn should_reresolve_history(pref: &MetricSourcePreference) -> bool {
    pref.scope == PreferenceScope::Default && pref.retroactive
}
