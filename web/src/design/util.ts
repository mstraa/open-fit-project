// Small shared helpers for the redesign layer.

/** Tint a color (incl. CSS vars) toward transparent via color-mix — replaces the
 *  invalid hex-alpha concat the design originally used. e.g. tint('var(--blue)', 13). */
export function tint(c: string, pct: number): string {
  return `color-mix(in srgb, ${c} ${pct}%, transparent)`;
}

/** Score → band color. Default bands: <50 low (red), 50–74 ok (amber), ≥75 good (green). */
export function scoreColor(v: number, bands: [number, number] = [50, 75]): string {
  if (v >= bands[1]) return "var(--good)";
  if (v >= bands[0]) return "var(--ok)";
  return "var(--low)";
}

/** Seeded PRNG (mulberry32) — stable charts across reloads. */
export function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth pseudo-random series around a base value (seeded). */
export function smoothSeries(
  n: number,
  base: number,
  amp: number,
  drift: number,
  seed: number,
): number[] {
  const r = mulberry32(seed);
  const out: number[] = [];
  let v = base;
  for (let i = 0; i < n; i++) {
    v += (r() - 0.5) * amp + Math.sin(i / (n / 6)) * drift;
    out.push(v);
  }
  return out;
}

export const MONTHS_FR = [
  "janv.", "févr.", "mars", "avr.", "mai", "juin",
  "juil.", "août", "sept.", "oct.", "nov.", "déc.",
];
export function fmtDay(d: Date): string {
  return `${d.getDate()} ${MONTHS_FR[d.getMonth()]}`;
}
/** "YYYY-MM-DD" key for a date. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "H:MM:SS" (or "M:SS" under an hour). */
export function fmtDur(sec: number): string {
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = Math.floor(sec % 60);
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/** Minutes → "H:MM". */
export function fmtHM(min: number): string {
  return `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, "0")}`;
}
/** Minutes → "Hh MMm". */
export function fmtH(min: number): string {
  return `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, "0")}m`;
}
