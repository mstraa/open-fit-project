//! # ofit-db
//!
//! sqlx persistence layer that targets **both SQLite and Postgres** from day one
//! (hard rule, AGENTS.md). We use sqlx's `Any` driver so a single code path and
//! a single set of portable SQL migrations serve both engines: the concrete
//! backend is chosen at runtime purely from `DATABASE_URL`
//! (`sqlite://…` vs `postgres://…`).
//!
//! ## Portability approach
//! * One [`AnyPool`] wraps either backend; `install_default_drivers()` registers
//!   the SQLite + Postgres `Any` drivers at startup.
//! * Migrations under `/migrations` use only TEXT / INTEGER / REAL (see the
//!   header comment in `0001_init.sql`). Timestamps are stored as RFC3339 TEXT,
//!   UUIDs as canonical hyphenated TEXT, booleans as INTEGER — all of which bind
//!   and compare identically on both engines through the `Any` driver.
//! * Application code never uses dialect-specific SQL; if it ever must, it
//!   branches on [`Db::backend`].
//!
//! Phase 0 keeps the surface tiny: [`Db::connect`], [`Db::run_migrations`], and a
//! few insert/get helpers to prove the round trip on both backends.

use std::path::Path;

use ofit_core::{RawRecording, Source, WellnessSample};
use sqlx::any::{AnyPoolOptions, AnyRow};
use sqlx::{AnyPool, Row};

mod error;
pub use error::{DbError, Result};

/// Embedded, portable migrations (run on SQLite and Postgres alike).
static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

/// Which concrete backend a [`Db`] is talking to. Lets app code branch in the
/// rare case portable SQL is not enough (Phase 0 never needs to).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// SQLite (palier "simple": single binary + file DB).
    Sqlite,
    /// Postgres / Timescale (palier "full").
    Postgres,
    /// Some other `Any`-supported backend.
    Other,
}

/// A connection pool over either SQLite or Postgres.
#[derive(Clone)]
pub struct Db {
    pool: AnyPool,
    backend: Backend,
}

impl Db {
    /// Connect from a `DATABASE_URL`. Registers the `Any` drivers, ensures the
    /// SQLite parent directory exists (so `sqlite://./data/ofit.db?mode=rwc`
    /// works on first run), and opens a pool.
    pub async fn connect(database_url: &str) -> Result<Self> {
        // Idempotent: safe to call more than once.
        sqlx::any::install_default_drivers();

        let backend = backend_of(database_url);
        if backend == Backend::Sqlite {
            ensure_sqlite_parent_dir(database_url)?;
        }

        let pool = AnyPoolOptions::new()
            .max_connections(5)
            .connect(database_url)
            .await?;

        Ok(Self { pool, backend })
    }

    /// The concrete backend in use.
    pub fn backend(&self) -> Backend {
        self.backend
    }

    /// Borrow the underlying pool (for other ofit crates to run queries).
    pub fn pool(&self) -> &AnyPool {
        &self.pool
    }

    /// Run embedded migrations. Portable SQL → same result on both engines.
    pub async fn run_migrations(&self) -> Result<()> {
        MIGRATOR.run(&self.pool).await?;
        Ok(())
    }

    // ---- minimal insert/get helpers (prove the round trip) ----

    /// Insert a [`Source`].
    pub async fn insert_source(&self, s: &Source) -> Result<()> {
        sqlx::query(
            "INSERT INTO sources (id, kind, name, manufacturer, default_priority, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(s.id.to_string())
        .bind(serde_plain(&s.kind))
        .bind(&s.name)
        .bind(s.manufacturer.clone())
        .bind(s.default_priority as i64)
        .bind(s.created_at.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Fetch a source's name by id, if present.
    pub async fn get_source_name(&self, id: uuid::Uuid) -> Result<Option<String>> {
        let row: Option<AnyRow> = sqlx::query("SELECT name FROM sources WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.get::<String, _>("name")))
    }

    /// Insert a [`RawRecording`]. Relies on the unique hash index for exact
    /// dedup; callers can treat a unique-violation as "already ingested".
    pub async fn insert_recording(&self, r: &RawRecording) -> Result<()> {
        sqlx::query(
            "INSERT INTO raw_recordings \
             (id, source_id, content_hash, sport, started_at, ended_at, metadata, ingested_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(r.id.to_string())
        .bind(r.source_id.to_string())
        .bind(r.content_hash.as_str())
        .bind(serde_plain(&r.sport))
        .bind(r.started_at.to_rfc3339())
        .bind(r.ended_at.to_rfc3339())
        .bind(r.metadata.to_string())
        .bind(r.ingested_at.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Insert a continuous [`WellnessSample`] (the high-rate streaming path).
    /// In a real stream this would be batched; kept single-row here for clarity.
    pub async fn insert_wellness_sample(&self, w: &WellnessSample) -> Result<()> {
        sqlx::query(
            "INSERT INTO wellness_samples (id, source_id, kind, value, ts) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(w.id.to_string())
        .bind(w.source_id.to_string())
        .bind(serde_plain(&w.kind))
        .bind(w.value)
        .bind(w.ts.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Count wellness samples (smoke-test helper / trend cardinality).
    pub async fn count_wellness_samples(&self) -> Result<i64> {
        let row: AnyRow = sqlx::query("SELECT COUNT(*) AS n FROM wellness_samples")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get::<i64, _>("n"))
    }
}

/// Serialize a small serde enum to its `snake_case` tag (our enums serialize to
/// plain strings), for storage in a TEXT column.
fn serde_plain<T: serde::Serialize>(v: &T) -> String {
    // Our domain enums are unit-variant + snake_case, so JSON is `"tag"`.
    serde_json::to_value(v)
        .ok()
        .and_then(|j| j.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn backend_of(url: &str) -> Backend {
    let u = url.trim_start();
    if u.starts_with("sqlite:") {
        Backend::Sqlite
    } else if u.starts_with("postgres:") || u.starts_with("postgresql:") {
        Backend::Postgres
    } else {
        Backend::Other
    }
}

/// For `sqlite://<path>?...` ensure the parent directory exists so first-run
/// `mode=rwc` can create the file.
fn ensure_sqlite_parent_dir(url: &str) -> Result<()> {
    // Strip scheme and any query string to recover the filesystem path.
    let after_scheme = url
        .strip_prefix("sqlite://")
        .or_else(|| url.strip_prefix("sqlite:"))
        .unwrap_or(url);
    let path_part = after_scheme.split('?').next().unwrap_or("");
    if path_part.is_empty() || path_part == ":memory:" {
        return Ok(());
    }
    if let Some(parent) = Path::new(path_part).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| DbError::Config(format!("create sqlite dir {parent:?}: {e}")))?;
        }
    }
    Ok(())
}
