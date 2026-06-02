// Typed endpoint wrappers over the thin transport in ./client.
//
// TODO(api-first): these will be superseded by the OpenAPI-generated client.
// Until the schema exists they are hand-written but deliberately TOLERANT of
// field-name drift (the task's API contract is "indicative"): we normalize a
// few likely aliases here, at the boundary, so the UI sees one stable shape.

import { apiFetch, apiPostForm, apiSend, ApiError, API_BASE, getToken } from "./client";
import { isNativeApp } from "../app/isNativeApp";
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

/** Like `num` but returns null (not a fallback) when absent/non-numeric — for
 *  genuinely-optional fields where "no value" must stay distinguishable from 0. */
function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : null;
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
      last_synced_at: (pick(o, "last_synced_at", "last_sync") as string | null) ?? null,
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
      distance_m: numOrNull(pick(o, "distance_m", "distance")),
      calories: numOrNull(pick(o, "calories", "calories_kcal")),
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

/**
 * DELETE /api/activities/{id} — **hard-delete** an entire activity (its
 * recordings, streams, derived outputs, gear + preference links). Irreversible.
 * Used by the activity Edit tab's "Delete activity" action.
 */
export async function deleteActivity(id: string): Promise<void> {
  await apiSend<unknown>(`/api/activities/${encodeURIComponent(id)}`, "DELETE");
}

/** Result of {@link deleteSource}: whether the activity itself was removed
 *  (last source) and, if not, the re-resolved activity to refresh the view. */
export interface DeleteSourceResult {
  activity_deleted: boolean;
  activity: ActivityDetail | null;
}

/**
 * DELETE /api/activities/{id}/sources/{recording_id} — **hard-delete** one
 * source (recording + streams) from an activity. If it was the activity's last
 * source the whole activity is deleted (`activity_deleted: true`); otherwise the
 * re-resolved, re-tightened activity comes back so the detail refreshes in place.
 */
export async function deleteSource(
  activityId: string,
  recordingId: string,
): Promise<DeleteSourceResult> {
  const raw = await apiSend<unknown>(
    `/api/activities/${encodeURIComponent(activityId)}/sources/${encodeURIComponent(recordingId)}`,
    "DELETE",
  );
  const o = (raw ?? {}) as Record<string, unknown>;
  const activityRaw = pick(o, "activity");
  return {
    activity_deleted: Boolean(pick(o, "activity_deleted")),
    activity: activityRaw ? normalizeActivityDetail(activityRaw, activityId) : null,
  };
}

/** How {@link exportActivityFit} finished. */
export interface ExportResult {
  /**
   * - `saved`: written to a file the user picked (browser Save-As dialog).
   * - `shared`: handed to the native share/save sheet (mobile).
   * - `downloaded`: ordinary browser download (no picker available).
   * - `canceled`: the user dismissed the picker / share sheet.
   */
  outcome: "saved" | "shared" | "downloaded" | "canceled";
  /** Chosen filename / file URI, when known. */
  path?: string;
}

/* --- File System Access API ("Save As"); not in TS 5.x lib.dom yet, so typed
   minimally here and feature-detected at the call site (Chromium-only). --- */
interface FsWritableLike {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}
interface FsFileHandleLike {
  name: string;
  createWritable(): Promise<FsWritableLike>;
}
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}
type ShowSaveFilePicker = (opts?: SaveFilePickerOptions) => Promise<FsFileHandleLike>;

/** True for the "user dismissed the dialog/sheet" rejection (not a real error). */
function isCancel(e: unknown): boolean {
  if (e instanceof DOMException && e.name === "AbortError") return true;
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return msg.includes("abort") || msg.includes("cancel") || msg.includes("dismiss");
}

