/* ============================================================
   OpenFit redesign — DATA WIRING.
   Hooks that adapt the REAL ofit-api into the shapes the design
   pages want. Each prefers live API data and falls back to the
   MOCKS in ./data when the backend is empty / has no endpoint.
   ============================================================ */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getWellness, getActivity, getDerived, listActivities, recomputeAnalytics } from "../api/endpoints";
import type { ActivitySummary, RecordingInfo, Sport, StreamKind } from "../api/types";
import { useActivities } from "../hooks/useActivities";
import { useTrainingLoad, hasTrainingLoad } from "../hooks/useTrainingLoad";
import { useWellnessLive } from "../hooks/useWellnessLive";
import { useBle } from "../ble/BleProvider";
import { useNativeBle } from "../ble/native/NativeBleProvider";
import { getStepsGoal } from "../prefs";
import * as D from "./data";
import { fmtDur } from "./util";

const MONTHS_FR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
/** ISO → "27 mai 2026, 08:10" to match the design. */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${MONTHS_FR[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
export const sportLabel = (s: Sport): string => D.SPORTS[s]?.label ?? "Activity";
export function readinessLabel(score: number): string {
  if (score >= 80) return "Primed";
  if (score >= 50) return "Balanced";
  if (score >= 30) return "Strained";
  return "Depleted";
}

/* ---- readiness + HRV (real → mock) ---- */
export interface ReadinessVM {
  score: number;
  label: string;
  hrv: number;
  baseline: number;
  real: boolean;
}
export function useReadiness(): ReadinessVM {
  const tl = useTrainingLoad();
  if (tl.kind === "ok" && tl.data.readiness_available && tl.data.readiness != null) {
    const score = Math.round(tl.data.readiness);
    return {
      score,
      label: readinessLabel(score),
      hrv: Math.round(tl.data.hrv_rmssd ?? D.READINESS.hrv),
      baseline: Math.round(tl.data.hrv_baseline ?? D.READINESS.baseline),
      real: true,
    };
  }
  return { score: 0, label: "—", hrv: 0, baseline: 0, real: false }; // no data → empty
}

/* ---- CTL/ATL/TSB series (real → mock) ---- */
export interface TLSeriesVM {
  points: { date: Date; ctl: number; atl: number; tsb: number }[];
  real: boolean;
  last: { ctl: number; atl: number; tsb: number };
}
export function useTrainingLoadSeries(): TLSeriesVM {
  const tl = useTrainingLoad();
  if (tl.kind === "ok" && hasTrainingLoad(tl.data)) {
    const points = tl.data.series.map((p) => ({ date: new Date(p.date), ctl: p.ctl, atl: p.atl, tsb: p.tsb }));
    return { points, real: true, last: points[points.length - 1] };
  }
  return { points: [], real: false, last: { ctl: 0, atl: 0, tsb: 0 } }; // no data → empty
}

/* ---- a generic daily-wellness series loader ---- */
function useWellnessSeries(kind: string, days = 7): { date: string; value: number }[] {
  const [out, setOut] = useState<{ date: string; value: number }[]>([]);
  useEffect(() => {
    let alive = true;
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - days);
    getWellness(kind, from.toISOString(), to.toISOString())
      .then((s) => alive && setOut(s.samples.map((x) => ({ date: x.date, value: x.value }))))
      .catch(() => alive && setOut([]));
    return () => {
      alive = false;
    };
  }, [kind, days]);
  return out;
}

/* ---- steps today + this week (real → mock) ---- */
export function useStepsToday(): { value: number; goal: number; real: boolean } {
  const series = useWellnessSeries("steps", 1);
  const goal = getStepsGoal();
  if (series.length) {
    // sum samples since local midnight
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const todays = series.filter((s) => new Date(s.date).getTime() >= midnight.getTime());
    const value = Math.round((todays.length ? todays : series).reduce((a, b) => a + b.value, 0));
    return { value, goal, real: true };
  }
  return { value: 0, goal, real: false }; // no data → empty
}
export function useStepsWeek(): { d: string; v: number }[] {
  const series = useWellnessSeries("steps", 7);
  return useMemo(() => {
    if (!series.length) return []; // no data → empty
    const lbl = ["D", "L", "M", "Me", "J", "V", "S"];
    const byDay = new Map<string, number>();
    for (const s of series) {
      const d = new Date(s.date);
      const key = d.toISOString().slice(0, 10);
      byDay.set(key, (byDay.get(key) ?? 0) + s.value);
    }
    const out: { d: string; v: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      out.push({ d: lbl[d.getDay()], v: Math.round(byDay.get(key) ?? 0) });
    }
    return out;
  }, [series]);
}

/* ---- live heart rate (WS / native BLE; no device → not streaming) ---- */
/** Max points kept in the live-HR sparkline buffer (seed history + live tail). */
const LIVE_HR_BUF = 120;
export function useLiveHR(): { hr: number | null; series: number[]; streaming: boolean } {
  const live = useWellnessLive();
  const ble = useBle();
  const native = useNativeBle();
  const realHr = live.last.heart_rate?.value ?? ble.live.hr ?? native.hr ?? null;
  const realConnected = live.connected || ble.live.hr != null || native.hr != null;

  // Rolling buffer of REAL samples only — no simulation. Seeded on mount with
  // the last ~10 min of recorded HR so the hero shows real recent history right
  // away instead of growing from a single point on every page load; live samples
  // then append on top. Stays empty (honest) when nothing has been recorded.
  const [buf, setBuf] = useState<number[]>([]);
  useEffect(() => {
    let alive = true;
    const to = new Date();
    const from = new Date(to.getTime() - 10 * 60_000);
    getWellness("heart_rate", from.toISOString(), to.toISOString())
      .then((r) => {
        if (!alive) return;
        const vals = r.samples.map((s) => s.value).filter((v) => Number.isFinite(v));
        // Prepend history before any live samples that already arrived (they're
        // the newest), so a fast first live sample doesn't discard the seed.
        if (vals.length) setBuf((b) => [...vals, ...b].slice(-LIVE_HR_BUF));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const lastReal = useRef<number | null>(null);
  useEffect(() => {
    if (realHr != null && realHr !== lastReal.current) {
      lastReal.current = realHr;
      setBuf((b) => [...b, realHr].slice(-LIVE_HR_BUF));
    }
  }, [realHr]);

  return { hr: realHr, series: buf, streaming: realConnected };
}

/* ---- HR last 24h: 10-minute-bucketed line + true min/avg/max ----
   Raw per-second/minute HR (~1440 pts) is an unreadable wall; we average it into
   10-min buckets for a legible trend, but keep MIN/AVG/MAX from the RAW samples
   so the headline stats stay exact (the bucket average would understate a peak). */
export interface HR24hVM { points: { ts: number; v: number }[]; min: number; avg: number; max: number; real: boolean }
export function useHR24h(): HR24hVM {
  const [out, setOut] = useState<HR24hVM | null>(null);
  useEffect(() => {
    let alive = true;
    const to = new Date();
    const from = new Date(to.getTime() - 24 * 3600 * 1000);
    getWellness("heart_rate", from.toISOString(), to.toISOString())
      .then((s) => {
        if (!alive) return;
        const raw = s.samples
          .map((x) => ({ ts: new Date(x.date).getTime(), v: x.value }))
          .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.v))
          .sort((a, b) => a.ts - b.ts);
        if (!raw.length) {
          setOut(null);
          return;
        }
        // True stats over raw samples.
        let min = Infinity, max = -Infinity, sum = 0;
        for (const p of raw) {
          if (p.v < min) min = p.v;
          if (p.v > max) max = p.v;
          sum += p.v;
        }
        // 10-minute mean buckets (aligned to wall-clock) for the chart line.
        // Each point keeps its real bucket-start timestamp so the x-axis can show
        // actual clock time (the overnight dip lands under night hours), not an
        // opaque "hours since the first sample" ramp.
        const BUCKET = 10 * 60 * 1000;
        const buckets = new Map<number, { sum: number; n: number }>();
        for (const p of raw) {
          const k = Math.floor(p.ts / BUCKET);
          const b = buckets.get(k);
          if (b) { b.sum += p.v; b.n++; } else buckets.set(k, { sum: p.v, n: 1 });
        }
        const points = [...buckets.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([k, b]) => ({ ts: k * BUCKET, v: b.sum / b.n }));
        setOut({ points, min: Math.round(min), avg: Math.round(sum / raw.length), max: Math.round(max), real: true });
      })
      .catch(() => alive && setOut(null));
    return () => {
      alive = false;
    };
  }, []);
  return out ?? { points: [], min: 0, avg: 0, max: 0, real: false }; // no data → empty
}

/** 24h-HR x-axis tick: label the first 10-min bucket of each 4-hourly clock hour
 *  (00/04/08/12/16/20) with its local hour, e.g. `"16h"`; otherwise `null`. This
 *  pins ticks to real clock time (right edge ≈ now), not an arbitrary offset. */
export function hr24hTick(ts: number): string | null {
  const d = new Date(ts);
  return d.getHours() % 4 === 0 && d.getMinutes() < 10 ? d.getHours() + "h" : null;
}

/** 24h-HR tooltip label for a point: local `H:MM`. */
export function hr24hTime(ts: number): string {
  const d = new Date(ts);
  return d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0");
}

/* ============================================================
   GENERIC WELLNESS — latest-anchored window + roll-ups.
   The backend serves raw points (GET /api/wellness, no aggregate);
   imported history may end before wall-clock "now", so views anchor
   to the most recent sample rather than the system clock.
   ============================================================ */
export interface WPoint { ts: number; date: string; value: number }
function useWellnessRaw(kind: string, days: number, nonce = 0): { points: WPoint[]; loading: boolean } {
  const [points, setPoints] = useState<WPoint[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    getWellness(kind, from.toISOString(), to.toISOString())
      .then((s) => {
        if (!alive) return;
        setPoints(
          s.samples
            .map((x) => ({ ts: new Date(x.date).getTime(), date: x.date, value: x.value }))
            .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.value))
            .sort((a, b) => a.ts - b.ts),
        );
        setLoading(false);
      })
      .catch(() => {
        if (alive) { setPoints([]); setLoading(false); }
      });
    return () => { alive = false; };
  }, [kind, days, nonce]);
  return { points, loading };
}
const dayKeyOf = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** Latest reading for a tile (real → empty). `real:false` ⇒ render "—". */
export function useWellnessLatest(kind: string): { value: number; real: boolean } {
  const { points } = useWellnessRaw(kind, 14);
  if (points.length) return { value: Math.round(points[points.length - 1].value), real: true };
  return { value: 0, real: false }; // no data → empty
}

