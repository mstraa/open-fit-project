//! # ofit-plugins — the sandboxed WASM algorithm plugin host
//!
//! This crate is Open Fit's **extension point** (PLAN.md Phase 3, "Algorithmes en
//! plugins"): community / third-party algorithms shipped as **WebAssembly**, run
//! under a strict sandbox, exposed behind the **same** stage-1 algorithm
//! abstraction as the built-ins so [`ofit_analytics`] treats them uniformly.
//!
//! ## What it provides
//! - [`PluginManifest`] — a TOML/JSON file next to the `.wasm` declaring the same
//!   [`AlgorithmSpec`](ofit_core::AlgorithmSpec) fields (id, version, name,
//!   inputs, outputs, applicable hardware) + the module path & integrity hash.
//! - [`PluginHost`] — discovers + loads plugins from a directory, **sandboxed**.
//! - [`WasmPlugin`] — one loaded plugin, implementing [`ofit_core::Algorithm`] and
//!   [`ofit_analytics::RunnableAlgorithm`] so it drops straight into the analytics
//!   registry alongside `ofit_analytics::builtin_algorithms()`.
//! - [`SandboxLimits`] + [`sandbox`] — the deny-by-default capability + resource
//!   policy (see below).
//! - [`wire`] — the JSON data-in/data-out contract a plugin author commits to.
//!
//! ## Sandbox guarantees (AGENTS.md hard rule)
//! Plugins handle **health data** and may be untrusted, so every plugin runs with
//! **no ambient capabilities** (full detail in [`sandbox`]):
//! - **no network** (HTTP allow-list empty + [`Manifest::disallow_all_hosts`](extism::Manifest::disallow_all_hosts), HTTP buffers capped to 0),
//! - **no filesystem / WASI** (built `with_wasi = false`, no preopened paths),
//! - **no host functions** (empty imports list; only the data-in/data-out ABI),
//! - **bounded memory** ([`SandboxLimits::max_pages`], var bytes), and
//! - **bounded CPU/wall time** ([`SandboxLimits::timeout_ms`] interrupts runaways).
//! A fresh sandbox instance is built per compute call, so no state leaks across
//! subjects or runs.
//!
//! ## Wiring into analytics
//! ```ignore
//! use ofit_plugins::{PluginHost, SandboxLimits};
//! let host = PluginHost::load_dir(plugins_dir, SandboxLimits::default())?;
//! let mut algos = ofit_analytics::builtin_algorithms();   // built-ins
//! algos.extend(host.into_runnables());                    // + plugins, same trait
//! // run them all over an AnalyticsInput exactly the same way.
//! ```
//!
//! ## Authoring a real algorithm plugin (machines *with* the wasm toolchain)
//! On a box with `rustup` + the `wasm32-unknown-unknown` target you write the
//! algorithm in Rust against [`extism-pdk`](https://crates.io/crates/extism-pdk):
//!
//! ```ignore
//! // Cargo.toml: crate-type = ["cdylib"]; deps: extism-pdk, serde, serde_json
//! use extism_pdk::*;
//! use serde::{Deserialize, Serialize};
//!
//! #[derive(Deserialize)] struct In  { /* mirror ofit_plugins::wire::PluginInput */ }
//! #[derive(Serialize)]   struct Out { /* mirror ofit_plugins::wire::PluginOutput */ }
//!
//! #[plugin_fn]
//! pub fn run(input: Json<In>) -> FnResult<Json<Out>> {
//!     let input = input.into_inner();
//!     // ... compute derived metrics/streams from input.activities / input.wellness,
//!     //     stamping subjects; the host tags provenance + computed_at ...
//!     Ok(Json(out))
//! }
//! ```
//! Build with `cargo build --release --target wasm32-unknown-unknown`, drop the
//! resulting `*.wasm` next to a [`PluginManifest`] (`plugin.toml`) in the plugins
//! directory, and the host loads it. The exported function name must match
//! `[wasm].entrypoint` (default `run`). The input/output JSON is exactly
//! [`wire::PluginInput`] / [`wire::PluginOutput`] — a plugin depends only on that
//! shape, never on these Rust types.
//!
//! > This machine (Homebrew Rust, no `rustup`, no `wasm32` target) cannot compile
//! > a plugin from source — see the crate's `tests/` for how the host is verified
//! > end-to-end against a **prebuilt** Extism module fixture instead.

pub mod error;
pub mod host;
pub mod manifest;
pub mod sandbox;
pub mod wire;

pub use error::{PluginError, Result};
pub use host::{PluginHost, WasmPlugin};
pub use manifest::{PluginManifest, WasmRef, DEFAULT_ENTRYPOINT};
pub use sandbox::SandboxLimits;
pub use wire::{PluginInput, PluginOutput};
