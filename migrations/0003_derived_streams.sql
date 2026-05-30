-- Open Fit — derived_streams (Phase 3 analytics persistence).
--
-- Algorithm outputs that are time-series (e.g. CTL/ATL/TSB curves) rather than a
-- single scalar. Mirrors the `streams` table shape: samples kept as a JSON blob
-- (compact, time-ordered) in a TEXT column. Same portability rules as 0001
-- (TEXT / INTEGER / REAL only) so it runs verbatim on SQLite and Postgres.
--
-- Tied to plugin id + version => recalculable; the supersede key on recompute is
-- (plugin_id, plugin_version, subject_kind, subject_id, name) — identical to the
-- derived_metrics convention. Indexed by subject (read derivations for an
-- activity/day) and by plugin (recompute/delete-stale by algorithm+version).
CREATE TABLE derived_streams (
    id             TEXT PRIMARY KEY,
    plugin_id      TEXT NOT NULL,
    plugin_version TEXT NOT NULL,
    subject_kind   TEXT NOT NULL,         -- 'activity' | 'day'
    subject_id     TEXT NOT NULL,
    name           TEXT NOT NULL,
    sample_count   INTEGER NOT NULL DEFAULT 0,
    samples        TEXT NOT NULL DEFAULT '[]',
    computed_at    TEXT NOT NULL
);
CREATE INDEX ix_derived_streams_subject ON derived_streams (subject_kind, subject_id);
CREATE INDEX ix_derived_streams_plugin ON derived_streams (plugin_id, plugin_version);
