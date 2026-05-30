//! End-to-end sandboxed-run verification of the plugin **host mechanism**.
//!
//! This machine has no wasm toolchain (Homebrew Rust, no `rustup`, no `wasm32`
//! target), so we cannot compile an Open-Fit algorithm plugin from source. We
//! prove the host two complementary ways:
//!
//! 1. [`fixture_count_vowels_runs_sandboxed`] loads a **real prebuilt Extism
//!    module** (`tests/fixtures/count_vowels.wasm`, the upstream Extism example,
//!    committed) through our [`SandboxLimits`] manifest and calls it — proving
//!    the full Extism compile → instantiate → data-in → data-out path works under
//!    our deny-by-default sandbox (no network/FS/host-fns, memory + timeout caps).
//!
//! 2. [`wat_module_speaks_our_abi`] compiles a tiny WAT module **in-process**
//!    (via the `wat` crate — no toolchain) that echoes a constant
//!    [`PluginOutput`] JSON, loads it as a [`WasmPlugin`] with a real manifest,
//!    and runs the **typed** [`WasmPlugin::try_compute`] path — proving input
//!    marshalling, the ABI call, output validation against declared outputs, and
//!    provenance tagging end-to-end.

use std::path::Path;

use chrono::{TimeZone, Utc};

use ofit_analytics::AnalyticsInput;
use ofit_core::{Algorithm, AlgorithmKind, DerivedSubject};
use ofit_plugins::manifest::PluginManifest;
use ofit_plugins::{SandboxLimits, WasmPlugin};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/count_vowels.wasm");

/// Path 1 — real prebuilt Extism module, run under our sandbox manifest.
#[test]
fn fixture_count_vowels_runs_sandboxed() {
    let wasm = match std::fs::read(FIXTURE) {
        Ok(b) => b,
        Err(_) => {
            eprintln!("fixture {FIXTURE} not present; skipping (see crate docs)");
            return;
        }
    };
    assert_eq!(&wasm[..4], b"\0asm", "fixture is a real wasm module");

    // Build the *exact* sandbox manifest the host uses (no network/FS/host-fns,
    // memory + timeout caps), then load + call the module directly via Extism to
    // prove the mechanism. `count_vowels` takes a string and returns JSON.
    let limits = SandboxLimits::default();
    let manifest = limits.extism_manifest(wasm, None);
    // Empty imports + with_wasi=false == fully sandboxed.
    let mut plugin = extism::Plugin::new(&manifest, [], false).expect("compile+instantiate");
    assert!(plugin.function_exists("count_vowels"));

    let out: &[u8] = plugin
        .call("count_vowels", b"the quick brown fox".as_slice())
        .expect("sandboxed call returns");
    let json: serde_json::Value = serde_json::from_slice(out).expect("json out");
    // "the quick brown fox" has 5 vowels (e,u,i,o,o) — proves real execution,
    // real data-out, all under the locked-down manifest.
    assert_eq!(json["count"], 5, "got {json}");
}

