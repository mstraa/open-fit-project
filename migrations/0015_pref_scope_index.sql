-- preferences_for_activity() filters with `WHERE scope = 'default' OR activity_id = ?`
-- on metric_source_preferences. The `activity_id` branch is already covered by
-- ix_pref_activity, but the `scope` branch had no usable index: ix_pref_metric_scope
-- leads with `metric`, so a scope-only lookup can't use it. Add a leading-`scope`
-- index so the OR predicate is index-backed on both engines as the table grows.
-- Portable (SQLite + Postgres). `IF NOT EXISTS` keeps it additive + idempotent.

CREATE INDEX IF NOT EXISTS ix_pref_scope ON metric_source_preferences (scope);