/** Per-day min/avg/max/last roll-up (for trends + min/avg/max bands). */
export interface DailyPoint { date: string; min: number; avg: number; max: number; last: number }
export interface TrendVM { days: DailyPoint[]; min: number; avg: number; max: number; real: boolean }
export function useDailyTrend(kind: string, days: number): TrendVM {
  const { points } = useWellnessRaw(kind, days);
  return useMemo(() => {
    if (!points.length) return { days: [], min: 0, avg: 0, max: 0, real: false };
    const groups = new Map<string, number[]>();
    for (const p of points) {
      const k = dayKeyOf(p.ts);
      const g = groups.get(k);
      if (g) g.push(p.value); else groups.set(k, [p.value]);
    }
    const dp: DailyPoint[] = [...groups.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, vals]) => ({
        date,
        min: Math.round(Math.min(...vals)),
        max: Math.round(Math.max(...vals)),
        avg: +mean(vals).toFixed(1),
        last: Math.round(vals[vals.length - 1]),
      }));
    const all = points.map((p) => p.value);
    return { days: dp, min: Math.round(Math.min(...all)), avg: +mean(all).toFixed(1), max: Math.round(Math.max(...all)), real: true };
  }, [points]);
}

/** Intraday series for the latest day that has data (anchored, not wall-clock). */
export interface IntradayVM { points: { t: number; v: number }[]; min: number; avg: number; max: number; real: boolean }
export function useIntradayLatestDay(kind: string): IntradayVM {
  const { points } = useWellnessRaw(kind, 7);
  return useMemo(() => {
    if (!points.length) return { points: [], min: 0, avg: 0, max: 0, real: false };
    const lastKey = dayKeyOf(points[points.length - 1].ts);
    const day = points.filter((p) => dayKeyOf(p.ts) === lastKey);
    const start = new Date(day[0].ts);
    start.setHours(0, 0, 0, 0);
    const pts = day.map((p) => ({ t: (p.ts - start.getTime()) / 3_600_000, v: p.value }));
    const vals = day.map((p) => p.value);
    return { points: pts, min: Math.round(Math.min(...vals)), avg: +mean(vals).toFixed(1), max: Math.round(Math.max(...vals)), real: true };
  }, [points]);
}

