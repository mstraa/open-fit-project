# Garmin Connect export → Open Fit: one-time import analysis

> Status: **✅ BUILT (2026-06-02) — full T1–T4 import shipped and verified.**
> Original survey below kept for reference. See **BUILT** section immediately
> after this block for what shipped + how to run it.

## BUILT — `POST /api/import/garmin` (one-time backfill)

Scope chosen: **everything feasible (T1–T4)**. Delivery: an **HTTP endpoint that
takes a server-side path** (`{"path": "<export root>"}`) — the 195 MB tree
already lives on the box, so a multipart upload was pointless. Sleep: **per-minute
stages approximated** from nightly durations (the export has no per-epoch stages).

What it does, in order (all idempotent per source):
1. `ofit_ingest::read_garmin_export(root)` parses the JSON: UDSFile daily wellness,
   sleep nights → approx per-minute `SleepStage`, userBioMetrics weight/bmi/bodyFat,
   `DI-Connect-Metrics` VO2max/training-load/race-preds/fitness-age, gear (+mileage
   joined from `summarizedActivities` distances), current personal records.
2. Wellness inserted via **`insert_wellness_backfill`** (max-HR filter, **no dirty
   marking**). Gear → existing `Gear` entity (skip names already present).
   PRs → new `personal_records` table.
3. `ofit_ingest::import_garmin_fit_dir(db, root)` walks the 4 `UploadedFiles_*.zip`,
   size-prefilters (<15 KB skip) + keeps only `file_id.type == activity`, exact-
   dedups, inserts, and **reclusters ONCE silently** (no per-activity dirty).
4. **One** `run_full_recompute(&state)` (factored out of the recompute handler),
   then `clear_all_dirty()` — a 6-yr backfill would otherwise mark ~3,000 dirty
   units and thrash the incremental worker.

**New model:** 12 `WellnessKind` variants (BodyFat, BodyWater, BoneMass,
MuscleMass, Bmi, Vo2Max, TrainingLoad, FitnessAge, RacePredict5k/10k/Half/
Marathon) + a `PersonalRecord` entity + migration `0012_personal_records.sql`.
FIT `file_id.type` now surfaced in recording metadata (`file_type`).
UI: System → Imports has a "Import Garmin history" card (path input) +
a "Personal records" card; `GET /api/personal-records`.

**Verified** against the real export (run on a throwaway DB; ~4m18s):
1,602 activity FITs → **1,594 activities** (2,624 non-activities filtered, 0 parse
errors), **993,304** wellness readings (963k sleep-stage), 2,259 days, 2,013 nights,
11 gear, 13 PRs; recompute produced a **4,066-point CTL/ATL/TSB series (2015→2026)**
and 20,160 derived metrics; **dirty_units = 0** after. `readiness` stays null —
the Garmin export carries **no HRV** (expected).

---

> Status (original): **analysis + plan only — not yet built.** Captures the full
> survey of a Garmin GDPR data export and how it maps onto the Open Fit ingest
> model. Decisions at the bottom are still open.

- **Export location:** `/Users/alex/Downloads/1ca64efe-f834-4b7b-b65c-d398a1aa87e3_1`
- **Size:** ~195 MB, 211 files (204 JSON, 4 zip, 3 png)
- **Account:** `alexauchart@gmail.com`, userProfilePK `10306743`, DOB 1990-08-24, gender MALE, locale `fr`
- This is the "history via Garmin Connect export" backfill anticipated by the
  `garmin-945-no-ble-file-sync` memory (945 = live HR only over BLE).

---

## TL;DR

| | What | Volume | Maps to | Effort | Code today |
|---|---|---|---|---|---|
| 🟢 **T1** | Activity workouts (FIT) | ~1,560 | `RawRecording` + `Stream` | Small | FIT parser **exists** |
| 🟢 **T2a** | Daily wellness (UDSFile) | ~2,233 days | `WellnessSample` (existing kinds) | Small–Med | new JSON parser |
| 🟢 **T2b** | Sleep | 2,030 nights | `WellnessSample` (sleep) | Medium | new JSON parser |
| 🟢 **T2c** | Weight | ~272 | `WellnessKind::Weight` | Small | new JSON parser |
| 🟡 **T3** | VO2max / training load / race preds / fitness age | ~6,600 day-pts | needs new model | Medium | model decision |
| 🟡 **T4** | Gear + personal records | 11 + 13 | needs new entity | Medium | model decision |
| 🔴 **skip** | workouts-templates, hydration, nutrition, golf, social, consent, events, PII | — | none | — | — |