/// A minimal WAT module that *is* an Open-Fit plugin: its exported `run` reads
/// nothing and writes a constant `PluginOutput` JSON via the Extism ABI. This
/// lets us exercise [`WasmPlugin::try_compute`] (typed in/out + validation +
/// tagging) with no toolchain.
fn echo_plugin_wat(out_json: &str) -> Vec<u8> {
    // Extism ABI: extism_output_set(offset, len) writes the output buffer; the
    // bytes are placed into the plugin's memory at a known offset via the
    // host-provided alloc. We use extism's `extism:host/env` imports.
    let wat = format!(
        r#"
(module
  (import "extism:host/env" "alloc"      (func $alloc (param i64) (result i64)))
  (import "extism:host/env" "output_set" (func $output_set (param i64 i64)))
  (import "extism:host/env" "store_u8"   (func $store_u8 (param i64 i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "{escaped}")
  (func (export "run") (result i32)
    (local $ptr i64)
    (local $i i32)
    (local $len i32)
    (local.set $len (i32.const {len}))
    ;; allocate `len` bytes in extism memory
    (local.set $ptr (call $alloc (i64.extend_i32_u (local.get $len))))
    ;; copy our data segment byte-by-byte into the extism allocation
    (local.set $i (i32.const 0))
    (block $done
      (loop $copy
        (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
        (call $store_u8
          (i64.add (local.get $ptr) (i64.extend_i32_u (local.get $i)))
          (i32.load8_u (local.get $i)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $copy)))
    (call $output_set (local.get $ptr) (i64.extend_i32_u (local.get $len)))
    (i32.const 0)))
"#,
        escaped = out_json.replace('\\', "\\\\").replace('"', "\\\""),
        len = out_json.len(),
    );
    wat::parse_str(&wat).expect("valid WAT compiles to wasm in-process")
}

/// Path 2 — typed compute over an in-process WAT module speaking our ABI.
#[test]
fn wat_module_speaks_our_abi() {
    // The day subject the plugin claims to compute over.
    let day = DerivedSubject::Day(uuid::Uuid::new_v4());
    let day_json = serde_json::to_string(&day).unwrap();
    // A constant PluginOutput: one declared metric + one declared stream.
    let out_json = format!(
        r#"{{"metrics":[{{"subject":{day},"name":"echo_score","value":42.5}}],"streams":[{{"subject":{day},"name":"echo_trend","samples":[{{"t_offset_ms":0,"value":1.0}},{{"t_offset_ms":1000,"value":2.0}}]}}]}}"#,
        day = day_json
    );
    let wasm = echo_plugin_wat(&out_json);

    let toml = r#"
        id = "echo"
        version = "1.0.0"
        name = "Echo"
        description = "test ABI echo"
        outputs = [
          { shape = "metric", name = "echo_score" },
          { shape = "stream", name = "echo_trend" },
        ]
        [wasm]
        path = "echo.wasm"
        entrypoint = "run"
    "#;
    let manifest = PluginManifest::parse(Path::new("plugin.toml"), toml.as_bytes()).unwrap();
    let plugin = WasmPlugin::from_parts(&manifest, wasm, SandboxLimits::default()).unwrap();
    assert_eq!(plugin.spec().kind, AlgorithmKind::Wasm);

    let when = Utc.with_ymd_and_hms(2024, 6, 1, 0, 0, 0).unwrap();
    let outputs = plugin
        .try_compute(&AnalyticsInput::default(), when)
        .expect("typed sandboxed compute succeeds");

    // The host validated both names against the manifest and tagged provenance.
    assert_eq!(outputs.metrics.len(), 1);
    assert_eq!(outputs.streams.len(), 1);
    let m = &outputs.metrics[0];
    assert_eq!(m.name, "echo_score");
    assert_eq!(m.value, 42.5);
    assert_eq!(m.plugin.plugin_id, "echo");
    assert_eq!(m.plugin.version, "1.0.0");
    assert_eq!(m.computed_at, when);
    assert!(matches!(m.subject, DerivedSubject::Day(_)));
    let s = &outputs.streams[0];
    assert_eq!(s.name, "echo_trend");
    assert_eq!(s.samples.len(), 2);
}

/// Full discovery path: lay out a real `plugins/<name>/{plugin.toml,*.wasm}`
/// directory on disk, load it via [`PluginHost::load_dir`], and run the loaded
/// plugin through the uniform `RunnableAlgorithm` trait — exactly how
/// `ofit-analytics` mixes plugins with built-ins.
#[test]
fn plugin_host_loads_dir_and_runs_as_runnable_algorithm() {
    use ofit_plugins::PluginHost;
    use sha2::{Digest, Sha256};

    let day = DerivedSubject::Day(uuid::Uuid::new_v4());
    let day_json = serde_json::to_string(&day).unwrap();
    let out_json = format!(
        r#"{{"metrics":[{{"subject":{day},"name":"my_readiness","value":77.0}}],"streams":[]}}"#,
        day = day_json
    );
    let wasm = echo_plugin_wat(&out_json);
    let hash = {
        let d = Sha256::digest(&wasm);
        d.iter().map(|b| format!("{b:02x}")).collect::<String>()
    };

    // tempdir without a crate dep.
    let dir = std::env::temp_dir().join(format!("ofit-plugins-test-{}", uuid::Uuid::new_v4()));
    let plugin_dir = dir.join("my_readiness");
    std::fs::create_dir_all(&plugin_dir).unwrap();
    std::fs::write(plugin_dir.join("readiness.wasm"), &wasm).unwrap();
    std::fs::write(
        plugin_dir.join("plugin.toml"),
        format!(
            r#"
id = "my_readiness"
version = "1.0.0"
name = "My Readiness"
description = "loaded from disk"
applicable_hardware = ["hrv-strap"]
[[inputs]]
domain = "wellness"
kind = "hrv"
[[outputs]]
shape = "metric"
name = "my_readiness"
[wasm]
path = "readiness.wasm"
sha256 = "{hash}"
"#,
        ),
    )
    .unwrap();

    let host = PluginHost::load_dir(&dir, SandboxLimits::default()).expect("load_dir");
    assert_eq!(host.len(), 1);
    let specs = host.specs();
    assert_eq!(specs[0].id, "my_readiness");
    assert_eq!(specs[0].kind, AlgorithmKind::Wasm);

    // Run through the boxed trait object, just like the orchestrator would.
    let runnables = host.into_runnables();
    let when = Utc::now();
    let out = runnables[0].compute(&AnalyticsInput::default(), when);
    assert_eq!(out.metrics.len(), 1);
    assert_eq!(out.metrics[0].name, "my_readiness");
    assert_eq!(out.metrics[0].value, 77.0);
    assert_eq!(out.metrics[0].plugin.plugin_id, "my_readiness");

    let _ = std::fs::remove_dir_all(&dir);
}

/// Prove the **timeout limit actually fires**: a WAT plugin that loops forever
/// is interrupted by the sandbox (not merely configured to be) and surfaces as a
/// runtime error rather than wedging the test.
#[test]
fn wat_infinite_loop_is_killed_by_timeout() {
    let wat = r#"
(module
  (memory (export "memory") 1)
  (func (export "run") (result i32)
    (loop $spin (br $spin))
    (i32.const 0)))
"#;
    let wasm = wat::parse_str(wat).expect("valid WAT");
    let toml = r#"
        id = "spinner"
        version = "1.0.0"
        name = "Spinner"
        outputs = [{ shape = "metric", name = "never" }]
        [wasm]
        path = "spin.wasm"
    "#;
    let manifest = PluginManifest::parse(Path::new("plugin.toml"), toml.as_bytes()).unwrap();
    // Tight 250 ms timeout so the test is fast.
    let limits = SandboxLimits { timeout_ms: 250, ..SandboxLimits::default() };
    let plugin = WasmPlugin::from_parts(&manifest, wasm, limits).unwrap();

    let started = std::time::Instant::now();
    let err = plugin
        .try_compute(&AnalyticsInput::default(), Utc::now())
        .unwrap_err();
    assert!(matches!(err, ofit_plugins::PluginError::Runtime { .. }), "got {err:?}");
    assert!(started.elapsed().as_secs() < 5, "timeout should fire quickly");
}

/// An in-process WAT plugin whose output names are NOT declared in its manifest
/// must be rejected by the host (it never trusts an undeclared output).
#[test]
fn wat_undeclared_output_is_rejected_at_runtime() {
    let day = DerivedSubject::Day(uuid::Uuid::new_v4());
    let day_json = serde_json::to_string(&day).unwrap();
    let out_json = format!(
        r#"{{"metrics":[{{"subject":{day},"name":"NOT_DECLARED","value":1.0}}],"streams":[]}}"#,
        day = day_json
    );
    let wasm = echo_plugin_wat(&out_json);
    let toml = r#"
        id = "echo2"
        version = "1.0.0"
        name = "Echo2"
        outputs = [{ shape = "metric", name = "only_this" }]
        [wasm]
        path = "echo.wasm"
    "#;
    let manifest = PluginManifest::parse(Path::new("plugin.toml"), toml.as_bytes()).unwrap();
    let plugin = WasmPlugin::from_parts(&manifest, wasm, SandboxLimits::default()).unwrap();
    let err = plugin
        .try_compute(&AnalyticsInput::default(), Utc::now())
        .unwrap_err();
    assert!(matches!(err, ofit_plugins::PluginError::UndeclaredOutput { .. }));
}
