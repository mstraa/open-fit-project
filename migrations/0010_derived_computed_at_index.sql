-- Index computed_at so purge_derived_before (DELETE ... WHERE computed_at < ?)
-- and the "latest by computed_at" lookups don't full-scan the derived tables as
-- history grows. Portable (plain CREATE INDEX on both SQLite and Postgres).

CREATE INDEX ix_derived_metrics_computed_at ON derived_metrics (computed_at);
CREATE INDEX ix_derived_streams_computed_at ON derived_streams (computed_at);
