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

/** Sport categories — mirror ofit-core `Sport` (serde snake_case). */
export type Sport =
  | "running"
  | "cycling"
  | "swimming"
  | "walking"
  | "strength"
  | "other";

/** Metric channels — mirror ofit-core `StreamKind` (serde snake_case). */
export type StreamKind =
  | "heart_rate"
  | "power"
  | "cadence"
  | "speed"
  | "altitude"
  | "lat_lng"
  | "wind"
  | "temperature"
  | "distance";

/** Broad data-origin kind — mirror ofit-core `SourceKind`. */
export type SourceKind =
  | "device"
  | "file_import"
  | "gadgetbridge"
  | "unknown";

/** Why a source was selected for a metric — mirror ofit-core `SelectionReason`. */
export type SelectionReason = "activity_override" | "default" | "priority";

/** Preference scope — mirror ofit-core `PreferenceScope`. */
export type PreferenceScope = "default" | "activity";

/** A logical data origin (device/import). Mirror ofit-core `Source`. */
export interface Source {
  id: string;
  kind: SourceKind;
  name: string;
  manufacturer?: string | null;
  default_priority: number;
  created_at?: string;
}

/** List-row shape: GET /api/activities. */
export interface ActivitySummary {
  id: string;
  sport: Sport;
  started_at: string;
  ended_at: string;
  recording_count: number;
  duration_secs: number;
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
  recordings: RecordingInfo[];
  /** Map keyed by StreamKind → resolved stream. */
  resolved: Partial<Record<StreamKind, ResolvedMetric>>;
  preferences: MetricSourcePreference[];
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
