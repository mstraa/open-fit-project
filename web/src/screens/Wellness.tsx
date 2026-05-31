// Wellness screen — faithful port of docs/designs/wellness.html.
//
// This is Phase 4: there is no backend wellness ingestion yet (resting HR, HRV,
// stress, sleep, body battery, steps), so EVERY data module renders the on-brand
// <EmptyState label="No data yet" phase="Phase 4" /> per the hard project rules
// — never fake numbers. The full design STRUCTURE, labels and layout are kept:
//   - readiness banner
//   - 4 stat tiles (resting HR · HRV · stress · body battery)
//   - main column: last-night sleep · HRV trend · body-battery 24h
//   - side column: resting HR 7d · stress today · steps this week
//
// getWellness() is wired defensively for each kind: if the backend ever returns
// samples, we render a small on-brand SVG sparkline; otherwise the empty state.

import { useEffect, useRef, useState, type ReactNode, type SVGProps } from "react";
import { AppShell } from "../app/AppShell";
import { EmptyState } from "../ui/EmptyState";
import { Seg } from "../ui/Seg";
import { getWellness, importGadgetbridge } from "../api/endpoints";
import type { WellnessSample } from "../api/types";
import { useWellnessLive } from "../hooks/useWellnessLive";

/* ------------------------------------------------------------- date range */

const RANGES = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
] as const;
type Range = (typeof RANGES)[number]["value"];

/* ------------------------------------------------- wellness series loading */

// Kinds we attempt to load. The backend exposes none of these yet (Phase 4), so
// getWellness returns empty series and each module falls back to its empty state.
const KINDS = [
  "resting_hr",
  "hrv",
  "stress",
  "body_battery",
  "sleep",
  "steps",
] as const;
type Kind = (typeof KINDS)[number];

type SeriesMap = Partial<Record<Kind, WellnessSample[]>>;

function useWellness(): SeriesMap {
  const [series, setSeries] = useState<SeriesMap>({});

  useEffect(() => {
    let alive = true;
    Promise.all(
      KINDS.map(async (kind) => {
        try {
          const s = await getWellness(kind);
          return [kind, s.samples] as const;
        } catch {
          // Defensive: a missing/erroring endpoint just yields an empty module.
          return [kind, [] as WellnessSample[]] as const;
        }
      }),
    ).then((entries) => {
      if (!alive) return;
      const next: SeriesMap = {};
      for (const [kind, samples] of entries) next[kind] = samples;
      setSeries(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  return series;
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

// A Phase-4 stat tile: keeps the design's icon + label, but shows a dash for the
// value and a muted "No data · Phase 4" delta instead of a fake number.
function StatTile({
  tint,
  icon,
  label,
}: {
  tint: string;
  icon: ReactNode;
  label: string;
}) {
  return (
    <div className="card stat">
      <div className={`stat__ico ${tint}`}>{icon}</div>
      <div className="stat__label">{label}</div>
      <div className="stat__val num muted" aria-label="No data yet">
        —
      </div>
      <div className="stat__delta flat">No data · Phase 4</div>
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
    <div className="card" style={{ marginBottom: 24, display: "flex", alignItems: "center", gap: 18 }}>
      <div className="stat__ico t-hr" style={{ marginBottom: 0 }}>
        <HeartGlyph />
      </div>
      <div style={{ minWidth: 96 }}>
        <div className="stat__label">Live heart rate</div>
        <div className="stat__val num" style={{ marginTop: 2 }}>
          {hr ? Math.round(hr.value) : "—"} <small>bpm</small>
        </div>
      </div>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ flex: "0 0 auto" }} aria-hidden>
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

export function Wellness() {
  const [range, setRange] = useState<Range>("week");
  const series = useWellness();

  const phaseHint =
    "Wellness ingestion (resting HR, HRV, stress, sleep, body battery, steps) lands in Phase 4.";

  return (
    <AppShell
      title="Wellness"
      crumb="Recovery, sleep & daily health · resolved per metric"
      actions={
        <Seg options={RANGES} value={range} onChange={setRange} aria-label="Date range" />
      }
    >
      {/* recovery readiness banner — no readiness algorithm yet (Phase 4) */}
      <div className="banner" style={{ marginBottom: 24 }}>
        <HeartGlyph />
        <div>
          <b>Readiness</b>{" "}
          <span className="muted">
            Recovery readiness (HRV balance, resting HR, sleep) is computed once
            wellness ingestion lands.
          </span>
        </div>
        <span className="tag" style={{ marginLeft: "auto", fontFamily: "var(--font-mono)" }}>
          Phase 4
        </span>
      </div>

      {/* live real-time feed (WebSocket) */}
      <LiveCard />

      {/* import wellness from a Gadgetbridge export DB (works on web + the app) */}
      <GadgetbridgeCard />

      {/* stat tiles */}
      <div className="grid grid--stats" style={{ marginBottom: "var(--gap)" }}>
        <StatTile tint="t-hr" icon={<HeartGlyph />} label="Resting HR" />
        <StatTile tint="t-pow" icon={<HrvGlyph />} label="HRV · overnight" />
        <StatTile tint="t-cad" icon={<StressGlyph />} label="Stress · avg" />
        <StatTile tint="t-acc" icon={<BatteryGlyph />} label="Body battery" />
      </div>

      <div className="grid grid--main">
        {/* ---------------------------------------------- main column */}
        <div className="grid" style={{ gap: "var(--gap)" }}>
          {/* sleep */}
          <div className="card">
            <div className="card__head">
              <div className="card__title">
                Last night<span className="sub">sleep stages</span>
              </div>
            </div>
            <ModuleBody
              samples={series.sleep}
              color="var(--accent)"
              height={140}
              empty={
                <EmptyState
                  label="No data yet"
                  phase="Phase 4"
                  hint="Sleep stages, score, resting HR and SpO₂ from overnight tracking."
                />
              }
            />
          </div>

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
              samples={series.resting_hr}
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

      {/* a screen-reader / dev hint about the phase, mirrored once */}
      <span className="faint" style={{ display: "none" }}>
        {phaseHint}
      </span>
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