/** Body battery composite — ring value + intraday curve + charged/drained. */
export interface BodyBatteryVM { now: number; atWake: number; lowToday: number; charged: number; drained: number; curve: number[]; spanSec: number; real: boolean }
export function useBodyBattery(): BodyBatteryVM {
  const intra = useIntradayLatestDay("body_battery");
  return useMemo(() => {
    if (!intra.real || intra.points.length < 2) {
      // no data → empty (no synthetic curve)
      return { now: 0, atWake: 0, lowToday: 0, charged: 0, drained: 0, curve: [], spanSec: 0, real: false };
    }
    const vs = intra.points.map((p) => p.v);
    let charged = 0, drained = 0;
    for (let i = 1; i < vs.length; i++) { const d = vs[i] - vs[i - 1]; if (d > 0) charged += d; else drained += d; }
    const spanSec = Math.max(3600, (intra.points[intra.points.length - 1].t - intra.points[0].t) * 3600);
    return {
      now: Math.round(vs[vs.length - 1]),
      atWake: Math.round(intra.max), // peak ≈ at-wake reserve
      lowToday: Math.round(intra.min),
      charged: Math.round(charged),
      drained: Math.round(drained),
      curve: downsample(vs, 60),
      spanSec,
      real: true,
    };
  }, [intra.real, intra.points, intra.min, intra.max]);
}

/* ============================================================
   SLEEP — built from raw sleep_stage minute samples
   (0=awake, 1=light, 2=deep, 3=rem) + HR / respiration / SpO₂.
   Score replicates the backend sleep algorithm exactly.
   ============================================================ */
type SleepStageName = "awake" | "light" | "deep" | "rem";
const STAGE_BY_CODE: Record<number, SleepStageName> = { 0: "awake", 1: "light", 2: "deep", 3: "rem" };
export interface SleepNightVM extends D.Night {
  segments: { stage: SleepStageName; len: number }[];
  start: string;
  end: string;
}
const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

function buildNights(stage: WPoint[], hr: WPoint[], resp: WPoint[], spo2: WPoint[]): SleepNightVM[] {
  if (!stage.length) return [];
  // Group by "sleep day" = the calendar day of (ts − 12h), so a night spanning
  // ~23:00→07:00 collapses into one entry.
  const groups = new Map<string, WPoint[]>();
  for (const p of stage) {
    const k = dayKeyOf(p.ts - 12 * 3_600_000);
    const g = groups.get(k);
    if (g) g.push(p); else groups.set(k, [p]);
  }
  const inWindow = (arr: WPoint[], a: number, b: number) => arr.filter((x) => x.ts >= a && x.ts <= b).map((x) => x.value);
  const nights: SleepNightVM[] = [];
  for (const [key, ptsRaw] of groups) {
    const sorted = ptsRaw.sort((a, b) => a.ts - b.ts);
    // Split into separate sleep periods on a large gap (> 5h) and keep the one
    // with the most asleep minutes. Otherwise a stray daytime block (e.g. an
    // HR-derived afternoon nap) merges with the next overnight sleep into one
    // bogus ~19h "night" (bed 13:50, wake 09:20). 5h is wide enough to keep a
    // genuinely fragmented night (brief mid-night awakenings) together.
    const GAP = 5 * 3_600_000;
    const blocks: WPoint[][] = [];
    for (const p of sorted) {
      const last = blocks[blocks.length - 1];
      if (last && p.ts - last[last.length - 1].ts > GAP) blocks.push([p]);
      else if (last) last.push(p);
      else blocks.push([p]);
    }
    const asleepMin = (b: WPoint[]) => b.reduce((c, x) => c + (Math.round(x.value) !== 0 ? 1 : 0), 0);
    const pts = blocks.reduce((best, b) => (asleepMin(b) > asleepMin(best) ? b : best), blocks[0]);
    let deep = 0, rem = 0, light = 0, awake = 0;
    const segments: { stage: SleepStageName; len: number }[] = [];
    let cur: SleepStageName | null = null, len = 0;
    for (const p of pts) {
      const s = STAGE_BY_CODE[Math.round(p.value)] ?? "awake";
      if (s === "deep") deep++; else if (s === "rem") rem++; else if (s === "light") light++; else awake++;
      if (s === cur) len++; else { if (cur) segments.push({ stage: cur, len }); cur = s; len = 1; }
    }
    if (cur) segments.push({ stage: cur, len });
    const asleep = deep + rem + light;
    if (asleep < 60) continue; // ignore naps / fragments
    const startTs = pts[0].ts, endTs = pts[pts.length - 1].ts;
    const sd = new Date(startTs), ed = new Date(endTs);
    const hrv = inWindow(hr, startTs, endTs);
    const rv = inWindow(resp, startTs, endTs);
    const sv = inWindow(spo2, startTs, endTs);
    // Score: matches ofit-analytics sleep.rs → 0.7·duration + 0.3·quality.
    const dur = Math.min(asleep / 480, 1) * 100;
    const qual = asleep ? Math.min((deep + rem) / asleep / 0.4, 1) * 100 : 0;
    const score = Math.round(Math.max(0, Math.min(100, 0.7 * dur + 0.3 * qual)));
    nights.push({
      date: key,
      asleep, score, deep, rem, light, awake,
      bed: sd.getHours() + sd.getMinutes() / 60,
      wake: ed.getHours() + ed.getMinutes() / 60,
      hr: Math.round(mean(hrv)),
      breath: Math.round(mean(rv)),
      hypopnea: 0, // MOCK: no apnea/hypopnea source yet
      spo2: sv.length ? Math.round(Math.min(...sv)) : 0,
      segments,
      start: hm(sd),
      end: hm(ed),
    });
  }
  return nights.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
}

