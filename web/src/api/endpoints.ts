// Typed endpoint wrappers over the thin transport in ./client.
//
// TODO(api-first): these will be superseded by the OpenAPI-generated client.
// Until the schema exists they are hand-written but deliberately TOLERANT of
// field-name drift (the task's API contract is "indicative"): we normalize a
// few likely aliases here, at the boundary, so the UI sees one stable shape.

import { apiFetch, apiPostForm, apiSend, ApiError } from "./client";
import type {
  AlgorithmDto,
  RecomputeResponseDto,
  TrainingLoadResponseDto,
  DerivedResponseDto,
} from "./schema";
import type {
  ActivityDetail,
  ActivitySummary,
  ImportFileOutcome,
  ImportResponse,
  LatLngSample,
  MetricSourcePreference,
  RecordingInfo,
  RemoveRecordingResponse,
  ResolvedMetric,
  ScalarSample,
  Source,
  StreamKind,
  VersionInfo,
  WellnessSample,
  WellnessSeries,
} from "./types";

/* ---------------------------------------------------------------- helpers */

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Pick the first defined value among several candidate keys on an object. */
function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

/* ------------------------------------------------------------- sources */

export async function listSources(): Promise<Source[]> {
  const raw = await apiFetch<unknown>("/api/sources");
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      id: str(pick(o, "id", "source_id")),
      kind: (str(pick(o, "kind"), "unknown") as Source["kind"]) ?? "unknown",
      name: str(pick(o, "name", "source_name"), "Unknown source"),
      manufacturer: (pick(o, "manufacturer") as string | null) ?? null,
      default_priority: num(pick(o, "default_priority", "priority")),
      created_at: str(pick(o, "created_at")) || undefined,
    };
  });
}

/* ---------------------------------------------------------- activities */

export async function listActivities(): Promise<ActivitySummary[]> {
  const raw = await apiFetch<unknown>("/api/activities");
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((r) => {
    const o = r as Record<string, unknown>;
    const started = str(pick(o, "started_at", "start", "start_time"));
    const ended = str(pick(o, "ended_at", "end", "end_time"));
    let dur = num(pick(o, "duration_secs", "duration", "duration_seconds"), NaN);
    if (!Number.isFinite(dur) && started && ended) {
      dur = Math.max(0, (Date.parse(ended) - Date.parse(started)) / 1000);
    }
    return {
      id: str(pick(o, "id", "activity_id")),
      sport: (str(pick(o, "sport"), "other") as ActivitySummary["sport"]),
      started_at: started,
      ended_at: ended,
      recording_count: num(
        pick(o, "recording_count", "recordings_count", "num_recordings"),
      ),
      duration_secs: Number.isFinite(dur) ? dur : 0,
    };
  });
}

const SCALAR_KINDS: StreamKind[] = [
  "heart_rate",
  "power",
  "cadence",
  "speed",
  "altitude",
  "wind",
  "temperature",
  "distance",
];

function normalizeResolvedMetric(kind: StreamKind, raw: unknown): ResolvedMetric {
  const o = (raw ?? {}) as Record<string, unknown>;
  const out: ResolvedMetric = {
    source_id: str(pick(o, "source_id", "source")),
    recording_id: str(pick(o, "recording_id")) || undefined,
    selected_by: pick(o, "selected_by", "selection_reason") as
      | ResolvedMetric["selected_by"],
  };
  // Samples can live at .samples or directly be an array; tracks at .track/.samples.
  const samplesRaw =
    (pick(o, "samples", "track", "points") as unknown[] | undefined) ??
    (Array.isArray(raw) ? (raw as unknown[]) : undefined);

  if (Array.isArray(samplesRaw)) {
    if (kind === "lat_lng") {
      out.track = samplesRaw
        .map((s) => {
          const p = s as Record<string, unknown>;
          return {
            t_offset_ms: num(pick(p, "t_offset_ms", "t")),
            lat: num(pick(p, "lat", "latitude")),
            lng: num(pick(p, "lng", "lon", "longitude")),
          } satisfies LatLngSample;
        })
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    } else {
      out.samples = samplesRaw.map((s) => {
        const p = s as Record<string, unknown>;
        return {
          t_offset_ms: num(pick(p, "t_offset_ms", "t")),
          value: num(pick(p, "value", "v")),
        } satisfies ScalarSample;
      });
    }
  }
  return out;
}

/** Normalize a raw activity-detail payload (GET /api/activities/{id} or the
 * `activity` field of the remove-recording response) into the view model. */
