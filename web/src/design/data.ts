/* ============================================================
   OpenFit redesign — static design data + MOCKS + gear store.
   --------------------------------------------------------------
   Everything tagged `MOCK:` has NO backend endpoint yet (or the
   endpoint is perpetually empty). wiring.ts prefers real API data
   and falls back to these so the redesign always renders fully.
   Replace the mocks as the backend grows (see the report / memory).
   ============================================================ */
import { mulberry32, smoothSeries, fmtDay, dayKey } from "./util";
export { fmtDay, dayKey };

const rnd = mulberry32(20260601);

/** Sport → visual meta, keyed by the REAL Sport enum (lowercase).
 *  Single source of truth lives in lib/metadata; re-exported here for the
 *  redesign's existing `import { SPORTS } from "./data"` call sites. */
export { SPORTS } from "../lib/metadata";

export const TODAY = new Date(2026, 5, 1); // 1 June 2026 — anchors the mock series

/* ==================== DASHBOARD MOCKS ==================== */
// MOCK: readiness/HRV fall back to these when analytics aren't computed.
export const READINESS = { score: 65, label: "Balanced", state: "RECOVERY", hrv: 67, baseline: 47 };

// MOCK: per-tile fallbacks (steps comes from real wellness when present).
export const DASH_TILES = {
  steps: { value: 82, goal: 7000, pct: 1, unit: "" },
  bodyBattery: { value: 59, unit: "%" },
  trainingLoad: { value: 51, form: -26, unit: "" },
  restingHR: { value: 40, unit: "bpm" },
};

// MOCK: ~26 weeks of CTL/ATL/TSB (used only if /api/analytics/training-load is empty).
const TL_WEEKS = 26;
export interface TLPoint {
  date: Date;
  ctl: number;
  atl: number;
  tsb: number;
}
function buildTrainingLoad(): TLPoint[] {
  const ctlBase = smoothSeries(TL_WEEKS * 7, 18, 1.4, 1.1, 11);
  const out: TLPoint[] = [];
  for (let i = 0; i < TL_WEEKS * 7; i++) {
    const d = new Date(TODAY);
    d.setDate(d.getDate() - (TL_WEEKS * 7 - 1 - i));
    const ctl = Math.max(2, ctlBase[i] + 18 + Math.sin(i / 30) * 8);
    const atl = Math.max(0, ctl + Math.sin(i / 6) * 16 + (rnd() - 0.5) * 14);
    out.push({ date: d, ctl: +ctl.toFixed(1), atl: +atl.toFixed(1), tsb: +(ctl - atl).toFixed(1) });
  }
  return out;
}
export const TRAINING_LOAD = buildTrainingLoad();

// MOCK: weekly training volume by sport (minutes) — no per-sport-volume endpoint.
export const VOL_KEYS = ["running", "cycling", "walking", "strength", "activity"] as const;
export const VOL_COLORS = ["var(--run)", "var(--cycle)", "var(--walk)", "var(--strength)", "var(--activity)"];
export const WEEKLY_VOLUME: (Record<(typeof VOL_KEYS)[number], number> & { week: string; d: string })[] = [
  { week: "13/04", d: "13/04", running: 62, cycling: 0, walking: 28, strength: 0, activity: 0 },
  { week: "20/04", d: "20/04", running: 24, cycling: 6, walking: 0, strength: 0, activity: 0 },
  { week: "27/04", d: "27/04", running: 70, cycling: 4, walking: 64, strength: 0, activity: 0 },
  { week: "04/05", d: "04/05", running: 78, cycling: 12, walking: 70, strength: 0, activity: 6 },
  { week: "11/05", d: "11/05", running: 66, cycling: 8, walking: 132, strength: 0, activity: 0 },
  { week: "18/05", d: "18/05", running: 58, cycling: 14, walking: 22, strength: 0, activity: 10 },
  { week: "25/05", d: "25/05", running: 84, cycling: 70, walking: 30, strength: 6, activity: 18 },
  { week: "01/06", d: "01/06", running: 11, cycling: 0, walking: 0, strength: 6, activity: 0 },
];