/** Light: nights from sleep_stage only (used where just the score/stages matter). */
export function useSleepNights(): { nights: SleepNightVM[]; real: boolean } {
  const stage = useWellnessRaw("sleep_stage", 30);
  return useMemo(() => {
    const nights = buildNights(stage.points, [], [], []);
    if (nights.length) return { nights, real: true };
    return { nights: [], real: false }; // no data → empty
  }, [stage.points]);
}

/** Full sleep data: nights enriched with HR/breath/SpO₂ + weekly series. */
export interface SleepWeekly {
  duration: (Record<"deep" | "light" | "rem" | "awake", number> & { d: string; total: number })[];
  hr: { d: string; v: number }[];
  breath: { d: string; v: number }[];
  regularity: { d: string; bed: number; wake: number }[];
}
export interface SleepDataVM { nights: SleepNightVM[]; weekly: SleepWeekly; regularity: number; real: boolean }
/** Sleep-regularity % from how consistent bed & wake times are. Only real
 *  *night* sleep (bed 20:00–04:00) counts, so naps / odd HR-derived daytime
 *  blocks don't blow up the variance. */
function regularityPct(nights: SleepNightVM[]): number {
  const wk = nights.slice(0, 10).filter((n) => n.bed >= 20 || n.bed <= 4);
  if (wk.length < 2) return 0; // not enough nights to judge → caller shows "—"
  const bed = wk.map((n) => (n.bed < 12 ? n.bed + 24 : n.bed) * 60); // minutes, unwrapped past midnight
  const wake = wk.map((n) => n.wake * 60);
  const std = (a: number[]) => {
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  };
  return Math.round(Math.max(0, Math.min(100, 100 - (std(bed) + std(wake)) / 2 / 2.0)));
}
/** `stageDays` widens only the sleep_stage window (nights come from it) — pass a
 *  large value for the full backlog. `nonce` forces a refetch (e.g. after a
 *  manual recompute). HR/breath/SpO₂ stay on short windows (they only enrich
 *  recent nights). */
export function useSleepData(stageDays = 30, nonce = 0): SleepDataVM {
  const stage = useWellnessRaw("sleep_stage", stageDays, nonce);
  const hr = useWellnessRaw("heart_rate", 9, nonce);
  const resp = useWellnessRaw("respiration", 14, nonce);
  const spo2 = useWellnessRaw("sp_o2", 14, nonce);
  return useMemo(() => {
    const nights = buildNights(stage.points, hr.points, resp.points, spo2.points);
    if (!nights.length) {
      // no data → empty (no mock night/week)
      return {
        nights: [],
        weekly: { duration: [], hr: [], breath: [], regularity: [] },
        regularity: 0,
        real: false,
      };
    }
    const wk = nights.slice(0, 7).reverse(); // oldest→newest for L..D
    const L = D.SLEEP_WEEK_LABELS;
    // Label each night by its REAL weekday (not slice position), so a missing
    // night doesn't shift every column's label. Parse as LOCAL ("…T00:00:00")
    // — a bare "YYYY-MM-DD" is UTC and would shift the weekday in negative-UTC zones.
    const wd = (date: string) => L[(new Date(date + "T00:00:00").getDay() + 6) % 7] ?? "";
    // HR/breath come from sparse in-sleep wellness; keep only nights that
    // actually carry the value (drop 0s) rather than substitute a mock series.
    const hrWk = wk.map((n) => ({ d: wd(n.date), v: n.hr })).filter((x) => x.v > 0);
    const breathWk = wk.map((n) => ({ d: wd(n.date), v: n.breath })).filter((x) => x.v > 0);
    return {
      nights,
      weekly: {
        duration: wk.map((n) => ({ d: wd(n.date), deep: n.deep, light: n.light, rem: n.rem, awake: n.awake, total: n.asleep })),
        hr: hrWk,
        breath: breathWk,
        regularity: wk.map((n) => ({ d: wd(n.date), bed: n.bed, wake: n.wake })),
      },
      regularity: regularityPct(nights),
      real: true,
    };
  }, [stage.points, hr.points, resp.points, spo2.points]);
}

/* ---- manual analytics recompute trigger ----
   Kicks a full recompute (POST /api/analytics/recompute) and bumps `nonce` so
   data hooks refetch. The endpoint runs synchronously and resolves only when the
   recompute has finished + persisted, so completion is detected off the promise
   itself (no WS/timer guessing — those would refetch before the new rows land). */