function normalizeActivityDetail(raw: unknown, fallbackId: string): ActivityDetail {
  const o = (raw ?? {}) as Record<string, unknown>;

  const recordingsRaw = (pick(o, "recordings") as unknown[]) ?? [];
  const recordings: RecordingInfo[] = recordingsRaw.map((r) => {
    const rr = r as Record<string, unknown>;
    // API field is `available_metrics`; keep older aliases as a fallback.
    const kinds = (pick(rr, "available_metrics", "stream_kinds", "kinds") as unknown[]) ?? [];
    return {
      id: str(pick(rr, "id", "recording_id")),
      source_id: str(pick(rr, "source_id")),
      source_name: str(pick(rr, "source_name", "source"), "Unknown source"),
      format: str(pick(rr, "format"), "?"),
      stream_kinds: kinds.filter((k): k is StreamKind => typeof k === "string"),
    };
  });

  // The API returns scalar metrics as an array `resolved_metrics` (each carrying
  // `points`) plus a separate top-level `track` + `track_source_id` for lat_lng.
  // Older/alternate shape: a `resolved` map keyed by StreamKind. Support both,
  // normalizing into the map the views consume.
  const resolved: ActivityDetail["resolved"] = {};
  const resolvedArr = pick(o, "resolved_metrics") as unknown[] | undefined;
  if (Array.isArray(resolvedArr)) {
    for (const m of resolvedArr) {
      const mm = m as Record<string, unknown>;
      const kind = str(pick(mm, "kind")) as StreamKind;
      if (kind) resolved[kind] = normalizeResolvedMetric(kind, mm);
    }
    const track = pick(o, "track") as unknown[] | undefined;
    if (Array.isArray(track)) {
      const m = normalizeResolvedMetric("lat_lng", { samples: track });
      m.source_id = str(pick(o, "track_source_id")) || m.source_id;
      resolved.lat_lng = m;
    }
  } else {
    const resolvedRaw = (pick(o, "resolved", "resolved_view") ?? {}) as Record<
      string,
      unknown
    >;
    for (const kind of [...SCALAR_KINDS, "lat_lng" as StreamKind]) {
      if (resolvedRaw[kind] !== undefined) {
        resolved[kind] = normalizeResolvedMetric(kind, resolvedRaw[kind]);
      }
    }
  }

  const prefsRaw = (pick(o, "preferences") as unknown[]) ?? [];
  const preferences = prefsRaw.map((p) => normalizePreference(p));

  // Summary-only activities (e.g. Zepp SPORT) carry totals instead of streams.
  const summaryRaw = pick(o, "summary") as Record<string, unknown> | null | undefined;
  const summary = summaryRaw
    ? {
        distance_m: num(pick(summaryRaw, "distance_m")),
        calories_kcal: num(pick(summaryRaw, "calories_kcal")),
        avg_pace_s_per_m: num(pick(summaryRaw, "avg_pace_s_per_m")),
      }
    : undefined;

  const startedAt = str(pick(o, "started_at", "start"));
  const endedAt = str(pick(o, "ended_at", "end"));
  let duration = num(pick(o, "duration_secs", "duration"), NaN);
  if (!Number.isFinite(duration) && startedAt && endedAt) {
    duration = Math.max(0, (Date.parse(endedAt) - Date.parse(startedAt)) / 1000);
  }

  return {
    id: str(pick(o, "id")) || fallbackId,
    sport: (str(pick(o, "sport"), "other") as ActivityDetail["sport"]),
    started_at: startedAt || undefined,
    ended_at: endedAt || undefined,
    duration_secs: Number.isFinite(duration) ? duration : undefined,
    recordings,
    resolved,
    preferences,
    summary,
  };
}

export async function getActivity(id: string): Promise<ActivityDetail> {
  const raw = await apiFetch<unknown>(`/api/activities/${encodeURIComponent(id)}`);
  return normalizeActivityDetail(raw, id);
}

/**
 * DELETE /api/activities/{id}/recordings/{recording_id} — durable manual split.
 * Detaches one recording (a single device's contribution) into its own new
 * single-recording activity; returns the re-resolved trimmed original plus the
 * id of the detached activity. Both ends are marked user_confirmed server-side,
 * so re-import / re-clustering will not merge them back.
 *
 * Errors: 400 (not a member, or the activity's only recording — no-op),
 * 404 (activity not found). These surface as thrown errors from apiSend.
 */
