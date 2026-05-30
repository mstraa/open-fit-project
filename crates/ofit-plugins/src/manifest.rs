//! The on-disk **plugin manifest** — the metadata file that sits next to a
//! `.wasm` module and declares the same [`AlgorithmSpec`](ofit_core::AlgorithmSpec)
//! fields plus the path + integrity hash of the module.
//!
//! ## Layout
//! A plugin is a directory (or a flat dir of many) containing pairs:
//!
//! ```text
//! plugins/
//!   my_algo/
//!     plugin.toml      # this manifest
//!     my_algo.wasm     # the sandboxed module
//! ```
//!
//! The manifest is authored as **TOML** (`*.toml`) or **JSON** (`*.json`). It
//! mirrors `AlgorithmSpec` so the registry, DB and API treat a plugin exactly
//! like a built-in, and adds a `[wasm]` section pointing at the module file with
//! an optional SHA-256 the host verifies before loading (supply-chain integrity).
//!
//! Example `plugin.toml`:
//! ```toml
//! id = "my_hrv"
//! version = "0.1.0"
//! name = "My HRV"
//! description = "Custom HRV readiness score"
//! applicable_hardware = ["hrv-strap"]
//!
//! [[inputs]]
//! domain = "wellness"
//! kind = "hrv"
//!
//! [[outputs]]
//! shape = "metric"
//! name = "my_readiness"
//!
//! [wasm]
//! path = "my_hrv.wasm"
//! sha256 = "…"            # optional integrity pin
//! entrypoint = "run"      # optional, defaults to "run"
//! ```

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use ofit_core::{AlgorithmInput, AlgorithmKind, AlgorithmOutput, AlgorithmSpec};

use crate::error::{PluginError, Result};

/// The default exported function a plugin must expose, taking the input JSON and
/// returning the outputs JSON. Overridable via `[wasm].entrypoint`.
pub const DEFAULT_ENTRYPOINT: &str = "run";

/// The `[wasm]` section: where the module lives and how to call it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WasmRef {
    /// Path to the `.wasm` file, **relative to the manifest** (or absolute).
    pub path: PathBuf,
    /// Optional SHA-256 (hex) of the module bytes; when present the host refuses
    /// to load a module whose bytes don't match (integrity / supply-chain pin).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// Exported function to call; defaults to [`DEFAULT_ENTRYPOINT`].
    #[serde(default = "default_entrypoint")]
    pub entrypoint: String,
}

fn default_entrypoint() -> String {
    DEFAULT_ENTRYPOINT.to_string()
}

/// The parsed manifest: the algorithm descriptor fields + the module reference.
///
/// Flattens the `AlgorithmSpec` fields at the top level (so a manifest reads
/// naturally) and carries the `[wasm]` section. [`PluginManifest::spec`] rebuilds
/// the canonical [`AlgorithmSpec`] (always `kind = Wasm`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginManifest {
    /// Stable plugin id (registry id), e.g. `"my_hrv"`.
    pub id: String,
    /// Semantic version (`x.y.z`). Bump = recompute.
    pub version: String,
    /// Human-readable name.
    pub name: String,
    /// One-line description.
    #[serde(default)]
    pub description: String,
    /// Required inputs (same tagged shape as [`AlgorithmInput`]).
    #[serde(default)]
    pub inputs: Vec<AlgorithmInput>,
    /// Declared outputs (same tagged shape as [`AlgorithmOutput`]).
    pub outputs: Vec<AlgorithmOutput>,
    /// Free-form hardware applicability tags.
    #[serde(default)]
    pub applicable_hardware: Vec<String>,
    /// The module reference.
    pub wasm: WasmRef,
}

impl PluginManifest {
    /// Parse a manifest from raw bytes, choosing TOML or JSON by `path`'s
    /// extension (`.json` → JSON, anything else → TOML).
    pub fn parse(path: &Path, bytes: &[u8]) -> Result<Self> {
        let is_json = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("json"))
            .unwrap_or(false);
        let text = std::str::from_utf8(bytes).map_err(|e| PluginError::Manifest {
            path: path.to_path_buf(),
            message: format!("not utf-8: {e}"),
        })?;
        let manifest: PluginManifest = if is_json {
            serde_json::from_str(text).map_err(|e| PluginError::Manifest {
                path: path.to_path_buf(),
                message: e.to_string(),
            })?
        } else {
            toml::from_str(text).map_err(|e| PluginError::Manifest {
                path: path.to_path_buf(),
                message: e.to_string(),
            })?
        };
        manifest.validate()?;
        Ok(manifest)
    }

    /// Read + parse a manifest from a file.
    pub fn from_file(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).map_err(|source| PluginError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        Self::parse(path, &bytes)
    }

    /// Structural validation independent of the wasm file: non-empty id/version,
    /// `x.y.z` version, at least one output.
    pub fn validate(&self) -> Result<()> {
        if self.id.trim().is_empty() {
            return Err(PluginError::InvalidSpec("empty plugin id".into()));
        }
        if self.name.trim().is_empty() {
            return Err(PluginError::InvalidSpec("empty plugin name".into()));
        }
        let parts: Vec<&str> = self.version.split('.').collect();
        if parts.len() != 3 || !parts.iter().all(|p| p.parse::<u32>().is_ok()) {
            return Err(PluginError::InvalidSpec(format!(
                "version '{}' is not x.y.z",
                self.version
            )));
        }
        if self.outputs.is_empty() {
            return Err(PluginError::InvalidSpec(format!(
                "plugin '{}' declares no outputs",
                self.id
            )));
        }
        if self.wasm.path.as_os_str().is_empty() {
            return Err(PluginError::InvalidSpec(format!(
                "plugin '{}' has empty wasm.path",
                self.id
            )));
        }
        Ok(())
    }

    /// Resolve the module path against `base` (the manifest's directory) when the
    /// declared path is relative.
    pub fn wasm_path(&self, base: &Path) -> PathBuf {
        if self.wasm.path.is_absolute() {
            self.wasm.path.clone()
        } else {
            base.join(&self.wasm.path)
        }
    }

    /// Build the canonical [`AlgorithmSpec`] for this plugin. Always
    /// [`AlgorithmKind::Wasm`] — the host enforces that a plugin can never
    /// masquerade as a built-in.
    pub fn spec(&self) -> AlgorithmSpec {
        AlgorithmSpec {
            id: self.id.clone(),
            version: self.version.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            inputs: self.inputs.clone(),
            outputs: self.outputs.clone(),
            applicable_hardware: self.applicable_hardware.clone(),
            kind: AlgorithmKind::Wasm,
        }
    }
}
