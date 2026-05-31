// Wellness screen — faithful port of docs/designs/wellness.html, wired to live
// data (Gadgetbridge / Zepp imports + the live BLE feed via the wellness API).
//   - readiness banner (readiness algorithm)
//   - 4 stat tiles: latest resting HR · HRV · stress avg · body battery
//   - main column: last-night sleep (sleep algorithm) · HRV trend · body-battery
//   - side column: resting HR · stress · steps
//
// Each module renders a real sparkline from getWellness(); when a metric has no
// samples for this account/hardware it falls back to the on-brand empty state
// (never fake numbers).

import { useEffect, useMemo, useState, type ReactNode, type SVGProps } from "react";
import { Link } from "react-router-dom";
import { AppShell } from "../app/AppShell";
import { EmptyState } from "../ui/EmptyState";
import { ReadinessSection } from "../ui/ReadinessSection";
import { Seg } from "../ui/Seg";
import { getWellness, getTrainingLoad, getDerived } from "../api/endpoints";
import type { WellnessSample } from "../api/types";
import type { TrainingLoadResponseDto } from "../api/schema";
import { useWellnessLive } from "../hooks/useWellnessLive";

/* ------------------------------------------------------------- date range */

const RANGES = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
] as const;
type Range = (typeof RANGES)[number]["value"];

/* ------------------------------------------------- wellness series loading */

// Continuous wellness kinds, by their real API (serde) names. Populated from the
// Gadgetbridge / Zepp imports and the live BLE feed (Phase 2) — Phase 4 renders
// them as trends here.
const KINDS = [
  "resting_heart_rate",
  "hrv",
  "stress",
  "body_battery",
  "steps",
] as const;
type Kind = (typeof KINDS)[number];

type SeriesMap = Partial<Record<Kind, WellnessSample[]>>;

const DAY_MS = 86_400_000;
const RANGE_DAYS: Record<Range, number> = { day: 1, week: 7, month: 30 };

/** Even-stride downsample so a multi-thousand-point series stays a smooth, cheap
 *  sparkline (HRV/stress can be tens of thousands of points). */
function downsample(s: WellnessSample[], cap = 500): WellnessSample[] {
  if (s.length <= cap) return s;
  const stride = Math.ceil(s.length / cap);
  return s.filter((_, i) => i % stride === 0);
}

// Load every kind once over a wide window (bounds payload), then window each to
// the selected range ANCHORED TO ITS LATEST SAMPLE — so imported history that
// ends a day or two ago still shows under "Day"/"Week".
function useWellness(range: Range): { series: SeriesMap; loading: boolean } {
  const [series, setSeries] = useState<SeriesMap>({});
  const [raw, setRaw] = useState<SeriesMap>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const fromISO = new Date(Date.now() - 120 * DAY_MS).toISOString();
    Promise.all(
      KINDS.map(async (kind) => {
        try {
          const s = await getWellness(kind, fromISO);
          const sorted = [...s.samples].sort((a, b) => a.date.localeCompare(b.date));
          return [kind, sorted] as const;
        } catch {
          return [kind, [] as WellnessSample[]] as const;
        }
      }),
    ).then((entries) => {
      if (!alive) return;
      const next: SeriesMap = {};
      for (const [kind, samples] of entries) next[kind] = samples;
      setRaw(next);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const winMs = RANGE_DAYS[range] * DAY_MS;
    const next: SeriesMap = {};
    for (const kind of KINDS) {
      const all = raw[kind] ?? [];
      const lastTs = all.length ? Date.parse(all[all.length - 1].date) : 0;
      const windowed = all.filter((x) => Date.parse(x.date) >= lastTs - winMs);
      next[kind] = downsample(windowed);
    }
    setSeries(next);
  }, [raw, range]);

  return { series, loading };
}

/** Latest numeric value of a series, or null. */
function latest(s: WellnessSample[] | undefined): number | null {
  return s && s.length ? s[s.length - 1].value : null;
}
/** Mean of a series, or null. */
function mean(s: WellnessSample[] | undefined): number | null {
  if (!s || !s.length) return null;
  return s.reduce((a, x) => a + x.value, 0) / s.length;
}

