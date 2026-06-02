-- Personal records (best-ever performances) imported from a Garmin export.
-- The value unit is record-type dependent and stored explicitly in `unit`
-- ("seconds" | "meters" | "count"), because the source leaves it unlabelled.
-- Portable SQL (TEXT / INTEGER / REAL only), matching the rest of the schema.

CREATE TABLE personal_records (
    id          TEXT PRIMARY KEY,
    record_type TEXT NOT NULL,          -- e.g. "Best 5km Run", "Farthest Run"
    value       REAL NOT NULL,          -- in `unit`
    unit        TEXT NOT NULL,          -- "seconds" | "meters" | "count"
    occurred_at TEXT NOT NULL,          -- RFC3339 (UTC)
    source      TEXT NOT NULL DEFAULT 'Garmin',
    current     INTEGER NOT NULL DEFAULT 1   -- 1 = current holder, 0 = superseded
);
CREATE INDEX ix_personal_records_current ON personal_records (current);
