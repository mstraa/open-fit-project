// Single source of truth for duration / pace formatting.
// Pure functions only. Existing helper names (formatDuration, fmtDur, fmtHM,
// fmtH, formatPace) are kept as thin wrappers in their old modules so call
// sites don't need to change.

/** Seconds → "H:MM:SS" (or "M:SS" under an hour). */
export function fmtSec(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Minutes → "H:MM". */
export function fmtMin(min: number): string {
  return `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, "0")}`;
}

/** Minutes → "Hh MMm". */
export function fmtMinLong(min: number): string {
  return `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, "0")}m`;
}

/** Seconds-per-km → "m:ss" pace. Rounds a carried 60s up into the minutes. */
export function fmtPace(secsPerKm: number): string {
  if (!Number.isFinite(secsPerKm) || secsPerKm <= 0) return "—";
  const m = Math.floor(secsPerKm / 60);
  const s = Math.round(secsPerKm % 60);
  if (s === 60) return `${m + 1}:00`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
