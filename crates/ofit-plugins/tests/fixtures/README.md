# Test fixtures

## `count_vowels.wasm`

A **prebuilt** Extism example plugin (the upstream `count_vowels` sample),
fetched once at build time from the public Extism plugins release:

```
https://github.com/extism/plugins/releases/latest/download/count_vowels.wasm
```

It is committed here because this build machine has **no wasm toolchain**
(Homebrew Rust, no `rustup`, no `wasm32-unknown-unknown` target) and therefore
cannot compile a plugin from source. The integration test
`tests/sandboxed_run.rs::fixture_count_vowels_runs_sandboxed` loads it through
the host's `SandboxLimits` manifest and calls it, proving the Extism
compile → instantiate → data-in → data-out path works end-to-end under our
deny-by-default sandbox.

It does **not** speak the Open-Fit `PluginInput`/`PluginOutput` ABI (it takes a
string, returns a vowel-count JSON), so it only exercises the *host mechanism*.
The typed `WasmPlugin::try_compute` path is proven separately by tiny WAT
modules compiled in-process via the `wat` crate (no toolchain) in the same test
file.

SHA-256: `72dfe2c69d8e5ac50886b7961664af6cccbbdcabeb45ce48270db2242778ce25`

Upstream license: Extism is BSD-3-Clause. This is a test fixture only; it is not
linked into the product.
