//! The **plugin host** — discovers, loads, sandboxes, and runs WASM algorithm
//! plugins, exposing each as a stage-1 [`Algorithm`] +
//! [`RunnableAlgorithm`](ofit_analytics::RunnableAlgorithm) so `ofit-analytics`
//! mixes built-ins and plugins behind one trait.
//!
//! ## Load flow
//! 1. [`PluginHost::load_dir`] scans a plugins directory for manifests
//!    (`plugin.toml` / `*.toml` / `*.json`), parses + validates each.
//! 2. For each, reads the referenced `.wasm`, verifies its SHA-256 against the
//!    manifest pin (if any), and stores the bytes + the canonical
//!    [`AlgorithmSpec`] + the [`SandboxLimits`].
//! 3. Duplicate `(id, version)` plugins are rejected.
//!
//! ## Run flow ([`WasmPlugin::compute`])
//! Each compute call **instantiates a fresh sandboxed Extism plugin** from the
//! stored bytes (no state carried across calls / subjects), serializes
//! [`PluginInput`] → JSON into its input buffer, calls the declared entrypoint,
//! reads back [`PluginOutput`] JSON, **validates every output name against the
//! manifest**, and tags each with the plugin's `PluginRef(id, version)` and the
//! run's `computed_at` (the host is the authority on provenance). An
//! undeclared-output, a trap, a memory/timeout limit, or malformed JSON all
//! surface as a [`PluginError`] and yield **zero** outputs — never a panic.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

use ofit_analytics::{AlgorithmOutputs, AnalyticsInput, RunnableAlgorithm};
use ofit_core::{Algorithm, AlgorithmOutput, AlgorithmSpec, DerivedMetric, DerivedStream};

use crate::error::{PluginError, Result};
use crate::manifest::PluginManifest;
use crate::sandbox::SandboxLimits;
use crate::wire::{PluginInput, PluginOutput};

/// A single loaded, sandboxed WASM algorithm plugin. Holds the module bytes +
/// its canonical spec + the entrypoint + the sandbox limits; instantiates a
/// fresh Extism plugin per [`compute`](WasmPlugin::compute).
pub struct WasmPlugin {
    spec: AlgorithmSpec,
    wasm_bytes: Vec<u8>,
    wasm_sha256: String,
    entrypoint: String,
    limits: SandboxLimits,
}

impl std::fmt::Debug for WasmPlugin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WasmPlugin")
            .field("id", &self.spec.id)
            .field("version", &self.spec.version)
            .field("entrypoint", &self.entrypoint)
            .field("wasm_bytes", &self.wasm_bytes.len())
            .field("limits", &self.limits)
            .finish()
    }
}

impl WasmPlugin {
    /// Load a plugin from an already-parsed manifest + the module bytes, under
    /// `limits`. Verifies the SHA-256 pin if the manifest declares one.
    pub fn from_parts(
        manifest: &PluginManifest,
        wasm_bytes: Vec<u8>,
        limits: SandboxLimits,
    ) -> Result<Self> {
        let actual = hex_sha256(&wasm_bytes);
        if let Some(declared) = &manifest.wasm.sha256 {
            if !declared.eq_ignore_ascii_case(&actual) {
                return Err(PluginError::HashMismatch {
                    path: manifest.wasm.path.clone(),
                    declared: declared.clone(),
                    actual,
                });
            }
        }
        Ok(Self {
            spec: manifest.spec(),
            wasm_bytes,
            wasm_sha256: actual,
            entrypoint: manifest.wasm.entrypoint.clone(),
            limits,
        })
    }

    /// Load a plugin from a manifest file on disk, resolving + reading its
    /// `.wasm` relative to the manifest's directory.
    pub fn load_manifest_file(path: &Path, limits: SandboxLimits) -> Result<Self> {
        let manifest = PluginManifest::from_file(path)?;
        let base = path.parent().unwrap_or_else(|| Path::new("."));
        let wasm_path = manifest.wasm_path(base);
        let wasm_bytes = std::fs::read(&wasm_path).map_err(|source| PluginError::Io {
            path: wasm_path.clone(),
            source,
        })?;
        Self::from_parts(&manifest, wasm_bytes, limits)
    }

    /// The actual SHA-256 (hex) of the loaded module bytes.
    pub fn wasm_sha256(&self) -> &str {
        &self.wasm_sha256
    }

    /// The entrypoint function this plugin is called through.
    pub fn entrypoint(&self) -> &str {
        &self.entrypoint
    }

    /// The active sandbox limits.
    pub fn limits(&self) -> SandboxLimits {
        self.limits
    }

