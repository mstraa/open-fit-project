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
        let rows = sqlx::query(
            "SELECT id, source_id, kind, value, ts FROM wellness_samples \
             WHERE kind = ? \
               AND (? IS NULL OR ts >= ?) \
               AND (? IS NULL OR ts <= ?) \
             ORDER BY ts ASC",
        )
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

    /// Whether a recording with this exact `content_hash` already exists (the
    /// exact-dedup check the import pipeline runs before persisting).
    pub async fn recording_exists_by_hash(&self, content_hash: &str) -> Result<bool> {
        let row: Option<AnyRow> =
            sqlx::query("SELECT 1 AS one FROM raw_recordings WHERE content_hash = ? LIMIT 1")
                .bind(content_hash)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.is_some())
    }

    /// Look up an existing recording id by its content hash, if present.
    pub async fn recording_id_by_hash(&self, content_hash: &str) -> Result<Option<Uuid>> {
        let row: Option<AnyRow> =
            sqlx::query("SELECT id FROM raw_recordings WHERE content_hash = ? LIMIT 1")
                .bind(content_hash)
                .fetch_optional(&self.pool)
                .await?;
        row.map(|r| parse_uuid(&r.get::<String, _>("id"))).transpose()
    }

    /// Count raw recordings (verification helper).
    pub async fn count_recordings(&self) -> Result<i64> {
        let row: AnyRow = sqlx::query("SELECT COUNT(*) AS n FROM raw_recordings")
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
        let row: Option<AnyRow> = sqlx::query(
            "SELECT id, kind, name, manufacturer, default_priority, created_at \
             FROM sources WHERE kind = ? AND name = ? LIMIT 1",
        )
        .bind(serde_plain(&kind))
        .bind(name)
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_source).transpose()
    }

    /// List all sources, ordered by descending default priority then name.
    pub async fn list_sources(&self) -> Result<Vec<Source>> {
        let rows = sqlx::query(
            "SELECT id, kind, name, manufacturer, default_priority, created_at \
             FROM sources ORDER BY default_priority DESC, name ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_source).collect()
    }

    /// Store a [`Stream`] as a JSON sample blob (per the `streams` table shape).
    pub async fn insert_stream(&self, s: &Stream) -> Result<()> {
        let samples_json = serde_json::to_string(&s.samples)
            .map_err(|e| DbError::Config(format!("encode stream samples: {e}")))?;
        sqlx::query(
            "INSERT INTO streams (id, recording_id, kind, sample_count, samples) \
             VALUES (?, ?, ?, ?, ?)",
        )
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
        let rows = sqlx::query(
            "SELECT id, recording_id, kind, samples FROM streams \
             WHERE recording_id = ? ORDER BY kind ASC",
        )
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
        let updated = sqlx::query(
            "UPDATE activities SET sport = ?, started_at = ?, ended_at = ?, \
             user_confirmed = ? WHERE id = ?",
        )
        .bind(serde_plain(&a.sport))
        .bind(a.started_at.to_rfc3339())
        .bind(a.ended_at.to_rfc3339())
        .bind(a.user_confirmed as i64)
        .bind(a.id.to_string())
        .execute(&self.pool)
        .await?;
        if updated.rows_affected() == 0 {
            sqlx::query(
                "INSERT INTO activities (id, sport, started_at, ended_at, user_confirmed, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
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
        sqlx::query("DELETE FROM activity_recordings WHERE activity_id = ?")
            .bind(activity_id.to_string())
            .execute(&self.pool)
            .await?;
        for rid in recording_ids {
            sqlx::query(
                "INSERT INTO activity_recordings (activity_id, recording_id) VALUES (?, ?)",
            )
            .bind(activity_id.to_string())
            .bind(rid.to_string())
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    /// Count activities (verification helper).
    pub async fn count_activities(&self) -> Result<i64> {
        let row: AnyRow = sqlx::query("SELECT COUNT(*) AS n FROM activities")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get::<i64, _>("n"))
    }

    /// List activities (header rows), most recent first.
    pub async fn list_activities(&self) -> Result<Vec<Activity>> {
        let rows = sqlx::query(
            "SELECT id, sport, started_at, ended_at, user_confirmed, created_at \
             FROM activities ORDER BY started_at DESC",
        )
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
        let row: Option<AnyRow> = sqlx::query(
            "SELECT id, sport, started_at, ended_at, user_confirmed, created_at \
             FROM activities WHERE id = ?",
        )
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
        let rows = sqlx::query(
            "SELECT recording_id FROM activity_recordings WHERE activity_id = ?",
        )
        .bind(activity_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|r| parse_uuid(&r.get::<String, _>("recording_id")))
            .collect()
    }

    /// Fetch one raw recording by id, if present.
    pub async fn get_recording(&self, id: Uuid) -> Result<Option<RawRecording>> {
        let row: Option<AnyRow> = sqlx::query(
            "SELECT id, source_id, content_hash, sport, started_at, ended_at, metadata, ingested_at \
             FROM raw_recordings WHERE id = ?",
        )
        .bind(id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        row.map(row_to_recording).transpose()
    }

    /// All raw recordings (used by the dedup pipeline to re-cluster on import).
    pub async fn list_recordings(&self) -> Result<Vec<RawRecording>> {
        let rows = sqlx::query(
            "SELECT id, source_id, content_hash, sport, started_at, ended_at, metadata, ingested_at \
             FROM raw_recordings ORDER BY started_at ASC",
        )
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
        sqlx::query(
            "INSERT INTO metric_source_preferences \
             (id, metric, scope, activity_id, source_id, retroactive, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
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
        let rows = sqlx::query(
            "SELECT id, metric, scope, activity_id, source_id, retroactive, updated_at \
             FROM metric_source_preferences",
        )
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
        let rows = sqlx::query(
            "SELECT id, metric, scope, activity_id, source_id, retroactive, updated_at \
             FROM metric_source_preferences \
             WHERE scope = 'default' OR activity_id = ?",
        )
        .bind(activity_id.to_string())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(row_to_preference).collect()
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
