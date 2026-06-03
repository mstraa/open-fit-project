// Hand-written API-boundary types — CENTRALIZED here on purpose.
//
// TODO(api-first): replace this whole file with the OpenAPI-generated client
// (`npm run gen:api` → src/api/generated/) once ofit-api exposes its utoipa
// schema. Until then these mirror the canonical ofit-core types (snake_case
// enums via serde) and the Phase-1 REST shapes described in docs/STATUS.md.
// Everything that touches the network goes through here so the swap is trivial.
//
// The client (see endpoints.ts) is deliberately TOLERANT of field-name drift:
// the API contract in the task brief is "indicative", so we normalize a few
// likely aliases at the boundary rather than scatter optionals across the UI.

// Enums now come from the OpenAPI-generated schema (./schema.ts), so they can't
// drift from the server. Imported for local use in the view-model interfaces
// below AND re-exported for the rest of the app.
import type {
  Sport,
  StreamKind,
  SourceKind,
  SelectionReason,
  PreferenceScope,
  WellnessKind,
} from "./schema";

export type { Sport, StreamKind, SourceKind, SelectionReason, PreferenceScope, WellnessKind };

/** A logical data origin (device/import). Mirror ofit-core `Source`. */
export interface Source {
  id: string;
  kind: SourceKind;
  name: string;
  manufacturer?: string | null;
  default_priority: number;
  created_at?: string;
  /** Latest data we have from this source (ISO); the device's "last sync". */
  last_synced_at?: string | null;
}

/** List-row shape: GET /api/activities. */
export interface ActivitySummary {
  id: string;
  sport: Sport;
  started_at: string;
  ended_at: string;
  recording_count: number;
  duration_secs: number;
  /** Total distance in metres, if computed by the analytics recompute. */
  distance_m: number | null;
  /** Energy in kcal (Zepp summary), if known. */
  calories: number | null;
}

/** A scalar time-series sample (HR/power/…): { t_offset_ms, value }. */
export interface ScalarSample {
  t_offset_ms: number;
  value: number;
}

/** A geographic sample for the lat_lng track: { t_offset_ms, lat, lng }. */
export interface LatLngSample {
  t_offset_ms: number;
  lat: number;
  lng: number;
}

/** One recording belonging to an activity (a single source's contribution). */
export interface RecordingInfo {
  id: string;
  source_id: string;
  source_name: string;
  format: string;
  stream_kinds: StreamKind[];
}

/**
 * The resolved (best-per-metric) stream for one metric kind. The API keys these
 * by StreamKind under `resolved`. Scalar metrics carry `samples`; the lat_lng
 * metric carries a `track`. We keep both optional and let the UI branch.
 */
export interface ResolvedMetric {
  source_id: string;
  recording_id?: string;
  selected_by?: SelectionReason;
  samples?: ScalarSample[];
  track?: LatLngSample[];
}

/** A per-metric source preference — mirror ofit-core `MetricSourcePreference`. */
export interface MetricSourcePreference {
  id?: string;
  metric: StreamKind;
  scope: PreferenceScope;
  activity_id?: string | null;
  source_id: string;
  retroactive: boolean;
  updated_at?: string;
}

/** GET /api/activities/{id} — the full detail payload. */
export interface ActivityDetail {
  id?: string;
  sport?: Sport;
  started_at?: string;
  ended_at?: string;
  duration_secs?: number;
  recordings: RecordingInfo[];
  /** Map keyed by StreamKind → resolved stream. */
  resolved: Partial<Record<StreamKind, ResolvedMetric>>;
  preferences: MetricSourcePreference[];
  /** Totals for a summary-only activity (no streams), e.g. a Zepp workout. */
  summary?: {
    distance_m: number;
    calories_kcal: number;
    avg_pace_s_per_m: number;
  };
  /** Total steps for the effort, if reported (e.g. phone step detector). */
  total_steps?: number;
}

/**
 * Response of DELETE /api/activities/{id}/recordings/{recording_id}.
 * `activity` is the FULL re-resolved detail of the trimmed original activity;
 * `detached_activity_id` is the new single-recording activity now owning the
 * removed recording (durable manual split — both marked user_confirmed).
 */
export interface RemoveRecordingResponse {
  activity: ActivityDetail;
  detached_activity_id: string;
}

/** Per-file outcome of POST /api/import (tolerant — shape varies by backend). */
export interface ImportFileOutcome {
  filename?: string;
  status?: string;
  outcome?: string;
  recording_id?: string;
  activity_id?: string;
  message?: string;
  [key: string]: unknown;
}

export type ImportResponse = ImportFileOutcome[] | { results: ImportFileOutcome[] };

/** GET /api/version — backend build/version info (tolerant shape). */
export interface VersionInfo {
  version: string;
  commit?: string;
  build?: string;
  [key: string]: unknown;
}

/**
 * One wellness sample (resting HR, HRV, body battery, sleep, stress …).
 * The `kind` is free-form so screens can request whatever the backend exposes
 * (e.g. "resting_hr", "hrv", "body_battery", "sleep"). Tolerant of field drift.
 */
export interface WellnessSample {
  /** ISO date or datetime for the sample. */
  date: string;
  value: number;
  /** Optional secondary value (e.g. sleep stage minutes, range high). */
  value2?: number;
  [key: string]: unknown;
}

export interface WellnessSeries {
  kind: string;
  samples: WellnessSample[];
}
