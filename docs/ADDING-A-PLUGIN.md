# Adding a computed metric (plugin or built-in)

Open Fit derives metrics (training load, readiness, sleep…) from your activities +
wellness data via **algorithms**. There are two ways to add one:

| | **WASM plugin** | **Built-in** |
|---|---|---|
| Where | a `.wasm` + manifest dropped in a directory | Rust, compiled into the server |
| Server rebuild | **no** — loaded at runtime | yes |
| Sandbox | strict (no net/fs/host calls) | trusted |
| Best for | third-party, experiments, private heuristics | first-class, shipped metrics |

Both implement the **same contract** (`ofit_core::AlgorithmSpec` + a compute step) and
flow through the same registry, persistence, and API, so the rest of the app treats a
plugin exactly like a built-in.

## Shared model

- An algorithm has a versioned **spec**: `id`, `version` (`x.y.z`), `name`, `inputs`
  (stream and/or wellness kinds it needs), `outputs` (the named metrics/streams it emits),
  `applicable_hardware`, `kind` (`built_in` | `wasm`).
- It consumes an **`AnalyticsInput`** (the subject's activities — each with resolved scalar
  metric series — plus the wellness series) and emits:
  - `DerivedMetric` — a named scalar over a subject (e.g. `tss` for an `Activity`, `readiness` for a `Day`).
  - `DerivedStream` — a named time-series over a subject (e.g. `ctl`/`atl`/`tsb` over `Day`s).
- A `DerivedSubject` is what the value is about: `Activity(uuid)`, `Day(uuid)`, etc.
- Every output is **tagged with provenance** `(plugin_id, version)` and a `computed_at` clock.
  **Bumping `version` is the recompute trigger** — old derivations are superseded.
- **Output names are a contract**: only names declared in the spec's `outputs` are
  persisted (the host rejects undeclared plugin outputs; the orchestrator drops undeclared
  built-in outputs with a warning). The web UI keys on these names.

---

## Option A — a WASM plugin (no server rebuild)

The server loads plugins from the directory in the `OFIT_PLUGINS_DIR` env var at compute
time (`PluginHost::load_dir_lenient` — a malformed plugin is skipped + logged, not fatal).
Each runs in a fresh sandbox per call: **no network, no filesystem, no host functions,
bounded memory + CPU/wall-time**. A plugin only depends on a JSON shape, never on Open Fit's
Rust types.

### 1. The wire contract (JSON in → JSON out)

Input the host hands you (`PluginInput`):
```jsonc
{
  "activities": [
    { "activity_id": "uuid", "sport": "running",
      "started_at": "2026-06-03T08:00:00Z", "ended_at": "2026-06-03T08:45:00Z",
      "metrics": [ { "kind": "heart_rate", "samples": [ { "t_offset_ms": 0, "value": 142 }, ... ] } ] }
  ],
  "wellness": [ { "kind": "hrv", "value": 62.0, "ts": "2026-06-03T06:00:00Z" }, ... ],
  "computed_at": "2026-06-03T09:00:00Z"   // stamp your outputs with this
}
```
Output you return (`PluginOutput`) — `subject` is a `DerivedSubject`, `name` must be a
declared output:
```jsonc
{
  "metrics": [ { "subject": { "kind": "day", "id": "uuid" }, "name": "my_readiness", "value": 78.0 } ],
  "streams": [ { "subject": { "kind": "day", "id": "uuid" }, "name": "my_trend",
                 "samples": [ { "t_offset_ms": 0, "value": 1.0 }, ... ] } ]
}
```
(The host overwrites provenance + `computed_at`, so you can't spoof them. The canonical
shapes are `ofit_plugins::wire::{PluginInput, PluginOutput}`.)

### 2. Author the module (Rust + extism-pdk)

```toml
# Cargo.toml
[lib]
crate-type = ["cdylib"]
[dependencies]
extism-pdk = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```
```rust
use extism_pdk::*;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)] struct In  { /* mirror PluginInput */ }
#[derive(Serialize)]   struct Out { /* mirror PluginOutput */ }

#[plugin_fn]
pub fn run(input: Json<In>) -> FnResult<Json<Out>> {
    let input = input.into_inner();
    // ... compute from input.activities / input.wellness, stamping subjects ...
    Ok(Json(out))
}
```
Build:
```bash
cargo build --release --target wasm32-unknown-unknown
```
The exported function name must match `[wasm].entrypoint` (default `run`).

> This dev machine (Homebrew Rust, no `rustup`/`wasm32` target) can't compile a plugin from
> source — the host is verified end-to-end against a prebuilt fixture in
> `crates/ofit-plugins/tests/`. Use a box with `rustup` + the `wasm32-unknown-unknown` target.

### 3. The manifest (`plugin.toml`)

