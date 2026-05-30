-- Open Fit — initial schema (Phase 0).
--
-- PORTABILITY: this migration runs verbatim on BOTH SQLite and Postgres
-- (hard rule: ofit-db supports both from day one). To stay dialect-neutral we
-- deliberately use only the column types both engines accept with identical
-- meaning:
--   * TEXT     — ids (UUID as canonical hyphenated string), enum tags, JSON,
--                and timestamps as ISO-8601 / RFC3339 UTC strings. ISO-8601
--                sorts lexicographically == chronologically, so range/ORDER BY
--                on ts works on both engines without a native timestamp type
--                (SQLite has no real DATETIME; Postgres TIMESTAMPTZ binding from
--                sqlx differs from SQLite — TEXT sidesteps the mismatch).
--   * INTEGER  — counts, priorities, and booleans (0/1; SQLite has no BOOLEAN,
--                Postgres accepts INTEGER here).
--   * REAL     — floating-point sample values (both engines: 8-byte float).
-- We avoid SERIAL/AUTOINCREMENT (id is app-generated UUID), AUTO timestamps,
-- and any dialect-specific function defaults. Indices use plain CREATE INDEX.
-- On Postgres/Timescale, wellness_samples can later be turned into a hypertable
-- without changing app code.

-- A device/provider instance.
CREATE TABLE sources (
    id               TEXT PRIMARY KEY,
    kind             TEXT NOT NULL,
    name             TEXT NOT NULL,
    manufacturer     TEXT,
    default_priority INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL
);

-- Immutable ingested artefacts. content_hash drives EXACT dedup (unique).
CREATE TABLE raw_recordings (
    id            TEXT PRIMARY KEY,
    source_id     TEXT NOT NULL REFERENCES sources(id),
    content_hash  TEXT NOT NULL,
    sport         TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    ended_at      TEXT NOT NULL,
    metadata      TEXT NOT NULL DEFAULT '{}',
    ingested_at   TEXT NOT NULL
);
-- Exact-dedup guarantee: identical bytes ingest once.
CREATE UNIQUE INDEX ux_raw_recordings_hash ON raw_recordings (content_hash);
CREATE INDEX ix_raw_recordings_time ON raw_recordings (started_at, ended_at);

-- Logical workouts = the dedup unit.
CREATE TABLE activities (
    id             TEXT PRIMARY KEY,
    sport          TEXT NOT NULL,
    started_at     TEXT NOT NULL,
    ended_at       TEXT NOT NULL,
    user_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL
);
CREATE INDEX ix_activities_time ON activities (started_at, ended_at);

-- Join: which recordings make up an activity (many-to-many anchor).
CREATE TABLE activity_recordings (
    activity_id  TEXT NOT NULL REFERENCES activities(id),
    recording_id TEXT NOT NULL REFERENCES raw_recordings(id),
    PRIMARY KEY (activity_id, recording_id)
);
CREATE INDEX ix_activity_recordings_rec ON activity_recordings (recording_id);

-- Per-recording time-series channels. We keep one row per stream and store its
-- samples as a JSON-encoded blob in `samples` (compact, time-ordered). A
-- normalized per-sample table can be added later for query-heavy analytics; for
-- Phase 0 a blob is portable and simple. `sample_count` is a cheap summary.
CREATE TABLE streams (
    id            TEXT PRIMARY KEY,
    recording_id  TEXT NOT NULL REFERENCES raw_recordings(id),
    kind          TEXT NOT NULL,
    sample_count  INTEGER NOT NULL DEFAULT 0,
    samples       TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX ix_streams_recording ON streams (recording_id, kind);

-- Continuous wellness — high-rate streaming-first. Flat & narrow on purpose:
-- one numeric value per (ts, kind, source). Indexed by ts for range scans /
-- trend queries; this is the table that would become a Timescale hypertable.
CREATE TABLE wellness_samples (
    id        TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id),
    kind      TEXT NOT NULL,
    value     REAL NOT NULL,
    ts        TEXT NOT NULL
);
CREATE INDEX ix_wellness_ts ON wellness_samples (ts);
CREATE INDEX ix_wellness_kind_ts ON wellness_samples (kind, ts);

-- Per-metric source resolver: default + per-activity override + retroactive.
CREATE TABLE metric_source_preferences (
    id          TEXT PRIMARY KEY,
    metric      TEXT NOT NULL,
    scope       TEXT NOT NULL,            -- 'default' | 'activity'
    activity_id TEXT REFERENCES activities(id),
    source_id   TEXT NOT NULL REFERENCES sources(id),
    retroactive INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL
);
CREATE INDEX ix_pref_metric_scope ON metric_source_preferences (metric, scope);
CREATE INDEX ix_pref_activity ON metric_source_preferences (activity_id);

-- Algorithm outputs (scalar). Tied to plugin id + version => recalculable.
CREATE TABLE derived_metrics (
    id             TEXT PRIMARY KEY,
    plugin_id      TEXT NOT NULL,
    plugin_version TEXT NOT NULL,
    subject_kind   TEXT NOT NULL,         -- 'activity' | 'day'
    subject_id     TEXT NOT NULL,
    name           TEXT NOT NULL,
    value          REAL NOT NULL,
    computed_at    TEXT NOT NULL
);
CREATE INDEX ix_derived_subject ON derived_metrics (subject_kind, subject_id);
CREATE INDEX ix_derived_plugin ON derived_metrics (plugin_id, plugin_version);
