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

mod analytics;
mod auth;
mod dto;
mod handlers;
mod static_assets;
mod worker;

/// Shared application state handed to every handler.
#[derive(Clone)]
pub(crate) struct AppState {
    pub db: Db,
    /// Bearer token required on `/api/*` when set. `None` = auth disabled
    /// (first-run / local dev). Real multi-credential auth is a later phase.
    pub token: Option<Arc<str>>,
    /// Live wellness fan-out: ingest publishes, `/api/wellness/live` subscribes.
    pub wellness_tx: tokio::sync::broadcast::Sender<dto::LiveWellness>,
    /// Wakes the background analytics worker after a raw write (debounced).
    pub recompute_notify: std::sync::Arc<tokio::sync::Notify>,
    /// Worker progress fan-out: `/api/analytics/status` subscribes.
    pub analytics_status_tx: tokio::sync::broadcast::Sender<worker::AnalyticsStatus>,
    /// Directory scanned for sandboxed WASM algorithm plugins (Phase 3). `None`
    /// or a missing dir ⇒ built-ins only. Set via `OFIT_PLUGINS_DIR`.
    pub plugins_dir: Option<Arc<std::path::Path>>,
    /// Status of the (single) background one-time Garmin import job, polled by the
    /// UI via `/api/import/garmin/status`. The import runs minutes, so it can't be
    /// a synchronous request.
    pub garmin_import: std::sync::Arc<std::sync::Mutex<handlers::GarminJobState>>,
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
        handlers::import_zepp,
        handlers::dedup_zepp_summaries,
        handlers::remap_zepp_sports,
        handlers::list_sources,
        handlers::list_activities,
        handlers::get_activity,
        handlers::delete_activity,
        handlers::remove_recording,
        handlers::delete_source,
        handlers::export_activity_fit,
        handlers::list_preferences,
        handlers::set_preference,
        handlers::wellness,
        handlers::ingest_wellness,
        analytics::list_algorithms,
        analytics::recompute,
        analytics::derived,
        analytics::training_load,
    ),
    components(schemas(
        Health,
        Version,
        dto::ImportResponse,
        dto::ImportFileResult,
        dto::ZeppImportResponse,
        dto::DedupResponse,
        dto::RemapResponse,
        dto::ActivitySummaryStats,
        dto::WellnessKindCount,
        dto::SourceDto,
        dto::ActivitySummary,
        dto::ActivityDetail,
        dto::RecordingDto,
        dto::RemoveRecordingResponse,
        dto::DeleteSourceResponse,
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
        analytics::AlgorithmDto,
        analytics::RecomputeResponse,
        analytics::RecomputeAlgorithmResult,
        analytics::DerivedResponse,
        analytics::DerivedMetricDto,
        analytics::DerivedStreamDto,
        analytics::DerivedPoint,
        analytics::TrainingLoadResponse,
        analytics::TrainingLoadPoint,
        ofit_core::analytics::AlgorithmKind,
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
    // Optional browser-CORS allowlist (comma-separated origins). Unset keeps
    // the historical reflect-any-origin behavior (safe today only because the
    // session cookie is SameSite=Lax); set it to pin explicit origins, e.g.
    // OFIT_CORS_ORIGINS="http://localhost:5173,https://fit.example.org".
    let cors_origins: Option<Vec<axum::http::HeaderValue>> = std::env::var("OFIT_CORS_ORIGINS")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|s| s.split(',').filter_map(|o| o.trim().parse().ok()).collect());
    // Optional sandboxed-plugins directory (Phase 3). Absent ⇒ built-ins only.
    let plugins_dir: Option<Arc<std::path::Path>> = std::env::var("OFIT_PLUGINS_DIR")
        .ok()
        .filter(|p| !p.is_empty())
        .map(|p| Arc::from(std::path::PathBuf::from(p).as_path()));
    if let Some(dir) = &plugins_dir {
        tracing::info!(dir = %dir.display(), "WASM plugins dir configured");
    }

    // ---- connect db + migrate on startup ----
    tracing::info!("connecting to database…");
    let db = Db::connect(&database_url).await?;
    db.run_migrations().await?;
    db.apply_timescale().await?; // no-op unless Postgres + TimescaleDB
    tracing::info!(backend = ?db.backend(), "database ready, migrations applied");

    // Live wellness fan-out channel (lagging slow subscribers are dropped).
    let (wellness_tx, _) = tokio::sync::broadcast::channel(512);
    // Background analytics worker: wake signal + progress fan-out.
    let recompute_notify = Arc::new(tokio::sync::Notify::new());
    let (analytics_status_tx, _) = tokio::sync::broadcast::channel(64);

    let state = AppState {
        db,
        token: token.map(Arc::from),
        wellness_tx,
        recompute_notify,
        analytics_status_tx,
        plugins_dir,
        garmin_import: std::sync::Arc::new(std::sync::Mutex::new(handlers::GarminJobState::default())),
    };

    // Spawn the incremental-recompute worker (drains the dirty queue on startup).
    worker::spawn(state.clone());

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
        .route(
            "/import/zepp",
            post(handlers::import_zepp).layer(DefaultBodyLimit::max(512 * 1024 * 1024)),
        )
        // One-time Garmin history backfill (runs in the background — poll status).
        // Either point at the export already on disk (JSON {path})…
        .route("/import/garmin", post(handlers::import_garmin))
        // …or upload the export .zip (raise the body limit for the ~195 MB file)…
        .route(
            "/import/garmin/upload",
            post(handlers::import_garmin_upload).layer(DefaultBodyLimit::max(1024 * 1024 * 1024)),
        )
        // …and poll progress + the final summary here.
        .route("/import/garmin/status", get(handlers::garmin_import_status))
        .route("/maintenance/dedup-zepp-summaries", post(handlers::dedup_zepp_summaries))
        .route("/maintenance/remap-zepp-sports", post(handlers::remap_zepp_sports))
        .route("/maintenance/clamp-hr", post(handlers::clamp_hr))
        .route("/sources", get(handlers::list_sources))
        .route("/activities", get(handlers::list_activities))
        .route(
            "/activities/:id",
            get(handlers::get_activity).delete(handlers::delete_activity),
        )
        .route(
            "/activities/:id/recordings/:recording_id",
            axum::routing::delete(handlers::remove_recording),
        )
        // Hard per-source delete (Edit tab) + FIT export.
        .route(
            "/activities/:id/sources/:recording_id",
            axum::routing::delete(handlers::delete_source),
        )
        .route(
            "/activities/:id/export.fit",
            get(handlers::export_activity_fit),
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
        .route("/analytics/status", get(worker::status_ws))
        .route("/algorithms", get(analytics::list_algorithms))
        .route("/analytics/recompute", post(analytics::recompute))
        .route("/analytics/derived", get(analytics::derived))
        .route("/analytics/training-load", get(analytics::training_load))
        .route(
            "/analytics/parameters",
            get(analytics::list_parameters).put(analytics::set_parameters),
        )
        .route("/analytics/variants", get(analytics::list_variants))
        .route("/analytics/selection", axum::routing::put(analytics::set_selection))
        .route("/settings", get(handlers::get_settings).put(handlers::set_setting))
        .route("/personal-records", get(handlers::personal_records))
        .route("/gear", get(handlers::get_gear).post(handlers::create_gear))
        .route("/gear/defaults", axum::routing::put(handlers::set_gear_default))
        .route(
            "/gear/:id",
            axum::routing::put(handlers::update_gear).delete(handlers::delete_gear),
        )
        .route(
            "/activities/:id/gear",
            axum::routing::put(handlers::set_activity_gear),
        );

    // MCP (Phase 8): tools self-dispatch in-process into this pre-auth clone —
    // same handlers, same state, zero duplication. Auth for MCP traffic is
    // enforced once at the /mcp ingress below, so the clone deliberately
    // skips the per-route gate. STRICT auth: unlike /api, /mcp never falls
    // open on a fresh install (it carries the SQL escape hatch).
    let mcp_dispatch = protected_api.clone().with_state(state.clone());
    let mcp = Router::new()
        .nest_service(
            "/mcp",
            ofit_mcp::streamable_service(mcp_dispatch, state.db.clone()),
        )
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::require_auth_strict));

    let protected_api = protected_api
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::require_auth));

    let api = public_api.merge(protected_api);

    let app = Router::new()
        .route("/health", get(health))
        .nest("/api", api)
        .merge(mcp)
        .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi()))
        // Anything not matched above is the embedded web SPA (web/dist): serve
        // the static file if present, else index.html so client-side routes
        // resolve on reload. API/doc namespaces are 404-guarded in the handler.
        .fallback(static_assets::handler)
        .layer(TraceLayer::new_for_http())
        // Session cookies are credentialed, so we reflect the request origin
        // (a wildcard `*` is invalid with credentials). Same-origin prod needs
        // no CORS; this is for the dev split (vite :5173 → api :8087).
        .layer(
            CorsLayer::new()
                .allow_origin(match cors_origins {
                    Some(origins) => AllowOrigin::list(origins),
                    None => AllowOrigin::mirror_request(),
                })
                .allow_credentials(true)
                .allow_methods([
                    Method::GET,
                    Method::POST,
                    Method::PUT,
                    Method::DELETE,
                    Method::OPTIONS,
                ])
                // MCP streamable-HTTP headers, so browser-based MCP clients
                // can negotiate sessions through the global CORS layer too
                // (server-to-server clients ignore CORS entirely).
                .allow_headers([
                    header::CONTENT_TYPE,
                    header::AUTHORIZATION,
                    axum::http::HeaderName::from_static("mcp-session-id"),
                    axum::http::HeaderName::from_static("mcp-protocol-version"),
                    axum::http::HeaderName::from_static("last-event-id"),
                ])
                .expose_headers([axum::http::HeaderName::from_static("mcp-session-id")]),
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

