export const meta = {
  name: 'openfit-backend-explore',
  description: 'Map the Rust backend + frontend touchpoints needed to implement gear, activity distance/calories, prefs persistence, FIT laps, hypopnea',
  phases: [{ title: 'Explore' }],
};
const ROOT = '/Volumes/Mimic/Code/Open Fit Project';

phase('Explore');
const areas = [
  {
    label: 'activities-distance-calories',
    spec: `In ${ROOT}: I want to add distance_m (+ calories) to the activity LIST so the redesign's "This week" distance and Overview calories are real. Map precisely (quote code + file:line):
- ofit-api: the GET /api/activities handler (list_activities) and the ActivitySummary DTO (exact fields + where defined). Also GET /api/activities/{id} — does the detail already expose total distance/calories anywhere?
- ofit-db: the list_activities query (SQL + return shape) and the activities table columns (from migrations/).
- How is distance currently obtainable per activity? Is there a StreamKind::Distance stream, a lat_lng track (to integrate length), and/or a summary{distance_m,calories_kcal} (Zepp summary-only)? Where would calories come from for stream activities?
- ofit-core: resolve_activity_view + how the API gets resolved streams for one activity (the path build_analytics_input/analytics.rs uses) — could the list handler reuse it cheaply, or should distance_m/calories be precomputed + stored on the activities table at import time?
Conclude with the SIMPLEST correct way to populate distance_m + calories on the list (compute-on-read vs stored column + ingest), with the exact structs/queries to change.`,
  },
  {
    label: 'db-migrations-settings',
    spec: `In ${ROOT}: map the DB layer for adding new tables + CRUD, and the settings store. Quote code + file:line:
- ofit-db migration mechanism (sqlx::migrate! embedded? — confirm; note that adding a migrations/*.sql needs a recompile trigger). The exact format of an existing migration file (e.g. migrations/0001_init.sql header + a CREATE TABLE) so a new one matches.
- ofit-db query style: sqlx query!/query_as!/query_scalar! macros vs runtime query? Quote 2-3 representative query fns (a SELECT list, an INSERT/upsert) so new gear queries match the idiom. Note SQLite+Postgres portability constraints (TEXT/INTEGER/REAL only).
- The settings table + get_settings()/set_setting() impl (ofit-db + ofit-api handlers) — confirm it's generic key→value JSON/text so the frontend can persist theme/units/week-start without backend changes.
- How AppState/Db is structured (so new handlers + db methods slot in). How routes are registered in ofit-api/src/main.rs (quote the router builder section).`,
  },
  {
    label: 'core-types-gear',
    spec: `In ${ROOT}: map ofit-core so I can add Gear + ActivityGear domain types + their tables. Quote code + file:line:
- How ofit-core structs/enums are defined (serde rename_all snake_case, utoipa::ToSchema derive patterns) — show Source (source.rs) and Activity (activity.rs?) as templates.
- The activities table schema + the Activity struct fields (id, sport, started_at, ended_at, etc.).
- Where a new Gear type + GearAssignment should live (new file crates/ofit-core/src/gear.rs? + lib.rs re-export). What deriving/serde is needed for it to be a utoipa ToSchema API DTO.
- The Uuid + chrono usage conventions. Propose the exact Gear fields (id, name, sport/type, initial_km, retire_km, used_km, created_at) + activity_gear(activity_id, gear_id) to mirror the frontend GEAR store, and how mileage (used_km) should accrue from activity distance.`,
  },
  {
    label: 'ingest-fit-laps',
    spec: `In ${ROOT}/crates/ofit-ingest: assess FIT lap parsing for the activity "Intervals" tab. Quote code + file:line:
- How are FIT files parsed (which crate — fit_file/fitparser/custom? where's the entry)? What message types are currently extracted (records→streams)?
- Are LAP messages (start_time, total_elapsed_time, total_distance, avg_speed, lap_trigger/intensity) accessible from the parser? How much work to extract per-lap interval data?
- Where would laps be stored (new table activity_laps? a derived stream?) and exposed (activity detail payload)?
Conclude with a feasibility + effort estimate (small/medium/large) and the concrete steps. This one I may STAGE rather than implement now — be honest about effort.`,
  },
  {
    label: 'frontend-gear-prefs',
    spec: `In ${ROOT}/web/src: map the frontend touchpoints. Quote code + file:line:
- The in-memory gear store in design/data.ts (the GearStore class / GEAR) — list EVERY method + field the UI calls (design/pages/System.tsx GearManager + design/pages/Activities.tsx GearTab via useGear()). I need the exact surface to reimplement as an API-backed store: addGear/updateGear/removeGear/setDefault/assign/unassign/gearsFor/idsFor/byId/defaults/gears/subscribe.
- design/pages/System.tsx Appearance section: how theme/units/weekStart/accent are held (local state today) — what to persist via /api/settings (keys), and whether ThemeProvider exists to apply theme.
- Confirm web/src/prefs.ts pattern (getStepsGoal/setStepsGoal via /api/settings) as the template for persisting more prefs.
- design/wiring.ts: where activity distance would feed (ActivityRow.dist is null today; useTrainingSummary dist null; ActivityDetail Overview calories). What hook changes are needed once the API returns distance_m/calories.`,
  },
];
const out = await parallel(areas.map((a) => () => agent(a.spec, { label: a.label, phase: 'Explore', agentType: 'Explore' })));
return { areas: out.filter(Boolean).length };
