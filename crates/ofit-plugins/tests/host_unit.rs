//! Unit tests for the host logic that needs **no live wasm module**: manifest
//! parsing (TOML + JSON), spec validation, registry dedup, sandbox-limit config,
//! and the output-validation / tagging path. These run everywhere, toolchain or
//! not.

use std::path::Path;

use ofit_core::{AlgorithmKind, AlgorithmOutput, DerivedSubject};
use ofit_plugins::manifest::PluginManifest;
use ofit_plugins::wire::{PluginInput, PluginOutput, WireOutMetric, WireOutStream, WireSample};
use ofit_plugins::{PluginHost, SandboxLimits, WasmPlugin};

const TOML_MANIFEST: &str = r#"
id = "my_hrv"
version = "0.2.1"
name = "My HRV"
description = "custom readiness"
applicable_hardware = ["hrv-strap"]

[[inputs]]
domain = "wellness"
kind = "hrv"

[[outputs]]
shape = "metric"
name = "my_readiness"

[[outputs]]
shape = "stream"
name = "my_trend"

[wasm]
path = "my_hrv.wasm"
sha256 = "abc123"
entrypoint = "run"
"#;

#[test]
fn parses_toml_manifest_into_spec() {
    let m = PluginManifest::parse(Path::new("plugin.toml"), TOML_MANIFEST.as_bytes()).unwrap();
    assert_eq!(m.id, "my_hrv");
    assert_eq!(m.version, "0.2.1");
    assert_eq!(m.wasm.entrypoint, "run");
    assert_eq!(m.wasm.sha256.as_deref(), Some("abc123"));

    let spec = m.spec();
    // A plugin is always Wasm — it can never claim to be a built-in.
    assert_eq!(spec.kind, AlgorithmKind::Wasm);
    assert_eq!(spec.inputs.len(), 1);
    assert_eq!(spec.outputs.len(), 2);
    assert!(spec.outputs.contains(&AlgorithmOutput::Metric("my_readiness".into())));
    assert!(spec.outputs.contains(&AlgorithmOutput::Stream("my_trend".into())));
}

#[test]
fn parses_json_manifest_equivalently() {
    let json = r#"{
      "id":"my_hrv","version":"0.2.1","name":"My HRV","description":"x",
      "inputs":[{"domain":"wellness","kind":"hrv"}],
      "outputs":[{"shape":"metric","name":"my_readiness"}],
      "applicable_hardware":[],
      "wasm":{"path":"my_hrv.wasm"}
    }"#;
    let m = PluginManifest::parse(Path::new("plugin.json"), json.as_bytes()).unwrap();
    assert_eq!(m.id, "my_hrv");
    // entrypoint defaults to "run" when omitted.
    assert_eq!(m.wasm.entrypoint, "run");
    assert!(m.wasm.sha256.is_none());
}

#[test]
fn validation_rejects_bad_version_and_no_outputs() {
    let bad_version = TOML_MANIFEST.replace("0.2.1", "1.2");
    assert!(PluginManifest::parse(Path::new("p.toml"), bad_version.as_bytes()).is_err());

    let no_outputs = r#"
        id = "x"
        version = "1.0.0"
        name = "x"
        outputs = []
        [wasm]
        path = "x.wasm"
    "#;
    assert!(PluginManifest::parse(Path::new("p.toml"), no_outputs.as_bytes()).is_err());
}

#[test]
fn sandbox_limits_default_is_locked_down() {
    let l = SandboxLimits::default();
    assert!(l.max_pages > 0 && l.max_pages <= 256, "memory bounded");
    assert!(l.timeout_ms > 0, "timeout set");
    // The extism manifest carries the timeout and never allows hosts.
    let m = l.extism_manifest(vec![0, 1, 2], Some("deadbeef".into()));
    assert_eq!(m.timeout_ms, Some(l.timeout_ms));
    assert_eq!(m.allowed_hosts, Some(vec![]), "no network hosts allowed");
    assert!(m.allowed_paths.is_none(), "no filesystem paths allowed");
    assert_eq!(m.memory.max_pages, Some(l.max_pages));
    assert_eq!(m.memory.max_http_response_bytes, Some(0), "http buffers denied");
}

#[test]
fn hash_pin_mismatch_is_rejected() {
    // Manifest pins a hash that won't match arbitrary bytes.
    let m = PluginManifest::parse(Path::new("plugin.toml"), TOML_MANIFEST.as_bytes()).unwrap();
    let err = WasmPlugin::from_parts(&m, b"not the real module".to_vec(), SandboxLimits::default())
        .unwrap_err();
    assert!(matches!(err, ofit_plugins::PluginError::HashMismatch { .. }));
}