/* ==================== WELLNESS MOCKS ==================== */
// MOCK: resting_heart_rate / hrv / stress / body_battery are perpetually empty on the API.
export const WELLNESS = {
  liveHR: 55,
  restingHR: 40,
  hrvOvernight: 48,
  stressAvg: 34,
  bodyBattery: 59,
  liveHRSeries: smoothSeries(60, 56, 3, 4, 7).map((v) => Math.round(v)),
  restingHR7d: { min: 40, avg: 47.1, max: 107, series: [44, 42, 42, 42, 41, 41, 42] },
  hrv30d: { min: 19, avg: 48, max: 115 },
  hr24h: { min: 38, avg: 61.7, max: 96 },
  stressToday: { min: 5, avg: 33.5, max: 65 },
};

export interface BandPoint { date: Date; avg: number; min: number; max: number }
function buildHRVBand(): BandPoint[] {
  const out: BandPoint[] = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(TODAY);
    d.setDate(d.getDate() - (29 - i));
    const avg = 42 + Math.sin(i / 5) * 9 + (rnd() - 0.5) * 8;
    const spread = 16 + rnd() * 22;
    out.push({ date: d, avg: Math.round(avg), min: Math.max(19, Math.round(avg - spread)), max: Math.min(115, Math.round(avg + spread)) });
  }
  return out;
}
export const HRV_BAND = buildHRVBand(); // MOCK

function build24hHR(): { t: number; v: number }[] {
  const out = [];
  for (let i = 0; i < 96; i++) {
    const hour = (i * 15) / 60;
    const base = hour < 6 ? 44 : hour < 8 ? 52 : 64;
    const v = base + Math.sin(i / 8) * 8 + (rnd() - 0.5) * 10 + (hour > 17 && hour < 19 ? 22 : 0);
    out.push({ t: hour, v: Math.max(38, Math.min(96, Math.round(v))) });
  }
  return out;
}
export const HR_24H = build24hHR(); // MOCK fallback (real via getWellness('heart_rate'))

function buildStressToday(): { t: number; v: number }[] {
  const out = [];
  for (let i = 0; i < 96; i++) {
    const hour = (i * 15) / 60;
    const base = hour < 7 ? 18 : 38;
    const v = base + Math.sin(i / 7) * 14 + (rnd() - 0.5) * 16;
    out.push({ t: hour, v: Math.max(5, Math.min(65, Math.round(v))) });
  }
  return out;
}
export const STRESS_TODAY = buildStressToday(); // MOCK

// MOCK fallback (real via getWellness('steps')).
export const STEPS_WEEK: { d: string; v: number }[] = [
  { d: "L", v: 8420 }, { d: "M", v: 6110 }, { d: "Me", v: 11230 },
  { d: "J", v: 4980 }, { d: "V", v: 9870 }, { d: "S", v: 13110 }, { d: "D", v: 82 },
];

/* ==================== SLEEP MOCKS ==================== */
// Sleep history is REAL via getDerived('day:'); these mocks are the fallback when no nights are imported.
const RAW_NIGHTS: [string, number, number][] = [
  ["2026-05-30", 452, 96], ["2026-05-29", 378, 73], ["2026-05-28", 428, 84],
  ["2026-05-27", 462, 97], ["2026-05-26", 457, 93], ["2026-05-25", 491, 86],
  ["2026-05-24", 472, 96], ["2026-05-23", 568, 98], ["2026-05-22", 499, 100],
  ["2026-05-21", 562, 100], ["2026-05-20", 534, 98], ["2026-05-19", 441, 94],
  ["2026-05-18", 456, 97], ["2026-05-17", 414, 90], ["2026-05-16", 498, 99],
  ["2026-05-15", 494, 100], ["2026-05-14", 398, 88], ["2026-05-13", 372, 84],
];
export interface Night {
  date: string;
  asleep: number;
  score: number;
  deep: number;
  rem: number;
  light: number;
  awake: number;
  bed: number;
  wake: number;
  hr: number;
  breath: number;
  hypopnea: number;
  spo2: number;
}
function buildNights(): Night[] {
  return RAW_NIGHTS.map(([date, asleep, score], idx) => {
    const r = mulberry32(idx + 99);
    const deep = Math.round(asleep * (0.13 + r() * 0.05));
    const rem = Math.round(asleep * (0.2 + r() * 0.06));
    const awake = Math.round(2 + r() * 12);
    const light = asleep - deep - rem;
    const bedH = 23 + (r() - 0.5);
    const wakeMin = (bedH * 60 + asleep + awake) % (24 * 60);
    return {
      date, asleep, score, deep, rem, light, awake,
      bed: ((bedH % 24) + 24) % 24,
      wake: wakeMin / 60,
      hr: Math.round(44 + r() * 6),
      breath: Math.round(15 + r() * 2),
      hypopnea: +(3.5 + r() * 4).toFixed(1),
      spo2: Math.round(94 + r() * 4),
    };
  });
}
export const NIGHTS = buildNights();
export const LAST_NIGHT = NIGHTS[0];