export function useRecomputeTrigger(): { recomputing: boolean; nonce: number; trigger: () => void } {
  const [nonce, setNonce] = useState(0);
  const [pending, setPending] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const trigger = useCallback(() => {
    setPending(true);
    recomputeAnalytics()
      .catch(() => {})
      .finally(() => {
        if (!alive.current) return;
        setPending(false);
        setNonce((n) => n + 1);
      });
  }, []);
  return { recomputing: pending, nonce, trigger };
}

/* ---- activities list (REAL) ---- */
export interface ActivityRow {
  id: string;
  sport: Sport;
  sportLabel: string;
  when: string;
  dur: number;
  durStr: string;
  rec: number;
  dist: number | null;
  pace: string | null;
}
/** Pace as "m:ss"/km from distance (m) + duration (s); null when not derivable. */
function paceStr(distanceM: number, durationSec: number): string | null {
  if (!(distanceM > 0) || !(durationSec > 0)) return null;
  const secPerKm = durationSec / (distanceM / 1000);
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function toRow(a: ActivitySummary): ActivityRow {
  // Real distance from the recompute cache on the list payload (matches the
  // detail view); null until recompute has run for the activity → "—".
  const dist = a.distance_m != null && a.distance_m > 0 ? +(a.distance_m / 1000).toFixed(2) : null;
  return {
    id: a.id,
    sport: a.sport,
    sportLabel: sportLabel(a.sport),
    when: formatWhen(a.started_at),
    dur: a.duration_secs,
    durStr: fmtDur(a.duration_secs),
    rec: a.recording_count,
    dist,
    pace: a.distance_m != null ? paceStr(a.distance_m, a.duration_secs) : null,
  };
}
export function useActivitiesList(): {
  rows: ActivityRow[];
  counts: Record<string, number>;
  total: number;
  loading: boolean;
  error: string | null;
  /** Re-fetch the activity list (e.g. after an activity/source delete). */
  reload: () => void;
} {
  const { state, activities, counts, reload } = useActivities();
  const rows = useMemo(
    () => [...activities].sort((a, b) => (a.started_at < b.started_at ? 1 : -1)).map(toRow),
    [activities],
  );
  const countMap: Record<string, number> = { All: activities.length };
  for (const [sport, n] of counts) countMap[sportLabel(sport)] = n;
  return {
    rows,
    counts: countMap,
    total: activities.length,
    loading: state.kind === "loading",
    error: state.kind === "error" ? state.message : null,
    reload,
  };
}

/* ---- one activity's REAL detail (resolved streams + GPS track) ---- */
export interface ActivityDetailVM {
  loading: boolean;
  /** resolved scalar streams downsampled to number[] per metric kind. */
  series: Partial<Record<StreamKind, number[]>>;
  avg: Partial<Record<StreamKind, number>>;
  max: Partial<Record<StreamKind, number>>;
  track: { lat: number; lng: number }[] | null;
  durationSec: number;
  summary?: { distance_m: number; calories_kcal: number; avg_pace_s_per_m: number };
  /** Derived per-activity metrics by name (training_effect_aerobic, exercise_load…). */
  derived: Record<string, number>;
  /** The contributing recordings (one per source) — drives the Edit tab. */
  recordings: RecordingInfo[];
  /** true once a real activity payload has loaded with at least one stream/track. */
  hasReal: boolean;
  /** Re-fetch this activity's detail (e.g. after deleting a source). */
  reload: () => void;
}
function downsample(vals: number[], cap = 200): number[] {
  if (vals.length <= cap) return vals;
  const step = vals.length / cap;
  const out: number[] = [];
  for (let i = 0; i < cap; i++) out.push(vals[Math.floor(i * step)]);
  return out;
}
type DetailState = Omit<ActivityDetailVM, "reload">;
export function useActivityDetailData(id: string, fallbackDur: number): ActivityDetailVM {
  const [vm, setVm] = useState<DetailState>({
    loading: true,
    series: {},
    avg: {},
    max: {},
    track: null,
    durationSec: fallbackDur,
    derived: {},
    recordings: [],
    hasReal: false,
  });
  // Bumped by `reload()` to re-fetch after a mutation (e.g. deleting a source).
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    Promise.all([
      getActivity(id),
      // Per-activity derived metrics (training_effect_*, exercise_load, tss…).
      getDerived(`activity:${id}`).catch(() => ({ subject: "", metrics: [], streams: [] })),
    ])
      .then(([d, der]) => {
        if (!alive) return;
        const series: Partial<Record<StreamKind, number[]>> = {};
        const avg: Partial<Record<StreamKind, number>> = {};
        const max: Partial<Record<StreamKind, number>> = {};
        let anyStream = false;
        for (const [kind, m] of Object.entries(d.resolved)) {
          const samples = m?.samples;
          if (!samples || !samples.length) continue;
          const vals = samples.map((s) => s.value);
          series[kind as StreamKind] = downsample(vals);
          avg[kind as StreamKind] = vals.reduce((a, b) => a + b, 0) / vals.length;
          max[kind as StreamKind] = Math.max(...vals);
          anyStream = true;
        }
        const trackPts = d.resolved.lat_lng?.track ?? null;
        const track = trackPts && trackPts.length ? trackPts.map((p) => ({ lat: p.lat, lng: p.lng })) : null;
        const derived: Record<string, number> = {};
        for (const m of der.metrics) derived[m.name] = m.value;
        setVm({
          loading: false,
          series,
          avg,
          max,
          track,
          durationSec: d.duration_secs ?? fallbackDur,
          summary: d.summary,
          derived,
          recordings: d.recordings ?? [],
          hasReal: anyStream || !!track || !!d.summary,
        });
      })
      .catch(() => alive && setVm((s) => ({ ...s, loading: false })));
    return () => {
      alive = false;
    };
  }, [id, fallbackDur, nonce]);
  return { ...vm, reload };
}