Sits next to the `.wasm`; mirrors the spec + points at the module:
```toml
id = "my_readiness"          # stable registry id
version = "0.1.0"            # x.y.z — bump to recompute
name = "My Readiness"
description = "Custom readiness score"
applicable_hardware = ["hrv-strap"]   # free-form tags; [] / ["any"] = broadly applicable

[[inputs]]                   # domain = "stream" | "wellness"; kind = the StreamKind/WellnessKind
domain = "wellness"
kind = "hrv"

[[outputs]]                  # shape = "metric" | "stream"; name = the emitted output name
shape = "metric"
name = "my_readiness"

[wasm]
path = "my_readiness.wasm"   # relative to this manifest
sha256 = "…"                 # optional integrity pin — host refuses a mismatching module
entrypoint = "run"           # optional (default "run")
```
(JSON is also accepted — name the file `*.json`. Validation: non-empty id/name, `x.y.z`
version, ≥1 output.)

### 4. Deploy

```
$OFIT_PLUGINS_DIR/
  my_readiness/
    plugin.toml
    my_readiness.wasm
```
Picked up on the next recompute. It appears in `GET /api/algorithms` next to the built-ins,
runs over every subject, and its outputs persist + supersede by `(id, version)`.

---

## Option B — a built-in algorithm (in-tree Rust)

Use this for a metric you want shipped and trusted. Touch-points:

### 1. Implement it — `crates/ofit-analytics/src/algorithms/my_algo.rs`

```rust
use ofit_core::{Algorithm, AlgorithmSpec, AlgorithmKind, AlgorithmInput, AlgorithmOutput};
use crate::{AnalyticsParams, AlgorithmOutputs, RunnableAlgorithm, input::AnalyticsInput};

pub struct MyAlgo { spec: AlgorithmSpec, /* + the params it needs */ }

impl MyAlgo {
    pub fn configured(p: &AnalyticsParams) -> Self {       // built-ins build their spec at runtime
        Self {
            spec: AlgorithmSpec {
                id: "my_algo".into(),
                version: "1.0.0".into(),                    // bump = recompute
                name: "My Algo".into(),
                description: "…".into(),
                inputs: vec![AlgorithmInput::Wellness(/* … */)],
                outputs: vec![AlgorithmOutput::Metric("my_metric".into())],
                applicable_hardware: vec!["any".into()],
                kind: AlgorithmKind::BuiltIn,
            },
            /* read knobs off `p` */
        }
    }
}

impl Algorithm for MyAlgo { fn spec(&self) -> &AlgorithmSpec { &self.spec } }

impl RunnableAlgorithm for MyAlgo {
    fn compute(&self, input: &AnalyticsInput, computed_at: chrono::DateTime<chrono::Utc>) -> AlgorithmOutputs {
        // Degrade gracefully (emit fewer/zero outputs) on sparse/empty data — never panic.
        // Tag via self.spec.tag_metric(subject, "my_metric", value, computed_at).
        AlgorithmOutputs::default()
    }
}
```

### 2. Register it (⚠️ easy to forget → it silently never runs)

- `crates/ofit-analytics/src/algorithms/mod.rs`: `pub mod my_algo; pub use my_algo::MyAlgo;`
- `crates/ofit-analytics/src/lib.rs` → `builtin_algorithms(p)`: add `Box::new(MyAlgo::configured(p))`
  to the `vec![]`. This is the single registration list (a test asserts every built-in is
  well-formed + emits only declared outputs, but it cannot know about an algorithm you never added).

### 3. Make its constants tunable — `crates/ofit-analytics/src/params.rs`

Every heuristic constant is a user-overridable parameter and part of the derivation's
fingerprint. For each knob:
- add an `f64` field to `AnalyticsParams` + its default in `impl Default`;
- add a `REGISTRY` entry via the `pdef!` macro. **The `plugins` list must contain your spec
  `id` exactly** — that's what ties the parameter into your algorithm's fingerprint (a typo
  silently breaks variant tracking, so stale cached results get reused when the knob changes):
  ```rust
  // pdef!(key, field, group, tier, integer?, min, max, plugins, unit, label, desc)
  pdef!("analytics.my_algo.threshold", my_threshold, "my_algo", Curated, false,
        Some(0.0), Some(100.0), &["my_algo"], "", "My threshold", "What it does."),
  ```

### 4. Display + verify

- Outputs flow through generic persistence + the API with **no DB/DTO edits** when they're
  scalar `metric`/`stream` shapes. Bind the new output name(s) to a tile/chart in `web/src/`
  if you want them shown.
- `cargo test -p ofit-analytics -p ofit-core` (add unit tests for your compute; the registry
  invariants run here too).

---

## Choosing

- **Plugin** if it's third-party, experimental, private, or you don't want a server release —
  it's nearly drop-in (2 files, zero server code) and sandboxed.
- **Built-in** if it's a core, shipped metric that benefits from being trusted, fast, and
  user-tunable via settings.

See also: `crates/ofit-plugins/` (host + sandbox), `crates/ofit-analytics/` (built-ins +
params), and `AUDIT.md` (the extensibility analysis these docs came out of).