---

## ⚠️ The single most important finding

`DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part{1..4}.zip` hold
**35,243 `.fit` files**, but this is a **raw firehose, not an activities folder**.
By FIT `file_id.type` (message 0, field 0):

| `file_id.type` | ~Count | Meaning | Ingest? |
|---|---|---|---|
| **4 = activity** | **~1,560** | real workouts, dense per-second streams | ✅ **yes** |
| 32 = monitoring_b | many | daily/intraday wellness blobs | ❌ no monitoring-FIT parser exists; use JSON instead |
| 49 = sleep | many | per-sleep-session | ❌ use sleep JSON instead |
| 44 = metrics | many | small daily derived snapshots | ❌ use metrics JSON instead |
| 41 = stub | ~10,500 | <600 bytes, near-empty | ❌ ignore |

**A naive "import every `.fit`" is ~95% wrong.** The importer MUST filter to
`file_id.type == 4` before treating a file as an activity.

- Size pre-filter (cheap first pass): activities are ~all ≥ 21 KB; **100% of files
  ≥ 50 KB are activities**; files < 15 KB are never activities. Overlap zone
  ~15–35 KB → must read `file_id.type` to disambiguate.
- Size distribution (uncompressed, all 35,243): `<5KB=24,720`, `5–15KB=6,434`,
  `15–30KB=2,608`, `30–50KB=702`, `≥50KB=779`. min 167 B, median 1,375 B, max 1.04 MB.
- **Validation:** all sampled activity files parsed with **ZERO errors** using
  `fitparser 0.9` — the exact crate `crates/ofit-ingest/src/fit.rs` already uses.
  No new activity-parsing code is required.

### ⚠️ FIT ↔ summary join caveat (resolves a contradiction between two survey agents)
FIT filenames are `alexauchart@gmail.com_<NUM>.fit`. **`<NUM>` is an internal
upload/file ID, NOT the `activityId`.** Verified: sampled activity-file numbers
(e.g. 70635866094, 66868717068, 104381119900 ≈ 66–104 billion) exceed the
`activityId` range in the summaries (745M–23B) and appear nowhere in
`summarizedActivities.json`. **To attach Connect metadata (names, training load,
VO2max) to a FIT recording you must join by START TIMESTAMP, not the filename.**
Sport/GPS/streams come from the FIT itself, so naming is "nice to have", not required.

---

## Tier 1 — Activities (works with the EXISTING FIT pipeline)

- **~1,560 activities**, 2015→2026 (FIT coverage likely ~2019/2021→2026; older/manual
  entries may be summary-only).
- `activityType` distribution: cycling 648, running 597, walking 204, strength 56,
  indoor_cardio 20, other 10, hiking 10, hiit 7, trail_running 2, indoor_rowing 2.
- FIT `Record` fields → already extracted by `fit.rs`: position_lat/long (semicircles
  ×180/2³¹), altitude/enhanced_altitude, heart_rate, cadence, distance,
  speed/enhanced_speed, temperature, + Stryd running-dynamics developer fields.
  → 15 of 16 `StreamKind`s (everything except `Wind`).
- Each FIT carries device identity (`device_info`); `garmin_product_name` in `fit.rs`
  already maps e.g. fr945 → "Garmin Forerunner 945". All same-device FITs attribute to
  **one `Source`**.

**Enrichment (optional):** `summarizedActivities` (below) supplies human names,
location, sport label, and Garmin's precomputed TSS / training load / VO2max — joined
by timestamp.

### Activity summaries — `DI-Connect-Fitness/alexauchart@gmail.com_{0,1001}_summarizedActivities.json`
- 12 MB + 7.5 MB. Shape: `[ { "summarizedActivitiesExport": [ {…activity…} ] } ]`.
- **1,560 records** (1000 + 560, non-overlapping pages; dedupe by `activityId` anyway).
- 2015-04-12 → 2026-05-29. **No streams** — metadata only.
- 124 distinct keys (vary by sport). Key ones: `activityId, name, activityType,
  sportType, beginTimestamp, startTimeGmt, duration, distance, avgHr/maxHr/minHr,
  calories, elevationGain/Loss, avgPower/maxPower/normPower, avg*Cadence, steps,
  vO2MaxValue, aerobicTrainingEffect, anaerobicTrainingEffect, activityTrainingLoad,
  trainingStressScore, intensityFactor, deviceId, manufacturer, start/end Lat/Long,
  locationName, hrTimeInZone_0..6, powerTimeInZone_0..7, splits, splitSummaries`.