export async function removeRecording(
  activityId: string,
  recordingId: string,
): Promise<RemoveRecordingResponse> {
  const raw = await apiSend<unknown>(
    `/api/activities/${encodeURIComponent(activityId)}/recordings/${encodeURIComponent(recordingId)}`,
    "DELETE",
  );
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    activity: normalizeActivityDetail(pick(o, "activity"), activityId),
    detached_activity_id: str(pick(o, "detached_activity_id", "detached_id")),
  };
}

/* --------------------------------------------------------- preferences */

function normalizePreference(raw: unknown): MetricSourcePreference {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    id: str(pick(o, "id")) || undefined,
    metric: str(pick(o, "metric")) as StreamKind,
    scope: (str(pick(o, "scope"), "default") as MetricSourcePreference["scope"]),
    activity_id: (pick(o, "activity_id") as string | null) ?? null,
    source_id: str(pick(o, "source_id")),
    retroactive: Boolean(pick(o, "retroactive")),
    updated_at: str(pick(o, "updated_at")) || undefined,
  };
}

export async function listPreferences(): Promise<MetricSourcePreference[]> {
  const raw = await apiFetch<unknown>("/api/preferences");
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map(normalizePreference);
}

/**
 * PUT /api/preferences. Sends the canonical MetricSourcePreference shape.
 * `retroactive` only matters for scope === 'default'.
 */
export async function putPreference(
  pref: MetricSourcePreference,
): Promise<MetricSourcePreference> {
  const res = await apiSend<unknown>("/api/preferences", "PUT", pref);
  return res ? normalizePreference(res) : pref;
}

/* -------------------------------------------------------------- import */

export async function importFiles(files: FileList | File[]): Promise<ImportFileOutcome[]> {
  const list = Array.from(files);
  const form = new FormData();
  for (const f of list) form.append("file", f, f.name);
  const res = await apiPostForm<ImportResponse>("/api/import", form);
  const arr = Array.isArray(res) ? res : (res?.results ?? []);
  return arr;
}

/** Stream wellness samples into the API (the live BLE / relay write path). */
export async function ingestWellness(
  items: { kind: string; value: number; ts?: string }[],
): Promise<{ ingested: number }> {
  return apiSend<{ ingested: number }>("/api/wellness", "POST", items);
}

/** One device's result from POST /api/import/gadgetbridge. */
export interface GadgetbridgeDeviceResult {
  device: string;
  manufacturer?: string | null;
  ingested: number;
  by_kind: { kind: string; count: number }[];
}

/** Response of POST /api/import/gadgetbridge (the DB can hold many devices). */
export interface GadgetbridgeImportResult {
  devices: GadgetbridgeDeviceResult[];
  ingested: number;
}

/** Upload an exported Gadgetbridge SQLite DB → ingest its wellness. */
export async function importGadgetbridge(file: File): Promise<GadgetbridgeImportResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  return apiPostForm<GadgetbridgeImportResult>("/api/import/gadgetbridge", form);
}

/** Response of POST /api/import/zepp (one Zepp account export .zip). */
export interface ZeppImportResult {
  source: string;
  ingested: number;
  by_kind: { kind: string; count: number }[];
  activities_imported: number;
  activities_skipped_dup: number;
  duplicate_summaries_removed: number;
  skipped: string[];
}

/** Upload a zipped Zepp/Amazfit app export → ingest its wellness. */
export async function importZepp(file: File): Promise<ZeppImportResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  return apiPostForm<ZeppImportResult>("/api/import/zepp", form);
}

/* ------------------------------------------------------------- version */

/** GET /api/version — backend build/version metadata. Tolerant of field drift. */
export async function getVersion(): Promise<VersionInfo> {
  const raw = await apiFetch<unknown>("/api/version");
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    version: str(pick(o, "version", "ver"), "unknown"),
    commit: (pick(o, "commit", "git_sha", "sha") as string | undefined) || undefined,
    build: (pick(o, "build", "build_time", "built_at") as string | undefined) || undefined,
    ...o,
  };
}

/* ------------------------------------------------------------ settings */

/** GET /api/settings — account/server-bound preferences as a `{ key: value }` map. */
export async function getSettings(): Promise<Record<string, string>> {
  const raw = await apiFetch<unknown>("/api/settings");
  return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
}

/** PUT /api/settings — upsert one setting; returns the full updated map. */
export async function setSetting(key: string, value: string): Promise<Record<string, string>> {
  return apiSend<Record<string, string>>("/api/settings", "PUT", { key, value });
}

/* ------------------------------------------------------------ wellness */

