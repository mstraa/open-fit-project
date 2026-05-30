// Speed → color mapping for the GPS path.
//
// SINGLE SOURCE OF TRUTH. Today this is a RELATIVE scale across the activity's
// own speed range (percentile-clamped so a GPS spike doesn't wash out the
// gradient). A future estimated-VMA scale only needs to swap `speedDomain` for
// a VMA-based [lo, hi] — the stops and the rest of the code stay the same.
//
// low → high: blue (slow) → green → yellow → red (fast).

export const SPEED_COLOR_STOPS: [number, string][] = [
  [0.0, "rgb(47, 109, 246)"], // blue — slow
  [0.5, "rgb(26, 156, 91)"], // green
  [0.8, "rgb(224, 168, 58)"], // yellow
  [1.0, "rgb(224, 72, 75)"], // red — fast
];

/** CSS gradient stops (for the legend bar). */
export const SPEED_LEGEND_GRADIENT = `linear-gradient(90deg, ${SPEED_COLOR_STOPS.map(
  ([t, c]) => `${c} ${Math.round(t * 100)}%`,
).join(", ")})`;

/** Percentile-clamped [lo, hi] domain for a relative scale. */
export function speedDomain(values: number[], loP = 0.05, hiP = 0.95): [number, number] {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return [0, 1];
  const at = (p: number) =>
    v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
  let lo = at(loP);
  let hi = at(hiP);
  if (hi <= lo) {
    lo = v[0];
    hi = v[v.length - 1];
  }
  if (hi <= lo) hi = lo + 1;
  return [lo, hi];
}

/** MapLibre `line-color` interpolate expression over a feature `v` property. */
export function speedColorExpression(lo: number, hi: number): unknown {
  const stops: unknown[] = [];
  for (const [t, color] of SPEED_COLOR_STOPS) {
    stops.push(lo + (hi - lo) * t, color);
  }
  return ["interpolate", ["linear"], ["get", "v"], ...stops];
}