/* ============================================================
   TRAINING VOLUME & SUMMARY — aggregated from the real activity
   list (GET /api/activities). Distance isn't in the list summary,
   so dist is reported null (→ "—"); time/sessions/by-sport are real.
   ============================================================ */
type VolBucket = "running" | "cycling" | "walking" | "strength" | "activity";
const sportBucket = (s: Sport): VolBucket =>
  s === "running" ? "running" : s === "cycling" ? "cycling" : s === "walking" ? "walking" : s === "strength" ? "strength" : "activity";
function mondayOf(ts: number): Date {
  const d = new Date(ts);
  const dow = (d.getDay() + 6) % 7; // Mon=0
  d.setDate(d.getDate() - dow);
  d.setHours(0, 0, 0, 0);
  return d;
}
const latestStart = (acts: ActivitySummary[]) => acts.reduce((m, a) => Math.max(m, Date.parse(a.started_at) || 0), 0) || Date.now();

export interface VolWeek { d: string; running: number; cycling: number; walking: number; strength: number; activity: number }
export function useWeeklyVolume(weeks = 8): { data: VolWeek[]; real: boolean } {
  const { activities } = useActivities();
  return useMemo(() => {
    if (!activities.length) return { data: [], real: false }; // no data → empty
    const anchorMon = mondayOf(latestStart(activities));
    const buckets: VolWeek[] = [];
    const idxOf = new Map<number, number>();
    for (let i = weeks - 1; i >= 0; i--) {
      const mon = new Date(anchorMon);
      mon.setDate(mon.getDate() - i * 7);
      idxOf.set(mon.getTime(), buckets.length);
      buckets.push({ d: `${String(mon.getDate()).padStart(2, "0")}/${String(mon.getMonth() + 1).padStart(2, "0")}`, running: 0, cycling: 0, walking: 0, strength: 0, activity: 0 });
    }
    for (const a of activities) {
      const t = Date.parse(a.started_at);
      if (!t) continue;
      const i = idxOf.get(mondayOf(t).getTime());
      if (i == null) continue;
      buckets[i][sportBucket(a.sport)] += Math.round(a.duration_secs / 60);
    }
    return { data: buckets, real: true };
  }, [activities, weeks]);
}

export type SummaryPeriod = "Week" | "Month" | "Year";
export interface TrainingSummaryVM {
  sessions: number;
  mins: number;
  dist: number | null;
  bars: { d: string; v: number }[];
  bySport: { sport: string; color: string; mins: number }[];
  real: boolean;
}
export function useTrainingSummary(period: SummaryPeriod, offset: number): TrainingSummaryVM {
  const { activities } = useActivities();
  return useMemo(() => {
    if (!activities.length) return { sessions: 0, mins: 0, dist: null, bars: [], bySport: [], real: false };
    const anchor = new Date(latestStart(activities));
    let start: Date, end: Date, bars: { d: string; v: number }[], barOf: (t: number) => number;
    if (period === "Week") {
      // Rolling last-7-days ending at the latest activity day (offset weeks back),
      // so "this week" reflects recent training rather than an empty Monday-start.
      end = new Date(anchor);
      end.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() + 1 + offset * 7); // exclusive end (includes anchor day)
      start = new Date(end);
      start.setDate(start.getDate() - 7);
      bars = ["L", "M", "Me", "J", "V", "S", "D"].map((d) => ({ d, v: 0 }));
      barOf = (t) => (new Date(t).getDay() + 6) % 7;
    } else if (period === "Month") {
      start = new Date(anchor.getFullYear(), anchor.getMonth() + offset, 1);
      end = new Date(anchor.getFullYear(), anchor.getMonth() + offset + 1, 1);
      bars = ["W1", "W2", "W3", "W4", "W5"].map((d) => ({ d, v: 0 }));
      barOf = (t) => Math.min(4, Math.floor((new Date(t).getDate() - 1) / 7));
    } else {
      start = new Date(anchor.getFullYear() + offset, 0, 1);
      end = new Date(anchor.getFullYear() + offset + 1, 0, 1);
      bars = "JFMAMJJASOND".split("").map((d) => ({ d, v: 0 }));
      barOf = (t) => new Date(t).getMonth();
    }
    const a0 = start.getTime(), a1 = end.getTime();
    let sessions = 0, mins = 0, distM = 0;
    const bySportMin = new Map<Sport, number>();
    for (const a of activities) {
      const t = Date.parse(a.started_at);
      if (!t || t < a0 || t >= a1) continue;
      const m = Math.round(a.duration_secs / 60);
      sessions++;
      mins += m;
      if (a.distance_m != null) distM += a.distance_m;
      bars[barOf(t)].v += m;
      bySportMin.set(a.sport, (bySportMin.get(a.sport) ?? 0) + m);
    }
    const bySport = [...bySportMin.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([sport, m]) => ({ sport: D.SPORTS[sport]?.label ?? "Activity", color: D.SPORTS[sport]?.color ?? "var(--activity)", mins: m }));
    // Real distance summed from the recompute cache; null when nothing in-window
    // carries a distance (→ "—") rather than a fabricated total.
    const dist = distM > 0 ? +(distM / 1000).toFixed(1) : null;
    return { sessions, mins, dist, bars, bySport, real: true };
  }, [activities, period, offset]);
}

/* ============================================================
   METRIC HISTORY — real Day/Week/Month/Year series for the
   tap-to-expand MetricDetail modal (replaces the synthetic
   genRange). Rolls up real data per metric; no mock.
   ============================================================ */
export type Range = "Day" | "Week" | "Month" | "Year";
export type HistorySpec =
  | { src: "wellness"; kind: string; agg?: "avg" | "sum"; intraday?: boolean }
  | { src: "sleep"; field: "deep" | "rem" | "light" | "awake" | "asleep" | "score" | "hr" | "breath" }
  | { src: "readiness" }
  | { src: "trainingMinutes" }
  | { src: "none" };
