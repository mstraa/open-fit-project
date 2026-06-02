-- Cache per-activity distance + calories on the activity row so the activities
-- LIST and "this week" totals show the same real numbers as the detail view
-- (which computes them from the distance stream / Zepp summary). Populated by the
-- analytics recompute; NULL until computed. Portable (REAL on SQLite + Postgres).

ALTER TABLE activities ADD COLUMN distance_m REAL;
ALTER TABLE activities ADD COLUMN calories REAL;
