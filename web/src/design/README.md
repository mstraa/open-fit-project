# OpenFit redesign (`web/src/design`)

The Zepp-inspired redesign from the Claude-Design handoff bundle, ported into the
real app. **The design is the source of truth.** It replaces the old
`web/src/screens/*` UI in place; the API/BLE/Gadgetbridge/auth wiring is reused.

## Layout
- `openfit.css` — design tokens + component CSS for **both** shells (imported last in `main.tsx`).
- `util.ts` · `charts.tsx` · `ui.tsx` · `shared.tsx` — primitives, chart SVGs, UI kit + `Nav` context, the `MetricDetail` engine.
- `data.ts` — static design data, the **MOCKS**, and the in-memory gear store.
- `wiring.ts` — hooks that adapt the **real ofit-api** to the design's shapes (mock fallback).
- `pages/*` — mobile pages + shared detail views. `desktop/*` — desktop grid layouts.
- `MobileApp.tsx` (phone shell, bottom-nav, drawer, push/pop stack, **swipe-between-tabs + edge-back gestures**, sheet), `DesktopApp.tsx` (sidebar + grid + modal/page-overlay), `Root.tsx` (viewport switch at 900px).

## Wired to REAL data
- **Activities list** + per-sport counts + badge (`useActivities`).
- **Activity detail** Overview tiles, HR chart, **Graphs** (resolved scalar streams) and the **GPS map polyline** (real `lat_lng` track) via `getActivity`; gear keyed to the activity's sport.
- **Training load** CTL/ATL/TSB + **readiness/HRV** (`useTrainingLoad`).
- **Live HR** hero (live WS `useWellnessLive` + native `useBle`/`useNativeBle`; simulated only if nothing is streaming).
- **Steps** today + week, **HR 24h**, **sleep** nights/score/stages (`getWellness('steps'|'heart_rate')`, `getDerived('day:…')`).
- **Settings → Sources** (real `listSources`/`listPreferences`/`putPreference`), **Imports** (Zepp `importZepp`), **Goals** (`getStepsGoal`/`setStepsGoal`), **About** (`getVersion`/`useHealth`). (Gadgetbridge was removed.)
- **Devices & sources**: native BLE live bpm, masked Helio auth key (`localStorage ofit_helio_authkey`), scan/sync, offline buffer (`OpenFitBle.getOutboxStatus`).
- **Logout** → real `useAuth().logout()`. Auth gating stays in `AuthProvider`.

### Phase 1 (DONE) — wired to real wellness/sleep/volume (see `wiring.ts` hooks)
- **Resting HR · HRV · Stress · SpO₂ · Body battery** tiles + HRV/stress bands + sparklines → `useWellnessLatest`/`useDailyTrend`/`useIntradayLatestDay` (latest-anchored daily roll-ups of `GET /api/wellness`).
- **Body battery** hero ring + "throughout today" intraday curve + charged/drained → `useBodyBattery`. (NB: the backend's stress-derived body_battery currently drains to **0** by evening — real data, a backend-quality matter, not a wiring bug.)
- **Sleep** fully from raw `sleep_stage` (0=awake/1=light/2=deep/3=rem): real hypnogram, stage minutes, score (algorithm formula), bed/wake regularity, per-night avg HR; SpO₂/breath joined from raw streams (show "—" when absent). `useSleepData`/`useSleepNights`.
- **Weekly volume by sport** + **"This week"/Training summary** (rolling 7-day / month / year) aggregated from `GET /api/activities` → `useWeeklyVolume`/`useTrainingSummary`.
- **Activity detail** Overview/Graphs/Statistics + GPS from real resolved streams (`useActivityDetailData`).

## STILL MOCKED — implement later
- **Hypopnea** weekly (no apnea source); sleep **regularity %** metric-row label is static (the regularity chart is real).
- Activity detail **Intervals + Training Effect** + the statsGroups **fallback** (no laps/TE endpoint).
- **Distance** in Training summary / "This week" shows "—" (the activity *list* summary has no distance; needs the detail or a summary endpoint).
- **Gear** tracking (in-memory `GEAR` store — no gear endpoint).
- **RecordFlow** simulated ticking on web (real recording is the native `OpenFitRecording` plugin).
- Appearance theme/units/week-start local-only (accent swatch recolors `--blue` live).