/**
 * GET /api/wellness?kind=...&from=...&to=... — daily wellness series
 * (resting HR, HRV, body battery, sleep, stress …). No backend data exists yet
 * for most kinds; this returns an empty series rather than throwing on shapes it
 * doesn't recognize, so screens render the on-brand empty state.
 */
export async function getWellness(
  kind: string,
  from?: string,
  to?: string,
): Promise<WellnessSeries> {
  const qs = new URLSearchParams({ kind });
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const raw = await apiFetch<unknown>(`/api/wellness?${qs.toString()}`);
  // The backend returns `{ kind, points: [{ ts, value, source_id }] }`.
  // (Older shapes used `samples`; accept either so we never silently empty out.)
  const o = raw as Record<string, unknown> | null;
  const arr = Array.isArray(raw)
    ? raw
    : ((o?.points as unknown[]) ?? (o?.samples as unknown[]) ?? []);
  const samples: WellnessSample[] = (Array.isArray(arr) ? arr : []).map((s) => {
    const p = s as Record<string, unknown>;
    return {
      date: str(pick(p, "ts", "date", "day", "timestamp", "t")),
      value: num(pick(p, "value", "v")),
      value2:
        pick(p, "value2", "v2") !== undefined ? num(pick(p, "value2", "v2")) : undefined,
    } satisfies WellnessSample;
  });
  return { kind, samples };
}

/* ------------------------------------------------------------ analytics */
// These bind to the Phase-3 analytics REST surface. The shapes come straight
// from the OpenAPI-generated schema (./schema.ts) so they can't drift; the
// server returns them verbatim, so no field normalization is needed here.

/**
 * GET /api/algorithms — the registry of built-in + WASM-plugin algorithms.
 * Each carries id/version/name/description, declared inputs (as `stream:<kind>`
 * / `wellness:<kind>` tags), output names, applicable hardware, `kind`
 * (`built_in` | `wasm`) and an `enabled` flag.
 */
export async function listAlgorithms(): Promise<AlgorithmDto[]> {
  const raw = await apiFetch<unknown>("/api/algorithms");
  return Array.isArray(raw) ? (raw as AlgorithmDto[]) : [];
}

/**
 * POST /api/analytics/recompute — runs every enabled algorithm over all
 * activities + wellness, persisting (idempotently, superseding by
 * plugin+version+subject+name) the derived metrics/streams. Returns per-algorithm
 * and total output counts.
 */
export async function recomputeAnalytics(): Promise<RecomputeResponseDto> {
  return apiSend<RecomputeResponseDto>("/api/analytics/recompute", "POST");
}

const EMPTY_TRAINING_LOAD: TrainingLoadResponseDto = {
  series: [],
  readiness: null,
  readiness_available: false,
  hrv_rmssd: null,
  hrv_baseline: null,
};

/**
 * GET /api/analytics/training-load — the dated CTL/ATL/TSB series plus the
 * latest readiness / HRV summary. Returns an EMPTY result (not a throw) when the
 * API is unreachable or analytics haven't been computed, so the dashboard shows
 * its on-brand "No data yet" empty state rather than an error.
 */
export async function getTrainingLoad(): Promise<TrainingLoadResponseDto> {
  try {
    const raw = await apiFetch<TrainingLoadResponseDto>("/api/analytics/training-load");
    if (!raw || !Array.isArray(raw.series)) return EMPTY_TRAINING_LOAD;
    return {
      series: raw.series,
      readiness: raw.readiness ?? null,
      readiness_available: Boolean(raw.readiness_available),
      hrv_rmssd: raw.hrv_rmssd ?? null,
      hrv_baseline: raw.hrv_baseline ?? null,
    };
  } catch (e) {
    if (e instanceof ApiError) return EMPTY_TRAINING_LOAD;
    throw e;
  }
}

/**
 * GET /api/analytics/derived?subject=activity:{uuid} | day:{YYYY-MM-DD} —
 * the chart-ready derived metrics + streams for one subject. 400 on a malformed
 * subject (surfaces as a thrown ApiError).
 */
export async function getDerived(subject: string): Promise<DerivedResponseDto> {
  const qs = new URLSearchParams({ subject });
  const raw = await apiFetch<DerivedResponseDto>(
    `/api/analytics/derived?${qs.toString()}`,
  );
  return {
    subject: raw?.subject ?? subject,
    metrics: Array.isArray(raw?.metrics) ? raw.metrics : [],
    streams: Array.isArray(raw?.streams) ? raw.streams : [],
  };
}
