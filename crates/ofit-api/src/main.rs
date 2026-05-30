//! # ofit-api
//!
//! axum REST + (later) WebSocket/SSE server, with an OpenAPI document (utoipa)
//! from which the frontend's typed TS client is generated. Phase 0 scaffold:
//! health/version routes, swagger-ui, CORS + tracing, a single-user auth STUB,
//! and startup wiring to `ofit-db` (connect + run migrations).
//!
//! ## Deployment (2 tiers, see PLAN.md / docker/)
//! * **simple**: this binary + SQLite file (`DATABASE_URL=sqlite://./data/ofit.db?mode=rwc`).
//!   First-run "wizard" today = env/defaults; a guided setup lands in a later phase.
//! * **full**: same binary against Postgres/Timescale via `DATABASE_URL=postgres://…`.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{header, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use ofit_db::Db;
use serde::Serialize;
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use utoipa::{OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;

/// Shared application state handed to every handler.
#[derive(Clone)]
struct AppState {
    db: Db,
    /// Bearer token required on `/api/*` when set. `None` = auth disabled
    /// (first-run / local dev). Real multi-credential auth is a later phase.
    token: Option<Arc<str>>,
}

/// Liveness payload. Reports the DB backend in use so the simple/full tier is
/// visible at a glance.
#[derive(Serialize, ToSchema)]
struct Health {
    status: &'static str,
    db: String,
}

/// Build/version metadata.
#[derive(Serialize, ToSchema)]
struct Version {
    name: &'static str,
    version: &'static str,
}

/// OpenAPI document. Served as JSON at `/api-docs/openapi.json`; the web client
/// is generated from it (never hand-write API types — AGENTS.md).
#[derive(OpenApi)]
#[openapi(
    paths(health, version),
    components(schemas(Health, Version)),
    info(title = "Open Fit API", description = "Cloudless self-hosted fitness platform")
)]
struct ApiDoc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,ofit_api=debug".into()),
        )
        .init();

    // ---- first-run config (env + sane SQLite default) ----
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "sqlite://./data/ofit.db?mode=rwc".to_string());
    let token = std::env::var("OFIT_TOKEN").ok().filter(|t| !t.is_empty());
    if token.is_none() {
        tracing::warn!("OFIT_TOKEN unset — /api auth is DISABLED (first-run/dev mode)");
    }
    let bind = std::env::var("OFIT_BIND").unwrap_or_else(|_| "0.0.0.0:8080".to_string());

    // ---- connect db + migrate on startup ----
    tracing::info!("connecting to database…");
    let db = Db::connect(&database_url).await?;
    db.run_migrations().await?;
    tracing::info!(backend = ?db.backend(), "database ready, migrations applied");

    let state = AppState {
        db,
        token: token.map(Arc::from),
    };

    // `/api/*` sits behind the auth stub; public routes (health, swagger) do not.
    let api = Router::new()
        .route("/version", get(version))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth_stub));

    let app = Router::new()
        .route("/health", get(health))
        .nest("/api", api)
        .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi()))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("ofit-api listening on http://{bind} (swagger: /swagger-ui)");
    axum::serve(listener, app).await?;
    Ok(())
}

/// Liveness + backend probe.
#[utoipa::path(get, path = "/health", responses((status = 200, body = Health)))]
async fn health(State(state): State<AppState>) -> Json<Health> {
    Json(Health {
        status: "ok",
        db: format!("{:?}", state.db.backend()),
    })
}

/// Server name + semver.
#[utoipa::path(get, path = "/api/version", responses((status = 200, body = Version)))]
async fn version() -> Json<Version> {
    Json(Version {
        name: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
    })
}

/// Single-user auth STUB. When `OFIT_TOKEN` is set, require
/// `Authorization: Bearer <token>` on `/api/*`. TODO(phase: auth): real
/// credential store, sessions, and per-user scoping.
async fn auth_stub(
    State(state): State<AppState>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let Some(expected) = state.token.as_deref() else {
        return next.run(req).await; // auth disabled
    };
    let presented = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    match presented {
        Some(t) if t == expected => next.run(req).await,
        _ => (StatusCode::UNAUTHORIZED, "missing or invalid bearer token").into_response(),
    }
}
