//! Algorithm abstraction — the *descriptor* + *trait* shared by built-in and
//! WASM algorithms (PLAN.md Phase 3, "Algorithmes en plugins").
//!
//! This module is intentionally **pure and IO-free**: it carries only the
//! versioned [`AlgorithmSpec`] (what an algorithm is, what it needs, what it
//! emits) and the [`Algorithm`] marker trait that ties a runnable algorithm to
//! its spec. The actual *compute* signature (which needs richer, DB-ish input
//! structs) lives in `ofit-analytics` — but the spec and the
//! [`DerivedMetric`]/[`DerivedStream`] tagging it produces are canonical here so
//! the DB, API and the WASM plugin host all bind to the **same** contract.
//!
//! Versioning is the recompute trigger: an output is tagged with the
//! [`PluginRef`](crate::derived::PluginRef) (`id` + `version`) of the algorithm
//! that produced it, so bumping [`AlgorithmSpec::version`] yields a *new*
//! derivation and the stale one can be recomputed/replaced.

use serde::{Deserialize, Serialize};

use crate::derived::{DerivedMetric, DerivedStream, DerivedSubject, PluginRef};
use crate::stream::StreamKind;
use crate::wellness::WellnessKind;

/// Whether an algorithm is compiled into the server (pure Rust) or loaded as a
/// sandboxed WASM plugin from the community registry.
///
/// Built-ins are the concrete, always-available wins (training load, readiness…);
/// WASM plugins are third-party / community algorithms run under the sandbox
/// (`ofit-plugins`). The spec shape is identical so the registry, DB and API
/// treat both uniformly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AlgorithmKind {
    /// Compiled into the server (pure Rust).
    BuiltIn,
    /// Loaded as a sandboxed WASM plugin.
    Wasm,
}

/// One input an algorithm consumes — either a workout [`StreamKind`] or a
/// continuous [`WellnessKind`]. Kept as a tagged enum so a single `inputs` list
/// can mix both kinds of raw material.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case", tag = "domain", content = "kind")]
pub enum AlgorithmInput {
    /// A per-activity stream metric (HR, power…).
    Stream(StreamKind),
    /// A continuous wellness metric (resting HR, HRV…).
    Wellness(WellnessKind),
}

/// What an algorithm emits: a named scalar [`DerivedMetric`] or a named
/// [`DerivedStream`] time-series. Names are the contract the API/web key on.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case", tag = "shape", content = "name")]
pub enum AlgorithmOutput {
    /// A scalar derived metric with this name (e.g. `"readiness"`, `"tss"`).
    Metric(String),
    /// A derived time-series with this name (e.g. `"ctl"`, `"atl"`, `"tsb"`).
    Stream(String),
}

/// The versioned descriptor of an algorithm — the unit the registry publishes,
/// the DB stores against, and the API exposes. Identical shape for built-ins and
/// WASM plugins.
///
/// `applicable_hardware` is a free-form tag list (`"any"`, `"running"`,
/// `"stryd"`, `"hrv-strap"`…) the registry/UI filter on; an empty list or
/// `["any"]` means broadly applicable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct AlgorithmSpec {
    /// Stable identifier (built-in name or registry id), e.g. `"training_load"`.
    pub id: String,
    /// Semantic version string (e.g. `"1.0.0"`). Bump = recompute.
    pub version: String,
    /// Human-readable name.
    pub name: String,
    /// One-line description of what it computes.
    pub description: String,
    /// Required inputs (stream and/or wellness kinds) the orchestrator must feed.
    pub inputs: Vec<AlgorithmInput>,
    /// The derived metric/stream names this algorithm emits.
    pub outputs: Vec<AlgorithmOutput>,
    /// Free-form hardware applicability tags (`"any"`, `"running"`, `"stryd"`…).
    pub applicable_hardware: Vec<String>,
    /// Built-in (Rust) or WASM plugin.
    pub kind: AlgorithmKind,
}

impl AlgorithmSpec {
    /// The [`PluginRef`] (id + version) every output of this algorithm is tagged
    /// with — the canonical tagging that makes derivations recomputable.
    pub fn plugin_ref(&self) -> PluginRef {
        PluginRef::new(self.id.clone(), self.version.clone())
    }

    /// Build a [`DerivedMetric`] tagged with this algorithm's [`PluginRef`].
    ///
    /// `computed_at` is taken as a parameter so the caller (the orchestrator)
    /// controls the recompute clock and `ofit-core` stays free of a wall clock
    /// in pure paths if it wants — but defaults to `Utc::now` via
    /// [`AlgorithmSpec::metric`] in practice.
    pub fn tag_metric(
        &self,
        subject: DerivedSubject,
        name: impl Into<String>,
        value: f64,
        computed_at: chrono::DateTime<chrono::Utc>,
    ) -> DerivedMetric {
        DerivedMetric {
            id: uuid::Uuid::new_v4(),
            plugin: self.plugin_ref(),
            subject,
            name: name.into(),
            value,
            computed_at,
        }
    }

    /// Build a [`DerivedStream`] tagged with this algorithm's [`PluginRef`].
    pub fn tag_stream(
        &self,
        subject: DerivedSubject,
        name: impl Into<String>,
        samples: Vec<crate::stream::Sample>,
        computed_at: chrono::DateTime<chrono::Utc>,
    ) -> DerivedStream {
        DerivedStream {
            id: uuid::Uuid::new_v4(),
            plugin: self.plugin_ref(),
            subject,
            name: name.into(),
            samples,
            computed_at,
        }
    }
}

/// A runnable algorithm: anything that exposes an [`AlgorithmSpec`].
///
/// The *compute* method lives in `ofit-analytics` (it needs richer input
/// structs and may touch DB-shaped data), but every algorithm — built-in or
/// WASM — is identified and versioned through this spec. This is the seam the
/// orchestrator and the registry program against.
pub trait Algorithm {
    /// The versioned descriptor of this algorithm.
    fn spec(&self) -> &AlgorithmSpec;
}
