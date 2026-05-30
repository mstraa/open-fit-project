// Time-series alignment helpers shared by the charts and the map. Samples are
// sorted by t_offset_ms (ms since activity start); we interpolate linearly.

import type { LatLngSample } from "../api/types";

export interface TimedValue {
  t_offset_ms: number;
  value: number;
}

/** Index of the last element with t_offset_ms <= ms (-1 if before the first). */
function lowerBound(arr: { t_offset_ms: number }[], ms: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t_offset_ms <= ms) {
      res = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return res;
}

/** Linearly-interpolated scalar value at `ms`, or null if no samples. */
export function valueAtMs(samples: TimedValue[] | undefined, ms: number): number | null {
  if (!samples || samples.length === 0) return null;
  const i = lowerBound(samples, ms);
  if (i < 0) return samples[0].value;
  if (i >= samples.length - 1) return samples[samples.length - 1].value;
  const a = samples[i];
  const b = samples[i + 1];
  const span = b.t_offset_ms - a.t_offset_ms;
  if (span <= 0) return a.value;
  const t = (ms - a.t_offset_ms) / span;
  return a.value + (b.value - a.value) * t;
}

/** Linearly-interpolated [lng, lat] at `ms`, or null if no track. */
export function coordAtMs(
  track: LatLngSample[] | undefined,
  ms: number,
): [number, number] | null {
  if (!track || track.length === 0) return null;
  const i = lowerBound(track, ms);
  if (i < 0) return [track[0].lng, track[0].lat];
  if (i >= track.length - 1) {
    const p = track[track.length - 1];
    return [p.lng, p.lat];
  }
  const a = track[i];
  const b = track[i + 1];
  const span = b.t_offset_ms - a.t_offset_ms;
  const t = span > 0 ? (ms - a.t_offset_ms) / span : 0;
  return [a.lng + (b.lng - a.lng) * t, a.lat + (b.lat - a.lat) * t];
}
