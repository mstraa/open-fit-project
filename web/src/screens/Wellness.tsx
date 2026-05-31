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

import { useEffect, useRef, useState, type ReactNode, type SVGProps } from "react";
import { Link } from "react-router-dom";
import { AppShell } from "../app/AppShell";
import { EmptyState } from "../ui/EmptyState";
import { Seg } from "../ui/Seg";
import { getWellness, getTrainingLoad, getDerived, importGadgetbridge, importZepp } from "../api/endpoints";
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

/* ------------------------------------------------------ tiny SVG sparkline */

// Minimal on-brand line sparkline used only when REAL samples are present. It
// mirrors the design's OF.lineChart shape (filled area under a single stroke).
function Sparkline({
  samples,
  color,
  height = 160,
  viewW = 720,
}: {
  samples: WellnessSample[];
  color: string;
  height?: number;
  viewW?: number;
}) {
  const vals = samples.map((s) => s.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const stepX = vals.length > 1 ? viewW / (vals.length - 1) : viewW;
  const sy = (v: number) => height - ((v - min) / span) * (height - 12) - 6;
  const pts = vals.map((v, i) => `${(i * stepX).toFixed(1)},${sy(v).toFixed(1)}`);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p}`).join(" ");
  const area = `M0,${height} L${line.slice(1)} L${viewW},${height} Z`;
  const gid = `sl-${Math.round(min)}-${Math.round(max)}-${vals.length}`;
  return (
    <svg
      viewBox={`0 0 ${viewW} ${height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height }}
      role="img"
      aria-label="trend"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
    </svg>
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

/** Import wellness from a Gadgetbridge export DB (HR / stress / steps / resting HR).
 * The file input opens the OS picker on web AND inside the Capacitor app. */
function GadgetbridgeCard() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await importGadgetbridge(f);
      const perDevice = r.devices
        .map((d) => `${d.device}: ${d.ingested.toLocaleString()} (${d.by_kind.map((k) => k.kind).join(", ")})`)
        .join(" · ");
      setResult(`Imported ${r.ingested.toLocaleString()} readings — ${perDevice}.`);
      setTimeout(() => window.location.reload(), 1600);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card__head">
        <div className="card__title">
          Import from Gadgetbridge<span className="sub">export DB · cloudless</span>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 12px" }}>
        In Gadgetbridge → <b>Database management → Export DB</b>, then upload the file here to
        ingest heart rate, stress, steps and resting HR.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept=".db,application/octet-stream,application/x-sqlite3"
        style={{ display: "none" }}
        disabled={busy}
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <button type="button" className="btn" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? "Importing…" : "Choose Gadgetbridge DB"}
      </button>
      {result && (
        <div className="pill pill--good" style={{ marginTop: 12, justifyContent: "flex-start" }}>
          {result}
        </div>
      )}
      {error && (
        <div className="pill pill--bad" style={{ marginTop: 12, justifyContent: "flex-start" }}>
          {error}
        </div>
      )}
    </div>
  );
}

/** Import a zipped Zepp/Amazfit app export (all-day HR, sleep staging, steps,
 *  calories, weight). One account → one Zepp source; re-uploading replaces. */