export interface HistoryVM {
  data: number[];
  xLabels: (string | null)[];
  min: number;
  avg: number;
  max: number;
  real: boolean;
  loading: boolean;
}
const WEEK_LABELS = ["L", "M", "Me", "J", "V", "S", "D"];
const startOfDay = (ts: number) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
/** Bucket points into n slots. Averaged metrics DROP empty buckets (a missing
 *  day is a gap, not a 0); count metrics (`fillZero`) keep 0 (a rest day / no
 *  steps is a real 0). Labels stay aligned to the kept buckets. */
function roll(
  pts: { ts: number; value: number }[],
  n: number,
  bucketOf: (ts: number) => number,
  labelOf: (i: number) => string | null,
  agg: "avg" | "sum",
  fillZero: boolean,
): { data: number[]; labels: (string | null)[] } {
  const sum = new Array(n).fill(0);
  const cnt = new Array(n).fill(0);
  for (const p of pts) {
    const b = bucketOf(p.ts);
    if (b >= 0 && b < n && Number.isFinite(p.value)) {
      sum[b] += p.value;
      cnt[b]++;
    }
  }
  const data: number[] = [];
  const labels: (string | null)[] = [];
  for (let i = 0; i < n; i++) {
    if (cnt[i] > 0) {
      data.push(agg === "sum" ? sum[i] : sum[i] / cnt[i]);
      labels.push(labelOf(i));
    } else if (fillZero) {
      data.push(0);
      labels.push(labelOf(i));
    }
  }
  return { data, labels };
}
const monthInitial = (anchor: Date, i: number) => "JFMAMJJASOND"[new Date(anchor.getFullYear(), anchor.getMonth() - (11 - i), 1).getMonth()];
const monthIndexFrom = (anchor: Date) => (ts: number) => {
  const d = new Date(ts);
  return 11 - ((anchor.getFullYear() - d.getFullYear()) * 12 + (anchor.getMonth() - d.getMonth()));
};