    /// Run the plugin sandboxed over `input`, returning validated + tagged
    /// outputs. Any runtime/validation failure is returned as a [`PluginError`].
    pub fn try_compute(
        &self,
        input: &AnalyticsInput,
        computed_at: DateTime<Utc>,
    ) -> Result<AlgorithmOutputs> {
        let payload = PluginInput::from_analytics(input, computed_at);
        let payload_json = serde_json::to_vec(&payload).map_err(|e| PluginError::BadOutput {
            plugin_id: self.spec.id.clone(),
            message: format!("failed to serialize input: {e}"),
        })?;

        // Build a fresh sandboxed instance for this call (no cross-call state).
        let manifest = self
            .limits
            .extism_manifest(self.wasm_bytes.clone(), Some(self.wasm_sha256.clone()));
        // Empty imports + with_wasi=false ⇒ no host functions, no WASI/filesystem.
        let mut plugin = extism::Plugin::new(&manifest, [], false).map_err(|source| {
            PluginError::Runtime {
                plugin_id: self.spec.id.clone(),
                source,
            }
        })?;

        let out_bytes: Vec<u8> = plugin
            .call::<&[u8], &[u8]>(&self.entrypoint, &payload_json)
            .map(|b| b.to_vec())
            .map_err(|source| PluginError::Runtime {
                plugin_id: self.spec.id.clone(),
                source,
            })?;

        let output: PluginOutput =
            serde_json::from_slice(&out_bytes).map_err(|e| PluginError::BadOutput {
                plugin_id: self.spec.id.clone(),
                message: format!("output is not valid PluginOutput JSON: {e}"),
            })?;

        self.tag_validated(output, computed_at)
    }

    /// Validate each emitted output against the manifest's declared outputs and
    /// tag it with this plugin's provenance (`PluginRef(id, version)` +
    /// `computed_at`). An undeclared output name is rejected. Public so the host
    /// validation/tagging path can be unit-tested without a live module.
    pub fn tag_validated(
        &self,
        output: PluginOutput,
        computed_at: DateTime<Utc>,
    ) -> Result<AlgorithmOutputs> {
        let mut out = AlgorithmOutputs::default();

        for m in output.metrics {
            if !self.declares(&AlgorithmOutput::Metric(m.name.clone())) {
                return Err(PluginError::UndeclaredOutput {
                    plugin_id: self.spec.id.clone(),
                    name: m.name,
                });
            }
            let tagged: DerivedMetric =
                self.spec.tag_metric(m.subject, m.name, m.value, computed_at);
            out.metrics.push(tagged);
        }

        for s in output.streams {
            if !self.declares(&AlgorithmOutput::Stream(s.name.clone())) {
                return Err(PluginError::UndeclaredOutput {
                    plugin_id: self.spec.id.clone(),
                    name: s.name,
                });
            }
            let samples = s
                .samples
                .into_iter()
                .map(|w| ofit_core::Sample::Scalar {
                    t_offset_ms: w.t_offset_ms,
                    value: w.value,
                })
                .collect();
            let tagged: DerivedStream =
                self.spec.tag_stream(s.subject, s.name, samples, computed_at);
            out.streams.push(tagged);
        }

        Ok(out)
    }

    /// Whether `out` is one of this plugin's manifest-declared outputs.
    fn declares(&self, out: &AlgorithmOutput) -> bool {
        self.spec.outputs.contains(out)
    }
}

impl Algorithm for WasmPlugin {
    fn spec(&self) -> &AlgorithmSpec {
        &self.spec
    }
}

impl RunnableAlgorithm for WasmPlugin {
    /// The uniform compute seam analytics calls. A sandbox/validation failure
    /// degrades to **empty** outputs (logged) so one bad plugin never aborts a
    /// batch run — call [`try_compute`](WasmPlugin::try_compute) for the error.
    fn compute(&self, input: &AnalyticsInput, computed_at: DateTime<Utc>) -> AlgorithmOutputs {
        match self.try_compute(input, computed_at) {
            Ok(out) => out,
            Err(e) => {
                tracing::warn!(plugin = %self.spec.id, error = %e, "plugin compute failed; skipping");
                AlgorithmOutputs::default()
            }
        }
    }
}

/// A registry of loaded WASM plugins. Discovers manifests in a directory and
/// hands back boxed [`RunnableAlgorithm`]s the analytics orchestrator can mix
/// with `ofit_analytics::builtin_algorithms()`.
#[derive(Debug, Default)]
pub struct PluginHost {
    plugins: Vec<WasmPlugin>,
    limits: SandboxLimits,
}

impl PluginHost {
    /// A host with the default [`SandboxLimits`] and no plugins yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// A host with custom sandbox limits.
    pub fn with_limits(limits: SandboxLimits) -> Self {
        Self { plugins: Vec::new(), limits }
    }

    /// Discover + load every plugin under `dir`. A plugin is any `*.toml` /
    /// `*.json` manifest (searched in `dir` and one level of subdirectories), each
    /// paired with its referenced `.wasm`. Missing dir ⇒ empty host (not an
    /// error: a fresh install simply has no community plugins yet).
    ///
    /// On the first malformed manifest / missing or mis-hashed module / duplicate
    /// id, returns the [`PluginError`]; successfully-loaded plugins before it are
    /// discarded so the caller decides the failure policy. Use
    /// [`PluginHost::load_dir_lenient`] to skip bad plugins instead.
    pub fn load_dir(dir: &Path, limits: SandboxLimits) -> Result<Self> {
        let mut host = Self::with_limits(limits);
        for manifest_path in discover_manifests(dir)? {
            let plugin = WasmPlugin::load_manifest_file(&manifest_path, limits)?;
            host.insert(plugin)?;
        }
        Ok(host)
    }

