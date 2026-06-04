//! # ofit-mcp — MCP server over the OpenFit API
//!
//! PLAN.md **Phase 8, Serveur MCP**: a thin layer above the REST API exposing
//! OpenFit to LLM clients (Claude Code & friends) as MCP tools — the metric/
//! stream catalog, data queries (derived outputs included), and safe runs
//! (recompute, parameters). It is the socle for Phase 9 (generative
//! visualizations).
//!
//! ## Shape
//!
//! * [`OpenFitMcp`] — the per-session tool handler. API-backed tools dispatch
//!   **in-process** into a clone of ofit-api's protected router (state
//!   applied, auth `route_layer` stripped): same handlers as the web UI, no
//!   network hop, zero logic duplication. See `dispatch`.
//! * `sql` — the read-only `query_sql`/`db_schema` escape hatch straight on
//!   the [`ofit_db::Db`] pool.
//! * [`streamable_service`] — wraps the handler in rmcp's **streamable-HTTP**
//!   transport, returned as a tower `Service` that ofit-api nests at `/mcp`.
//!
//! ## Wiring (ofit-api)
//!
//! ```ignore
//! let dispatch = protected_api.clone().with_state(state.clone()); // pre-auth
//! let mcp = ofit_mcp::streamable_service(dispatch, state.db.clone());
//! app = app.nest_service("/mcp", mcp); // behind require_auth at the ingress
//! ```
//!
//! Auth is enforced **once at `/mcp`** (session cookie or `OFIT_TOKEN`
//! bearer, exactly like `/api/*`); the in-process dispatch then intentionally
//! bypasses per-route auth. Host-header validation is disabled (rmcp's
//! default only allows localhost) because the server is reached via LAN IPs
//! and reverse proxies — the auth gate is the trust boundary.

use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};

mod dispatch;
mod error;
mod server;
mod sql;

pub use error::{McpServeError, Result};
pub use server::OpenFitMcp;

/// Build the streamable-HTTP MCP service for mounting into an axum app.
///
/// * `api_router` — clone of the protected API router (paths relative to the
///   `/api` nest) with state applied and **without** the auth layer.
/// * `db` — pool handle for the read-only SQL tools.
pub fn streamable_service(
    api_router: axum::Router,
    db: ofit_db::Db,
) -> StreamableHttpService<OpenFitMcp, LocalSessionManager> {
    StreamableHttpService::new(
        // Factory: a fresh handler per MCP session (cheap clones).
        move || Ok(OpenFitMcp::new(api_router.clone(), db.clone())),
        LocalSessionManager::default().into(),
        // Defaults: stateful sessions + 15s SSE keep-alive. Host validation
        // off — see crate docs; auth at /mcp is the boundary.
        StreamableHttpServerConfig::default().disable_allowed_hosts(),
    )
}