export function useMetricHistory(spec: HistorySpec, range: Range, decimals = 0, offset = 0): HistoryVM {
  const [vm, setVm] = useState<HistoryVM>({ data: [], xLabels: [], min: 0, avg: 0, max: 0, real: false, loading: true });
  const key = JSON.stringify(spec);
  useEffect(() => {
    let alive = true;
    setVm((s) => ({ ...s, loading: true }));
    const finish = (data: number[], xLabels: (string | null)[]) => {
      if (!alive) return;
      const rounded = data.map((v) => (decimals ? +v.toFixed(decimals) : Math.round(v)));
      if (!rounded.length) {
        setVm({ data: [], xLabels: [], min: 0, avg: 0, max: 0, real: false, loading: false });
        return;
      }
      const total = rounded.reduce((a, c) => a + c, 0);
      setVm({
        data: rounded,
        xLabels,
        min: Math.min(...rounded),
        max: Math.max(...rounded),
        avg: +(total / rounded.length).toFixed(decimals ? 1 : 0),
        real: true,
        loading: false,
      });
    };
    (async () => {
      const DAY = 86_400_000;
      const now = Date.now();
      const today0 = startOfDay(now);
      // Window + bucket anchor for the selected range, stepped back by `offset`
      // units (0 = current period, -1 = the previous one, …). `anchorDay0` is the
      // start of the LAST day in the window — what each branch buckets relative to.
      let fromMs: number, toMs: number, anchorDay0: number;
      if (range === "Day") {
        anchorDay0 = today0 + offset * DAY;
        // Fetch a couple of extra days back so offset 0 can fall on the most
        // recent day WITH data when today hasn't synced yet (imported history /
        // not-worn-today), matching the app's "anchor to latest sample" convention.
        fromMs = anchorDay0 - 2 * DAY;
        toMs = anchorDay0 + DAY;
      } else if (range === "Week") {
        anchorDay0 = today0 + offset * 7 * DAY;
        toMs = anchorDay0 + DAY;
        fromMs = toMs - 7 * DAY;
      } else if (range === "Month") {
        anchorDay0 = today0 + offset * 30 * DAY;
        toMs = anchorDay0 + DAY;
        fromMs = toMs - 30 * DAY;
      } else {
        // Year: 12 calendar months ending at the anchor month (today's month shifted).
        const am = new Date(now);
        am.setDate(1);
        am.setHours(0, 0, 0, 0);
        am.setMonth(am.getMonth() + offset * 12);
        anchorDay0 = am.getTime();
        toMs = new Date(am.getFullYear(), am.getMonth() + 1, 1).getTime();
        fromMs = new Date(am.getFullYear(), am.getMonth() - 11, 1).getTime();
      }
      const fromISO = new Date(fromMs).toISOString();
      const toISO = new Date(toMs).toISOString();
      const toPts = (samples: { date: string; value: number }[]) =>
        samples.map((x) => ({ ts: new Date(x.date).getTime(), value: x.value })).filter((p) => Number.isFinite(p.ts)).sort((a, b) => a.ts - b.ts);

      try {
        if (spec.src === "none") return finish([], []);

        if (spec.src === "wellness") {
          const agg = spec.agg ?? "avg";
          const fill = agg === "sum"; // steps: empty hour/day is a real 0
          const pts = toPts((await getWellness(spec.kind, fromISO, toISO)).samples);
          if (!pts.length) return finish([], []);
          if (range === "Day") {
            // Anchor to the latest day with data at/before the target day, so
            // offset 0 isn't empty when today hasn't synced; offset then steps
            // whole days back from there.
            const within = pts.filter((p) => p.ts < anchorDay0 + DAY);
            if (!within.length) return finish([], []);
            const base = startOfDay(within[within.length - 1].ts);
            const day = within.filter((p) => startOfDay(p.ts) === base);
            const { data, labels } = roll(day, 24, (ts) => Math.min(23, Math.floor((ts - base) / 3_600_000)), (i) => ([0, 6, 12, 18, 23].includes(i) ? i + "h" : null), agg, fill);
            return finish(data, labels);
          }
          if (range === "Year") {
            const anchor = new Date(anchorDay0);
            const { data, labels } = roll(pts, 12, monthIndexFrom(anchor), (i) => monthInitial(anchor, i), agg, fill);
            return finish(data, labels);
          }
          const n = range === "Week" ? 7 : 30;
          const lastDay = anchorDay0;
          const dayIdx = (ts: number) => n - 1 - Math.round((lastDay - startOfDay(ts)) / 86_400_000);
          const lab = range === "Week" ? (i: number) => WEEK_LABELS[i] : (i: number) => (i % 6 === 0 ? n - i + "j" : null);
          const { data, labels } = roll(pts, n, dayIdx, lab, agg, fill);
          return finish(data, labels);
        }

        if (spec.src === "sleep") {
          const n = range === "Year" ? 12 : range === "Month" ? 30 : 7;
          // Step `offset` whole windows of `n` nights into the past; fetch a wide
          // enough range to reach them, then slice that window out (newest-first).
          const skip = -offset * n;
          const backDays = skip + n + 14; // + margin for nights spanning midnight
          const wide = new Date(today0 - backDays * DAY).toISOString();
          const wideTo = new Date(today0 + DAY).toISOString();
          const [stage, hr, resp] = await Promise.all([
            getWellness("sleep_stage", wide, wideTo),
            spec.field === "hr" ? getWellness("heart_rate", wide, wideTo) : Promise.resolve({ kind: "", samples: [] }),
            spec.field === "breath" ? getWellness("respiration", wide, wideTo) : Promise.resolve({ kind: "", samples: [] }),
          ]);
          const toW = (x: { samples: { date: string; value: number }[] }) =>
            x.samples.map((s) => ({ ts: new Date(s.date).getTime(), date: s.date, value: s.value })).filter((p) => Number.isFinite(p.ts)).sort((a, b) => a.ts - b.ts);
          const nights = buildNights(toW(stage), toW(hr), toW(resp), []);
          if (!nights.length) return finish([], []);
          // each night is real; for hr/breath drop nights missing that stream (value 0)
          const recent = nights.slice(skip, skip + n).reverse(); // oldest→newest
          if (!recent.length) return finish([], []);
          const field = spec.field;
          const drop = field === "hr" || field === "breath";
          const data: number[] = [];
          const labels: (string | null)[] = [];
          recent.forEach((nt, i) => {
            const v = (nt as unknown as Record<string, number>)[field] ?? 0;
            if (drop && !(v > 0)) return;
            data.push(v);
            // Week: label by the night's REAL weekday (not slice position), so a
            // missing night doesn't shift every label. Parse LOCAL (bare YYYY-MM-DD
            // is UTC → off-by-one weekday in negative-UTC zones).
            labels.push(range === "Week" ? WEEK_LABELS[(new Date(nt.date + "T00:00:00").getDay() + 6) % 7] ?? "" : i % Math.ceil(n / 6) === 0 ? nt.date.slice(5) : null);
          });
          return finish(data, labels);
        }

        if (spec.src === "readiness") {
          const n = range === "Year" ? 12 : range === "Month" ? 30 : 7;
          const endDay0 = today0 + offset * n * DAY; // last day of the window
          const dates: string[] = [];
          for (let i = n - 1; i >= 0; i--) dates.push(new Date(endDay0 - i * 86_400_000).toISOString().slice(0, 10));
          const vals = await Promise.all(
            dates.map((day) =>
              getDerived(`day:${day}`)
                .then((r) => (r.metrics as { name: string; value: number }[]).find((m) => m.name === "readiness")?.value ?? 0)
                .catch(() => 0),
            ),
          );
          const data: number[] = [];
          const labels: (string | null)[] = [];
          vals.forEach((v, i) => {
            if (!(v > 0)) return; // drop days with no computed readiness
            data.push(v);
            labels.push(range === "Week" ? WEEK_LABELS[i] : i % Math.ceil(n / 6) === 0 ? dates[i].slice(5) : null);
          });
          return finish(data, labels);
        }

        if (spec.src === "trainingMinutes") {
          const pts = (await listActivities())
            .map((a) => ({ ts: Date.parse(a.started_at), value: a.duration_secs / 60 }))
            .filter((p) => Number.isFinite(p.ts))
            .sort((a, b) => a.ts - b.ts);
          if (!pts.length) return finish([], []);
          if (range === "Year") {
            const anchor = new Date(anchorDay0);
            const { data, labels } = roll(pts, 12, monthIndexFrom(anchor), (i) => monthInitial(anchor, i), "sum", true);
            return finish(data, labels);
          }
          const n = range === "Month" ? 30 : 7;
          const lastDay = anchorDay0;
          const dayIdx = (ts: number) => n - 1 - Math.round((lastDay - startOfDay(ts)) / 86_400_000);
          const lab = n === 7 ? (i: number) => WEEK_LABELS[i] : (i: number) => (i % 6 === 0 ? n - i + "j" : null);
          const { data, labels } = roll(pts, n, dayIdx, lab, "sum", true); // rest days = real 0
          return finish(data, labels);
        }
      } catch {
        if (alive) setVm((s) => ({ ...s, loading: false, real: false }));
      }
    })();
    return () => {
      alive = false;
    };
    // `key` is JSON.stringify(spec) — it captures spec's content, so we depend on
    // it rather than the spec OBJECT (an inline `{src:…}` arg is a new reference
    // every render, which would re-run this effect forever → setState loop).
  }, [key, range, decimals, offset]);
  return vm;
}

export { getStepsGoal };
export type { StreamKind };