export const SLEEP_WEEK_LABELS = ["L", "M", "Me", "J", "V", "S", "D"];
const sleepWeek = NIGHTS.slice(0, 7).reverse();
export const SLEEP_WEEK = {
  duration: sleepWeek.map((n, i) => ({ d: SLEEP_WEEK_LABELS[i], deep: n.deep, light: n.light, rem: n.rem, awake: n.awake, total: n.asleep })),
  regularity: sleepWeek.map((n, i) => ({ d: SLEEP_WEEK_LABELS[i], bed: n.bed, wake: n.wake })),
  hr: sleepWeek.map((n, i) => ({ d: SLEEP_WEEK_LABELS[i], v: n.hr })),
  breath: sleepWeek.map((n, i) => ({ d: SLEEP_WEEK_LABELS[i], v: n.breath })),
  hypopnea: sleepWeek.map((n, i) => ({ d: SLEEP_WEEK_LABELS[i], v: n.hypopnea })),
};

export type SleepStage = "awake" | "rem" | "light" | "deep";
export function buildHypnogram(n: Night, seed = 7): { stage: SleepStage; len: number }[] {
  const r = mulberry32(seed);
  const segs: { stage: SleepStage; len: number }[] = [];
  const total = n.asleep + n.awake;
  let used = 0;
  const cycle: SleepStage[] = ["deep", "light", "rem", "light"];
  let ci = 0;
  while (used < total) {
    const stage: SleepStage = used < 10 ? "awake" : cycle[ci % cycle.length];
    let len = stage === "deep" ? 18 + r() * 22 : stage === "rem" ? 14 + r() * 26 : stage === "awake" ? 4 + r() * 6 : 16 + r() * 30;
    if (r() < 0.12 && used > 40) {
      segs.push({ stage: "awake", len: 3 + r() * 5 });
      used += 4;
    }
    len = Math.min(len, total - used);
    segs.push({ stage, len });
    used += len;
    ci++;
  }
  return segs;
}
export const HYPNOGRAM = buildHypnogram(LAST_NIGHT);

/* ==================== ACTIVITY DETAIL MOCK (Garmin tabs) ==================== */
// MOCK: stats groups / intervals / training effect / graph series have no endpoint.
// The Graphs tab uses REAL resolved streams when present; this is the template/fallback.
export const ACT_COUNTS: Record<string, number> = { All: 371, Running: 110, Cycling: 196, Walking: 33, Strength: 1, Activity: 31 };

