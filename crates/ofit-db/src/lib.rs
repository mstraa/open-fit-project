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
    Sport, Stream, StreamKind, WellnessSample,
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

        let pool = AnyPoolOptions::new()
            .max_connections(5)
            .connect(database_url)
            .await?;

        // SQLite: enable WAL so readers (dashboard/wellness queries) don't block
        // on the continuous live-wellness writes, and a busy-timeout so they wait
        // instead of erroring. WAL is persistent for the file; the others are
        // best-effort per-connection. (Postgres ignores these — guarded by backend.)
        if backend == Backend::Sqlite {
            for pragma in [
                "PRAGMA journal_mode=WAL",
                "PRAGMA busy_timeout=5000",
                "PRAGMA synchronous=NORMAL",
            ] {
                let _ = sqlx::query(pragma).execute(&pool).await;
            }
        }

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
    pub async fn insert_wellness_samples(&self, samples: &[WellnessSample]) -> Result<()> {
        if samples.is_empty() {
            return Ok(());
        }
        let mut tx = self.pool.begin().await?;
        for w in samples {
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
        }
        tx.commit().await?;
        Ok(())
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
    /// never lost); only the grouping is removed.
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
        let rows = sqlx::query(&self.p("SELECT id, sport, started_at, ended_at, user_confirmed, created_at \
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
        let row: Option<AnyRow> = sqlx::query(&self.p("SELECT id, sport, started_at, ended_at, user_confirmed, created_at \
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
                 WHERE plugin_id = ? AND plugin_version = ? \
                   AND subject_kind = ? AND subject_id = ? AND name = ?",
            ))
            .bind(&m.plugin.plugin_id)
            .bind(&m.plugin.version)
            .bind(&sk)
            .bind(&sid)
            .bind(&m.name)
            .execute(&mut *tx)
            .await?;
            sqlx::query(&self.p(
                "INSERT INTO derived_metrics \
                 (id, plugin_id, plugin_version, subject_kind, subject_id, name, value, computed_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ))
            .bind(m.id.to_string())
            .bind(&m.plugin.plugin_id)
            .bind(&m.plugin.version)
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
                 WHERE plugin_id = ? AND plugin_version = ? \
                   AND subject_kind = ? AND subject_id = ? AND name = ?",
            ))
            .bind(&s.plugin.plugin_id)
            .bind(&s.plugin.version)
            .bind(&sk)
            .bind(&sid)
            .bind(&s.name)
            .execute(&mut *tx)
            .await?;
            sqlx::query(&self.p(
                "INSERT INTO derived_streams \
                 (id, plugin_id, plugin_version, subject_kind, subject_id, name, sample_count, samples, computed_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ))
            .bind(s.id.to_string())
            .bind(&s.plugin.plugin_id)
            .bind(&s.plugin.version)
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

    /// All derived **metrics** for one subject (an activity id or a day id),
    /// ordered by plugin then name.
    pub async fn derived_metrics_for_subject(
        &self,
        subject: ofit_core::DerivedSubject,
    ) -> Result<Vec<ofit_core::DerivedMetric>> {
        let (sk, sid) = subject_parts(&subject);
        let rows = sqlx::query(&self.p(
            "SELECT id, plugin_id, plugin_version, subject_kind, subject_id, name, value, computed_at \
             FROM derived_metrics WHERE subject_kind = ? AND subject_id = ? \
             ORDER BY plugin_id, plugin_version, name",
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
            "SELECT id, plugin_id, plugin_version, subject_kind, subject_id, name, samples, computed_at \
             FROM derived_streams WHERE subject_kind = ? AND subject_id = ? \
             ORDER BY plugin_id, plugin_version, name",
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
        name: Option<&str>,
    ) -> Result<Vec<ofit_core::DerivedMetric>> {
        let rows = sqlx::query(&self.p(
            "SELECT id, plugin_id, plugin_version, subject_kind, subject_id, name, value, computed_at \
             FROM derived_metrics \
             WHERE plugin_id = ? AND plugin_version = ? AND (? IS NULL OR name = ?) \
             ORDER BY computed_at",
        ))
        .bind(plugin_id)
        .bind(version)
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
        name: Option<&str>,
    ) -> Result<Vec<ofit_core::DerivedStream>> {
        let rows = sqlx::query(&self.p(
            "SELECT id, plugin_id, plugin_version, subject_kind, subject_id, name, samples, computed_at \
             FROM derived_streams \
             WHERE plugin_id = ? AND plugin_version = ? AND (? IS NULL OR name = ?) \
             ORDER BY computed_at",
        ))
        .bind(plugin_id)
        .bind(version)
        .bind(name)
        .bind(name)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_derived_stream).collect()
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
        })
    }
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
        ),
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
        ),
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
