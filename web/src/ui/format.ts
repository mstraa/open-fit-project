// Presentation helpers: human-readable labels, formatting, metric metadata.
// Pure functions only — no API or DOM coupling.

import type { Sport, StreamKind } from "../api/types";

/** Title-case a snake_case kind into a human label (fallback for unknowns). */
export function humanizeKind(kind: string): string {
  return kind
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Inline SVG sport glyphs (currentColor) — no icon-font dependency. */
export const SPORT_ICON: Record<Sport, string> = {
  running: "🏃",
  cycling: "🚴",
  swimming: "🏊",
  walking: "🚶",
  strength: "🏋️",
  other: "🎯",
};

export const SPORT_LABEL: Record<Sport, string> = {
  running: "Running",
  cycling: "Cycling",
  swimming: "Swimming",
  walking: "Walking",
  strength: "Strength",
  other: "Activity",
};

export function sportIcon(sport: Sport): string {
  return SPORT_ICON[sport] ?? SPORT_ICON.other;
}

export function sportLabel(sport: Sport): string {
  return SPORT_LABEL[sport] ?? SPORT_LABEL.other;
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

/* ----------------------------------------------- pace / speed presentation */

/**
 * How SPEED should be presented for a given sport:
 *  - running / walking → PACE in min/km (faster = lower number, axis inverted)
 *  - cycling → km/h
 *  - other → raw m/s
 */
export type SpeedMode = "pace" | "kmh" | "mps";

export function speedModeFor(sport: Sport | undefined): SpeedMode {
  if (sport === "running" || sport === "walking") return "pace";
  if (sport === "cycling") return "kmh";
  return "mps";
}

/** Format seconds-per-km as m:ss. */
export function formatPace(secsPerKm: number): string {
  if (!Number.isFinite(secsPerKm) || secsPerKm <= 0) return "—";
  const m = Math.floor(secsPerKm / 60);
  const s = Math.round(secsPerKm % 60);
  // Carry a rounded-up 60 seconds into the minutes.
  if (s === 60) return `${m + 1}:00`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Convert a raw speed sample value (m/s) for the given presentation mode. */
export function speedToMode(speedMps: number, mode: SpeedMode): number {
  if (mode === "pace") return speedMps > 0 ? 1000 / speedMps : 0;
  if (mode === "kmh") return speedMps * 3.6;
  return speedMps;
}

/** The unit label for a speed presentation mode. */
export function speedUnit(mode: SpeedMode): string {
  if (mode === "pace") return "/km";
  if (mode === "kmh") return "km/h";
  return "m/s";
}

/** The metric label for a speed presentation mode. */
export function speedLabel(mode: SpeedMode): string {
  return mode === "pace" ? "Pace" : "Speed";
}

/** Format a duration in seconds as H:MM:SS or M:SS. */
export function formatDuration(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Format an ISO datetime as a locale date + short time. */
export function formatDateTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function selectionReasonLabel(reason?: string): string {
  switch (reason) {
    case "activity_override":
      return "override";
    case "default":
      return "default";
    case "priority":
      return "auto (priority)";
    default:
      return "auto";
  }
}