- **Unit gotchas:** `beginTimestamp`/`startTimeGmt` = epoch **ms** (often scientific
  notation `1.78E12`); `duration` family = **ms** (float); `distance` = **cm**;
  `avgSpeed`/`maxSpeed` = m/s; `timeZoneId` is a Garmin internal id, not an offset.
- **Do NOT import these as activities** (no streams → would double-count the FIT
  recordings). They are an enrichment lookup table only.

---

## Tier 2 — Daily wellness, sleep, body (new JSON parser → existing WellnessKinds)

### T2a · Daily summaries — `DI-Connect-Aggregator/UDSFile_*.json` (richest daily source)
- 31 quarterly files, **2,259 day-records** (~2,233 real). Continuous coverage
  ~2019-11-04 → 2026-05-29. Per-day granularity (no intraday arrays).
- **Every metric here already has a `WellnessKind`:**
  - `totalSteps` → Steps · `totalKilocalories`/`activeKilocalories` → Calories
  - `restingHeartRate` → RestingHeartRate · `minHeartRate`/`maxHeartRate` → HeartRate
  - `allDayStress.aggregatorList[]` (TOTAL/AWAKE/ASLEEP avg/max + low/med/high durations) → Stress
  - `bodyBattery.bodyBatteryStatList[]` (HIGHEST/LOWEST/START/END-of-day, charged/drained) → BodyBattery
  - `respiration.avgWaking/high/low` → Respiration · `averageSpo2Value`/`lowestSpo2Value` → SpO2
- **No home (skip or add variants):** `moderate/vigorousIntensityMinutes`,
  `floorsAscended/DescendedInMeters`, `totalDistanceMeters`, hydration block.
- Gotchas: field presence inconsistent over 20-yr span → treat all metrics optional;
  guard empty `allDayStress:{}`. Skip pre-device junk files (2005/2015/2018, <12 KB,
  `includesWellnessData=false`). Stamp at a stable per-day ts (midnight, like Zepp's
  `at_midnight`) or the `(source_id,kind,ts)` unique index will collide. Prefer
  `calendarDate`/Local fields as the day key. `restingHeartRate` (7-day avg) ≠
  `currentDayRestingHeartRate` (single day) — pick deliberately. Calorie fields highly
  redundant. **UDS = DAILY rollups only**; don't double-count vs any intraday source.

### T2b · Sleep — `DI-Connect-Wellness/*_sleepData.json`
- 21 files, **2,030 nights**, 2019-11-14 → 2025-07-04 (no 2026). Bare JSON array,
  one record per `calendarDate`. **Per-night summaries, NOT per-epoch stages.**
- Fields: `deep/light/rem/awake/unmeasurableSeconds`, `sleepStart/EndTimestampGMT`,
  `averageRespiration` (+low/high), `avgSleepStress`, `awakeCount`,
  `restlessMomentCount`, nested `sleepScores.*` (overall/quality/duration/recovery/
  deep/rem/light + feedback/insight enum strings), nested `spo2SleepSummary.*`
  (averageSPO2/lowestSPO2/averageHR — the only overnight HR signal). **No HRV field
  anywhere in the export.**
- **Model mismatch:** Open Fit stores per-minute `WellnessKind::SleepStage` samples and
  a `sleep` algorithm summarizes them. Garmin gives only nightly durations → either
  (a) add nightly-summary sleep kinds, or (b) approximate. Coverage grows over time
  (stages 2,023/2,030; respiration 1,653; scores 1,469; SpO2 930) → every field except
  date/start/end must be optional. Flag/skip `OFF_WRIST`/`UNCONFIRMED` nights.
  Timestamps are GMT ISO with trailing `.0` and **no zone** → parse as UTC.

