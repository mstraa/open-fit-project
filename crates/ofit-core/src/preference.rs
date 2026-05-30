//! `MetricSourcePreference` — the per-metric source resolver.
//!
//! One of the project's two innovations: when several devices recorded the same
//! effort, the "best" source is chosen **per metric** (e.g. HR from the Helio
//! strap, power from Stryd). A preference has three layers, per PLAN.md:
//!
//! 1. **Persistent default** — applies to future activities for a metric.
//! 2. **Per-activity override** — pins a source for one [`crate::activity::Activity`].
//! 3. **Retroactive toggle** — when on, changing the default re-resolves history;
//!    when off, the default only affects future activities.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::stream::StreamKind;

/// Scope a preference applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreferenceScope {
    /// The persistent default for a metric (no specific activity).
    Default,
    /// An override pinned to a single activity.
    Activity,
}

/// A resolver entry: "for this metric (optionally on this activity), prefer this source".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetricSourcePreference {
    /// Stable identifier.
    pub id: Uuid,
    /// The metric this preference resolves.
    pub metric: StreamKind,
    /// Scope (default vs per-activity override).
    pub scope: PreferenceScope,
    /// Set when `scope == Activity`; the activity this override pins.
    pub activity_id: Option<Uuid>,
    /// The chosen source for this metric in this scope.
    pub source_id: Uuid,
    /// Retroactive toggle: if true, default changes re-resolve historical activities.
    /// Meaningful only for `scope == Default`.
    pub retroactive: bool,
    /// Last time this preference changed (drives retroactive re-resolution).
    pub updated_at: DateTime<Utc>,
}

impl MetricSourcePreference {
    /// Create a persistent default preference for a metric.
    pub fn default_for(metric: StreamKind, source_id: Uuid, retroactive: bool) -> Self {
        Self {
            id: Uuid::new_v4(),
            metric,
            scope: PreferenceScope::Default,
            activity_id: None,
            source_id,
            retroactive,
            updated_at: Utc::now(),
        }
    }

    /// Create a per-activity override for a metric.
    pub fn override_for(metric: StreamKind, activity_id: Uuid, source_id: Uuid) -> Self {
        Self {
            id: Uuid::new_v4(),
            metric,
            scope: PreferenceScope::Activity,
            activity_id: Some(activity_id),
            source_id,
            retroactive: false,
            updated_at: Utc::now(),
        }
    }
}

/// Resolve the preferred source for `metric` on `activity` given the available
/// preferences. Per-activity overrides win over the persistent default.
///
/// This is the pure resolution rule; persistence/cache live in `ofit-db`.
pub fn resolve_source(
    metric: StreamKind,
    activity_id: Uuid,
    prefs: &[MetricSourcePreference],
) -> Option<Uuid> {
    // 1) per-activity override for this metric.
    if let Some(p) = prefs.iter().find(|p| {
        p.metric == metric
            && p.scope == PreferenceScope::Activity
            && p.activity_id == Some(activity_id)
    }) {
        return Some(p.source_id);
    }
    // 2) persistent default for this metric.
    prefs
        .iter()
        .find(|p| p.metric == metric && p.scope == PreferenceScope::Default)
        .map(|p| p.source_id)
}
