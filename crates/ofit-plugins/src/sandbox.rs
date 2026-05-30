//! The **sandbox policy** — the resource limits and the deny-by-default
//! capability set every plugin is loaded under.
//!
//! ## Guarantees (AGENTS.md hard rule: algos run sandboxed, no network, CPU/mem
//! limits — they handle health data and may come from third parties)
//!
//! Extism/wasmtime plugins start with **no ambient capabilities**. We never opt
//! into any of the escape hatches:
//!
//! - **No network.** We never call `with_allowed_host(s)`, and we explicitly
//!   `disallow_all_hosts()`. With an empty allow-list the PDK `http_request`
//!   import has nothing it may reach, so the plugin cannot make outbound
//!   requests. (Belt-and-suspenders: the host also caps any HTTP response size
//!   to zero via [`MemoryOptions`].)
//! - **No filesystem / WASI.** We build plugins with `with_wasi = false` and
//!   never call `with_allowed_path(s)`, so there is no preopened directory and no
//!   WASI syscalls — the module cannot read or write the host disk.
//! - **No host functions.** We pass an **empty** imports list to the plugin
//!   builder: the only ABI surface is the single exported entrypoint
//!   (data-in / data-out via Extism's input/output buffers).
//! - **Bounded memory.** `max_pages` caps linear-memory growth (64 KiB/page);
//!   `max_var_bytes` caps Extism vars; `max_http_response_bytes = 0` denies HTTP
//!   buffers entirely.
//! - **Bounded CPU/wall time.** `timeout_ms` aborts a runaway call (Extism arms
//!   an interrupt timer), so an infinite loop cannot wedge the server.
//!
//! These are *deny-by-default*: the policy only ever **tightens** the Extism
//! defaults, it never loosens them.

use std::time::Duration;

use extism::Manifest as ExtismManifest;
use extism_manifest::MemoryOptions;

use ofit_core::AlgorithmSpec;

/// Conservative per-plugin resource limits. Health-data algorithms are pure
/// compute over a single subject's window, so these are deliberately small.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SandboxLimits {
    /// Max WebAssembly linear-memory pages (64 KiB each). `64` ⇒ 4 MiB.
    pub max_pages: u32,
    /// Max bytes a plugin may keep in Extism vars (persistent scratch).
    pub max_var_bytes: u64,
    /// Wall-clock timeout for a single call, in milliseconds.
    pub timeout_ms: u64,
}

impl Default for SandboxLimits {
    fn default() -> Self {
        Self {
            // 4 MiB of linear memory — generous for a day/activity-sized input.
            max_pages: 64,
            // 64 KiB of vars; most algorithms need none.
            max_var_bytes: 64 * 1024,
            // 5 s hard ceiling on a single compute call.
            timeout_ms: 5_000,
        }
    }
}

impl SandboxLimits {
    /// Build an [`extism::Manifest`] for `wasm_bytes` under this policy with
    /// **zero ambient capabilities** (see module docs). `wasm_hash`, when set on
    /// the [`extism_manifest::Wasm`], lets Extism cache compiled modules by hash.
    pub fn extism_manifest(&self, wasm_bytes: Vec<u8>, wasm_hash: Option<String>) -> ExtismManifest {
        let mut wasm = extism::Wasm::data(wasm_bytes);
        if let Some(h) = wasm_hash {
            wasm = wasm.with_hash(h);
        }

        let memory = MemoryOptions::new()
            .with_max_pages(self.max_pages)
            .with_max_var_bytes(self.max_var_bytes)
            // Deny HTTP response buffers entirely (no network in any case).
            .with_max_http_response_bytes(0);

        ExtismManifest::new([wasm])
            .with_memory_options(memory)
            .with_timeout(Duration::from_millis(self.timeout_ms))
            // Explicit, even though the default allow-list is already empty.
            .disallow_all_hosts()
        // NOTE: we intentionally never call:
        //   .with_allowed_host(_) / .with_allowed_hosts(_)  → would grant network
        //   .with_allowed_path(_) / .with_allowed_paths(_)  → would grant FS
        // and the plugin is built with_wasi = false and an empty imports list.
    }
}

/// One-line human description of the active sandbox policy (for logs / the API
/// `GET …/plugins` surface, so operators can audit what plugins run under).
pub fn describe(limits: &SandboxLimits) -> String {
    format!(
        "sandboxed: no-network, no-filesystem (wasi off), no host-fns; \
         mem<= {} pages ({} KiB), vars<= {} KiB, timeout {} ms",
        limits.max_pages,
        limits.max_pages as u64 * 64,
        limits.max_var_bytes / 1024,
        limits.timeout_ms,
    )
}

/// Whether a spec is something this host is willing to run: it must be a WASM
/// plugin (built-ins go through `ofit-analytics` directly, never the host).
pub fn is_loadable(spec: &AlgorithmSpec) -> bool {
    matches!(spec.kind, ofit_core::AlgorithmKind::Wasm)
}