function hasData(samples: WellnessSample[] | undefined): samples is WellnessSample[] {
  return Array.isArray(samples) && samples.length > 0;
}

/** Catmull-Rom → cubic-bézier smoothing for a soft, rounded line through points. */
function smoothLine(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

/* ----------------------------------------------- bucketed trend rendering */
// Raw per-minute series (HR, stress, body battery) are far too jagged to read,
// and multi-day trends are noise at full resolution. We bucket each series by
// hour (≤2-day spans) or day (longer) and render a min/max BAND with a mean
// line — so a glance shows the spread and the trend, with min/avg/max printed.

interface Bucket {
  t: number;
  min: number;
  max: number;
  mean: number;
  sum: number;
  count: number;
}

const HOUR_MS = 3_600_000;

function bucketize(samples: WellnessSample[], bucketMs: number): Bucket[] {
  const map = new Map<number, { min: number; max: number; sum: number; count: number }>();
  for (const s of samples) {
    const t = Date.parse(s.date);
    if (!Number.isFinite(t)) continue;
    const key = Math.floor(t / bucketMs) * bucketMs;
    const b = map.get(key);
    if (!b) map.set(key, { min: s.value, max: s.value, sum: s.value, count: 1 });
    else {
      if (s.value < b.min) b.min = s.value;
      if (s.value > b.max) b.max = s.value;
      b.sum += s.value;
      b.count += 1;
    }
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, b]) => ({ t, min: b.min, max: b.max, mean: b.sum / b.count, sum: b.sum, count: b.count }));
}

/** Hour buckets for ≤2-day spans, day buckets beyond — keeps bucket count readable. */
function chooseBucketMs(samples: WellnessSample[]): number {
  if (samples.length < 2) return HOUR_MS;
  const span = Date.parse(samples[samples.length - 1].date) - Date.parse(samples[0].date);
  return span <= 2 * DAY_MS ? HOUR_MS : DAY_MS;
}

/** Min/max band (shaded) + mean line. De-noises raw series into a readable shape
 *  while still showing the per-bucket spread. */
