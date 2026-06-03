// Single source of truth for sport + metric presentation metadata.
// Pure data/functions only — no API or DOM coupling. Presentation
// differences (icon-name vs emoji, token color) are FIELDS on the shared
// data, not separate copies; consumers pick the field/function they need.

import type { Sport, StreamKind } from "../api/types";

/* --------------------------------------------------------------- sports */

/** Per-sport visual metadata.
 *  - `color`  : design-token color name (line/badge tint)
 *  - `icon`   : icon-font name (see design/ui.tsx ICONS) for <Icon name=…>
 *  - `emoji`  : inline emoji glyph (no icon-font dependency)
 *  - `label`  : human-readable label
 */
export interface SportMeta {
  color: string;
  icon: string;
  emoji: string;
  label: string;
}

/** Sport → visual meta, keyed by the REAL Sport enum (lowercase). */
export const SPORTS: Record<Sport, SportMeta> = {
  running: { color: "var(--run)", icon: "run", emoji: "🏃", label: "Running" },
  cycling: { color: "var(--cycle)", icon: "bike", emoji: "🚴", label: "Cycling" },
  swimming: { color: "var(--light)", icon: "swim", emoji: "🏊", label: "Swimming" },
  walking: { color: "var(--walk)", icon: "walk", emoji: "🚶", label: "Walking" },
  strength: { color: "var(--strength)", icon: "strength", emoji: "🏋️", label: "Strength" },
  other: { color: "var(--activity)", icon: "pulse", emoji: "🎯", label: "Activity" },
};

export function sportLabel(sport: Sport): string {
  return (SPORTS[sport] ?? SPORTS.other).label;
}

/** Emoji glyph for a sport (legacy SPORT_ICON behavior). */
export function sportIcon(sport: Sport): string {
  return (SPORTS[sport] ?? SPORTS.other).emoji;
}

/* --------------------------------------------------------------- metrics */

/** Title-case a snake_case kind into a human label (fallback for unknowns). */
export function humanizeKind(kind: string): string {
  return kind
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Metric metadata used by the charts and the source picker. */
export interface MetricMeta {
  kind: StreamKind;
  label: string;
  unit: string;
  /** A token color name used as the line stroke. */
  color: string;
}

/**
 * Per-metric metadata for EVERY scalar StreamKind, in a sensible display order.
 * Colors reuse the design tokens (--hr/--power/--pace/--cadence/--elev/--cal/
 * --temp) and add a few on-brand extras for the running-dynamics channels.
 * lat_lng is intentionally absent (it's surfaced as the map track, not a chart).
 */
export const METRIC_META: Record<Exclude<StreamKind, "lat_lng">, MetricMeta> = {
  heart_rate: { kind: "heart_rate", label: "Heart rate", unit: "bpm", color: "var(--hr)" },
  power: { kind: "power", label: "Power", unit: "W", color: "var(--power)" },
  speed: { kind: "speed", label: "Speed", unit: "m/s", color: "var(--pace)" },
  cadence: { kind: "cadence", label: "Cadence", unit: "rpm/spm", color: "var(--cadence)" },
  altitude: { kind: "altitude", label: "Altitude", unit: "m", color: "var(--elev)" },
  distance: { kind: "distance", label: "Distance", unit: "m", color: "var(--accent)" },
  temperature: { kind: "temperature", label: "Temperature", unit: "°C", color: "var(--temp)" },
  wind: { kind: "wind", label: "Wind", unit: "m/s", color: "var(--accent-2)" },
  form_power: { kind: "form_power", label: "Form power", unit: "W", color: "var(--power)" },
  air_power: { kind: "air_power", label: "Air power", unit: "W", color: "var(--temp)" },
  vertical_oscillation: {
    kind: "vertical_oscillation",
    label: "Vertical oscillation",
    unit: "mm",
    color: "var(--cal)",
  },
  ground_contact_time: {
    kind: "ground_contact_time",
    label: "Ground contact time",
    unit: "ms",
    color: "var(--metric-gct)",
  },
  stride_length: {
    kind: "stride_length",
    label: "Stride length",
    unit: "mm",
    color: "var(--metric-stride)",
  },
  vertical_ratio: {
    kind: "vertical_ratio",
    label: "Vertical ratio",
    unit: "%",
    color: "var(--metric-vratio)",
  },
  leg_spring_stiffness: {
    kind: "leg_spring_stiffness",
    label: "Leg spring stiffness",
    unit: "kN/m",
    color: "var(--metric-lss)",
  },
};

/** Display order for charts: HR / power / pace / cadence / altitude first. */
export const METRIC_ORDER: (keyof typeof METRIC_META)[] = [
  "heart_rate",
  "power",
  "speed",
  "cadence",
  "altitude",
  "distance",
  "form_power",
  "air_power",
  "vertical_oscillation",
  "ground_contact_time",
  "stride_length",
  "vertical_ratio",
  "leg_spring_stiffness",
  "temperature",
  "wind",
];

/** Metrics shown by default (the rest are toggled on by the user). */
export const DEFAULT_VISIBLE: StreamKind[] = [
  "heart_rate",
  "power",
  "speed",
  "cadence",
  "altitude",
];

const NEUTRAL_COLOR = "var(--faint)";

/**
 * Metadata for any StreamKind, including kinds not in METRIC_META (future
 * channels) — falls back to a humanized label + neutral color so they still
 * render. Returns undefined only for lat_lng (the map track, never a chart).
 */
export function metricMeta(kind: StreamKind): MetricMeta | undefined {
  if (kind === "lat_lng") return undefined;
  const known = METRIC_META[kind as Exclude<StreamKind, "lat_lng">];
  if (known) return known;
  return { kind, label: humanizeKind(kind), unit: "", color: NEUTRAL_COLOR };
}

/** Legacy export kept for callers that want the default-visible chart metas. */
export const CHART_METRICS: MetricMeta[] = METRIC_ORDER.slice(0, 5).map(
  (k) => METRIC_META[k],
);

export function metricLabel(kind: StreamKind): string {
  if (kind === "lat_lng") return "GPS track";
  return metricMeta(kind)?.label ?? humanizeKind(kind);
}

/* ----------------------------------------------------------------- score */

/** Score → band color. Default bands: <50 low (red), 50–74 ok (amber), ≥75 good (green). */
export function scoreColor(v: number, bands: [number, number] = [50, 75]): string {
  if (v >= bands[1]) return "var(--good)";
  if (v >= bands[0]) return "var(--ok)";
  return "var(--low)";
}
