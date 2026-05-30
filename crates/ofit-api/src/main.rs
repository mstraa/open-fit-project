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
    extract::{DefaultBodyLimit, State},
    http::{header, Method},
    middleware,
    routing::{get, post},
    Json, Router,
};
use ofit_db::Db;
use serde::Serialize;
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    trace::TraceLayer,
};
use utoipa::{OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;

mod auth;
mod dto;
mod handlers;

/// Shared application state handed to every handler.
#[derive(Clone)]
pub(crate) struct AppState {
    pub db: Db,
    /// Bearer token required on `/api/*` when set. `None` = auth disabled
    /// (first-run / local dev). Real multi-credential auth is a later phase.
    pub token: Option<Arc<str>>,
    /// Live wellness fan-out: ingest publishes, `/api/wellness/live` subscribes.
    pub wellness_tx: tokio::sync::broadcast::Sender<dto::LiveWellness>,
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
    paths(
        health,
        version,
        auth::status,
        auth::setup,
        auth::login,
        auth::logout,
        auth::me,
        handlers::import,
        handlers::list_sources,
        handlers::list_activities,
        handlers::get_activity,
        handlers::remove_recording,
        handlers::list_preferences,
        handlers::set_preference,
        handlers::wellness,
        handlers::ingest_wellness,
    ),
    components(schemas(
        Health,
        Version,
        dto::ImportResponse,
        dto::ImportFileResult,
        dto::SourceDto,
        dto::ActivitySummary,
        dto::ActivityDetail,
        dto::RecordingDto,
        dto::RemoveRecordingResponse,
        dto::ResolvedScalarMetric,
        dto::ScalarPoint,
        dto::TrackPoint,
        dto::PreferenceDto,
        dto::PreferenceScopeDto,
        dto::SetPreferenceRequest,
        dto::WellnessResponse,
        dto::WellnessPoint,
        dto::WellnessIngest,
        dto::WellnessIngestResponse,
        dto::LiveWellness,
        auth::SetupStatus,
        auth::Credentials,
        auth::Me,
        ofit_core::SourceKind,
        ofit_core::Sport,
        ofit_core::StreamKind,
        ofit_core::WellnessKind,
        ofit_core::SelectionReason,
    )),
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
    let bind = std::env::var("OFIT_BIND").unwrap_or_else(|_| "0.0.0.0:8087".to_string());

    // ---- connect db + migrate on startup ----
    tracing::info!("connecting to database…");
    let db = Db::connect(&database_url).await?;
    db.run_migrations().await?;
    db.apply_timescale().await?; // no-op unless Postgres + TimescaleDB
    tracing::info!(backend = ?db.backend(), "database ready, migrations applied");

    // Live wellness fan-out channel (lagging slow subscribers are dropped).
    let (wellness_tx, _) = tokio::sync::broadcast::channel(512);

    let state = AppState {
        db,
        token: token.map(Arc::from),
        wellness_tx,
    };

    // Auth routes are always reachable (login/setup/status); the rest sit behind
    // `require_auth`.
    let public_api = Router::new()
        .route("/auth/status", get(auth::status))
        .route("/auth/setup", post(auth::setup))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me));

    let protected_api = Router::new()
        .route("/version", get(version))
        // Initial-backfill uploads can be many MB (multi-format FIT/GPX/TCX).
        // Raise the body limit well above axum's 2 MB default for this route.
        .route(
            "/import",
            post(handlers::import).layer(DefaultBodyLimit::max(512 * 1024 * 1024)),
        )
        .route("/sources", get(handlers::list_sources))
        .route("/activities", get(handlers::list_activities))
        .route("/activities/:id", get(handlers::get_activity))
        .route(
            "/activities/:id/recordings/:recording_id",
            axum::routing::delete(handlers::remove_recording),
        )
        .route(
            "/preferences",
            get(handlers::list_preferences).put(handlers::set_preference),
        )
        .route(
            "/wellness",
            get(handlers::wellness).post(handlers::ingest_wellness),
        )
        .route("/wellness/live", get(handlers::wellness_live))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::require_auth));

    let api = public_api.merge(protected_api);

    let app = Router::new()
        .route("/health", get(health))
        .nest("/api", api)
        .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi()))
        .layer(TraceLayer::new_for_http())
        // Session cookies are credentialed, so we reflect the request origin
        // (a wildcard `*` is invalid with credentials). Same-origin prod needs
        // no CORS; this is for the dev split (vite :5173 → api :8087).
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::mirror_request())
                .allow_credentials(true)
                .allow_methods([
                    Method::GET,
                    Method::POST,
                    Method::PUT,
                    Method::DELETE,
                    Method::OPTIONS,
                ])
                .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]),
        )
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