export const RUN_DETAIL = {
  title: "Run — Activity",
  date: "27 mai 2026, 08:10",
  durSec: 4004,
  fused: 3,
  source: "Garmin Forerunner 945",
  summary: [
    ["Distance", "12.04", "km"], ["Duration", "1:06:44", ""], ["Avg pace", "5:32", "/km"],
    ["Calories", "704", "kcal"], ["Avg HR", "140", "bpm"], ["Avg power", "256", "W"],
  ] as [string, string, string][],
  trainingEffect: { aerobic: 4.1, anaerobic: 0.3, load: 158, label: "Tempo · high aerobic" },
  hrAvg: 140,
  hrMax: 164,
  gear: { name: "Escalante 4", desc: "Escalante 4 noire", used: 347.79, max: 1000 },
  statsGroups: [
    { title: "Pace", icon: "run", rows: [["Avg pace", "5:30", "/km"], ["Avg moving pace", "5:29", "/km"], ["Best pace", "3:14", "/km"]] },
    { title: "Speed", icon: "bolt", rows: [["Avg speed", "10.9", "km/h"], ["Avg moving speed", "11.0", "km/h"], ["Max speed", "18.5", "km/h"]] },
    { title: "Timing", icon: "clock", rows: [["Total time", "1:06:43", ""], ["Moving time", "1:06:31", ""], ["Elapsed time", "1:06:43", ""]] },
    { title: "Run / walk", icon: "walk", rows: [["Run time", "1:04:19", ""], ["Walk time", "2:21", ""], ["Idle time", "0:03", ""]] },
    { title: "Heart rate", icon: "drop", rows: [["Avg HR", "140", "bpm"], ["Max HR", "164", "bpm"]] },
    { title: "Training effect", icon: "bolt", rows: [["Aerobic", "4.1", ""], ["Anaerobic", "0.3", ""], ["Exercise load", "158", ""]] },
    { title: "Running dynamics", icon: "pulse", rows: [["Avg cadence", "174", "spm"], ["Max cadence", "212", "spm"], ["Avg stride", "1.04", "m"], ["Avg power", "256", "W"], ["Avg form power", "74", "W"], ["Vert. oscillation", "6.2", "cm"], ["Ground contact", "287", "ms"], ["Leg stiffness", "11.5", "kN/m"]] },
    { title: "Elevation", icon: "trend", rows: [["Total ascent", "32", "m"], ["Total descent", "33", "m"], ["Min elevation", "17", "m"], ["Max elevation", "33", "m"]] },
    { title: "Workout intervals", icon: "gauge", rows: [["Run time", "24:00", ""], ["Run distance", "5.20", "km"], ["Run pace", "4:37", "/km"]] },
    { title: "Calories & hydration", icon: "flame", rows: [["Resting cal", "98", ""], ["Active cal", "785", ""], ["Total cal", "883", ""], ["Est. sweat", "1 013", "ml"]] },
    { title: "Temperature", icon: "wind", rows: [["Avg temp", "28", "°C"], ["Min temp", "27", "°C"], ["Max temp", "31", "°C"]] },
    { title: "Intensity minutes", icon: "bolt", rows: [["Moderate", "14", "min"], ["Vigorous", "12", "min"], ["Total", "38", "min"]] },
  ] as { title: string; icon: string; rows: [string, string, string][] }[],
  intervals: [
    { n: "", type: "Warmup", time: "20:03", dist: "3.62", pace: "5:33", kind: "warmup" },
    { n: 1, type: "Run", time: "8:00", dist: "1.74", pace: "4:37", kind: "run" },
    { n: "", type: "Recovery", time: "3:00", dist: "0.52", pace: "5:47", kind: "recovery" },
    { n: 2, type: "Run", time: "8:00", dist: "1.73", pace: "4:38", kind: "run" },
    { n: "", type: "Recovery", time: "3:00", dist: "0.46", pace: "6:32", kind: "recovery" },
    { n: 3, type: "Run", time: "8:00", dist: "1.73", pace: "4:37", kind: "run" },
    { n: "", type: "Recovery", time: "16:40", dist: "2.35", pace: "7:06", kind: "recovery" },
  ] as { n: string | number; type: string; time: string; dist: string; pace: string; kind: string }[],
  intervalsTotal: { time: "1:06:43", dist: "12.14", pace: "5:30" },
  graphs: [
    { key: "hr", label: "Heart rate", color: "var(--rhr)", a: "140", b: "164", al: "Avg", bl: "Max" },
    { key: "paceSeries", label: "Pace", color: "var(--run)", a: "5:30", b: "3:14", al: "Avg", bl: "Best", invert: true },
    { key: "power", label: "Power", color: "var(--activity)", a: "256", b: "389", al: "Avg", bl: "Max" },
    { key: "cadenceSpm", label: "Cadence", color: "var(--strength)", a: "174", b: "212", al: "Avg", bl: "Max" },
    { key: "altitude", label: "Altitude", color: "var(--walk)", a: "17", b: "33", al: "Min", bl: "Max" },
    { key: "vertOsc", label: "Vertical oscillation", color: "var(--good)", a: "6.2", b: "13", al: "Avg", bl: "Max" },
    { key: "formPower", label: "Form power", color: "var(--strength)", a: "74", b: "106", al: "Avg", bl: "Max" },
    { key: "legSpring", label: "Leg spring stiffness", color: "var(--rhr)", a: "11.5", b: "33", al: "Avg", bl: "Max" },
    { key: "temperature", label: "Temperature", color: "var(--awake)", a: "28", b: "31", al: "Avg", bl: "Max" },
    { key: "humidity", label: "Humidity", color: "var(--ok)", a: "48", b: "54", al: "Avg", bl: "Max" },
  ] as { key: string; label: string; color: string; a: string; b: string; al: string; bl: string; invert?: boolean }[],
  hr: smoothSeries(160, 140, 4, 8, 3).map((v) => Math.round(Math.max(110, Math.min(168, v)))),
  power: smoothSeries(160, 256, 30, 10, 4).map((v) => Math.round(Math.max(120, v))),
  paceSeries: smoothSeries(160, 5.5, 0.3, 0.5, 5).map((v) => +Math.max(3.2, Math.min(10, v)).toFixed(2)),
  cadenceSpm: smoothSeries(160, 174, 6, 4, 6).map((v) => Math.round(Math.max(120, v))),
  altitude: smoothSeries(160, 24, 2, 6, 9).map((v) => Math.round(Math.max(15, v))),
  vertOsc: smoothSeries(160, 6.2, 0.5, 0.8, 12).map((v) => +Math.max(2, v).toFixed(1)),
  formPower: smoothSeries(160, 74, 8, 6, 13).map((v) => Math.round(Math.max(20, v))),
  legSpring: smoothSeries(160, 11.5, 1.2, 1.5, 14).map((v) => +Math.max(4, v).toFixed(1)),
  temperature: smoothSeries(160, 28, 0.6, 1.2, 15).map((v) => +v.toFixed(1)),
  humidity: smoothSeries(160, 48, 1.5, 4, 16).map((v) => Math.round(Math.max(40, Math.min(56, v)))),
} as const;
export type RunDetailGraphKey = keyof Pick<
  typeof RUN_DETAIL,
  "hr" | "power" | "paceSeries" | "cadenceSpm" | "altitude" | "vertOsc" | "formPower" | "legSpring" | "temperature" | "humidity"
