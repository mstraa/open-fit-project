-- Wellness de-duplication + idempotent ingest.
--
-- Re-running a device fetch (M2 stored-data pull) or a live re-connect previously
-- re-inserted the SAME per-minute samples again and again — each row keeps a fresh
-- random id, so nothing stopped the duplication. A single day of steps ballooned to
-- thousands of rows and summed to absurd totals (e.g. 768k "steps").
--
-- Fix: collapse to one row per (source_id, kind, ts) keeping the largest value, then
-- enforce that uniqueness with an index so future re-syncs UPSERT instead of pile up.
-- Portable across SQLite and Postgres (window functions + `id NOT IN (...)`).

DELETE FROM wellness_samples
WHERE id NOT IN (
  SELECT keep_id FROM (
    SELECT id AS keep_id,
           ROW_NUMBER() OVER (PARTITION BY source_id, kind, ts ORDER BY value DESC, id) AS rn
    FROM wellness_samples
  ) ranked
  WHERE rn = 1
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_wellness_skt
  ON wellness_samples (source_id, kind, ts);
