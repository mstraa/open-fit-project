-- Gear tracking: equipment (shoes/bikes) with mileage + retirement, a default
-- gear per activity type, and per-activity assignments. Portable SQL (TEXT /
-- INTEGER / REAL only), matching the rest of the schema.

CREATE TABLE gear (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sport       TEXT NOT NULL,            -- activity type label: "Running" | "Cycling" | …
    initial_km  REAL NOT NULL DEFAULT 0,
    retire_km   REAL NOT NULL DEFAULT 0,
    used_km     REAL NOT NULL DEFAULT 0,
    icon        TEXT NOT NULL DEFAULT 'run',
    created_at  TEXT NOT NULL
);

-- Default gear per activity type (new activities of that type use it).
CREATE TABLE gear_defaults (
    sport   TEXT PRIMARY KEY,
    gear_id TEXT NOT NULL REFERENCES gear(id)
);

-- Per-activity gear assignment (many-to-many; overrides the type default).
CREATE TABLE activity_gear (
    activity_id TEXT NOT NULL,
    gear_id     TEXT NOT NULL REFERENCES gear(id),
    PRIMARY KEY (activity_id, gear_id)
);
CREATE INDEX ix_activity_gear_gear ON activity_gear (gear_id);