>;

export const RECORD_TYPES = ["Running", "Cycling", "Walking", "Hiking", "Strength"];

/* ==================== GEAR STORE (shared, observable) ==================== */
// Backed by the real /api/gear endpoints (ofit-core::Gear + activity_gear).
// The store keeps the design's camelCase shape for the UI and maps to/from the
// snake_case API. Mutations are optimistic (instant local update + emit) and
// then reconciled against the server via reload(). Loads lazily on first
// subscribe so the fetch runs after auth.
import {
  getGear as apiGetGear,
  createGear as apiCreateGear,
  updateGearApi,
  deleteGear as apiDeleteGear,
  setGearDefaultApi,
  setActivityGearApi,
  type ApiGear,
} from "../api/endpoints";

export interface Gear {
  id: string;
  name: string;
  desc: string;
  type: string;
  initialKm: number;
  used: number;
  max: number;
  icon: string;
}

const fromApi = (g: ApiGear): Gear => ({
  id: g.id,
  name: g.name,
  desc: g.description || g.sport,
  type: g.sport,
  initialKm: g.initial_km,
  used: g.used_km,
  max: g.retire_km,
  icon: g.icon || (g.sport === "Cycling" ? "bike" : "run"),
});

class GearStore {
  gears: Gear[] = [];
  defaults: Record<string, string> = {};
  activityGear: Record<string, string[]> = {};
  private subs: (() => void)[] = [];
  private seq = 0;
  private loaded = false;
  private loading = false;

  subscribe(fn: () => void): () => void {
    this.subs.push(fn);
    void this.ensureLoaded();
    return () => {
      this.subs = this.subs.filter((f) => f !== fn);
    };
  }
  private emit() {
    this.subs.forEach((f) => f());
  }