#[test]
fn registry_rejects_duplicate_id_version() {
    // Build two plugins with the same id+version (no hash pin so any bytes load).
    let toml = r#"
        id = "dup"
        version = "1.0.0"
        name = "Dup"
        outputs = [{ shape = "metric", name = "x" }]
        [wasm]
        path = "d.wasm"
    "#;
    let m = PluginManifest::parse(Path::new("plugin.toml"), toml.as_bytes()).unwrap();
    let p1 = WasmPlugin::from_parts(&m, b"abc".to_vec(), SandboxLimits::default()).unwrap();
    let p2 = WasmPlugin::from_parts(&m, b"abc".to_vec(), SandboxLimits::default()).unwrap();

    let mut host = PluginHost::new();
    host.insert(p1).unwrap();
    let err = host.insert(p2).unwrap_err();
    assert!(matches!(err, ofit_plugins::PluginError::DuplicateId { .. }));
    assert_eq!(host.len(), 1);
}

#[test]
fn load_dir_missing_is_empty_not_error() {
    let host = PluginHost::load_dir(Path::new("/no/such/plugins/dir"), SandboxLimits::default())
        .expect("missing dir is not an error");
    assert!(host.is_empty());
}

#[test]
fn wire_input_roundtrips_through_json() {
    use chrono::{TimeZone, Utc};
    use ofit_analytics::{ActivityInput, AnalyticsInput, MetricSeries, WellnessPoint};
    use ofit_core::{Sport, StreamKind, WellnessKind};

    let t = Utc.with_ymd_and_hms(2024, 1, 1, 8, 0, 0).unwrap();
    let input = AnalyticsInput {
        activities: vec![ActivityInput {
            activity_id: uuid::Uuid::new_v4(),
            sport: Sport::Running,
            started_at: t,
            ended_at: t + chrono::Duration::minutes(30),
            metrics: vec![MetricSeries::new(StreamKind::HeartRate, vec![(0, 150.0), (1000, 152.0)])],
        }],
        wellness: vec![WellnessPoint { kind: WellnessKind::Hrv, value: 60.0, ts: t }],
    };

    let wire = PluginInput::from_analytics(&input, t);
    let json = serde_json::to_vec(&wire).unwrap();
    let back: PluginInput = serde_json::from_slice(&json).unwrap();
    assert_eq!(back.to_analytics(), input, "wire roundtrip is lossless");
}

#[test]
fn output_validation_rejects_undeclared_and_tags_declared() {
    use chrono::Utc;
    // Plugin that declares only "my_readiness" (metric) and "my_trend" (stream).
    let m = PluginManifest::parse(Path::new("plugin.toml"), TOML_MANIFEST.as_bytes()).unwrap();
    // No hash pin needed: use a manifest variant without sha256 so any bytes load.
    let no_pin = PluginManifest {
        wasm: ofit_plugins::WasmRef { sha256: None, ..m.wasm.clone() },
        ..m.clone()
    };
    let plugin =
        WasmPlugin::from_parts(&no_pin, b"bytes".to_vec(), SandboxLimits::default()).unwrap();

    let now = Utc::now();
    let day = DerivedSubject::Day(uuid::Uuid::new_v4());

    // Declared outputs → tagged with the plugin's provenance.
    let good = PluginOutput {
        metrics: vec![WireOutMetric { subject: day, name: "my_readiness".into(), value: 88.0 }],
        streams: vec![WireOutStream {
            subject: day,
            name: "my_trend".into(),
            samples: vec![WireSample { t_offset_ms: 0, value: 1.0 }],
        }],
    };
    let out = plugin.tag_validated(good, now).unwrap();
    assert_eq!(out.metrics.len(), 1);
    assert_eq!(out.streams.len(), 1);
    assert_eq!(out.metrics[0].plugin.plugin_id, "my_hrv");
    assert_eq!(out.metrics[0].plugin.version, "0.2.1");
    assert_eq!(out.metrics[0].computed_at, now);

    // Undeclared metric name → rejected.
    let bad = PluginOutput {
        metrics: vec![WireOutMetric { subject: day, name: "sneaky".into(), value: 1.0 }],
        streams: vec![],
    };
    let err = plugin.tag_validated(bad, now).unwrap_err();
    assert!(matches!(err, ofit_plugins::PluginError::UndeclaredOutput { .. }));
}
