-- Phase 1 of the computed-values overhaul: the PARAMETER SET becomes part of a
-- derivation's identity. A derivation is now identified by
-- (plugin_id, plugin_version, params_hash); changing any tunable analytics
-- parameter yields a new params_hash and therefore a NEW, side-by-side derivation
-- line rather than overwriting the old one — so old and new can be compared and
-- switched between freely.
--
-- The supersede key in `Db::persist_derived` becomes
-- (plugin_id, plugin_version, params_hash, subject_kind, subject_id, name).
-- Existing rows default to params_hash '' (the pre-overhaul "unknown params"
-- line); the next full recompute re-stamps them with the real fingerprint.

ALTER TABLE derived_metrics ADD COLUMN params_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE derived_streams ADD COLUMN params_hash TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS ix_derived_metrics_variant
    ON derived_metrics (plugin_id, plugin_version, params_hash);
CREATE INDEX IF NOT EXISTS ix_derived_streams_variant
    ON derived_streams (plugin_id, plugin_version, params_hash);

-- Catalog of every distinct derivation variant ever computed, with the exact
-- parameter set that produced it. Drives the version/variant switcher and the
-- old-vs-new comparison UI: list a plugin's variants, show their parameter diffs,
-- and pick which one is authoritative.
CREATE TABLE IF NOT EXISTS derivations (
    plugin_id         TEXT NOT NULL,
    plugin_version    TEXT NOT NULL,
    params_hash       TEXT NOT NULL,
    -- The plugin's effective parameters as a JSON object {key: value}.
    params_json       TEXT NOT NULL DEFAULT '{}',
    -- Optional human label (e.g. "LTHR 170 · CTL 42d"); blank = auto.
    label             TEXT NOT NULL DEFAULT '',
    first_computed_at TEXT NOT NULL,
    last_computed_at  TEXT NOT NULL,
    PRIMARY KEY (plugin_id, plugin_version, params_hash)
);