    /// Like [`load_dir`](PluginHost::load_dir) but logs + skips any plugin that
    /// fails to load, returning the host with whatever loaded cleanly. Returns
    /// the per-plugin errors alongside so the API can surface them.
    pub fn load_dir_lenient(dir: &Path, limits: SandboxLimits) -> (Self, Vec<PluginError>) {
        let mut host = Self::with_limits(limits);
        let mut errors = Vec::new();
        let manifests = match discover_manifests(dir) {
            Ok(m) => m,
            Err(e) => return (host, vec![e]),
        };
        for manifest_path in manifests {
            match WasmPlugin::load_manifest_file(&manifest_path, limits) {
                Ok(plugin) => {
                    if let Err(e) = host.insert(plugin) {
                        tracing::warn!(error = %e, "skipping plugin");
                        errors.push(e);
                    }
                }
                Err(e) => {
                    tracing::warn!(path = %manifest_path.display(), error = %e, "skipping plugin");
                    errors.push(e);
                }
            }
        }
        (host, errors)
    }

    /// Add an already-loaded plugin, rejecting an `(id, version)` collision.
    pub fn insert(&mut self, plugin: WasmPlugin) -> Result<()> {
        let spec = plugin.spec();
        if self
            .plugins
            .iter()
            .any(|p| p.spec().id == spec.id && p.spec().version == spec.version)
        {
            return Err(PluginError::DuplicateId {
                id: spec.id.clone(),
                version: spec.version.clone(),
            });
        }
        self.plugins.push(plugin);
        Ok(())
    }

    /// Number of loaded plugins.
    pub fn len(&self) -> usize {
        self.plugins.len()
    }

    /// Whether no plugins are loaded.
    pub fn is_empty(&self) -> bool {
        self.plugins.is_empty()
    }

    /// The sandbox limits this host loads plugins under.
    pub fn limits(&self) -> SandboxLimits {
        self.limits
    }

    /// Borrow the loaded plugins.
    pub fn plugins(&self) -> &[WasmPlugin] {
        &self.plugins
    }

    /// The specs of all loaded plugins (mirrors
    /// `ofit_analytics::builtin_specs()` for plugins; the API lists both).
    pub fn specs(&self) -> Vec<AlgorithmSpec> {
        self.plugins.iter().map(|p| p.spec().clone()).collect()
    }

    /// Find a loaded plugin by `(id, version)`.
    pub fn get(&self, id: &str, version: &str) -> Option<&WasmPlugin> {
        self.plugins
            .iter()
            .find(|p| p.spec().id == id && p.spec().version == version)
    }

    /// Consume the host into boxed [`RunnableAlgorithm`]s so analytics can run
    /// built-ins + plugins through one list:
    /// ```ignore
    /// let mut algos = ofit_analytics::builtin_algorithms();
    /// algos.extend(host.into_runnables());
    /// ```
    pub fn into_runnables(self) -> Vec<Box<dyn RunnableAlgorithm>> {
        self.plugins
            .into_iter()
            .map(|p| Box::new(p) as Box<dyn RunnableAlgorithm>)
            .collect()
    }
}

/// SHA-256 of `bytes` as lowercase hex.
fn hex_sha256(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in digest {
        // Single pre-allocated String, no per-byte temporary allocation.
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Manifest file names we recognize directly in a plugin dir.
fn is_manifest_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()),
        Some(ref e) if e == "toml" || e == "json"
    )
}

/// Collect manifest paths in `dir` (top level + one level of subdirs). A missing
/// `dir` yields an empty list (no plugins installed yet). Results are sorted for
/// deterministic load order.
fn discover_manifests(dir: &Path) -> Result<Vec<PathBuf>> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let read = std::fs::read_dir(dir).map_err(|source| PluginError::Io {
        path: dir.to_path_buf(),
        source,
    })?;
    for entry in read {
        let entry = entry.map_err(|source| PluginError::Io {
            path: dir.to_path_buf(),
            source,
        })?;
        let path = entry.path();
        if path.is_file() && is_manifest_file(&path) {
            out.push(path);
        } else if path.is_dir() {
            // One level of nesting: plugins/<name>/plugin.toml
            let sub = std::fs::read_dir(&path).map_err(|source| PluginError::Io {
                path: path.clone(),
                source,
            })?;
            for e in sub.flatten() {
                let p = e.path();
                if p.is_file() && is_manifest_file(&p) {
                    out.push(p);
                }
            }
        }
    }
    out.sort();
    Ok(out)
}