function ZeppCard() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await importZepp(f);
      const breakdown = r.by_kind.map((k) => `${k.count.toLocaleString()} ${k.kind}`).join(" · ");
      const acts = r.activities_imported ? ` + ${r.activities_imported} workouts → Activities` : "";
      const dups = r.activities_skipped_dup + r.duplicate_summaries_removed;
      const deduped = dups ? ` (skipped ${dups} that duplicate your .fit imports)` : "";
      setResult(`Imported ${r.ingested.toLocaleString()} readings into ${r.source} — ${breakdown}${acts}${deduped}.`);
      setTimeout(() => window.location.reload(), 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card__head">
        <div className="card__title">
          Import from Zepp / Amazfit<span className="sub">app export · cloudless</span>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 12px" }}>
        In the Zepp app → <b>Profile → Settings → About → Export data</b>, then zip the exported
        folder and upload it here to ingest all-day heart rate, sleep staging (→ sleep score),
        daily steps &amp; calories, and weight.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip"
        style={{ display: "none" }}
        disabled={busy}
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <button type="button" className="btn" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? "Importing…" : "Choose Zepp export (.zip)"}
      </button>
      {result && (
        <div className="pill pill--good" style={{ marginTop: 12, justifyContent: "flex-start" }}>
          {result}
        </div>
      )}
      {error && (
        <div className="pill pill--bad" style={{ marginTop: 12, justifyContent: "flex-start" }}>
          {error}
        </div>
      )}
    </div>
  );
}

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
  const path = values
    .map((v, i) => {
      const x = values.length > 1 ? (i / (values.length - 1)) * w : 0;
      const y = h - ((v - min) / span) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div
      className="card"
      style={{ marginBottom: 24, display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}
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
        style={{ flex: "1 1 120px", minWidth: 120, maxWidth: "100%", height: h }}
        aria-hidden
      >
        {path && <path d={path} fill="none" stroke="var(--hr)" strokeWidth={2} />}
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

/** Recovery readiness banner — the 0–100 score from the `readiness` algorithm
 *  (HRV + resting-HR vs your baseline), or a prompt when it can't be computed. */
function ReadinessBanner() {
  const [tl, setTl] = useState<TrainingLoadResponseDto | null>(null);
  useEffect(() => {
    let alive = true;
    getTrainingLoad().then((d) => alive && setTl(d));
    return () => {
      alive = false;
    };
  }, []);

  const ready = tl?.readiness_available && tl.readiness != null;
  const score = ready ? Math.round(tl!.readiness as number) : null;
  const word =
    score == null ? "" : score >= 75 ? "Primed" : score >= 55 ? "Balanced" : score >= 35 ? "Strained" : "Depleted";
  const tint = score == null ? "t-acc" : score >= 55 ? "t-pace" : score >= 35 ? "t-cad" : "t-hr";

  return (
    <div className="banner" style={{ marginBottom: 24, alignItems: "center" }}>
      {ready ? (
        <div className={`stat__ico ${tint}`} style={{ marginBottom: 0 }}>
          <HeartGlyph />
        </div>
      ) : (
        <HeartGlyph />
      )}
      <div>
        <b>Readiness{ready ? ` · ${word}` : ""}</b>{" "}
        <span className="muted">
          {ready ? (
            <>
              HRV + resting-HR vs your personal baseline.
              {tl!.hrv_rmssd != null ? ` HRV ${Math.round(tl!.hrv_rmssd)} ms` : ""}
              {tl!.hrv_baseline != null ? ` (baseline ${Math.round(tl!.hrv_baseline)} ms).` : "."}
            </>
          ) : (
            "Needs overnight HRV + resting HR — import a Gadgetbridge DB or Zepp export, then Recompute on the Algorithms screen."
          )}
        </span>
      </div>
      {ready && (
        <span className="num" style={{ marginLeft: "auto", fontSize: 30, fontWeight: 800 }}>
          {score}
          <small style={{ fontSize: 13, opacity: 0.6 }}> /100</small>
        </span>
      )}
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
      {/* recovery readiness banner — fed by the Phase-3 readiness algorithm */}
      <ReadinessBanner />

      {/* live real-time feed (WebSocket) */}
      <LiveCard />

      {/* import wellness from a Gadgetbridge export DB (works on web + the app) */}
      <GadgetbridgeCard />
      <ZeppCard />

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
              empty={
                <EmptyState
                  label="No data yet"
                  phase="Phase 4"
                  hint="Overnight HRV trend with your personal balanced band."
                />
              }
            />
          </div>

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
              empty={
                <EmptyState
                  label="No data yet"
                  phase="Phase 4"
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
              height={110}
              empty={<EmptyState label="No data yet" phase="Phase 4" compact />}
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
              empty={<EmptyState label="No data yet" phase="Phase 4" compact />}
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
              height={130}
              empty={<EmptyState label="No data yet" phase="Phase 4" compact />}
            />
          </div>
        </div>
      </div>

    </AppShell>
  );
}

/* --------------------------------------------------------------- helpers */

// Render real samples as a sparkline if present, otherwise the empty state.
function ModuleBody({
  samples,
  color,
  empty,
  height,
}: {
  samples: WellnessSample[] | undefined;
  color: string;
  empty: ReactNode;
  height?: number;
}) {
  if (hasData(samples)) {
    return <Sparkline samples={samples} color={color} height={height} />;
  }
  return <>{empty}</>;
}
