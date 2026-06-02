//! Guarantee `../../web/dist` exists at compile time.
//!
//! `src/static_assets.rs` embeds the web SPA with `rust-embed`, whose derive
//! macro requires the folder to exist when the crate is compiled. In a fresh
//! checkout — or a CI `cargo check` / `cargo test` that never builds the web
//! app — the folder is absent, which would otherwise be a hard compile error.
//!
//! Release builds (and the Docker image) run `npm --prefix web run build` first,
//! so the *real* SPA is embedded. This placeholder only stands in when it isn't,
//! keeping `cargo check --workspace` green without a Node toolchain.

use std::path::PathBuf;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo");
    let dist = PathBuf::from(&manifest).join("../../web/dist");
    let index = dist.join("index.html");

    if !index.exists() {
        let _ = std::fs::create_dir_all(&dist);
        let _ = std::fs::write(
            &index,
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
<title>Open Fit</title></head><body style=\"font-family:system-ui;margin:3rem\">\
<h1>Open Fit</h1>\
<p>The web UI was not bundled into this build of <code>ofit-api</code>.</p>\
<p>Run <code>npm --prefix web run build</code> before compiling the release \
binary, or use the published image / release artifact.</p>\
<p>The API is live at <a href=\"/swagger-ui\">/swagger-ui</a>.</p>\
</body></html>",
        );
    }

    // Re-embed when the web build changes (release). Debug reads from disk at
    // runtime regardless, so dev iteration never needs a Rust rebuild.
    println!("cargo:rerun-if-changed=../../web/dist");
}