/** Blob → bare base64 (no `data:` prefix), for Capacitor `Filesystem.writeFile`. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => {
      const s = typeof r.result === "string" ? r.result : "";
      const comma = s.indexOf(",");
      resolve(comma >= 0 ? s.slice(comma + 1) : s); // strip "data:…;base64,"
    };
    r.onerror = () => reject(r.error ?? new Error("blob read failed"));
    r.readAsDataURL(blob);
  });
}

/** Fetch the export bytes with the client's cookie/Bearer auth. */
async function fetchExportBlob(url: string, token: string): Promise<Blob> {
  const res = await fetch(url, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new ApiError(`${res.status} ${res.statusText}`, res.status);
  return res.blob();
}

/** Click a hidden `<a download>` to start a download. `href` may be a real URL
 *  (browser streams it from the server) or a `blob:` URL. */
function clickDownloadAnchor(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Ordinary browser download (no Save-As picker available). */
async function browserDownload(url: string, filename: string, token: string): Promise<ExportResult> {
  // Cookie / disabled-auth, same-origin: a direct anchor is most reliable — no
  // fetch/blob/await before the click (keeps the user-gesture), no revoke race.
  if (!token) {
    clickDownloadAnchor(url, filename);
    return { outcome: "downloaded" };
  }
  // Bearer auth can't ride a navigation → fetch with the header, download a blob.
  const blob = await fetchExportBlob(url, token);
  const objUrl = URL.createObjectURL(blob);
  clickDownloadAnchor(objUrl, filename);
  setTimeout(() => URL.revokeObjectURL(objUrl), 10_000); // late revoke
  return { outcome: "downloaded" };
}

/**
 * GET /api/activities/{id}/export.fit — save the activity as a `.fit` file,
 * letting the user choose WHERE on each platform:
 *  - **Mobile (Capacitor)**: write the bytes to a cache file, then open the
 *    native share/save sheet (`@capacitor/share`) so the user picks Files /
 *    Drive / email / etc.
 *  - **Browser with the File System Access API** (Chromium): a real "Save As"
 *    dialog via `showSaveFilePicker()` — opened FIRST (within the click) so the
 *    user gesture isn't lost, then the bytes are streamed into the chosen file.
 *  - **Other browsers** (Firefox/Safari — no picker API): an ordinary download
 *    (its location follows the browser's "ask where to save each file" setting).
 *
 * Resolves with how it ended (incl. `canceled` when the user dismisses the
 * picker/sheet). Throws ApiError on a non-2xx.
 */
export async function exportActivityFit(id: string): Promise<ExportResult> {
  const filename = `activity-${id}.fit`;
  const url = `${API_BASE}/api/activities/${encodeURIComponent(id)}/export.fit`;
  const token = getToken();

  // --- Mobile: save to a cache file, then the OS sheet picks the destination.
  if (isNativeApp()) {
    const blob = await fetchExportBlob(url, token);
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([
      import("@capacitor/filesystem"),
      import("@capacitor/share"),
    ]);
    const base64 = await blobToBase64(blob);
    const written = await Filesystem.writeFile({
      path: filename,
      data: base64, // no `encoding` ⇒ written as binary from base64
      directory: Directory.Cache,
      recursive: true,
    });
    try {
      await Share.share({
        title: filename,
        files: [written.uri], // shared via Android FileProvider → "Save to Files"…
        dialogTitle: "Save or share activity",
      });
      return { outcome: "shared", path: written.uri };
    } catch (e) {
      if (isCancel(e)) return { outcome: "canceled" };
      throw e;
    }
  }

  // --- Browser with a real "Save As" picker (Chromium File System Access API).
  const picker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker;
  if (typeof picker === "function") {
    let handle: FsFileHandleLike;
    try {
      // Open the picker FIRST (within the click gesture) so it isn't blocked.
      handle = await picker({
        suggestedName: filename,
        types: [{ description: "FIT activity", accept: { "application/octet-stream": [".fit"] } }],
      });
    } catch (e) {
      if (isCancel(e)) return { outcome: "canceled" };
      throw e;
    }
    const blob = await fetchExportBlob(url, token);
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return { outcome: "saved", path: handle.name };
  }

  // --- Fallback: ordinary browser download.
  return browserDownload(url, filename, token);
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

/** Response of POST /api/import/garmin (one-time history backfill). */
export interface GarminImportResult {
  source: string;
  wellness_ingested: number;
  by_kind: { kind: string; count: number }[];
  days: number;
  nights: number;
  gear_imported: number;
  personal_records: number;
  fit_activities_imported: number;
  fit_duplicates: number;
  fit_skipped_non_activity: number;
  fit_parse_errors: number;
  activities_total: number;
  recompute_activities: number;
  recompute_wellness_points: number;
  skipped: string[];
}

/** Background-job status for the Garmin import (the import runs minutes, so the
 *  POST returns immediately and the UI polls this). */
export interface GarminJobState {
  running: boolean;
  started: boolean;
  phase: string;
  result: GarminImportResult | null;
  error: string | null;
}

/** POST /api/import/garmin — START a backfill from an export directory already on
 *  the server's disk (`{path}`). Returns immediately; poll getGarminImportStatus. */
export async function importGarmin(path: string): Promise<GarminJobState> {
  return apiSend<GarminJobState>("/api/import/garmin", "POST", { path });
}

/** POST /api/import/garmin/upload — START a backfill from an uploaded export .zip
 *  (the whole Garmin GDPR download). Returns immediately; poll the status. */
export async function importGarminZip(file: File): Promise<GarminJobState> {
  const form = new FormData();
  form.append("file", file, file.name);
  return apiPostForm<GarminJobState>("/api/import/garmin/upload", form);
}

/** GET /api/import/garmin/status — current background-import status. */
export async function getGarminImportStatus(): Promise<GarminJobState> {
  return apiFetch<GarminJobState>("/api/import/garmin/status");
}

/** One personal record (best-ever performance) imported from Garmin. */
export interface PersonalRecord {
  id: string;
  record_type: string;
  value: number;
  unit: string; // "seconds" | "meters" | "count"
  occurred_at: string;
  source: string;
  current: boolean;
}

/** GET /api/personal-records — all imported personal records, newest first. */
export async function getPersonalRecords(): Promise<PersonalRecord[]> {
  const raw = await apiFetch<unknown>("/api/personal-records");
  return Array.isArray(raw) ? (raw as PersonalRecord[]) : [];
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

/** POST /api/maintenance/clamp-hr — drop heart-rate samples above the
 *  "Max HR Allowed" setting (scrubs device-artifact spikes). Returns the count. */
export async function clampHr(): Promise<{ deleted: number; max_hr: number }> {
  return apiSend<{ deleted: number; max_hr: number }>("/api/maintenance/clamp-hr", "POST");
}

/* ------------------------------------------------------------ gear */

/** Gear as the API returns it (snake_case domain shape from ofit-core::Gear). */
export interface ApiGear {
  id: string;
  name: string;
  description: string;
  sport: string;
  initial_km: number;
  retire_km: number;
  used_km: number;
  icon: string;
  created_at: string;
}

/** Composite gear state: gear + default-per-type + per-activity assignments. */
export interface GearState {
  gears: ApiGear[];
  defaults: Record<string, string>;
  assignments: Record<string, string[]>;
}

/** GET /api/gear — full gear state for the UI store. */
export async function getGear(): Promise<GearState> {
  const raw = await apiFetch<Partial<GearState>>("/api/gear");
  return {
    gears: Array.isArray(raw?.gears) ? (raw!.gears as ApiGear[]) : [],
    defaults: (raw?.defaults as Record<string, string>) ?? {},
    assignments: (raw?.assignments as Record<string, string[]>) ?? {},
  };
}

/** POST /api/gear — create a piece of gear. */
export async function createGear(body: {
  name: string;
  description?: string;
  sport: string;
  initial_km?: number;
  retire_km?: number;
  icon?: string;
}): Promise<ApiGear> {
  return apiSend<ApiGear>("/api/gear", "POST", body);
}

/** PUT /api/gear/{id} — patch editable fields. */
export async function updateGearApi(
  id: string,
  patch: {
    name?: string;
    description?: string;
    sport?: string;
    retire_km?: number;
    used_km?: number;
    icon?: string;
  },
): Promise<ApiGear> {
  return apiSend<ApiGear>(`/api/gear/${encodeURIComponent(id)}`, "PUT", patch);
}

/** DELETE /api/gear/{id}. */
export async function deleteGear(id: string): Promise<void> {
  await apiSend<unknown>(`/api/gear/${encodeURIComponent(id)}`, "DELETE");
}

/** PUT /api/gear/defaults — set (or clear with `null`) the default gear for a type. */
export async function setGearDefaultApi(sport: string, gearId: string | null): Promise<void> {
  await apiSend<unknown>("/api/gear/defaults", "PUT", { sport, gear_id: gearId });
}

/** PUT /api/activities/{id}/gear — replace an activity's gear set. */
export async function setActivityGearApi(activityId: string, gearIds: string[]): Promise<void> {
  await apiSend<unknown>(
    `/api/activities/${encodeURIComponent(activityId)}/gear`,
    "PUT",
    { gear_ids: gearIds },
  );
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
  // A full recompute is O(all-data) and runs synchronously, so it can exceed the
  // default 60s on large accounts — disable the client timeout. The POST resolves
  // only when the recompute has finished and persisted.
  return apiFetch<RecomputeResponseDto>("/api/analytics/recompute", { method: "POST" }, { timeoutMs: 0 });
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
export async function getDerived(
  subject: string,
  variants?: "active" | "all",
): Promise<DerivedResponseDto> {
  const qs = new URLSearchParams({ subject });
  if (variants) qs.set("variants", variants);
  const raw = await apiFetch<DerivedResponseDto>(
    `/api/analytics/derived?${qs.toString()}`,
  );
  return {
    subject: raw?.subject ?? subject,
    metrics: Array.isArray(raw?.metrics) ? raw.metrics : [],
    streams: Array.isArray(raw?.streams) ? raw.streams : [],
  };
}

/* --------------------------------------------- analytics: parameters & variants
 * The computed-values overhaul: every algorithm constant is a tunable parameter
 * (a "derivation" = plugin + code version + parameter set); changing one forks a
 * new comparable variant you can switch between and diff. */

/** One tunable analytics parameter with its registry metadata + current value. */
export interface AnalyticsParameter {
  key: string;
  label: string;
  description: string;
  unit: string;
  group: string;
  tier: "curated" | "advanced";
  integer: boolean;
  min: number | null;
  max: number | null;
  default: number;
  value: number;
  plugins: string[];
}

/** GET /api/analytics/parameters — every tunable parameter + its effective value. */
export async function getParameters(): Promise<AnalyticsParameter[]> {
  const raw = await apiFetch<unknown>("/api/analytics/parameters");
  return Array.isArray(raw) ? (raw as AnalyticsParameter[]) : [];
}

/** Result of applying parameter changes (which runs a full recompute). */
export interface SetParametersResult {
  applied: string[];
  rejected: string[];
  recompute: RecomputeResponseDto;
}

/**
 * PUT /api/analytics/parameters — set one or more parameters, then run a FULL
 * recompute so the new parameter set's variant exists (and becomes the active
 * newest). O(all-data) + synchronous → no client timeout.
 */
export async function setParameters(
  updates: { key: string; value: number }[],
  resetOthers = false,
): Promise<SetParametersResult> {
  return apiFetch<SetParametersResult>(
    "/api/analytics/parameters",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates, reset_others: resetOthers }),
    },
    { timeoutMs: 0 },
  );
}

/** One catalogued derivation variant of a plugin. */
export interface DerivationVariant {
  plugin_id: string;
  version: string;
  params_hash: string;
  params: Record<string, number>;
  label: string;
  first_computed_at: string;
  last_computed_at: string;
  active_default: boolean;
}

/** GET /api/analytics/variants — catalogued variants, optionally for one plugin. */
export async function getVariants(plugin?: string): Promise<DerivationVariant[]> {
  const qs = plugin ? `?plugin=${encodeURIComponent(plugin)}` : "";
  const raw = await apiFetch<unknown>(`/api/analytics/variants${qs}`);
  return Array.isArray(raw) ? (raw as DerivationVariant[]) : [];
}

/** Pin (or clear) which variant a plugin resolves to — globally or per activity. */
export async function setSelection(body: {
  scope: "default" | "activity";
  plugin_id: string;
  subject_id?: string;
  version?: string;
  params_hash?: string;
  clear?: boolean;
}): Promise<unknown> {
  return apiSend<unknown>("/api/analytics/selection", "PUT", body);
}
