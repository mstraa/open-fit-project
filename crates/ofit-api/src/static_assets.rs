//! Serves the embedded web SPA (`../../web/dist`) as the axum router fallback.
//!
//! In **release** builds the assets are baked into the binary by `rust-embed`,
//! so one self-contained `ofit-api` serves both the API and the UI on a single
//! port — no nginx, no separate web bundle (this is what the Proxmox-LXC /
//! single-binary deployment relies on). In **debug** builds `rust-embed` reads
//! `web/dist` from disk at runtime, so `npm run dev` (or a fresh `vite build`)
//! is reflected without recompiling Rust. `build.rs` guarantees the folder
//! exists at compile time (a placeholder page if the web build is absent).

use axum::{
    body::Body,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

// Folder is resolved relative to this crate's root (CARGO_MANIFEST_DIR), i.e.
// `<repo>/web/dist`. Release builds embed it; debug builds read it from disk.
#[derive(RustEmbed)]
#[folder = "../../web/dist"]
struct WebAssets;

/// Router fallback for everything not matched by an API/doc route: serve the
/// bundled static file, else fall back to `index.html` so client-side routes
/// (e.g. `/activities/42`) resolve on a hard reload.
///
/// `/api`, `/health`, `/api-docs` and `/swagger-ui` are registered routes, so a
/// request only lands here if it didn't match one of them. We still guard those
/// namespaces explicitly: a stray `/api/typo` must 404, not return the SPA HTML.
pub(crate) async fn handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');

    if path == "health"
        || path == "api"
        || path.starts_with("api/")
        || path == "api-docs"
        || path.starts_with("api-docs/")
        || path == "swagger-ui"
        || path.starts_with("swagger-ui/")
        || path == "mcp"
        || path.starts_with("mcp/")
    {
        return StatusCode::NOT_FOUND.into_response();
    }

    if let Some(resp) = serve(path) {
        return resp;
    }

    // A concrete asset that isn't bundled (e.g. `/assets/old-hash.js` requested
    // by a stale tab after a redeploy) must 404 — returning index.html here would
    // hand the browser HTML where it expects a JS/CSS module, breaking dynamic
    // imports (React.lazy chunk recovery). Only extensionless paths are treated
    // as client-side routes that fall through to the SPA shell.
    let last_segment = path.rsplit('/').next().unwrap_or("");
    if path.starts_with("assets/") || last_segment.contains('.') {
        return StatusCode::NOT_FOUND.into_response();
    }

    // SPA fallback — the single-page app resolves the route client-side.
    serve("index.html").unwrap_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            "Open Fit web UI is not bundled in this build.",
        )
            .into_response()
    })
}

/// Look up one embedded asset and turn it into a response with the right
/// `Content-Type`. Returns `None` when the path isn't bundled.
fn serve(path: &str) -> Option<Response> {
    let file = WebAssets::get(path)?;
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    Some(
        (
            [(header::CONTENT_TYPE, mime.as_ref())],
            Body::from(file.data.into_owned()),
        )
            .into_response(),
    )
}
