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

use chrono::{DateTime, Utc};
use ofit_core::{
    Activity, MetricSourcePreference, PreferenceScope, RawRecording, Sample, Source, SourceKind,
    Sport, Stream, StreamKind, WellnessKind, WellnessSample,
};
use sqlx::any::{AnyPoolOptions, AnyRow};
use sqlx::{AnyPool, Row};
use uuid::Uuid;

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

        let mut opts = AnyPoolOptions::new().max_connections(5);

        // SQLite: enable WAL so readers (dashboard/wellness queries) don't block
        // on writes, and a busy-timeout so contended ops wait instead of erroring
        // with SQLITE_BUSY ("database is locked").
        //
        // These MUST be set on EVERY pooled connection, not once on the pool:
        // journal_mode is persistent per database *file*, but busy_timeout and
        // synchronous are per-*connection*. Running them once via `execute(&pool)`
        // only configured whichever single connection answered that query, leaving
        // the other (max_connections-1) at busy_timeout=0 — so under concurrent
        // load (e.g. a ~770k-row Zepp/Garmin import racing the dashboard's wellness
        // queries) those connections errored instantly instead of waiting. The
        // 15 s timeout comfortably outlasts a chunked import's short write txns.
        // (Postgres pools skip this — the pragmas are SQLite-only.)
        if backend == Backend::Sqlite {
            opts = opts.after_connect(|conn, _meta| {
                Box::pin(async move {
                    for pragma in [
                        "PRAGMA journal_mode=WAL",
                        "PRAGMA busy_timeout=15000",
                        "PRAGMA synchronous=NORMAL",
                    ] {
                        sqlx::query(pragma).execute(&mut *conn).await?;
                    }
                    Ok(())
                })
            });
        }

        let pool = opts.connect(database_url).await?;

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

    /// Make a query's `?` placeholders portable: sqlx's `Any` driver does NOT
    /// translate them, and Postgres requires `$1, $2, …`. SQLite keeps `?`.
    /// Our SQL never contains a literal `?`, so a positional rewrite is safe.
    fn p(&self, sql: &str) -> String {
        if self.backend != Backend::Postgres {
            return sql.to_string();
        }
        let mut out = String::with_capacity(sql.len() + 8);
        let mut n = 0u32;
        for ch in sql.chars() {
            if ch == '?' {
                n += 1;
                out.push('$');
                out.push_str(&n.to_string());
            } else {
                out.push(ch);
            }
        }
        out
    }

    /// Run embedded migrations. Portable SQL → same result on both engines.
    pub async fn run_migrations(&self) -> Result<()> {
        MIGRATOR.run(&self.pool).await?;
        Ok(())
    }

    /// On Postgres, prepare for TimescaleDB. **Non-destructive and non-fatal.**
    /// * SQLite → no-op.
    /// * plain Postgres → no-op.
    /// * Postgres + TimescaleDB → enable the extension.
    ///
    /// The `wellness_samples` **hypertable is deliberately deferred to the
    /// wellness-streaming phase (Phase 4).** Reason (verified against
    /// timescale/timescaledb pg16): our portable schema stores `ts` as RFC3339
    /// **TEXT** (so the same SQL serves SQLite and Postgres), but a hypertable
    /// must partition on a **native** timestamp column — and TimescaleDB will
    /// **not** accept a `BEFORE INSERT` trigger to populate that partition column
    /// (the partition value must come from the INSERT itself; a trigger leaves it
    /// NULL → "Columns used for time partitioning cannot be NULL"). A GENERATED
    /// column is also rejected (the text→timestamptz cast isn't immutable).
    /// So the hypertable lands when the wellness write-path is built and can
    /// provide a native `ts` (a Postgres-specific column type for that table),
    /// rather than mutating the portable schema into a state where inserts break.
    pub async fn apply_timescale(&self) -> Result<()> {
        if self.backend != Backend::Postgres {
            return Ok(());
        }
        let available = sqlx::query("SELECT 1 AS x FROM pg_available_extensions WHERE name = 'timescaledb'")
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten()
            .is_some();
        if !available {
            tracing::info!("timescaledb not available; wellness_samples stays a plain table");
            return Ok(());
        }
        if let Err(e) = sqlx::query("CREATE EXTENSION IF NOT EXISTS timescaledb")
            .execute(&self.pool)
            .await
        {
            tracing::warn!(error = %e, "could not enable timescaledb extension");
        }
        tracing::info!(
            "timescaledb available; wellness hypertable deferred to the wellness-streaming phase (needs native ts)"
        );
        Ok(())
    }

    // ---- auth: users & sessions (single-user, multi-user-ready) ----

    /// Number of accounts. 0 ⇒ first-run (the setup wizard applies).
    pub async fn user_count(&self) -> Result<i64> {
        let row: AnyRow = sqlx::query(&self.p("SELECT COUNT(*) AS n FROM users"))
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get::<i64, _>("n"))
    }

    /// Create an account with an already-hashed (argon2 PHC) password.
    pub async fn create_user(&self, id: Uuid, username: &str, password_hash: &str) -> Result<()> {
        sqlx::query(&self.p(
            "INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
        ))
        .bind(id.to_string())
        .bind(username)
        .bind(password_hash)
        .bind(Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Look up `(user_id, password_hash)` by username for login verification.
    pub async fn user_by_username(&self, username: &str) -> Result<Option<(Uuid, String)>> {
        let row: Option<AnyRow> =
            sqlx::query(&self.p("SELECT id, password_hash FROM users WHERE username = ?"))
                .bind(username)
                .fetch_optional(&self.pool)
                .await?;
        match row {
            Some(r) => Ok(Some((
                parse_uuid(&r.get::<String, _>("id"))?,
                r.get::<String, _>("password_hash"),
            ))),
            None => Ok(None),
        }
    }

    /// The username for a user id (for `GET /api/me`).
    pub async fn username_of(&self, id: Uuid) -> Result<Option<String>> {
        let row: Option<AnyRow> =
            sqlx::query(&self.p("SELECT username FROM users WHERE id = ?"))
                .bind(id.to_string())
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|r| r.get::<String, _>("username")))
    }

    /// Persist a session token for `user_id`, expiring at `expires_at`.
    pub async fn create_session(
        &self,
        token: &str,
        user_id: Uuid,
        expires_at: DateTime<Utc>,
    ) -> Result<()> {
        sqlx::query(&self.p(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        ))
        .bind(token)
        .bind(user_id.to_string())
        .bind(Utc::now().to_rfc3339())
        .bind(expires_at.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Resolve a session token to its user id if present and unexpired.
    pub async fn session_user(&self, token: &str) -> Result<Option<Uuid>> {
        let row: Option<AnyRow> = sqlx::query(&self.p(
            "SELECT user_id FROM sessions WHERE token = ? AND expires_at >= ?",
        ))
        .bind(token)
        .bind(Utc::now().to_rfc3339())
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(r) => Ok(Some(parse_uuid(&r.get::<String, _>("user_id"))?)),
            None => Ok(None),
        }
    }

    /// Delete a session (logout).
    pub async fn delete_session(&self, token: &str) -> Result<()> {
        sqlx::query(&self.p("DELETE FROM sessions WHERE token = ?"))
            .bind(token)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ---- minimal insert/get helpers (prove the round trip) ----

    /// Insert a [`Source`].
    pub async fn insert_source(&self, s: &Source) -> Result<()> {
        sqlx::query(&self.p("INSERT INTO sources (id, kind, name, manufacturer, default_priority, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)"))
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
        let row: Option<AnyRow> = sqlx::query(&self.p("SELECT name FROM sources WHERE id = ?"))
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.get::<String, _>("name")))
    }

    /// Insert a [`RawRecording`]. Relies on the unique hash index for exact
    /// dedup; callers can treat a unique-violation as "already ingested".
    pub async fn insert_recording(&self, r: &RawRecording) -> Result<()> {
        sqlx::query(&self.p("INSERT INTO raw_recordings \
             (id, source_id, content_hash, sport, started_at, ended_at, metadata, ingested_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)"))
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
        sqlx::query(&self.p("INSERT INTO wellness_samples (id, source_id, kind, value, ts) \
             VALUES (?, ?, ?, ?, ?) \
             ON CONFLICT (source_id, kind, ts) DO UPDATE SET value = excluded.value"))
        .bind(w.id.to_string())
        .bind(w.source_id.to_string())
        .bind(serde_plain(&w.kind))
        .bind(w.value)
        .bind(w.ts.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Batch-insert wellness samples (the streaming/relay write path). One
    /// transaction so a burst of HR samples commits together.
    /// Insert RAW wellness samples (device/import ingest) and mark each touched
    /// UTC day dirty IN THE SAME TRANSACTION — so the background analytics worker
    /// recomputes only those days, and a crash can't leave data un-recomputed
    /// (data + dirty-mark commit together).
    pub async fn insert_wellness_samples(&self, samples: &[WellnessSample]) -> Result<()> {
        self.write_wellness(samples, true, true).await
    }

    /// Insert COMPUTED wellness (the recompute's own gap-fill: body battery,
    /// derived resting HR, HR-estimated sleep). Same write as
    /// [`Self::insert_wellness_samples`] but does **NOT** mark days dirty — these
    /// are algorithm OUTPUTS, not raw ingest, so they must never re-trigger the
    /// worker (which would loop) — and skips the max-HR filter (outputs are valid).
    pub async fn insert_computed_wellness(&self, samples: &[WellnessSample]) -> Result<()> {
        self.write_wellness(samples, false, false).await
    }

    /// Insert RAW wellness for a **one-time backfill** (e.g. a 6-year Garmin
    /// export). Applies the max-HR filter like [`Self::insert_wellness_samples`]
    /// but does **NOT** mark days dirty: a backfill would otherwise mark thousands
    /// of days and thrash the incremental worker — the caller runs a single full
    /// recompute at the end instead.
    pub async fn insert_wellness_backfill(&self, samples: &[WellnessSample]) -> Result<()> {
        self.write_wellness(samples, false, true).await
    }

    /// Shared wellness writer. `mark_dirty` queues each touched UTC day for the
    /// incremental worker (in the SAME tx — crash-safe); `filter_hr` drops
    /// heart-rate artifacts above the "Max HR Allowed" setting (default 200).
    async fn write_wellness(
        &self,
        samples: &[WellnessSample],
        mark_dirty: bool,
        filter_hr: bool,
    ) -> Result<()> {
        if samples.is_empty() {
            return Ok(());
        }
        let max_hr: f64 = if filter_hr {
            self.get_setting("max_hr_allowed")
                .await?
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(200.0)
        } else {
            f64::INFINITY
        };
        // Write in bounded chunks, each its own transaction, so no single write
        // holds the SQLite write lock for long. Callers like the import handler
        // already chunk, but the recompute worker passes whole-history series in
        // one call (e.g. body-battery / gap-filled RHR over years) — a single
        // transaction over tens of thousands of rows would hold the lock past the
        // busy-timeout and make a concurrent writer (an import running while the
        // worker recomputes) fail with SQLITE_BUSY ("database is locked").
        // Per-chunk commits are safe: the sample upsert and the dirty-day mark are
        // both idempotent, so a crash mid-write just re-applies on the next run.
        const CHUNK: usize = 5_000;
        let now = Utc::now().to_rfc3339();
        for batch in samples.chunks(CHUNK) {
            let mut tx = self.pool.begin().await?;
            let mut days: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
            for w in batch {
                if filter_hr && w.kind == WellnessKind::HeartRate && w.value > max_hr {
                    continue; // drop the artifact (and don't dirty its day on its account)
                }
                sqlx::query(&self.p("INSERT INTO wellness_samples (id, source_id, kind, value, ts) \
                     VALUES (?, ?, ?, ?, ?) \
                     ON CONFLICT (source_id, kind, ts) DO UPDATE SET value = excluded.value"))
                    .bind(w.id.to_string())
                    .bind(w.source_id.to_string())
                    .bind(serde_plain(&w.kind))
                    .bind(w.value)
                    .bind(w.ts.to_rfc3339())
                    .execute(&mut *tx)
                    .await?;
                if mark_dirty {
                    days.insert(w.ts.date_naive().to_string());
                }
            }
            if mark_dirty {
                for day in &days {
                    sqlx::query(&self.p("INSERT INTO dirty_units (kind, unit_id, marked_at) \
                         VALUES ('day', ?, ?) \
                         ON CONFLICT (kind, unit_id) DO UPDATE SET marked_at = excluded.marked_at"))
                        .bind(day)
                        .bind(&now)
                        .execute(&mut *tx)
                        .await?;
                }
            }
            tx.commit().await?;
        }
        Ok(())
    }

    // ---- incremental-recompute dirty queue ----

    /// Mark an activity (and optionally its day) dirty for the worker.
    pub async fn mark_activity_dirty(
        &self,
        activity_id: Uuid,
        day: Option<chrono::NaiveDate>,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let n = now.to_rfc3339();
        sqlx::query(&self.p("INSERT INTO dirty_units (kind, unit_id, marked_at) \
             VALUES ('activity', ?, ?) \
             ON CONFLICT (kind, unit_id) DO UPDATE SET marked_at = excluded.marked_at"))
            .bind(activity_id.to_string())
            .bind(&n)
            .execute(&self.pool)
            .await?;
        if let Some(d) = day {
            sqlx::query(&self.p("INSERT INTO dirty_units (kind, unit_id, marked_at) \
                 VALUES ('day', ?, ?) \
                 ON CONFLICT (kind, unit_id) DO UPDATE SET marked_at = excluded.marked_at"))
                .bind(d.to_string())
                .bind(&n)
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }

    /// All dirty units, oldest mark first: `(kind, unit_id)`.
    pub async fn list_dirty(&self) -> Result<Vec<(String, String)>> {
        let rows = sqlx::query("SELECT kind, unit_id FROM dirty_units ORDER BY marked_at")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| (r.get::<String, _>("kind"), r.get::<String, _>("unit_id")))
            .collect())
    }

    /// Clear one dirty unit (call in the SAME tx/step that persisted its outputs).
    pub async fn clear_dirty(&self, kind: &str, unit_id: &str) -> Result<()> {
        sqlx::query(&self.p("DELETE FROM dirty_units WHERE kind = ? AND unit_id = ?"))
            .bind(kind)
            .bind(unit_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// How many units are queued (for the status indicator).
    pub async fn count_dirty(&self) -> Result<i64> {
        let row: AnyRow = sqlx::query(&self.p("SELECT COUNT(*) AS n FROM dirty_units"))
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get::<i64, _>("n"))
    }

    /// Clear the ENTIRE dirty queue. Used after a one-time backfill that runs a
    /// single full recompute at the end (any days/activities marked along the way
    /// are already covered, so the worker has nothing left to do).
    pub async fn clear_all_dirty(&self) -> Result<u64> {
        let r = sqlx::query("DELETE FROM dirty_units")
            .execute(&self.pool)
            .await?;
        Ok(r.rows_affected())
    }

    /// Delete one kind of wellness sample from a source — used to fully replace a
    /// recomputed estimate (e.g. the "Computed" HR-derived sleep) each run.
    pub async fn delete_wellness_kind_for_source(
        &self,
        source_id: Uuid,
        kind: ofit_core::WellnessKind,
    ) -> Result<u64> {
        let r = sqlx::query(&self.p("DELETE FROM wellness_samples WHERE source_id = ? AND kind = ?"))
            .bind(source_id.to_string())
            .bind(serde_plain(&kind))
            .execute(&self.pool)
            .await?;
        Ok(r.rows_affected())
    }

    /// Delete wellness samples of one `kind` in a `[from, to)` window, across ALL
    /// sources — used to drop degenerate imported sleep stages (all-light, no
    /// deep/REM) for a night before replacing them with an HR-derived estimate.
    /// `from`/`to` are RFC3339 (timestamps are ISO-8601 TEXT that sorts
    /// chronologically), matching [`Self::wellness_samples`].
    pub async fn delete_wellness_kind_in_range(
        &self,
        kind: WellnessKind,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
    ) -> Result<u64> {
        let r = sqlx::query(&self.p("DELETE FROM wellness_samples WHERE kind = ? AND ts >= ? AND ts < ?"))
            .bind(serde_plain(&kind))
            .bind(from.to_rfc3339())
            .bind(to.to_rfc3339())
            .execute(&self.pool)
            .await?;
        Ok(r.rows_affected())
    }

    /// Delete all wellness samples from a source — used to make a re-import of a
    /// device's export idempotent (replace, don't duplicate).
    pub async fn delete_wellness_for_source(&self, source_id: Uuid) -> Result<u64> {
        let r = sqlx::query(&self.p("DELETE FROM wellness_samples WHERE source_id = ?"))
            .bind(source_id.to_string())
            .execute(&self.pool)
            .await?;
        Ok(r.rows_affected())
    }

    /// Read every app setting as `(key, value)` pairs.
    pub async fn list_settings(&self) -> Result<Vec<(String, String)>> {
        let rows = sqlx::query("SELECT key, value FROM settings")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| (r.get::<String, _>("key"), r.get::<String, _>("value")))
            .collect())
    }

    /// Upsert one app setting (portable: try UPDATE, INSERT if nothing changed).
    pub async fn set_setting(&self, key: &str, value: &str, now: DateTime<Utc>) -> Result<()> {
        let ts = now.to_rfc3339();
        let updated = sqlx::query(&self.p("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?"))
            .bind(value)
            .bind(&ts)
            .bind(key)
            .execute(&self.pool)
            .await?;
        if updated.rows_affected() == 0 {
            sqlx::query(&self.p("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)"))
                .bind(key)
                .bind(value)
                .bind(&ts)
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }

    /// Read one setting's raw value, if set.
    pub async fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let row: Option<AnyRow> = sqlx::query(&self.p("SELECT value FROM settings WHERE key = ?"))
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.get::<String, _>("value")))
    }

    /// Delete wellness samples of `kind` whose value exceeds `threshold` (used to
    /// scrub device-artifact spikes, e.g. HR > the "Max HR Allowed" setting).
    /// Returns the number of rows removed.
    pub async fn delete_wellness_above(&self, kind: WellnessKind, threshold: f64) -> Result<u64> {
        let r = sqlx::query(&self.p("DELETE FROM wellness_samples WHERE kind = ? AND value > ?"))
            .bind(serde_plain(&kind))
            .bind(threshold)
            .execute(&self.pool)
            .await?;
        Ok(r.rows_affected())
    }

    /// Get-or-create a [`Source`] by `(kind, name)`, returning its id. Used by the
    /// wellness ingest path to attribute streamed samples to a stable source.
    pub async fn ensure_source(&self, kind: SourceKind, name: &str) -> Result<Uuid> {
        let existing: Option<AnyRow> =
            sqlx::query(&self.p("SELECT id FROM sources WHERE kind = ? AND name = ?"))
                .bind(serde_plain(&kind))
                .bind(name)
                .fetch_optional(&self.pool)
                .await?;
        if let Some(r) = existing {
            return parse_uuid(&r.get::<String, _>("id"));
        }
        let src = Source::new(kind, name, 50);
        self.insert_source(&src).await?;
        Ok(src.id)
    }

    /// Count wellness samples (smoke-test helper / trend cardinality).
    pub async fn count_wellness_samples(&self) -> Result<i64> {
        let row: AnyRow = sqlx::query(&self.p("SELECT COUNT(*) AS n FROM wellness_samples"))
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get::<i64, _>("n"))
    }

    /// Trend query for the wellness UI: continuous samples of one
    /// [`WellnessKind`], optionally bounded by an RFC3339 `[from, to]` window,
    /// ordered by ascending timestamp.
    ///
    /// `from`/`to` are RFC3339 strings; because timestamps are stored as
    /// ISO-8601 TEXT (which sorts chronologically), the range filter is a plain
    /// lexicographic `>=` / `<=` that behaves identically on SQLite and Postgres.
    pub async fn wellness_samples(
        &self,
        kind: ofit_core::WellnessKind,
        from: Option<&str>,
        to: Option<&str>,
    ) -> Result<Vec<WellnessSample>> {
        let rows = sqlx::query(&self.p("SELECT id, source_id, kind, value, ts FROM wellness_samples \
             WHERE kind = ? \
               AND (? IS NULL OR ts >= ?) \
               AND (? IS NULL OR ts <= ?) \
             ORDER BY ts ASC"))
        .bind(serde_plain(&kind))
        .bind(from)
        .bind(from)
        .bind(to)
        .bind(to)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_wellness).collect()
    }

    // ---- Phase 1: dedup/fusion persistence + read-side queries ----

    /// Update just the `sport` of a stored recording (e.g. re-deriving a Zepp
    /// summary's sport from its raw type code after a mapping fix).
    pub async fn update_recording_sport(&self, id: Uuid, sport: ofit_core::Sport) -> Result<()> {
        sqlx::query(&self.p("UPDATE raw_recordings SET sport = ? WHERE id = ?"))
            .bind(serde_plain(&sport))
            .bind(id.to_string())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Whether a recording with this exact `content_hash` already exists (the
    /// exact-dedup check the import pipeline runs before persisting).
    pub async fn recording_exists_by_hash(&self, content_hash: &str) -> Result<bool> {
        let row: Option<AnyRow> =
            sqlx::query(&self.p("SELECT 1 AS one FROM raw_recordings WHERE content_hash = ? LIMIT 1"))
                .bind(content_hash)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.is_some())
    }

    /// Look up an existing recording id by its content hash, if present.
    pub async fn recording_id_by_hash(&self, content_hash: &str) -> Result<Option<Uuid>> {
        let row: Option<AnyRow> =
            sqlx::query(&self.p("SELECT id FROM raw_recordings WHERE content_hash = ? LIMIT 1"))
                .bind(content_hash)
                .fetch_optional(&self.pool)
                .await?;
        row.map(|r| parse_uuid(&r.get::<String, _>("id"))).transpose()
    }

    /// Count raw recordings (verification helper).
    pub async fn count_recordings(&self) -> Result<i64> {
        let row: AnyRow = sqlx::query(&self.p("SELECT COUNT(*) AS n FROM raw_recordings"))
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get::<i64, _>("n"))
    }

    /// Find an existing [`Source`] by its (kind, name) identity, if any. The
    /// import pipeline uses this to reuse a source instead of duplicating it.
    pub async fn find_source_by_identity(
        &self,
        kind: SourceKind,
        name: &str,
    ) -> Result<Option<Source>> {
        let row: Option<AnyRow> = sqlx::query(&self.p("SELECT id, kind, name, manufacturer, default_priority, created_at \
             FROM sources WHERE kind = ? AND name = ? LIMIT 1"))
        .bind(serde_plain(&kind))
        .bind(name)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_source).transpose()
    }

    /// List all sources, ordered by descending default priority then name.
    pub async fn list_sources(&self) -> Result<Vec<Source>> {
        let rows = sqlx::query(&self.p("SELECT id, kind, name, manufacturer, default_priority, created_at \
             FROM sources ORDER BY default_priority DESC, name ASC"))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_source).collect()
    }

    /// Latest data timestamp per source — `max(wellness ts, recording ended_at)`,
    /// the "last synced" date shown per device. RFC3339 TEXT sorts chronologically,
    /// so `MAX(...)` is correct on both SQLite and Postgres.
    pub async fn last_sync_per_source(&self) -> Result<std::collections::HashMap<Uuid, DateTime<Utc>>> {
        let mut map: std::collections::HashMap<Uuid, DateTime<Utc>> = std::collections::HashMap::new();
        let mut fold = |rows: Vec<AnyRow>| {
            for r in rows {
                let (Ok(id), Ok(ts)) = (
                    parse_uuid(&r.get::<String, _>("source_id")),
                    parse_ts(&r.get::<String, _>("m")),
                ) else {
                    continue;
                };
                map.entry(id).and_modify(|cur| { if ts > *cur { *cur = ts; } }).or_insert(ts);
            }
        };
        fold(
            sqlx::query("SELECT source_id, MAX(ts) AS m FROM wellness_samples GROUP BY source_id")
                .fetch_all(&self.pool)
                .await?,
        );
        fold(
            sqlx::query("SELECT source_id, MAX(ended_at) AS m FROM raw_recordings GROUP BY source_id")
                .fetch_all(&self.pool)
                .await?,
        );
        Ok(map)
    }

    /// Store a [`Stream`] as a JSON sample blob (per the `streams` table shape).
    pub async fn insert_stream(&self, s: &Stream) -> Result<()> {
        let samples_json = serde_json::to_string(&s.samples)
            .map_err(|e| DbError::Config(format!("encode stream samples: {e}")))?;
        sqlx::query(&self.p("INSERT INTO streams (id, recording_id, kind, sample_count, samples) \
             VALUES (?, ?, ?, ?, ?)"))
        .bind(s.id.to_string())
        .bind(s.recording_id.to_string())
        .bind(serde_plain(&s.kind))
        .bind(s.samples.len() as i64)
        .bind(samples_json)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Store all streams of a recording.
    pub async fn insert_streams(&self, streams: &[Stream]) -> Result<()> {
        for s in streams {
            self.insert_stream(s).await?;
        }
        Ok(())
    }

    /// Fetch all streams for a recording (samples decoded from the JSON blob).
    pub async fn streams_for_recording(&self, recording_id: Uuid) -> Result<Vec<Stream>> {
        let rows = sqlx::query(&self.p("SELECT id, recording_id, kind, samples FROM streams \
             WHERE recording_id = ? ORDER BY kind ASC"))
        .bind(recording_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_stream).collect()
    }

    /// Upsert an [`Activity`] row (header only; membership via
    /// [`Self::set_activity_recordings`]). Re-running clustering on import may
    /// widen an activity's window, so this updates in place when the id exists.
    pub async fn upsert_activity(&self, a: &Activity) -> Result<()> {
        self.write_activity(a, true).await
    }

    /// Upsert an activity WITHOUT marking it (or its day) dirty — for a one-time
    /// backfill that runs a single full recompute at the end. See
    /// [`Self::insert_wellness_backfill`] for the rationale.
    pub async fn upsert_activity_silent(&self, a: &Activity) -> Result<()> {
        self.write_activity(a, false).await
    }

    /// Shared activity upsert. `mark_dirty` queues the activity + its day for the
    /// incremental worker (per-activity training-effect/load + that day's volume).
    async fn write_activity(&self, a: &Activity, mark_dirty: bool) -> Result<()> {
        // Portable upsert without ON CONFLICT dialect differences: try UPDATE,
        // INSERT if nothing was updated.
        let updated = sqlx::query(&self.p("UPDATE activities SET sport = ?, started_at = ?, ended_at = ?, \
             user_confirmed = ? WHERE id = ?"))
        .bind(serde_plain(&a.sport))
        .bind(a.started_at.to_rfc3339())
        .bind(a.ended_at.to_rfc3339())
        .bind(a.user_confirmed as i64)
        .bind(a.id.to_string())
        .execute(&self.pool)
        .await?;
        if updated.rows_affected() == 0 {
            sqlx::query(&self.p("INSERT INTO activities (id, sport, started_at, ended_at, user_confirmed, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?)"))
            .bind(a.id.to_string())
            .bind(serde_plain(&a.sport))
            .bind(a.started_at.to_rfc3339())
            .bind(a.ended_at.to_rfc3339())
            .bind(a.user_confirmed as i64)
            .bind(a.created_at.to_rfc3339())
            .execute(&self.pool)
            .await?;
        }
        if mark_dirty {
            let now = Utc::now().to_rfc3339();
            sqlx::query(&self.p("INSERT INTO dirty_units (kind, unit_id, marked_at) \
                 VALUES ('activity', ?, ?) \
                 ON CONFLICT (kind, unit_id) DO UPDATE SET marked_at = excluded.marked_at"))
                .bind(a.id.to_string())
                .bind(&now)
                .execute(&self.pool)
                .await?;
            sqlx::query(&self.p("INSERT INTO dirty_units (kind, unit_id, marked_at) \
                 VALUES ('day', ?, ?) \
                 ON CONFLICT (kind, unit_id) DO UPDATE SET marked_at = excluded.marked_at"))
                .bind(a.started_at.date_naive().to_string())
                .bind(&now)
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }

    /// Replace an activity's recording membership with `recording_ids`.
    /// Idempotent: clears then re-inserts the join rows for this activity.
    pub async fn set_activity_recordings(
        &self,
        activity_id: Uuid,
        recording_ids: &[Uuid],
    ) -> Result<()> {
        sqlx::query(&self.p("DELETE FROM activity_recordings WHERE activity_id = ?"))
            .bind(activity_id.to_string())
            .execute(&self.pool)
            .await?;
        for rid in recording_ids {
            sqlx::query(&self.p("INSERT INTO activity_recordings (activity_id, recording_id) VALUES (?, ?)"))
            .bind(activity_id.to_string())
            .bind(rid.to_string())
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    /// Delete an activity header row and its membership join rows. The member
    /// [`RawRecording`]s and their [`Stream`]s are **not** touched (raw data is
    /// never lost); only the grouping is removed. Used by the summary-dedup
    /// maintenance task. For a user-requested *hard* delete (raw data and all),
    /// see [`Self::delete_activity_cascade`].
    pub async fn delete_activity(&self, activity_id: Uuid) -> Result<()> {
        sqlx::query(&self.p("DELETE FROM activity_recordings WHERE activity_id = ?"))
            .bind(activity_id.to_string())
            .execute(&self.pool)
            .await?;
        sqlx::query(&self.p("DELETE FROM activities WHERE id = ?"))
            .bind(activity_id.to_string())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Delete every derived metric AND stream for one subject
    /// (`subject_kind` = `"activity"` | `"day"`, `subject_id` = its TEXT key).
    /// Used when a subject is removed (e.g. an activity is hard-deleted) so its
    /// stale derived outputs don't linger.
    pub async fn delete_derived_for_subject(
        &self,
        subject_kind: &str,
        subject_id: &str,
    ) -> Result<()> {
        sqlx::query(&self.p("DELETE FROM derived_metrics WHERE subject_kind = ? AND subject_id = ?"))
            .bind(subject_kind)
            .bind(subject_id)
            .execute(&self.pool)
            .await?;
        sqlx::query(&self.p("DELETE FROM derived_streams WHERE subject_kind = ? AND subject_id = ?"))
            .bind(subject_kind)
            .bind(subject_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// **Hard-delete** one raw recording: its streams, every activity-membership
    /// join row that references it, and the `raw_recordings` row itself. This is
    /// irreversible (the raw bytes/streams are gone) — used by the explicit,
    /// user-confirmed "delete source" action, NOT by automatic dedup/clustering
    /// (which always preserve raw data).
    ///
    /// Does **not** touch the activity header(s) it belonged to; the caller is
    /// responsible for re-tightening / removing any now-empty activity. All three
    /// deletes run in **one transaction** so an irreversible hard-delete can never
    /// half-apply (e.g. drop the streams but leave an orphan `raw_recordings` row).
    pub async fn delete_recording(&self, recording_id: Uuid) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let rid = recording_id.to_string();
        sqlx::query(&self.p("DELETE FROM activity_recordings WHERE recording_id = ?"))
            .bind(&rid)
            .execute(&mut *tx)
            .await?;
        sqlx::query(&self.p("DELETE FROM streams WHERE recording_id = ?"))
            .bind(&rid)
            .execute(&mut *tx)
            .await?;
        sqlx::query(&self.p("DELETE FROM raw_recordings WHERE id = ?"))
            .bind(&rid)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// **Hard-delete** an entire activity and everything attached to it: the
    /// activity header, its membership rows, each member recording's streams +
    /// row (only when no *other* activity still references that recording), its
    /// derived metrics/streams, gear assignments, per-activity source
    /// preferences, and any dirty-queue entry for it.
    ///
    /// The whole cascade runs in a **single transaction**, so this irreversible
    /// delete is all-or-nothing — a mid-cascade failure can't leave a ghost
    /// activity or orphaned recording behind, and the in-loop "referenced
    /// elsewhere?" guard reads a consistent in-transaction view.
    ///
    /// Returns the ids of the recordings actually deleted (for logging /
    /// verification). The caller should refold any cross-activity aggregates
    /// (e.g. training load) afterwards, since this activity's contribution is now
    /// gone.
    pub async fn delete_activity_cascade(&self, activity_id: Uuid) -> Result<Vec<Uuid>> {
        let aid = activity_id.to_string();
        let mut tx = self.pool.begin().await?;

        // Member recordings (read inside the tx for a consistent view).
        let rec_ids: Vec<Uuid> = {
            let rows =
                sqlx::query(&self.p("SELECT recording_id FROM activity_recordings WHERE activity_id = ?"))
                    .bind(&aid)
                    .fetch_all(&mut *tx)
                    .await?;
            rows.into_iter()
                .map(|r| parse_uuid(&r.get::<String, _>("recording_id")))
                .collect::<Result<Vec<_>>>()?
        };

        // Derived outputs for this activity subject (metrics + streams).
        for table in ["derived_metrics", "derived_streams"] {
            sqlx::query(&self.p(&format!(
                "DELETE FROM {table} WHERE subject_kind = 'activity' AND subject_id = ?"
            )))
            .bind(&aid)
            .execute(&mut *tx)
            .await?;
        }
        // Gear assignments + per-activity source preferences scoped to it, then
        // membership (dropped first so the per-recording guard below is accurate).
        for sql in [
            "DELETE FROM activity_gear WHERE activity_id = ?",
            "DELETE FROM metric_source_preferences WHERE activity_id = ?",
            "DELETE FROM activity_recordings WHERE activity_id = ?",
        ] {
            sqlx::query(&self.p(sql)).bind(&aid).execute(&mut *tx).await?;
        }

        // Delete each member recording's data — but only if no other activity
        // still references it (recordings normally belong to exactly one).
        let mut deleted = Vec::new();
        for rid in &rec_ids {
            let rid_s = rid.to_string();
            let still: Option<AnyRow> = sqlx::query(
                &self.p("SELECT 1 AS one FROM activity_recordings WHERE recording_id = ? LIMIT 1"),
            )
            .bind(&rid_s)
            .fetch_optional(&mut *tx)
            .await?;
            if still.is_none() {
                sqlx::query(&self.p("DELETE FROM streams WHERE recording_id = ?"))
                    .bind(&rid_s)
                    .execute(&mut *tx)
                    .await?;
                sqlx::query(&self.p("DELETE FROM raw_recordings WHERE id = ?"))
                    .bind(&rid_s)
                    .execute(&mut *tx)
                    .await?;
                deleted.push(*rid);
            }
        }

        // The activity header + its dirty-queue entry.
        sqlx::query(&self.p("DELETE FROM activities WHERE id = ?"))
            .bind(&aid)
            .execute(&mut *tx)
            .await?;
        sqlx::query(&self.p("DELETE FROM dirty_units WHERE kind = 'activity' AND unit_id = ?"))
            .bind(&aid)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        Ok(deleted)
    }

    /// Detach one recording from an activity into its **own** new
    /// single-recording activity (a durable manual split).
    ///
    /// Implements [`ofit_core::detach_recording`] against the store:
    /// 1. The recording is removed from `activity`; both the trimmed original
    ///    and the new single-recording activity are marked `user_confirmed` so
    ///    re-running clustering (the import pipeline) will not merge them back
    ///    ([`ofit_core::cluster_recordings_respecting`]).
    /// 2. The detached activity's window is recomputed from the recording's own
    ///    `started_at`/`ended_at`; the remaining activity's window is recomputed
    ///    from its surviving members so both windows stay tight.
    /// 3. The recording row and its streams are untouched — only the grouping
    ///    changes.
    ///
    /// Returns the id of the new detached activity. Returns
    /// [`DbError::Conflict`] when the recording is not a member, or when it is
    /// the activity's only recording (removing it would orphan the data — the
    /// API surfaces this as a 400 no-op).
    pub async fn detach_recording_from_activity(
        &self,
        activity_id: Uuid,
        recording_id: Uuid,
    ) -> Result<Uuid> {
        let activity = self
            .get_activity(activity_id)
            .await?
            .ok_or_else(|| DbError::Conflict("activity not found".into()))?;

        let mut res = ofit_core::detach_recording(&activity, recording_id).ok_or_else(|| {
            DbError::Conflict(
                "recording is not a member, or is the activity's only recording".into(),
            )
        })?;

        // Tighten the detached activity's window to the recording it now owns.
        if let Some(rec) = self.get_recording(recording_id).await? {
            res.detached.started_at = rec.started_at;
            res.detached.ended_at = rec.ended_at;
        }

        // Tighten the remaining activity's window to its surviving members.
        if let Some((min_start, max_end)) = self.member_window(&res.remaining.recording_ids).await? {
            res.remaining.started_at = min_start;
            res.remaining.ended_at = max_end;
        }

        // Persist both groupings (membership + headers).
        self.upsert_activity(&res.remaining).await?;
        self.set_activity_recordings(res.remaining.id, &res.remaining.recording_ids)
            .await?;
        self.upsert_activity(&res.detached).await?;
        self.set_activity_recordings(res.detached.id, &res.detached.recording_ids)
            .await?;

        Ok(res.detached.id)
    }

    /// Compute the `[min(started_at), max(ended_at)]` window across the given
    /// recordings, or `None` when the set is empty.
    async fn member_window(
        &self,
        recording_ids: &[Uuid],
    ) -> Result<Option<(DateTime<Utc>, DateTime<Utc>)>> {
        let mut window: Option<(DateTime<Utc>, DateTime<Utc>)> = None;
        for rid in recording_ids {
            if let Some(rec) = self.get_recording(*rid).await? {
                window = Some(match window {
                    None => (rec.started_at, rec.ended_at),
                    Some((s, e)) => (s.min(rec.started_at), e.max(rec.ended_at)),
                });
            }
        }
        Ok(window)
    }

    /// Count activities (verification helper).
    pub async fn count_activities(&self) -> Result<i64> {
        let row: AnyRow = sqlx::query(&self.p("SELECT COUNT(*) AS n FROM activities"))
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get::<i64, _>("n"))
    }

    /// List activities (header rows), most recent first.
    pub async fn list_activities(&self) -> Result<Vec<Activity>> {
        let rows = sqlx::query(&self.p("SELECT id, sport, started_at, ended_at, user_confirmed, created_at, distance_m, calories \
             FROM activities ORDER BY started_at DESC"))
        .fetch_all(&self.pool)
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let id = parse_uuid(&r.get::<String, _>("id"))?;
            out.push(self.hydrate_activity(r, id).await?);
        }
        Ok(out)
    }

    /// Fetch one activity with its recording membership populated, if present.
    pub async fn get_activity(&self, id: Uuid) -> Result<Option<Activity>> {
        let row: Option<AnyRow> = sqlx::query(&self.p("SELECT id, sport, started_at, ended_at, user_confirmed, created_at, distance_m, calories \
             FROM activities WHERE id = ?"))
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(r) => Ok(Some(self.hydrate_activity(r, id).await?)),
            None => Ok(None),
        }
    }

    /// Recording ids belonging to an activity.
    pub async fn recording_ids_for_activity(&self, activity_id: Uuid) -> Result<Vec<Uuid>> {
        let rows = sqlx::query(&self.p("SELECT recording_id FROM activity_recordings WHERE activity_id = ?"))
        .bind(activity_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|r| parse_uuid(&r.get::<String, _>("recording_id")))
            .collect()
    }

    /// Fetch one raw recording by id, if present.
    pub async fn get_recording(&self, id: Uuid) -> Result<Option<RawRecording>> {
        let row: Option<AnyRow> = sqlx::query(&self.p("SELECT id, source_id, content_hash, sport, started_at, ended_at, metadata, ingested_at \
             FROM raw_recordings WHERE id = ?"))
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_recording).transpose()
    }

    /// All raw recordings (used by the dedup pipeline to re-cluster on import).
    pub async fn list_recordings(&self) -> Result<Vec<RawRecording>> {
        let rows = sqlx::query(&self.p("SELECT id, source_id, content_hash, sport, started_at, ended_at, metadata, ingested_at \
             FROM raw_recordings ORDER BY started_at ASC"))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_recording).collect()
    }

    /// Map of recording_id → source_id for the given recordings (for resolution).
    pub async fn recording_sources(
        &self,
        recording_ids: &[Uuid],
    ) -> Result<std::collections::BTreeMap<Uuid, Uuid>> {
        let mut map = std::collections::BTreeMap::new();
        for rid in recording_ids {
            if let Some(rec) = self.get_recording(*rid).await? {
                map.insert(rec.id, rec.source_id);
            }
        }
        Ok(map)
    }

    /// Batch-fetch many recordings in one query (kills the per-activity N+1 in
    /// the recompute hot path). Empty input → empty result.
    pub async fn get_recordings(&self, ids: &[Uuid]) -> Result<Vec<RawRecording>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let sql = format!(
            "SELECT id, source_id, content_hash, sport, started_at, ended_at, metadata, ingested_at \
             FROM raw_recordings WHERE id IN ({placeholders})"
        );
        let rewritten = self.p(&sql);
        let mut q = sqlx::query(&rewritten);
        for id in ids {
            q = q.bind(id.to_string());
        }
        let rows = q.fetch_all(&self.pool).await?;
        rows.into_iter().map(row_to_recording).collect()
    }

    /// Insert a [`MetricSourcePreference`].
    pub async fn insert_preference(&self, p: &MetricSourcePreference) -> Result<()> {
        sqlx::query(&self.p("INSERT INTO metric_source_preferences \
             (id, metric, scope, activity_id, source_id, retroactive, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)"))
        .bind(p.id.to_string())
        .bind(serde_plain(&p.metric))
        .bind(serde_plain(&p.scope))
        .bind(p.activity_id.map(|a| a.to_string()))
        .bind(p.source_id.to_string())
        .bind(p.retroactive as i64)
        .bind(p.updated_at.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// List all preferences (defaults + overrides).
    pub async fn list_preferences(&self) -> Result<Vec<MetricSourcePreference>> {
        let rows = sqlx::query(&self.p("SELECT id, metric, scope, activity_id, source_id, retroactive, updated_at \
             FROM metric_source_preferences"))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_preference).collect()
    }

    /// Preferences relevant to one activity: its overrides plus all defaults.
    /// This is exactly the slice [`ofit_core::resolve_activity_view`] needs.
    pub async fn preferences_for_activity(
        &self,
        activity_id: Uuid,
    ) -> Result<Vec<MetricSourcePreference>> {
        let rows = sqlx::query(&self.p("SELECT id, metric, scope, activity_id, source_id, retroactive, updated_at \
             FROM metric_source_preferences \
             WHERE scope = 'default' OR activity_id = ?"))
        .bind(activity_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_preference).collect()
    }

    // ---- Phase 3: derived analytics persistence (metrics + streams) ----
    //
    // Both tables are keyed for **idempotent recompute**: the supersede key is
    // `(plugin_id, plugin_version, subject_kind, subject_id, name)`. Re-running an
    // algorithm version replaces its prior outputs for the same subject+name in
    // place (delete-then-insert in one tx) so recompute never accumulates dupes.

    /// Persist one batch of [`DerivedMetric`]/[`DerivedStream`] outputs,
    /// **superseding** any prior rows from the same `(plugin_id, version,
    /// subject, name)` (idempotent recompute). One transaction.
    pub async fn persist_derived(
        &self,
        metrics: &[ofit_core::DerivedMetric],
        streams: &[ofit_core::DerivedStream],
    ) -> Result<()> {
        if metrics.is_empty() && streams.is_empty() {
            return Ok(());
        }
        let mut tx = self.pool.begin().await?;
        for m in metrics {
            let (sk, sid) = subject_parts(&m.subject);
            sqlx::query(&self.p(
                "DELETE FROM derived_metrics \
                 WHERE plugin_id = ? AND plugin_version = ? AND params_hash = ? \
                   AND subject_kind = ? AND subject_id = ? AND name = ?",
            ))
            .bind(&m.plugin.plugin_id)
            .bind(&m.plugin.version)
            .bind(&m.plugin.params_hash)
            .bind(&sk)
            .bind(&sid)
            .bind(&m.name)
            .execute(&mut *tx)
            .await?;
            sqlx::query(&self.p(
                "INSERT INTO derived_metrics \
                 (id, plugin_id, plugin_version, params_hash, subject_kind, subject_id, name, value, computed_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ))
            .bind(m.id.to_string())
            .bind(&m.plugin.plugin_id)
            .bind(&m.plugin.version)
            .bind(&m.plugin.params_hash)
            .bind(&sk)
            .bind(&sid)
            .bind(&m.name)
            .bind(m.value)
            .bind(m.computed_at.to_rfc3339())
            .execute(&mut *tx)
            .await?;
        }
        for s in streams {
            let (sk, sid) = subject_parts(&s.subject);
            let samples_json = serde_json::to_string(&s.samples)
                .map_err(|e| DbError::Config(format!("encode derived stream samples: {e}")))?;
            sqlx::query(&self.p(
                "DELETE FROM derived_streams \
                 WHERE plugin_id = ? AND plugin_version = ? AND params_hash = ? \
                   AND subject_kind = ? AND subject_id = ? AND name = ?",
            ))
            .bind(&s.plugin.plugin_id)
            .bind(&s.plugin.version)
            .bind(&s.plugin.params_hash)
            .bind(&sk)
            .bind(&sid)
            .bind(&s.name)
            .execute(&mut *tx)
            .await?;
            sqlx::query(&self.p(
                "INSERT INTO derived_streams \
                 (id, plugin_id, plugin_version, params_hash, subject_kind, subject_id, name, sample_count, samples, computed_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ))
            .bind(s.id.to_string())
            .bind(&s.plugin.plugin_id)
            .bind(&s.plugin.version)
            .bind(&s.plugin.params_hash)
            .bind(&sk)
            .bind(&sid)
            .bind(&s.name)
            .bind(s.samples.len() as i64)
            .bind(samples_json)
            .bind(s.computed_at.to_rfc3339())
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Purge derived outputs left over from a *previous* recompute — rows whose
    /// `computed_at` predates `cutoff`. A full recompute stamps every fresh output
    /// with one clock, so anything older belongs to a subject that no longer
    /// produces output (e.g. a day whose bad wellness data was deleted). Without
    /// this, those orphans linger forever because supersede-by-key can't replace
    /// a row that nothing re-emits. Returns the number of rows removed.
    pub async fn purge_derived_before(&self, cutoff: DateTime<Utc>) -> Result<u64> {
        let c = cutoff.to_rfc3339();
        let m = sqlx::query(&self.p("DELETE FROM derived_metrics WHERE computed_at < ?"))
            .bind(&c)
            .execute(&self.pool)
            .await?;
        let s = sqlx::query(&self.p("DELETE FROM derived_streams WHERE computed_at < ?"))
            .bind(&c)
            .execute(&self.pool)
            .await?;
        Ok(m.rows_affected() + s.rows_affected())
    }

    /// Purge **orphan** derived rows of the *given variants only* — rows whose
    /// `computed_at` predates `cutoff` for exactly the `(plugin_id, version,
    /// params_hash)` triples a full recompute just re-stamped. This cleans up a
    /// subject that no longer produces output (e.g. a deleted day) WITHOUT
    /// touching any OTHER derivation variant — so old parameter/version variants
    /// kept for comparison survive (unlike the blunt [`Self::purge_derived_before`]).
    pub async fn purge_derived_orphans(
        &self,
        cutoff: DateTime<Utc>,
        variants: &[(String, String, String)],
    ) -> Result<u64> {
        let c = cutoff.to_rfc3339();
        let mut n = 0u64;
        for (plugin_id, version, params_hash) in variants {
            for table in ["derived_metrics", "derived_streams"] {
                let r = sqlx::query(&self.p(&format!(
                    "DELETE FROM {table} \
                     WHERE plugin_id = ? AND plugin_version = ? AND params_hash = ? \
                       AND computed_at < ?"
                )))
                .bind(plugin_id)
                .bind(version)
                .bind(params_hash)
                .bind(&c)
                .execute(&self.pool)
                .await?;
                n += r.rows_affected();
            }
        }
        Ok(n)
    }

    /// Record (upsert) a derivation variant in the catalog: a distinct
    /// `(plugin_id, version, params_hash)` with the parameter set that produced it.
    /// Refreshes `last_computed_at` (+ params_json/label) on repeat; stamps
    /// `first_computed_at` on first sight. Drives the variant switcher + diff UI.
    pub async fn register_derivation(
        &self,
        plugin_id: &str,
        version: &str,
        params_hash: &str,
        params_json: &str,
        label: &str,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let ts = now.to_rfc3339();
        let updated = sqlx::query(&self.p(
            "UPDATE derivations SET params_json = ?, label = ?, last_computed_at = ? \
             WHERE plugin_id = ? AND plugin_version = ? AND params_hash = ?",
        ))
        .bind(params_json)
        .bind(label)
        .bind(&ts)
        .bind(plugin_id)
        .bind(version)
        .bind(params_hash)
        .execute(&self.pool)
        .await?;
        if updated.rows_affected() == 0 {
            sqlx::query(&self.p(
                "INSERT INTO derivations \
                 (plugin_id, plugin_version, params_hash, params_json, label, first_computed_at, last_computed_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            ))
            .bind(plugin_id)
            .bind(version)
            .bind(params_hash)
            .bind(params_json)
            .bind(label)
            .bind(&ts)
            .bind(&ts)
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    /// List catalogued derivation variants, optionally filtered to one plugin,
    /// newest-computed first.
    pub async fn list_derivations(&self, plugin_id: Option<&str>) -> Result<Vec<Derivation>> {
        let rows = sqlx::query(&self.p(
            "SELECT plugin_id, plugin_version, params_hash, params_json, label, first_computed_at, last_computed_at \
             FROM derivations WHERE (? IS NULL OR plugin_id = ?) \
             ORDER BY plugin_id, last_computed_at DESC",
        ))
        .bind(plugin_id)
        .bind(plugin_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| Derivation {
                plugin_id: r.get::<String, _>("plugin_id"),
                version: r.get::<String, _>("plugin_version"),
                params_hash: r.get::<String, _>("params_hash"),
                params_json: r.get::<String, _>("params_json"),
                label: r.get::<String, _>("label"),
                first_computed_at: r.get::<String, _>("first_computed_at"),
                last_computed_at: r.get::<String, _>("last_computed_at"),
            })
            .collect())
    }

    /// Pin (upsert) which derivation variant a plugin resolves to, for a scope.
    /// `subject_id` is `""` for the global default or an activity uuid for an
    /// activity override. Portable upsert keyed on `(scope, subject_id, plugin_id)`.
    pub async fn set_derivation_selection(
        &self,
        scope: &str,
        subject_id: &str,
        plugin_id: &str,
        version: &str,
        params_hash: &str,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let ts = now.to_rfc3339();
        let updated = sqlx::query(&self.p(
            "UPDATE derivation_selection SET plugin_version = ?, params_hash = ?, updated_at = ? \
             WHERE scope = ? AND subject_id = ? AND plugin_id = ?",
        ))
        .bind(version)
        .bind(params_hash)
        .bind(&ts)
        .bind(scope)
        .bind(subject_id)
        .bind(plugin_id)
        .execute(&self.pool)
        .await?;
        if updated.rows_affected() == 0 {
            sqlx::query(&self.p(
                "INSERT INTO derivation_selection \
                 (scope, subject_id, plugin_id, plugin_version, params_hash, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?)",
            ))
            .bind(scope)
            .bind(subject_id)
            .bind(plugin_id)
            .bind(version)
            .bind(params_hash)
            .bind(&ts)
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    /// Remove a pinned selection (revert to the resolution fallback). Returns rows
    /// removed.
    pub async fn clear_derivation_selection(
        &self,
        scope: &str,
        subject_id: &str,
        plugin_id: &str,
    ) -> Result<u64> {
        let r = sqlx::query(&self.p(
            "DELETE FROM derivation_selection \
             WHERE scope = ? AND subject_id = ? AND plugin_id = ?",
        ))
        .bind(scope)
        .bind(subject_id)
        .bind(plugin_id)
        .execute(&self.pool)
        .await?;
        Ok(r.rows_affected())
    }

    /// The selections relevant to resolving a subject: all global defaults, plus
    /// (when `activity_id` is given) that activity's overrides. Exactly the slice
    /// the analytics resolver needs.
    pub async fn list_derivation_selections(
        &self,
        activity_id: Option<&str>,
    ) -> Result<Vec<DerivationSelection>> {
        let rows = sqlx::query(&self.p(
            "SELECT scope, subject_id, plugin_id, plugin_version, params_hash \
             FROM derivation_selection \
             WHERE scope = 'default' OR (? IS NOT NULL AND subject_id = ?)",
        ))
        .bind(activity_id)
        .bind(activity_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| DerivationSelection {
                scope: r.get::<String, _>("scope"),
                subject_id: r.get::<String, _>("subject_id"),
                plugin_id: r.get::<String, _>("plugin_id"),
                version: r.get::<String, _>("plugin_version"),
                params_hash: r.get::<String, _>("params_hash"),
            })
            .collect())
    }

    /// All derived **metrics** for one subject (an activity id or a day id),
    /// ordered by plugin then name.
    pub async fn derived_metrics_for_subject(
        &self,
        subject: ofit_core::DerivedSubject,
    ) -> Result<Vec<ofit_core::DerivedMetric>> {
        let (sk, sid) = subject_parts(&subject);
        let rows = sqlx::query(&self.p(
            "SELECT id, plugin_id, plugin_version, params_hash, subject_kind, subject_id, name, value, computed_at \
             FROM derived_metrics WHERE subject_kind = ? AND subject_id = ? \
             ORDER BY plugin_id, plugin_version, params_hash, name",
        ))
        .bind(&sk)
        .bind(&sid)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_derived_metric).collect()
    }

    /// All derived **streams** for one subject, ordered by plugin then name.
    pub async fn derived_streams_for_subject(
        &self,
        subject: ofit_core::DerivedSubject,
    ) -> Result<Vec<ofit_core::DerivedStream>> {
        let (sk, sid) = subject_parts(&subject);
        let rows = sqlx::query(&self.p(
            "SELECT id, plugin_id, plugin_version, params_hash, subject_kind, subject_id, name, samples, computed_at \
             FROM derived_streams WHERE subject_kind = ? AND subject_id = ? \
             ORDER BY plugin_id, plugin_version, params_hash, name",
        ))
        .bind(&sk)
        .bind(&sid)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_derived_stream).collect()
    }

    /// Every derived metric produced by one algorithm (plugin id + version),
    /// across all subjects. Used by the training-load convenience view to gather
    /// the latest readiness/HRV without knowing the day id ahead of time.
    pub async fn derived_metrics_for_plugin(
        &self,
        plugin_id: &str,
        version: &str,
        params_hash: Option<&str>,
        name: Option<&str>,
    ) -> Result<Vec<ofit_core::DerivedMetric>> {
        let rows = sqlx::query(&self.p(
            "SELECT id, plugin_id, plugin_version, params_hash, subject_kind, subject_id, name, value, computed_at \
             FROM derived_metrics \
             WHERE plugin_id = ? AND plugin_version = ? \
               AND (? IS NULL OR params_hash = ?) AND (? IS NULL OR name = ?) \
             ORDER BY computed_at",
        ))
        .bind(plugin_id)
        .bind(version)
        .bind(params_hash)
        .bind(params_hash)
        .bind(name)
        .bind(name)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_derived_metric).collect()
    }

    /// Every derived stream produced by one algorithm (plugin id + version),
    /// across all subjects (e.g. all `ctl`/`atl`/`tsb` curves training_load wrote).
    pub async fn derived_streams_for_plugin(
        &self,
        plugin_id: &str,
        version: &str,
        params_hash: Option<&str>,
        name: Option<&str>,
    ) -> Result<Vec<ofit_core::DerivedStream>> {
        let rows = sqlx::query(&self.p(
            "SELECT id, plugin_id, plugin_version, params_hash, subject_kind, subject_id, name, samples, computed_at \
             FROM derived_streams \
             WHERE plugin_id = ? AND plugin_version = ? \
               AND (? IS NULL OR params_hash = ?) AND (? IS NULL OR name = ?) \
             ORDER BY computed_at",
        ))
        .bind(plugin_id)
        .bind(version)
        .bind(params_hash)
        .bind(params_hash)
        .bind(name)
        .bind(name)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_derived_stream).collect()
    }

    /// The single most-recently-computed derived metric value for
    /// `(plugin, version, name)` — `ORDER BY computed_at DESC LIMIT 1` instead of
    /// fetching every row and popping.
    pub async fn latest_derived_metric(
        &self,
        plugin_id: &str,
        version: &str,
        name: &str,
    ) -> Result<Option<f64>> {
        let row: Option<AnyRow> = sqlx::query(&self.p(
            "SELECT value FROM derived_metrics \
             WHERE plugin_id = ? AND plugin_version = ? AND name = ? \
             ORDER BY computed_at DESC LIMIT 1",
        ))
        .bind(plugin_id)
        .bind(version)
        .bind(name)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.get::<f64, _>("value")))
    }

    /// The single most-recently-computed derived stream for `(plugin, version, name)`.
    pub async fn latest_derived_stream(
        &self,
        plugin_id: &str,
        version: &str,
        name: &str,
    ) -> Result<Option<ofit_core::DerivedStream>> {
        let row: Option<AnyRow> = sqlx::query(&self.p(
            "SELECT id, plugin_id, plugin_version, params_hash, subject_kind, subject_id, name, samples, computed_at \
             FROM derived_streams \
             WHERE plugin_id = ? AND plugin_version = ? AND name = ? \
             ORDER BY computed_at DESC LIMIT 1",
        ))
        .bind(plugin_id)
        .bind(version)
        .bind(name)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_derived_stream).transpose()
    }

    /// Count derived metrics + streams (verification helper).
    pub async fn count_derived(&self) -> Result<(i64, i64)> {
        let m: AnyRow = sqlx::query(&self.p("SELECT COUNT(*) AS n FROM derived_metrics"))
            .fetch_one(&self.pool)
            .await?;
        let s: AnyRow = sqlx::query(&self.p("SELECT COUNT(*) AS n FROM derived_streams"))
            .fetch_one(&self.pool)
            .await?;
        Ok((m.get::<i64, _>("n"), s.get::<i64, _>("n")))
    }

    /// Hydrate an activity header row into an [`Activity`] with its membership.
    async fn hydrate_activity(&self, r: AnyRow, id: Uuid) -> Result<Activity> {
        let recording_ids = self.recording_ids_for_activity(id).await?;
        Ok(Activity {
            id,
            sport: parse_enum::<Sport>(&r.get::<String, _>("sport"))?,
            started_at: parse_ts(&r.get::<String, _>("started_at"))?,
            ended_at: parse_ts(&r.get::<String, _>("ended_at"))?,
            recording_ids,
            user_confirmed: r.get::<i64, _>("user_confirmed") != 0,
            created_at: parse_ts(&r.get::<String, _>("created_at"))?,
            distance_m: r.get::<Option<f64>, _>("distance_m"),
            calories: r.get::<Option<f64>, _>("calories"),
        })
    }

    /// Cache an activity's computed distance (m) + calories (kcal) on its row.
    /// Written by the analytics recompute so the list/totals match the detail.
    pub async fn set_activity_metrics(
        &self,
        id: Uuid,
        distance_m: Option<f64>,
        calories: Option<f64>,
    ) -> Result<()> {
        sqlx::query(&self.p("UPDATE activities SET distance_m = ?, calories = ? WHERE id = ?"))
            .bind(distance_m)
            .bind(calories)
            .bind(id.to_string())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ---- gear (equipment mileage tracking) ----

    /// All gear, oldest first.
    pub async fn list_gear(&self) -> Result<Vec<ofit_core::Gear>> {
        let rows = sqlx::query(&self.p(
            "SELECT id, name, description, sport, initial_km, retire_km, used_km, icon, created_at \
             FROM gear ORDER BY created_at ASC",
        ))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_gear).collect()
    }

    /// Fetch one gear by id.
    pub async fn get_gear(&self, id: Uuid) -> Result<Option<ofit_core::Gear>> {
        let row: Option<AnyRow> = sqlx::query(&self.p(
            "SELECT id, name, description, sport, initial_km, retire_km, used_km, icon, created_at \
             FROM gear WHERE id = ?",
        ))
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_gear).transpose()
    }

    /// Insert a new gear row.
    pub async fn insert_gear(&self, g: &ofit_core::Gear) -> Result<()> {
        sqlx::query(&self.p(
            "INSERT INTO gear (id, name, description, sport, initial_km, retire_km, used_km, icon, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ))
        .bind(g.id.to_string())
        .bind(&g.name)
        .bind(&g.description)
        .bind(&g.sport)
        .bind(g.initial_km)
        .bind(g.retire_km)
        .bind(g.used_km)
        .bind(&g.icon)
        .bind(g.created_at.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Update an existing gear's editable fields.
    pub async fn update_gear(
        &self,
        id: Uuid,
        name: &str,
        description: &str,
        sport: &str,
        retire_km: f64,
        used_km: f64,
        icon: &str,
    ) -> Result<()> {
        sqlx::query(&self.p(
            "UPDATE gear SET name = ?, description = ?, sport = ?, retire_km = ?, used_km = ?, icon = ? \
             WHERE id = ?",
        ))
        .bind(name)
        .bind(description)
        .bind(sport)
        .bind(retire_km)
        .bind(used_km)
        .bind(icon)
        .bind(id.to_string())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Delete a gear and any defaults/assignments that reference it.
    pub async fn remove_gear(&self, id: Uuid) -> Result<()> {
        let s = id.to_string();
        sqlx::query(&self.p("DELETE FROM activity_gear WHERE gear_id = ?"))
            .bind(&s)
            .execute(&self.pool)
            .await?;
        sqlx::query(&self.p("DELETE FROM gear_defaults WHERE gear_id = ?"))
            .bind(&s)
            .execute(&self.pool)
            .await?;
        sqlx::query(&self.p("DELETE FROM gear WHERE id = ?"))
            .bind(&s)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Default gear per activity type: `(sport, gear_id)` pairs.
    pub async fn list_gear_defaults(&self) -> Result<Vec<(String, Uuid)>> {
        let rows = sqlx::query("SELECT sport, gear_id FROM gear_defaults")
            .fetch_all(&self.pool)
            .await?;
        rows.into_iter()
            .map(|r| Ok((r.get::<String, _>("sport"), parse_uuid(&r.get::<String, _>("gear_id"))?)))
            .collect()
    }

    /// Set (or clear, when `gear_id` is `None`) the default gear for a type.
    pub async fn set_gear_default(&self, sport: &str, gear_id: Option<Uuid>) -> Result<()> {
        sqlx::query(&self.p("DELETE FROM gear_defaults WHERE sport = ?"))
            .bind(sport)
            .execute(&self.pool)
            .await?;
        if let Some(g) = gear_id {
            sqlx::query(&self.p("INSERT INTO gear_defaults (sport, gear_id) VALUES (?, ?)"))
                .bind(sport)
                .bind(g.to_string())
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }

    /// All per-activity gear assignments: `(activity_id, gear_id)` pairs.
    pub async fn list_activity_gear(&self) -> Result<Vec<(Uuid, Uuid)>> {
        let rows = sqlx::query("SELECT activity_id, gear_id FROM activity_gear")
            .fetch_all(&self.pool)
            .await?;
        rows.into_iter()
            .map(|r| {
                Ok((
                    parse_uuid(&r.get::<String, _>("activity_id"))?,
                    parse_uuid(&r.get::<String, _>("gear_id"))?,
                ))
            })
            .collect()
    }

    /// Replace the full gear set assigned to one activity (idempotent).
    pub async fn set_activity_gear(&self, activity_id: Uuid, gear_ids: &[Uuid]) -> Result<()> {
        let a = activity_id.to_string();
        sqlx::query(&self.p("DELETE FROM activity_gear WHERE activity_id = ?"))
            .bind(&a)
            .execute(&self.pool)
            .await?;
        for g in gear_ids {
            sqlx::query(&self.p("INSERT INTO activity_gear (activity_id, gear_id) VALUES (?, ?)"))
                .bind(&a)
                .bind(g.to_string())
                .execute(&self.pool)
                .await?;
        }
        Ok(())
    }

    /// Find a gear by its (unique-by-convention) display name — used so a Garmin
    /// re-import updates the matching gear instead of duplicating it.
    pub async fn find_gear_by_name(&self, name: &str) -> Result<Option<ofit_core::Gear>> {
        let row: Option<AnyRow> = sqlx::query(&self.p(
            "SELECT id, name, description, sport, initial_km, retire_km, used_km, icon, created_at \
             FROM gear WHERE name = ?",
        ))
        .bind(name)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_gear).transpose()
    }

    // ---- personal records ----

    /// All personal records, most recent first.
    pub async fn list_personal_records(&self) -> Result<Vec<ofit_core::PersonalRecord>> {
        let rows = sqlx::query(&self.p(
            "SELECT id, record_type, value, unit, occurred_at, source, current \
             FROM personal_records ORDER BY occurred_at DESC",
        ))
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_personal_record).collect()
    }

    /// Insert a personal record.
    pub async fn insert_personal_record(&self, pr: &ofit_core::PersonalRecord) -> Result<()> {
        sqlx::query(&self.p(
            "INSERT INTO personal_records (id, record_type, value, unit, occurred_at, source, current) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        ))
        .bind(pr.id.to_string())
        .bind(&pr.record_type)
        .bind(pr.value)
        .bind(&pr.unit)
        .bind(pr.occurred_at.to_rfc3339())
        .bind(&pr.source)
        .bind(pr.current as i64)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Delete every personal record from a source — idempotent re-import (replace,
    /// don't duplicate). Returns rows removed.
    pub async fn delete_personal_records_for_source(&self, source: &str) -> Result<u64> {
        let r = sqlx::query(&self.p("DELETE FROM personal_records WHERE source = ?"))
            .bind(source)
            .execute(&self.pool)
            .await?;
        Ok(r.rows_affected())
    }
}

fn row_to_personal_record(r: AnyRow) -> Result<ofit_core::PersonalRecord> {
    Ok(ofit_core::PersonalRecord {
        id: parse_uuid(&r.get::<String, _>("id"))?,
        record_type: r.get::<String, _>("record_type"),
        value: r.get::<f64, _>("value"),
        unit: r.get::<String, _>("unit"),
        occurred_at: parse_ts(&r.get::<String, _>("occurred_at"))?,
        source: r.get::<String, _>("source"),
        current: r.get::<i64, _>("current") != 0,
    })
}

fn row_to_gear(r: AnyRow) -> Result<ofit_core::Gear> {
    Ok(ofit_core::Gear {
        id: parse_uuid(&r.get::<String, _>("id"))?,
        name: r.get::<String, _>("name"),
        description: r.get::<String, _>("description"),
        sport: r.get::<String, _>("sport"),
        initial_km: r.get::<f64, _>("initial_km"),
        retire_km: r.get::<f64, _>("retire_km"),
        used_km: r.get::<f64, _>("used_km"),
        icon: r.get::<String, _>("icon"),
        created_at: parse_ts(&r.get::<String, _>("created_at"))?,
    })
}

fn row_to_source(r: AnyRow) -> Result<Source> {
    Ok(Source {
        id: parse_uuid(&r.get::<String, _>("id"))?,
        kind: parse_enum::<SourceKind>(&r.get::<String, _>("kind"))?,
        name: r.get::<String, _>("name"),
        manufacturer: r.get::<Option<String>, _>("manufacturer"),
        default_priority: r.get::<i64, _>("default_priority") as i32,
        created_at: parse_ts(&r.get::<String, _>("created_at"))?,
    })
}

fn row_to_recording(r: AnyRow) -> Result<RawRecording> {
    let metadata: serde_json::Value = serde_json::from_str(&r.get::<String, _>("metadata"))
        .unwrap_or(serde_json::Value::Null);
    Ok(RawRecording {
        id: parse_uuid(&r.get::<String, _>("id"))?,
        source_id: parse_uuid(&r.get::<String, _>("source_id"))?,
        content_hash: ofit_core::ContentHash(r.get::<String, _>("content_hash")),
        sport: parse_enum::<Sport>(&r.get::<String, _>("sport"))?,
        started_at: parse_ts(&r.get::<String, _>("started_at"))?,
        ended_at: parse_ts(&r.get::<String, _>("ended_at"))?,
        metadata,
        ingested_at: parse_ts(&r.get::<String, _>("ingested_at"))?,
    })
}

fn row_to_stream(r: AnyRow) -> Result<Stream> {
    let samples: Vec<Sample> = serde_json::from_str(&r.get::<String, _>("samples"))
        .map_err(|e| DbError::Config(format!("decode stream samples: {e}")))?;
    Ok(Stream {
        id: parse_uuid(&r.get::<String, _>("id"))?,
        recording_id: parse_uuid(&r.get::<String, _>("recording_id"))?,
        kind: parse_enum::<StreamKind>(&r.get::<String, _>("kind"))?,
        samples,
    })
}

fn row_to_preference(r: AnyRow) -> Result<MetricSourcePreference> {
    let activity_id = r
        .get::<Option<String>, _>("activity_id")
        .map(|s| parse_uuid(&s))
        .transpose()?;
    Ok(MetricSourcePreference {
        id: parse_uuid(&r.get::<String, _>("id"))?,
        metric: parse_enum::<StreamKind>(&r.get::<String, _>("metric"))?,
        scope: parse_enum::<PreferenceScope>(&r.get::<String, _>("scope"))?,
        activity_id,
        source_id: parse_uuid(&r.get::<String, _>("source_id"))?,
        retroactive: r.get::<i64, _>("retroactive") != 0,
        updated_at: parse_ts(&r.get::<String, _>("updated_at"))?,
    })
}

fn row_to_wellness(r: AnyRow) -> Result<WellnessSample> {
    Ok(WellnessSample {
        id: parse_uuid(&r.get::<String, _>("id"))?,
        source_id: parse_uuid(&r.get::<String, _>("source_id"))?,
        kind: parse_enum::<ofit_core::WellnessKind>(&r.get::<String, _>("kind"))?,
        value: r.get::<f64, _>("value"),
        ts: parse_ts(&r.get::<String, _>("ts"))?,
    })
}

/// A catalogued derivation variant: one distinct `(plugin_id, version,
/// params_hash)` with the parameter set (`params_json`) that produced it and when
/// it was first/last computed. Returned by [`Db::list_derivations`].
#[derive(Debug, Clone)]
pub struct Derivation {
    /// Producing algorithm id.
    pub plugin_id: String,
    /// Producing algorithm code version.
    pub version: String,
    /// Fingerprint of the parameter set.
    pub params_hash: String,
    /// The effective parameters as a JSON object `{key: value}`.
    pub params_json: String,
    /// Optional human label.
    pub label: String,
    /// First time this variant was computed (RFC3339).
    pub first_computed_at: String,
    /// Most recent time this variant was computed (RFC3339).
    pub last_computed_at: String,
}

/// A pinned active-variant selection: which `(plugin_version, params_hash)` a
/// plugin's outputs resolve to, globally (`scope = "default"`) or for one activity
/// (`scope = "activity"`, `subject_id` = activity uuid). Returned by
/// [`Db::list_derivation_selections`].
#[derive(Debug, Clone)]
pub struct DerivationSelection {
    /// `"default"` or `"activity"`.
    pub scope: String,
    /// Empty for default scope; the activity uuid for an activity override.
    pub subject_id: String,
    /// The plugin this selection pins.
    pub plugin_id: String,
    /// The pinned code version.
    pub version: String,
    /// The pinned parameter fingerprint.
    pub params_hash: String,
}

/// Split a [`DerivedSubject`] into its stored `(subject_kind, subject_id)` TEXT
/// columns: `("activity"|"day", uuid)`.
fn subject_parts(subject: &ofit_core::DerivedSubject) -> (String, String) {
    match subject {
        ofit_core::DerivedSubject::Activity(id) => ("activity".to_string(), id.to_string()),
        ofit_core::DerivedSubject::Day(id) => ("day".to_string(), id.to_string()),
    }
}

/// Inverse of [`subject_parts`].
fn subject_from_parts(kind: &str, id: &str) -> Result<ofit_core::DerivedSubject> {
    let uuid = parse_uuid(id)?;
    match kind {
        "activity" => Ok(ofit_core::DerivedSubject::Activity(uuid)),
        "day" => Ok(ofit_core::DerivedSubject::Day(uuid)),
        other => Err(DbError::Config(format!("bad subject_kind {other:?}"))),
    }
}

fn row_to_derived_metric(r: AnyRow) -> Result<ofit_core::DerivedMetric> {
    Ok(ofit_core::DerivedMetric {
        id: parse_uuid(&r.get::<String, _>("id"))?,
        plugin: ofit_core::PluginRef::new(
            r.get::<String, _>("plugin_id"),
            r.get::<String, _>("plugin_version"),
        )
        .with_params_hash(r.get::<String, _>("params_hash")),
        subject: subject_from_parts(
            &r.get::<String, _>("subject_kind"),
            &r.get::<String, _>("subject_id"),
        )?,
        name: r.get::<String, _>("name"),
        value: r.get::<f64, _>("value"),
        computed_at: parse_ts(&r.get::<String, _>("computed_at"))?,
    })
}

fn row_to_derived_stream(r: AnyRow) -> Result<ofit_core::DerivedStream> {
    let samples: Vec<Sample> = serde_json::from_str(&r.get::<String, _>("samples"))
        .map_err(|e| DbError::Config(format!("decode derived stream samples: {e}")))?;
    Ok(ofit_core::DerivedStream {
        id: parse_uuid(&r.get::<String, _>("id"))?,
        plugin: ofit_core::PluginRef::new(
            r.get::<String, _>("plugin_id"),
            r.get::<String, _>("plugin_version"),
        )
        .with_params_hash(r.get::<String, _>("params_hash")),
        subject: subject_from_parts(
            &r.get::<String, _>("subject_kind"),
            &r.get::<String, _>("subject_id"),
        )?,
        name: r.get::<String, _>("name"),
        samples,
        computed_at: parse_ts(&r.get::<String, _>("computed_at"))?,
    })
}

/// Parse a canonical hyphenated UUID string from a TEXT column.
fn parse_uuid(s: &str) -> Result<Uuid> {
    Uuid::parse_str(s).map_err(|e| DbError::Config(format!("bad uuid {s:?}: {e}")))
}

/// Parse an RFC3339 timestamp (our TEXT storage format) into UTC.
fn parse_ts(s: &str) -> Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|e| DbError::Config(format!("bad timestamp {s:?}: {e}")))
}

/// Parse a snake_case enum tag (stored as TEXT) back into its domain enum by
/// round-tripping through JSON — the inverse of [`serde_plain`].
fn parse_enum<T: serde::de::DeserializeOwned>(tag: &str) -> Result<T> {
    serde_json::from_value(serde_json::Value::String(tag.to_string()))
        .map_err(|e| DbError::Config(format!("bad enum tag {tag:?}: {e}")))
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