### T2c · Body / biometrics — `DI-Connect-Wellness/10306743_{userBioMetrics,fitnessAgeData,bioMetrics_latest,userBioMetricProfileData}.json`
- `userBioMetrics.json` (560 KB): 1,031 versioned snapshots, 2018-08 → 2026-05.
  ~272 weight readings, ~171 full INDEX_SCALE composition sets, ~653 `vo2MaxRunning`,
  108 lactate-threshold-HR, 43 LT-speed, 10 FTP.
  - **Units:** weight/boneMass/muscleMass in **grams** (÷1000 for kg); bodyFat/bodyWater %.
  - `WellnessKind::Weight` exists → weight lands directly. **Body composition (bodyFat,
    bodyWater, boneMass, muscleMass, bmi) has NO variant** → new kinds or it's lost
    (Zepp's BODY parser already drops bmi/height too).
  - Versioned log keyed by `metaData.sequence` → dedupe by distinct `weight.timestampGMT`
    / vo2 change, not record count. `sourceType` MFP/MANUAL (user-entered) vs INDEX_SCALE.
- `fitnessAgeData.json` (449 KB): 704 daily records, 2021-06 → 2026-05 (Fitness Age,
  currentBioAge, biometricVo2Max, bmi, bodyFat, rhr) — Garmin-computed → Tier 3.
- The two single-row files = current-profile snapshots (they even disagree on FTP
  124 vs 207) → treat as profile metadata, not samples.

---

## Tier 3 — Performance / derived analytics (needs a model decision)

`DI-Connect-Metrics/` — 5 flat-JSON-array families, **~11,322 raw records / ~6,600
unique-day after dedup**. Heavy intra-day duplication (sync bursts) → **dedup by
`(calendarDate, sport, subSport)`, keep latest timestamp.**

| Family | Records / days | Range | Payload |
|---|---|---|---|
| `TrainingHistory_*` | 4030 / ~2267 | 2020-02→2026-05 | weeklyTrainingLoadSum, loadTunnelMin/Max, `trainingStatus` (8-value enum), fitness/load trend, feedback phrase (~47 strings) |
| `MetricsMaxMetData_*` | 631 / ~558 | 2019-11→2026-05 | `vo2MaxValue` (47–58), maxMet, category, per-sport |
| `RunRacePredictions_*` | 3440 / ~1934 | 2021-01→2026-05 | raceTime 5K/10K/Half/Marathon (**integer seconds**) |
| `MetricsHeatAltitudeAcclimation_*` | 3220 / ~1842 | 2020-10→2026-05 | altitudeAcclimation (m), heatAcclimationPercentage (0–100) — niche, mostly 0 |
| `ManualStressLevel_*` | **1 / 1** | 2020-08 | effectively empty → skip |

**Why this matters:** these are **Firstbeat proprietary** outputs Open Fit cannot
faithfully recompute — ~6 years of VO2max + race-prediction trend that's lost if not
ingested. **No clean home today:** `DerivedMetric` requires a `PluginRef` +
`DerivedSubject` (Activity|Day) and is a *plugin-output* type, not an import target;
`WellnessKind` has no VO2max/training-load/intensity-minutes variant.

Recommendation: ingest VO2max + training load + race predictions; defer
heat/altitude; drop ManualStressLevel. `trainingStatus`/feedback are categorical →
need an enum→code map or a string-payload extension (DerivedMetric value is a single f64).

---

## Tier 4 — Equipment & records (new entities)

`DI-Connect-Fitness/`:
- **`gear.json`** — 11 items (9 shoes, 2 bikes; 3 active, 8 retired) + **1,244
  gear→activity link rows** + 4 default-sport mappings. Distance is NOT stored
  (`maximumMeters` = user wear-limit) → real mileage = join links against imported
  activities and sum. `gearActivityDTOs` is a **map keyed by gearPk-string**, not an
  array. **No `Equipment` concept in ofit-core; `SourceKind` has no Equipment variant.**
- **`personalRecord.json`** — 32 rows, **13 current** (`current==true`), rest superseded.
  **Value units are type-dependent and unlabeled:** Farthest Run/Cycle + Max Elevation =
  meters; "Best 5k/10k/Half" = **time in seconds**; "Most Steps" = counts; Goal Streak =
  days. `activityId` references Garmin ids (0 for step/streak). `prStartTimeGMT` is a
  non-ISO `EEE MMM dd HH:mm:ss GMT yyyy` string.
- `workout.json` (212 structured templates) + `trainingPlan.json` (`[{}]`, empty) →
  **out of scope** (no template model). The schedule's `associatedActivityId` could
  later flag "planned vs actual" — future join.

---

## Out of scope / skip

- **Hydration** (`HydrationLogFile_*`, 1,351 recs): `valueInML` always 0, no goal — only
  `estimatedSweatLossInML` per activity (would need a new SweatLoss kind; better as a
  per-activity DerivedMetric). **Not the daily intake/goal you'd expect.**
- **Nutrition** (`nutritionLogs.json`, 67 recs): only a constant 1500-kcal MyFitnessPal
  *goal*, no actual calories/macros. Non-ingestible as nutrition.
- **Config (useful as profile/analytics seed, not time-series):** `heartRateZones.json`
  (rest 88 / LT 162 / max 184; Z floors 105/130/144/154/162), `powerZones.json`
  (cycling FTP 207W; XC-ski FTP 124W), `user_profile.json`, `user_settings.json`
  (locale fr), `UserGoal_*` (8000-step goal + NET_CALORIES history). Dates are
  `MMM d, yyyy` strings.
- **`IT_DEVICE_AND_CONTENT/devicesandcontent.json`** — 3 registered Garmin devices
  (unitId/serial/partNumber; part numbers identify exact models, e.g. the 945) →
  authoritative `Source` list if you want clean device attribution.
- **`DI-Connect-Routing/courses_*.json`** — 5 saved routes w/ lat/lon geometry (the two
  files are **byte-identical duplicates** → dedupe). Possible future Route feature, not
  a recorded activity.
- **Pure skip:** golf (`DI-GOLF`), social (2 comments/11 likes), consent history,
  `IT_GLOBAL_EVENT/events.json` (4,360 audit rows), livetrack, connectIQ id.
- **EXCLUDE — PII:** `user_contact.json` holds **third-party emergency contacts**
  (names/emails/phones) — not the account owner. Do not ingest/index.
- ~32 empty top-level dirs (aviation/AVC/inReach/Navionics/Tacx/Xero/baseball/marine…).

---

## Engineering issues that gate the build

1. **⚠️ O(N²) reclustering.** `crates/ofit-ingest/src/pipeline.rs:167`
   `recluster_and_persist` reloads **all** recordings + activities and re-runs
   `cluster_recordings_respecting` over the whole set **on every single import**.
   Importing ~1,560 activities one-by-one ≈ 1.2M comparisons + 1,560 full table
   reloads/rewrites (minutes–slow). For the full 35k it'd be catastrophic — but we only
   feed ~1,560 type-4 files. **Fix: add a batch path that inserts all recordings with
   exact-dedup, then clusters ONCE at the end** (e.g. `import_many(db, paths)`).
2. **No directory/batch entry point and no zip-of-FIT support.** Only per-file
   `import_path` / `import_bytes_path`. Zip handling exists ONLY in `zepp.rs`
   (`read_zepp_zip`) and is hardwired to the Zepp CSV/wellness path.
3. **No CLI binary.** The only workspace bin is `ofit-api` (axum). A one-time 195 MB job
   is either a new CLI bin or a new HTTP endpoint.
4. Minor: FIT parser drops `StreamKind::Wind` (only matters for Stryd wind).

---

## Existing code touchpoints (precedents + integration points)

**Activity (FIT) path — reuse as-is:**
- `ofit_ingest::import_bytes_path(db, name, bytes)` — `pipeline.rs:82` (what `POST
  /api/import` calls). Parse → SHA-256 exact-dedup → `ensure_source` (one per device) →
  `db.insert_recording` + `db.insert_streams` → `recluster_and_persist`.
- `fit.rs` — field→`StreamKind` extraction + `DeviceIdentity`/`garmin_product_name`.

**Wellness/JSON path — mirror the Zepp design (the template):**
- `crates/ofit-ingest/src/zepp.rs` — `read_zepp_zip(bytes)` extracts to scratch temp dir
  (traversal-safe via `enclosed_name`), `read_zepp_export(root)` walks tree, emits
  `ZeppImport { source_name, readings: Vec<WellnessReading{kind,value,ts}>, workouts,
  counts, skipped }`. (NB: Zepp is **CSV**; Garmin is **JSON** → use `serde_json`, but the
  output contract + API path are identical and reusable.)
- API consumer `handlers::import_zepp` (`handlers.rs:~591`): `db.ensure_source(Device,
  name)` → `db.delete_wellness_for_source(source_id)` (idempotent replace) →
  `WellnessSample::scalar(source_id, kind, value, ts)` → `db.insert_wellness_samples` in
  **5,000-row chunks**. Workout summaries → stream-less `RawRecording` + `Activity` with a
  stable content-hash, skipped if overlapping a real streamed activity.
- **New work:** add `crates/ofit-ingest/src/garmin.rs` (`read_garmin_export(path)` →
  `GarminImport{…}`), re-export from `lib.rs:41`, add `import_garmin` handler + route in
  `main.rs` next to `/import/zepp` (`main.rs:204`), add DTO in `dto.rs:~299`.

**Lowest-level DB sinks (`crates/ofit-db/src/lib.rs`):** `insert_recording` L294,
`insert_streams` L543, `insert_wellness_samples` L329 (batched, `ON CONFLICT
(source_id,kind,ts)`), `delete_wellness_for_source` L367, `ensure_source` L408,
`upsert_activity` L563, `recording_id_by_hash` L484. Wellness unique key
`(source_id,kind,ts)` — migration `0005_wellness_dedup.sql`.

---

## Core-model enums today (and gaps)

- `StreamKind` (16): HeartRate, Power, Cadence, Speed, Altitude, LatLng, Wind,
  Temperature, Distance, VerticalOscillation, GroundContactTime, StrideLength,
  VerticalRatio, FormPower, AirPower, LegSpringStiffness. *(FIT extracts all but Wind.)*
- `WellnessKind` (11): HeartRate, SleepStage, RestingHeartRate, Hrv, Stress,
  BodyBattery, Respiration, SpO2, Steps, Weight, Calories.
- `SleepStage`: Awake/Light/Deep/Rem (codes 0–3) — 1:1 with Garmin.
- `SourceKind`: Device, FileImport, Unknown. `Sport`: Running, Cycling, Swimming,
  Walking, Strength, Other.

**Missing for full Garmin coverage** (add `WellnessKind` variants and/or a
DerivedMetric naming scheme): IntensityMinutes (moderate/vigorous), Floors, Vo2Max,
TrainingLoad, FitnessAge, Hydration/SweatLoss, body composition (BodyFat, BodyWater,
BoneMass, MuscleMass, Bmi). Each new `WellnessKind` also touches the snake_case serde +
utoipa schema. **No Equipment entity** for gear; **no standalone records table** for PRs.

---

## Suggested build order (once scope is decided)

1. **Batch FIT path** — `import_many` (or a zip variant) that parses+exact-dedups+inserts
   all, then clusters once. Filter to `file_id.type == 4`. → Tier 1.
2. **`garmin.rs` JSON parser** + `import_garmin` handler → UDSFile (T2a), weight (T2c) into
   existing kinds; sleep (T2b) per chosen sleep model.
3. **(If T3)** add VO2max/training-load model (new kinds or garmin-import DerivedMetric);
   parse `DI-Connect-Metrics/`.
4. **(If T4)** Equipment entity + activity-link + records table; parse gear/PRs.
5. **Enrichment pass (optional)** — timestamp-join `summarizedActivities` to set
   activity names/location/Garmin TSS.
6. Optionally seed `Source` from `devicesandcontent.json` and user profile/zones from config.

---

## OPEN DECISIONS (for later)

1. **Scope:** Activities only / **Activities + daily wellness (recommended)** / Everything
   feasible incl. T3+T4.
2. **Where do VO2max / training load / race predictions / fitness age land?**
   New `WellnessKind` variants / `DerivedMetric` tagged `garmin-import` / skip.
3. **Delivery:** **new `ofit-import` CLI bin (recommended for a 195 MB one-shot)** /
   new `/import/garmin` HTTP endpoint / reuse per-file `/api/import` (not viable for JSON).
4. **Sleep model:** add nightly-summary sleep kinds vs approximate from durations.
5. **Body composition & intensity minutes:** add new wellness kinds or drop.