  /** Fetch from the API once (after auth). Safe to call repeatedly. */
  async ensureLoaded(): Promise<void> {
    if (this.loaded || this.loading) return;
    await this.reload();
  }

  /** (Re)load the full gear state from the server and reconcile local cache. */
  async reload(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const state = await apiGetGear();
      this.gears = state.gears.map(fromApi);
      this.defaults = { ...state.defaults };
      this.activityGear = { ...state.assignments };
      this.loaded = true;
      this.emit();
    } catch {
      /* leave cache as-is (e.g. not yet authed); a later subscribe retries */
    } finally {
      this.loading = false;
    }
  }

  byId(id: string): Gear | undefined {
    return this.gears.find((g) => g.id === id);
  }

  addGear({ name, desc, type, initialKm, max }: { name: string; desc?: string; type: string; initialKm: number | string; max: number | string }): string {
    const tmpId = "tmp-" + ++this.seq;
    const init = +initialKm || 0;
    const retire = +max || 1000;
    const icon = type === "Cycling" ? "bike" : "run";
    // Optimistic insert so the UI updates immediately.
    this.gears.push({ id: tmpId, name, desc: desc || type, type, initialKm: init, used: init, max: retire, icon });
    if (!this.defaults[type]) this.defaults[type] = tmpId;
    this.emit();
    void apiCreateGear({ name, description: desc || "", sport: type, initial_km: init, retire_km: retire, icon })
      .then(() => this.reload())
      .catch(() => this.reload());
    return tmpId;
  }

  updateGear(id: string, patch: Partial<Gear>) {
    const g = this.byId(id);
    if (g) Object.assign(g, patch);
    this.emit();
    if (id.startsWith("tmp-")) return; // not yet persisted; create will carry fields
    void updateGearApi(id, {
      name: patch.name,
      description: patch.desc,
      sport: patch.type,
      retire_km: patch.max,
      used_km: patch.used,
      icon: patch.icon,
    })
      .then(() => this.reload())
      .catch(() => this.reload());
  }

  removeGear(id: string) {
    this.gears = this.gears.filter((g) => g.id !== id);
    Object.keys(this.defaults).forEach((t) => {
      if (this.defaults[t] === id) delete this.defaults[t];
    });
    Object.keys(this.activityGear).forEach((a) => {
      this.activityGear[a] = this.activityGear[a].filter((x) => x !== id);
    });
    this.emit();
    if (id.startsWith("tmp-")) return;
    void apiDeleteGear(id)
      .then(() => this.reload())
      .catch(() => this.reload());
  }

  setDefault(type: string, id: string) {
    if (id) this.defaults[type] = id;
    else delete this.defaults[type];
    this.emit();
    if (id && id.startsWith("tmp-")) return;
    void setGearDefaultApi(type, id || null)
      .then(() => this.reload())
      .catch(() => this.reload());
  }

  idsFor(actId: string, type: string): string[] {
    if (this.activityGear[actId]) return this.activityGear[actId];
    const d = this.defaults[type];
    return d ? [d] : [];
  }
  gearsFor(actId: string, type: string): Gear[] {
    return this.idsFor(actId, type)
      .map((id) => this.byId(id))
      .filter((g): g is Gear => Boolean(g));
  }

  /** Persist an explicit gear set for one activity (used by assign/unassign). */
  private persistActivity(actId: string) {
    const ids = this.activityGear[actId] ?? [];
    if (ids.some((x) => x.startsWith("tmp-"))) return; // wait for create to reconcile
    void setActivityGearApi(actId, ids)
      .then(() => this.reload())
      .catch(() => this.reload());
  }
  assign(actId: string, type: string, id: string) {
    const cur = this.idsFor(actId, type);
    if (!cur.includes(id)) this.activityGear[actId] = [...cur, id];
    this.emit();
    this.persistActivity(actId);
  }
  unassign(actId: string, type: string, id: string) {
    this.activityGear[actId] = this.idsFor(actId, type).filter((x) => x !== id);
    this.emit();
    this.persistActivity(actId);
  }
}
export const GEAR = new GearStore();
