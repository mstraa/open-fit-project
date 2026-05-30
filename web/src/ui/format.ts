// Presentation helpers: human-readable labels, formatting, metric metadata.
// Pure functions only — no API or DOM coupling.

import type { Sport, StreamKind } from "../api/types";

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

/** Scalar metrics we render as line charts, in display order. */
export const CHART_METRICS: MetricMeta[] = [
  { kind: "heart_rate", label: "Heart rate", unit: "bpm", color: "var(--hr)" },
  { kind: "power", label: "Power", unit: "W", color: "var(--power)" },
  { kind: "cadence", label: "Cadence", unit: "rpm/spm", color: "var(--cadence)" },
  { kind: "speed", label: "Speed", unit: "m/s", color: "var(--pace)" },
  { kind: "altitude", label: "Altitude", unit: "m", color: "var(--elev)" },
];

export const METRIC_LABEL: Record<StreamKind, string> = {
  heart_rate: "Heart rate",
  power: "Power",
  cadence: "Cadence",
  speed: "Speed",
  altitude: "Altitude",
  lat_lng: "GPS track",
  wind: "Wind",
  temperature: "Temperature",
  distance: "Distance",
};

export function metricLabel(kind: StreamKind): string {
  return METRIC_LABEL[kind] ?? kind;
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
