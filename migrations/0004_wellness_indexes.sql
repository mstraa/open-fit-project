-- Indexes for the continuous wellness time-series. The dashboard/wellness views
-- query `WHERE kind = ? AND ts BETWEEN ...`; without an index that's a full scan
-- of the (now ~1M-row) table — slow enough to lock against the live-HR write
-- stream and time out, leaving the UI blank. These make those lookups instant.
-- Portable (SQLite + Postgres). `IF NOT EXISTS` keeps it idempotent.

CREATE INDEX IF NOT EXISTS idx_wellness_kind_ts ON wellness_samples (kind, ts);
CREATE INDEX IF NOT EXISTS idx_wellness_source ON wellness_samples (source_id);
