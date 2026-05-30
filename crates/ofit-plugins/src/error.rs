//! Errors for the WASM plugin host (`thiserror`, per AGENTS.md lib convention).

use std::path::PathBuf;

/// Errors raised while discovering, loading, validating, or running a plugin.
#[derive(Debug, thiserror::Error)]
pub enum PluginError {
    /// The plugins directory or a plugin file could not be read.
    #[error("io error for {path}: {source}")]
    Io {
        /// The path that failed.
        path: PathBuf,
        /// The underlying IO error.
        #[source]
        source: std::io::Error,
    },

    /// A manifest file failed to parse (TOML or JSON).
    #[error("failed to parse manifest {path}: {message}")]
    Manifest {
        /// The manifest path.
        path: PathBuf,
        /// Parser message.
        message: String,
    },

    /// The manifest references a `.wasm` whose on-disk SHA-256 does not match the
    /// declared `wasm.sha256` — the integrity guard refused to load it.
    #[error("wasm hash mismatch for {path}: manifest declares {declared}, file is {actual}")]
    HashMismatch {
        /// The wasm path.
        path: PathBuf,
        /// Hash declared in the manifest.
        declared: String,
        /// Hash actually computed from the file bytes.
        actual: String,
    },

    /// The manifest is structurally invalid (empty id/version, no outputs, …).
    #[error("invalid manifest: {0}")]
    InvalidSpec(String),

    /// The Extism runtime failed to compile/instantiate the module, or the call
    /// trapped / hit a sandbox limit (memory, timeout).
    #[error("wasm runtime error in plugin '{plugin_id}': {source}")]
    Runtime {
        /// The plugin id that failed.
        plugin_id: String,
        /// The underlying Extism/wasmtime error.
        #[source]
        source: anyhow::Error,
    },

    /// The plugin returned bytes that are not the expected output JSON.
    #[error("plugin '{plugin_id}' returned malformed output: {message}")]
    BadOutput {
        /// The plugin id.
        plugin_id: String,
        /// What was wrong.
        message: String,
    },

    /// The plugin emitted a derived metric/stream whose name is not in its
    /// declared `outputs`, or tagged it with the wrong plugin ref — the host
    /// rejected it rather than trust an undeclared output.
    #[error("plugin '{plugin_id}' produced undeclared output '{name}'")]
    UndeclaredOutput {
        /// The plugin id.
        plugin_id: String,
        /// The offending output name.
        name: String,
    },

    /// Two loaded plugins (or a plugin and a built-in) collide on `(id, version)`.
    #[error("duplicate plugin id+version: {id}@{version}")]
    DuplicateId {
        /// Colliding id.
        id: String,
        /// Colliding version.
        version: String,
    },
}

/// Convenience alias.
pub type Result<T> = std::result::Result<T, PluginError>;
