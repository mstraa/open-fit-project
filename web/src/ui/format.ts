// Presentation helpers: human-readable labels, formatting, metric metadata.
// Pure functions only — no API or DOM coupling.
//
// Sport + metric metadata and pace/duration formatters now live in the shared
// lib/ modules (single source of truth); they are re-exported here so existing
// importers of ui/format keep working unchanged.

import type { Sport } from "../api/types";
import { fmtSec, fmtPace } from "../lib/time";

export {
  humanizeKind,
  sportIcon,
  sportLabel,
  metricMeta,
  metricLabel,
  CHART_METRICS,
  METRIC_META,
  METRIC_ORDER,
  DEFAULT_VISIBLE,
} from "../lib/metadata";
export type { MetricMeta } from "../lib/metadata";

/** Inline SVG sport glyphs (currentColor) — no icon-font dependency.
 *  Kept as a derived map for any legacy callers. */
import { SPORTS } from "../lib/metadata";
export const SPORT_ICON: Record<Sport, string> = Object.fromEntries(
  (Object.keys(SPORTS) as Sport[]).map((s) => [s, SPORTS[s].emoji]),
) as Record<Sport, string>;
export const SPORT_LABEL: Record<Sport, string> = Object.fromEntries(
  (Object.keys(SPORTS) as Sport[]).map((s) => [s, SPORTS[s].label]),
) as Record<Sport, string>;

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
export const formatPace = fmtPace;

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
export const formatDuration = fmtSec;

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
