//! Single-user auth: a first-run setup wizard, password login, and server-side
//! sessions (an opaque random token in an http-only cookie → `sessions` table).
//!
//! Enforcement (see [`require_auth`]): protected `/api/*` routes require a valid
//! session cookie — or, for automation, the `OFIT_TOKEN` bearer when configured.
//! Before any account exists (fresh install) the API stays open so the existing
//! data is reachable and the wizard can run; once you create an account it locks.

use std::time::Duration;

use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::{
    extract::State,
    http::{header, HeaderMap, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::AppState;

const COOKIE: &str = "ofit_session";
const SESSION_DAYS: i64 = 30;

/* ----------------------------------------------------------------- DTOs */

#[derive(Serialize, ToSchema)]
pub struct SetupStatus {
    /// True when no account exists yet → the setup wizard should run.
    pub needs_setup: bool,
}

#[derive(Deserialize, ToSchema)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

#[derive(Serialize, ToSchema)]
pub struct Me {
    pub username: String,
}

/* -------------------------------------------------------------- helpers */

fn hash_password(password: &str) -> Result<String, (StatusCode, String)> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("hash error: {e}")))
}

fn verify_password(password: &str, phc: &str) -> bool {
    PasswordHash::new(phc)
        .map(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
        .unwrap_or(false)
}

fn new_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn session_cookie(token: &str) -> String {
    let max_age = Duration::from_secs(SESSION_DAYS as u64 * 86_400).as_secs();
    // No `Secure` so it works on local http; add it behind TLS via a proxy.
    format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}")
}

fn clear_cookie() -> String {
    format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
}

fn cookie_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';')
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == COOKIE)
        .map(|(_, v)| v.to_string())
}

async fn issue_session(state: &AppState, user_id: uuid::Uuid) -> Result<String, (StatusCode, String)> {
    let token = new_token();
    let expires = Utc::now() + chrono::Duration::days(SESSION_DAYS);
    state
        .db
        .create_session(&token, user_id, expires)
        .await
        .map_err(internal)?;
    Ok(token)
}

fn internal<E: std::fmt::Display>(e: E) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, format!("database error: {e}"))
}

/* ------------------------------------------------------------- handlers */

/// `GET /api/auth/status` — whether the first-run wizard should run.
#[utoipa::path(get, path = "/api/auth/status", responses((status = 200, body = SetupStatus)))]
pub async fn status(State(state): State<AppState>) -> Result<Json<SetupStatus>, (StatusCode, String)> {
    let count = state.db.user_count().await.map_err(internal)?;
    Ok(Json(SetupStatus { needs_setup: count == 0 }))
}

/// `POST /api/auth/setup` — create the first account (only when none exists),
/// then log in. 409 if an account already exists.
#[utoipa::path(post, path = "/api/auth/setup", request_body = Credentials,
    responses((status = 200, body = Me), (status = 409, description = "already set up")))]
pub async fn setup(
    State(state): State<AppState>,
    Json(body): Json<Credentials>,
) -> Result<Response, (StatusCode, String)> {
    if body.username.trim().is_empty() || body.password.len() < 8 {
        return Err((StatusCode::BAD_REQUEST, "username required, password ≥ 8 chars".into()));
    }
    if state.db.user_count().await.map_err(internal)? > 0 {
        return Err((StatusCode::CONFLICT, "already set up".into()));
    }
    let id = uuid::Uuid::new_v4();
    let hash = hash_password(&body.password)?;
    state.db.create_user(id, body.username.trim(), &hash).await.map_err(internal)?;
    let token = issue_session(&state, id).await?;
    Ok((
        [(header::SET_COOKIE, session_cookie(&token))],
        Json(Me { username: body.username.trim().to_string() }),
    )
        .into_response())
}

/// `POST /api/auth/login` — verify credentials, start a session.
#[utoipa::path(post, path = "/api/auth/login", request_body = Credentials,
    responses((status = 200, body = Me), (status = 401, description = "invalid credentials")))]
pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<Credentials>,
) -> Result<Response, (StatusCode, String)> {
    let unauthorized = (StatusCode::UNAUTHORIZED, "invalid credentials".to_string());
    let Some((id, phc)) = state.db.user_by_username(body.username.trim()).await.map_err(internal)? else {
        return Err(unauthorized);
    };
    if !verify_password(&body.password, &phc) {
        return Err(unauthorized);
    }
    let token = issue_session(&state, id).await?;
    Ok((
        [(header::SET_COOKIE, session_cookie(&token))],
        Json(Me { username: body.username.trim().to_string() }),
    )
        .into_response())
}

/// `POST /api/auth/logout` — end the current session.
#[utoipa::path(post, path = "/api/auth/logout", responses((status = 200)))]
pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(token) = cookie_token(&headers) {
        let _ = state.db.delete_session(&token).await;
    }
    ([(header::SET_COOKIE, clear_cookie())], StatusCode::OK).into_response()
}

/// `GET /api/auth/me` — the current account, or 401.
#[utoipa::path(get, path = "/api/auth/me", responses((status = 200, body = Me), (status = 401)))]
pub async fn me(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Me>, StatusCode> {
    let token = cookie_token(&headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let user_id = state
        .db
        .session_user(&token)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let username = state
        .db
        .username_of(user_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;
    Ok(Json(Me { username }))
}

/* ------------------------------------------------------------ middleware */

/// Gate protected `/api/*` routes. Order: valid session cookie → `OFIT_TOKEN`
/// bearer (automation) → first-run open (no account yet) → 401.
pub async fn require_auth(
    State(state): State<AppState>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    // 1) Session cookie.
    if let Some(token) = cookie_token(req.headers()) {
        if matches!(state.db.session_user(&token).await, Ok(Some(_))) {
            return next.run(req).await;
        }
    }
    // 2) Service token (optional, for curl/automation).
    if let Some(expected) = state.token.as_deref() {
        let presented = req
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "));
        if presented == Some(expected) {
            return next.run(req).await;
        }
    }
    // 3) Fresh install with no account yet → stay open so data + wizard work.
    if matches!(state.db.user_count().await, Ok(0)) {
        return next.run(req).await;
    }
    (StatusCode::UNAUTHORIZED, "authentication required").into_response()
}
