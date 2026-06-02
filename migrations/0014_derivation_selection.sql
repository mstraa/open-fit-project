-- Phase 2 of the computed-values overhaul: "switch freely" between derivation
-- variants. A selection pins which variant (plugin_version + params_hash) is the
-- AUTHORITATIVE one a metric resolves to, either globally (`scope = 'default'`)
-- or as a per-activity override (`scope = 'activity'`, subject_id = activity id),
-- mirroring the existing metric-source-preference model.
--
-- Resolution order for a metric's active variant:
--   per-activity selection  >  global default selection  >  newest by computed_at
-- (the newest-wins fallback makes an edited setting auto-activate once recomputed,
-- while every prior variant stays queryable for the old-vs-new diff.)
CREATE TABLE IF NOT EXISTS derivation_selection (
    scope          TEXT NOT NULL,            -- 'default' | 'activity'
    subject_id     TEXT NOT NULL DEFAULT '', -- '' for default scope; activity uuid for 'activity'
    plugin_id      TEXT NOT NULL,
    plugin_version TEXT NOT NULL,
    params_hash    TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    PRIMARY KEY (scope, subject_id, plugin_id)
);

CREATE INDEX IF NOT EXISTS ix_derivation_selection_subject
    ON derivation_selection (subject_id);
