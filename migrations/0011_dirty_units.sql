-- Incremental-recompute work queue: which units (a day or an activity) have raw
-- data that changed since their derived outputs were last computed. Marked in the
-- SAME transaction as the raw write (crash-safe), drained by the background
-- analytics worker, cleared per-unit as each is recomputed. Portable SQL.

CREATE TABLE dirty_units (
    kind      TEXT NOT NULL,          -- 'activity' | 'day'
    unit_id   TEXT NOT NULL,          -- activity uuid  OR  day 'YYYY-MM-DD' (UTC)
    marked_at TEXT NOT NULL,          -- RFC3339; newest mark wins on re-dirty
    PRIMARY KEY (kind, unit_id)
);
CREATE INDEX ix_dirty_units_marked ON dirty_units (marked_at);
