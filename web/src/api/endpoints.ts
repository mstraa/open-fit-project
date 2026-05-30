// Typed endpoint wrappers over the thin transport in ./client.
//
// TODO(api-first): these will be superseded by the OpenAPI-generated client.
// Until the schema exists they are hand-written but deliberately TOLERANT of
// field-name drift (the task's API contract is "indicative"): we normalize a
// few likely aliases here, at the boundary, so the UI sees one stable shape.

import { apiFetch, apiPostForm, apiSend } from "./client";
import type {
  ActivityDetail,
  ActivitySummary,
  ImportFileOutcome,
  ImportResponse,
  LatLngSample,
  MetricSourcePreference,
  RecordingInfo,
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

export async function getActivity(id: string): Promise<ActivityDetail> {
  const raw = await apiFetch<unknown>(`/api/activities/${encodeURIComponent(id)}`);
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

  return { id: str(pick(o, "id")) || id, recordings, resolved, preferences };
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
  const arr = Array.isArray(raw)
    ? raw
    : ((raw as Record<string, unknown> | null)?.samples as unknown[]) ?? [];
  const samples: WellnessSample[] = (Array.isArray(arr) ? arr : []).map((s) => {
    const p = s as Record<string, unknown>;
    return {
      date: str(pick(p, "date", "day", "timestamp", "t")),
      value: num(pick(p, "value", "v")),
      value2:
        pick(p, "value2", "v2") !== undefined ? num(pick(p, "value2", "v2")) : undefined,
    } satisfies WellnessSample;
  });
  return { kind, samples };
}