function BandChart({
  buckets,
  color,
  height = 140,
  viewW = 720,
}: {
  buckets: Bucket[];
  color: string;
  height?: number;
  viewW?: number;
}) {
  const lo = Math.min(...buckets.map((b) => b.min));
  const hi = Math.max(...buckets.map((b) => b.max));
  const span = hi - lo || 1;
  const stepX = buckets.length > 1 ? viewW / (buckets.length - 1) : 0;
  const sy = (v: number) => height - ((v - lo) / span) * (height - 16) - 8;
  const top = buckets.map((b, i) => ({ x: i * stepX, y: sy(b.max) }));
  const bot = buckets.map((b, i) => ({ x: i * stepX, y: sy(b.min) }));
  const meanPts = buckets.map((b, i) => ({ x: i * stepX, y: sy(b.mean) }));
  const topLine = smoothLine(top);
  const botBack = smoothLine([...bot].reverse()).replace(/^M/, "L");
  const band = buckets.length > 1 ? `${topLine} ${botBack} Z` : "";
  const gid = `band-${color.replace(/\W/g, "")}-${buckets.length}`;
  return (
    <svg
      viewBox={`0 0 ${viewW} ${height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height }}
      role="img"
      aria-label="trend with min/max band"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.24" />
          <stop offset="100%" stopColor={color} stopOpacity="0.04" />
        </linearGradient>
      </defs>
      {band && <path d={band} fill={`url(#${gid})`} />}
      <path
        d={smoothLine(meanPts)}
        fill="none"
        stroke={color}
        strokeWidth="2.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Daily-total bars (steps). */
function BarChart({
  buckets,
  color,
  height = 140,
  viewW = 720,
}: {
  buckets: Bucket[];
  color: string;
  height?: number;
  viewW?: number;
}) {
  const hi = Math.max(...buckets.map((b) => b.sum), 1);
  const slot = viewW / buckets.length;
  const bw = slot * 0.6;
  const gid = `bar-${color.replace(/\W/g, "")}-${buckets.length}`;
  return (
    <svg
      viewBox={`0 0 ${viewW} ${height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height }}
      role="img"
      aria-label="daily totals"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.9" />
          <stop offset="100%" stopColor={color} stopOpacity="0.35" />
        </linearGradient>
      </defs>
      {buckets.map((b, i) => {
        const h = Math.max((b.sum / hi) * (height - 8), 1);
        return (
          <rect key={b.t} x={i * slot + (slot - bw) / 2} y={height - h} width={bw} height={h} fill={`url(#${gid})`} />
        );
      })}
    </svg>
  );
}

/** Compact number: 13381 → "13,381"; small values keep one decimal. */
function fmtNum(v: number, big = false): string {
  if (!Number.isFinite(v)) return "—";
  if (big) return Math.round(v).toLocaleString();
  return Math.abs(v) >= 100 ? `${Math.round(v)}` : `${Math.round(v * 10) / 10}`;
}

/** Small min/avg/max (or total) readout above a chart. */
function StatHeader({ items }: { items: { label: string; value: string; unit?: string }[] }) {
  return (
    <div style={{ display: "flex", gap: 20, flexWrap: "wrap", margin: "0 0 12px" }}>
      {items.map((it) => (
        <div key={it.label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 10, letterSpacing: ".07em", textTransform: "uppercase", color: "var(--muted)" }}>
            {it.label}
          </span>
          <span className="num" style={{ fontSize: 16, fontWeight: 700, lineHeight: 1 }}>
            {it.value}
            {it.unit ? <small style={{ fontSize: 10, opacity: 0.5, marginLeft: 3 }}>{it.unit}</small> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/** A readable metric trend: min/avg/max (or total) header + a min/max band, or
 *  daily-total bars for cumulative metrics (mode="bars"). */
function MetricChart({
  samples,
  color,
  unit,
  height = 140,
  mode = "band",
}: {
  samples: WellnessSample[];
  color: string;
  unit?: string;
  height?: number;
  mode?: "band" | "bars";
}) {
  const sorted = useMemo(
    () => [...samples].sort((a, b) => a.date.localeCompare(b.date)),
    [samples],
  );
  const buckets = useMemo(
    () => bucketize(sorted, mode === "bars" ? DAY_MS : chooseBucketMs(sorted)),
    [sorted, mode],
  );
  if (!buckets.length) return null;

  if (mode === "bars") {
    const totals = buckets.map((b) => b.sum);
    const total = totals.reduce((a, b) => a + b, 0);
    return (
      <>
        <StatHeader
          items={[
            { label: "Total", value: fmtNum(total, true), unit },
            { label: "Daily avg", value: fmtNum(total / buckets.length, true), unit },
            { label: "Best day", value: fmtNum(Math.max(...totals), true), unit },
          ]}
        />
        <BarChart buckets={buckets} color={color} height={height} />
      </>
    );
  }

  const vals = sorted.map((s) => s.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return (
    <>
      <StatHeader
        items={[
          { label: "Min", value: fmtNum(min), unit },
          { label: "Avg", value: fmtNum(avg), unit },
          { label: "Max", value: fmtNum(max), unit },
        ]}
      />
      <BandChart buckets={buckets} color={color} height={height} />
    </>
  );
}

/* ------------------------------------------------ stat-tile glyphs (design) */
// Ported verbatim from wellness.html. These are screen-specific stat glyphs not
// present in the shared icons file; kept presentational (aria-hidden).

const g = { fill: "none", stroke: "currentColor", strokeWidth: 2 } as const;

function HeartGlyph(p: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...g} aria-hidden {...p}>
      <path d="M12 21s-7-4.5-7-9.5A3.5 3.5 0 0112 8a3.5 3.5 0 017 3.5C19 16.5 12 21 12 21z" />
    </svg>
  );
}
function HrvGlyph(p: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...g} aria-hidden {...p}>
      <path d="M3 12h4l2-5 3 10 2-7 2 4h5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function StressGlyph(p: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...g} aria-hidden {...p}>
      <path d="M12 3a9 9 0 109 9" strokeLinecap="round" />
      <path d="M12 8v4l3 1" strokeLinecap="round" />
    </svg>
  );
}
function BatteryGlyph(p: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...g} aria-hidden {...p}>
      <rect x="6" y="3" width="12" height="18" rx="3" />
      <path d="M9 8h6" strokeLinecap="round" />
    </svg>
  );
}

/* --------------------------------------------------------------- stat tile */

// A stat tile: design icon + label, with the latest resolved value (or a dash +
// "No data yet" when the metric has no samples for this account/hardware).
function StatTile({
  tint,
  icon,
  label,
  value,
  unit,
}: {
  tint: string;
  icon: ReactNode;
  label: string;
  value?: string | null;
  unit?: string;
}) {
  const has = value != null;
  return (
    <div className="card stat">
      <div className={`stat__ico ${tint}`}>{icon}</div>
      <div className="stat__label">{label}</div>
      <div className={`stat__val num${has ? "" : " muted"}`} aria-label={has ? undefined : "No data yet"}>
        {has ? value : "—"}
        {has && unit ? <small> {unit}</small> : null}
      </div>
      {!has && <div className="stat__delta flat">No data yet</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ screen */

/** Live real-time card: current HR from the wellness WebSocket + a sparkline. */
function LiveCard() {
  const live = useWellnessLive();
  const hr = live.last.heart_rate;
  const buf = live.buffer.heart_rate ?? [];
  const values = buf.map((s) => s.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const span = max - min || 1;
  const w = 220;
  const h = 40;
  const path = smoothLine(
    values.map((v, i) => ({
      x: values.length > 1 ? (i / (values.length - 1)) * w : 0,
      y: h - ((v - min) / span) * (h - 6) - 3,
    })),
  );

  return (
    <div
      className="card"
      style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}
    >
      <div className="stat__ico t-hr" style={{ marginBottom: 0 }}>
        <HeartGlyph />
      </div>
      <div style={{ minWidth: 96 }}>
        <div className="stat__label">Live heart rate</div>
        <div className="stat__val num" style={{ marginTop: 2 }}>
          {hr ? Math.round(hr.value) : "—"} <small>bpm</small>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        height={h}
        style={{ flex: "1 1 140px", minWidth: 120, maxWidth: 360, height: h }}
        aria-hidden
      >
        {path && (
          <path
            d={path}
            fill="none"
            stroke="var(--hr)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <span
        className={live.connected ? "pill pill--good" : "pill"}
        style={{ marginLeft: "auto" }}
      >
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: live.connected ? "var(--good)" : "var(--faint)",
          }}
        />
        {live.connected ? "streaming" : "waiting for stream"}
      </span>
    </div>
  );
}

interface SleepNight {
  date: string;
  score: number;
  total: number;
  deep: number;
  rem: number;
  light: number;
  awake: number;
}

/** Heart rate over the last 24h — the per-minute history pulled from the strap
 *  (M2 fetch) plus live samples. Bounded window + downsample so it stays light. */
function HeartRateDayCard() {
  const [samples, setSamples] = useState<WellnessSample[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    getWellness("heart_rate", from)
      .then((s) => {
        if (!alive) return;
        const sorted = [...s.samples].sort((a, b) => a.date.localeCompare(b.date));
        setSamples(downsample(sorted, 400));
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);
  return (
    <div className="card">
      <div className="card__head">
        <div className="card__title">
          Heart rate<span className="sub">last 24 hours</span>
        </div>
      </div>
      {samples.length > 0 ? (
        <MetricChart samples={samples} color="var(--hr)" unit="bpm" height={140} />
      ) : (
        <EmptyState
          label={loaded ? "No data yet" : "Loading…"}
          hint="Live HR + per-minute history synced from your strap."
        />
      )}
    </div>
  );
}

/** Last-night sleep summary (score + stage bar) from the `sleep` algorithm,
 *  walking back to the most recent night that has data. Links to /sleep. */
function LastNightSleepCard() {
  const [night, setNight] = useState<SleepNight | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const today = new Date();
      for (let i = 0; i < 14; i++) {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - i);
        const date = d.toISOString().slice(0, 10);
        try {
          const r = await getDerived(`day:${date}`);
          const by = new Map(r.metrics.map((m) => [m.name, m.value]));
          if (by.get("sleep_available") === 1) {
            if (!alive) return;
            setNight({
              date,
              score: by.get("sleep_score") ?? 0,
              total: by.get("sleep_total_min") ?? 0,
              deep: by.get("sleep_deep_min") ?? 0,
              rem: by.get("sleep_rem_min") ?? 0,
              light: by.get("sleep_light_min") ?? 0,
              awake: by.get("sleep_awake_min") ?? 0,
            });
            setLoaded(true);
            return;
          }
        } catch {
          /* keep walking back */
        }
      }
      if (alive) setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const fmt = (m: number) => `${Math.floor(m / 60)}h ${Math.round(m % 60).toString().padStart(2, "0")}m`;
  const staged = night ? night.deep + night.rem + night.light + night.awake || 1 : 1;
  const seg = (m: number, bg: string) =>
    m > 0 ? <span style={{ width: `${(m / staged) * 100}%`, background: bg }} /> : null;

  return (
    <div className="card">
      <div className="card__head">
        <div className="card__title">
          Last night<span className="sub">sleep stages · score</span>
        </div>
        <div className="card__tools">
          <Link to="/sleep" className="pill">
            All nights
          </Link>
        </div>
      </div>
      {!loaded ? (
        <div className="muted" style={{ fontSize: 12.5, padding: "8px 2px" }}>
          Loading…
        </div>
      ) : !night ? (
        <EmptyState
          label="No sleep data yet"
          hint="Import a Zepp export or a Gadgetbridge DB with sleep tracking, then Recompute."
          compact
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 4 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <span className="num" style={{ fontSize: 30, fontWeight: 800 }}>
              {Math.round(night.score)}
              <small style={{ fontSize: 13, opacity: 0.6 }}> /100</small>
            </span>
            <span className="muted" style={{ fontSize: 13 }}>
              {fmt(night.total)} asleep · {night.date}
            </span>
          </div>
          <div style={{ display: "flex", height: 12, borderRadius: 999, overflow: "hidden", background: "var(--surface-2, #1a1d28)" }}>
            {seg(night.deep, "var(--hr, #6c8cff)")}
            {seg(night.rem, "var(--acc, #8e7bff)")}
            {seg(night.light, "var(--pace, #46c3a6)")}
            {seg(night.awake, "var(--muted, #5a6072)")}
          </div>
          <div className="legend">
            <i><b style={{ background: "var(--hr, #6c8cff)" }} />Deep {fmt(night.deep)}</i>
            <i><b style={{ background: "var(--acc, #8e7bff)" }} />REM {fmt(night.rem)}</i>
            <i><b style={{ background: "var(--pace, #46c3a6)" }} />Light {fmt(night.light)}</i>
            <i><b style={{ background: "var(--muted, #5a6072)" }} />Awake {fmt(night.awake)}</i>
          </div>
        </div>
      )}
    </div>
  );
}

export function Wellness() {
  const [range, setRange] = useState<Range>("week");
  const { series } = useWellness(range);

  const [tl, setTl] = useState<TrainingLoadResponseDto | null>(null);
  useEffect(() => {
    let alive = true;
    getTrainingLoad().then((d) => alive && setTl(d));
    return () => {
      alive = false;
    };
  }, []);

  const rhr = latest(series.resting_heart_rate);
  const hrv = latest(series.hrv);
  const stress = mean(series.stress);
  const bb = latest(series.body_battery);

  return (
    <AppShell
      title="Wellness"
      crumb="Recovery, sleep & daily health · resolved per metric"
      actions={
        <Seg options={RANGES} value={range} onChange={setRange} aria-label="Date range" />
      }
    >
      {/* recovery readiness (once-daily metric) + live HR, compact 2-up row */}
      <div className="grid grid--2" style={{ marginBottom: "var(--gap)" }}>
        <ReadinessSection data={tl} compact />
        <LiveCard />
      </div>

      {/* import wellness from a Gadgetbridge export DB (works on web + the app) */}

      {/* stat tiles — latest values from the resolved wellness series */}
      <div className="grid grid--stats" style={{ marginBottom: "var(--gap)" }}>
        <StatTile tint="t-hr" icon={<HeartGlyph />} label="Resting HR"
          value={rhr != null ? `${Math.round(rhr)}` : null} unit="bpm" />
        <StatTile tint="t-pow" icon={<HrvGlyph />} label="HRV · overnight"
          value={hrv != null ? `${Math.round(hrv)}` : null} unit="ms" />
        <StatTile tint="t-cad" icon={<StressGlyph />} label="Stress · avg"
          value={stress != null ? `${Math.round(stress)}` : null} />
        <StatTile tint="t-acc" icon={<BatteryGlyph />} label="Body battery"
          value={bb != null ? `${Math.round(bb)}` : null} unit="%" />
      </div>

      <div className="grid grid--main">
        {/* ---------------------------------------------- main column */}
        <div className="grid" style={{ gap: "var(--gap)" }}>
          {/* sleep — last night summary from the sleep algorithm */}
          <LastNightSleepCard />

          {/* HRV trend */}
          <div className="card">
            <div className="card__head">
              <div className="card__title">
                HRV trend<span className="sub">30 days · balanced band</span>
              </div>
            </div>
            <ModuleBody
              samples={series.hrv}
              color="var(--power)"
              unit="ms"
              empty={
                <EmptyState
                  label="No data yet"
                  hint="Overnight HRV trend with your personal balanced band."
                />
              }
            />
          </div>

          {/* heart rate · 24h (live + the strap's fetched per-minute history) */}
          <HeartRateDayCard />

          {/* body battery 24h */}
          <div className="card">
            <div className="card__head">
              <div className="card__title">
                Body battery<span className="sub">last 24 hours</span>
              </div>
            </div>
            <ModuleBody
              samples={series.body_battery}
              color="var(--accent)"
              unit="%"
              empty={
                <EmptyState
                  label="No data yet"
                  hint="Energy charge & drain across the day."
                />
              }
            />
          </div>
        </div>

        {/* ---------------------------------------------- side column */}
        <div className="grid" style={{ gap: "var(--gap)" }}>
          {/* resting HR trend */}
          <div className="card">
            <div className="card__head">
              <div className="card__title">Resting HR</div>
              <div className="card__tools">
                <span className="tag">7d</span>
              </div>
            </div>
            <ModuleBody
              samples={series.resting_heart_rate}
              color="var(--hr)"
              unit="bpm"
              height={110}
              empty={<EmptyState label="No data yet" compact />}
            />
          </div>

          {/* stress through day */}
          <div className="card">
            <div className="card__head">
              <div className="card__title">Stress · today</div>
            </div>
            <ModuleBody
              samples={series.stress}
              color="var(--cal)"
              height={130}
              empty={<EmptyState label="No data yet" compact />}
            />
            <div className="legend" style={{ marginTop: 8 }}>
              <i>
                <b style={{ background: "var(--good)" }} />
                Rest
              </i>
              <i>
                <b style={{ background: "var(--cadence)" }} />
                Low
              </i>
              <i>
                <b style={{ background: "var(--cal)" }} />
                Medium
              </i>
              <i>
                <b style={{ background: "var(--hr)" }} />
                High
              </i>
            </div>
          </div>

          {/* steps week */}
          <div className="card">
            <div className="card__head">
              <div className="card__title">Steps · this week</div>
            </div>
            <ModuleBody
              samples={series.steps}
              color="var(--accent)"
              mode="bars"
              height={130}
              empty={<EmptyState label="No data yet" compact />}
            />
          </div>
        </div>
      </div>

    </AppShell>
  );
}

/* --------------------------------------------------------------- helpers */

// Render real samples as a readable min/max-band (or bars) chart if present,
// otherwise the on-brand empty state.
function ModuleBody({
  samples,
  color,
  empty,
  height,
  unit,
  mode,
}: {
  samples: WellnessSample[] | undefined;
  color: string;
  empty: ReactNode;
  height?: number;
  unit?: string;
  mode?: "band" | "bars";
}) {
  if (hasData(samples)) {
    return <MetricChart samples={samples} color={color} unit={unit} height={height} mode={mode} />;
  }
  return <>{empty}</>;
}
