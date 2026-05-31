// Dashboard screen — faithful port of docs/designs/dashboard.html.
//
// REAL DATA (via the typed endpoint wrappers): the "Recent activities" list
// (top ~6 from listActivities(), each a design .act row linking to
// /activities/:id) and the "Connected sources" card (from listSources()).
// EVERYTHING that has no backend data yet — the training-status banner, the 4
// stat tiles, the training-load + weekly-volume charts, the Today rings, and the
// 7-day wellness mini-trends — renders the module styled per design with an
// on-brand <EmptyState> ("No data yet · Phase N"). NEVER fake numbers.

import { useEffect, useState, type ReactNode, type SVGProps } from "react";
import { Link } from "react-router-dom";
import { AppShell } from "../app/AppShell";
import { SearchIcon, WellnessIcon } from "../app/icons";
import { Seg } from "../ui/Seg";
import { EmptyState } from "../ui/EmptyState";
import { ReadinessSection } from "../ui/ReadinessSection";
import { useActivities } from "../hooks/useActivities";
import { useTrainingLoad, hasTrainingLoad } from "../hooks/useTrainingLoad";
import { listSources, getWellness } from "../api/endpoints";
import type { ActivitySummary, Source, Sport, WellnessKind } from "../api/types";
import type { TrainingLoadResponseDto } from "../api/schema";
import { MultiLineChart, type MultiSeries } from "../charts/MultiLineChart";
import { formatDuration, sportLabel } from "../ui/format";
import { getStepsGoal } from "../prefs";
import "./Dashboard.css";

/* --------------------------------------------------------------- ranges */

const RANGES = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
] as const;
type Range = (typeof RANGES)[number]["value"];

/* ----------------------------------------------------- sport glyphs/tints */
// The design renders each .act row with a tinted SVG glyph. format.ts only
// exposes emoji, so we map the project's Sport enum onto the design's tint class
// + an inline currentColor glyph (ported from dashboard.html's .act__ico SVGs).

type IconProps = SVGProps<SVGSVGElement>;
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2 } as const;

function RunGlyph(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <path d="M13 4l-2 6h4l-3 10" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="5" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
function CycleGlyph(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <circle cx="6" cy="17" r="3.2" />
      <circle cx="18" cy="17" r="3.2" />
      <path d="M6 17l4-7h5l-3 7M10 10l-2-3H6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function SwimGlyph(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <path d="M3 17c2 1.5 4 1.5 6 0s4-1.5 6 0 4 1.5 6 0" strokeLinecap="round" />
      <path d="M7 13l5-4 4 3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="7" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
function WalkGlyph(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <path d="M12 4l-1 6 3 3 1 7M11 10l-4 2-1 4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="13" cy="4" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
function StrengthGlyph(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <path d="M6 9v6M4 11v2M18 9v6M20 11v2M8 12h8" strokeLinecap="round" />
    </svg>
  );
}
function OtherGlyph(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <path d="M3 12h4l3 7 4-14 3 7h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const SPORT_TINT: Record<Sport, string> = {
  running: "t-pace",
  cycling: "t-pow",
  swimming: "t-acc",
  walking: "t-cad",
  strength: "t-hr",
  other: "t-elev",
};

function SportGlyph({ sport }: { sport: Sport }) {
  switch (sport) {
    case "running":
      return <RunGlyph />;
    case "cycling":
      return <CycleGlyph />;
    case "swimming":
      return <SwimGlyph />;
    case "walking":
      return <WalkGlyph />;
    case "strength":
      return <StrengthGlyph />;
    default:
      return <OtherGlyph />;
  }
}

/* ------------------------------------------------------ source kind icons */

function deviceKindGlyph(kind: Source["kind"]) {
  switch (kind) {
    case "gadgetbridge":
      return (
        <svg viewBox="0 0 24 24" {...stroke} aria-hidden>
          <path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "file_import":
      return (
        <svg viewBox="0 0 24 24" {...stroke} aria-hidden>
          <path d="M12 16V4m0 0L8 8m4-4l4 4M4 20h16" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" {...stroke} aria-hidden>
          <circle cx="12" cy="12" r="6" />
          <path d="M12 2v3m0 14v3m10-10h-3M5 12H2" strokeLinecap="round" />
        </svg>
      );
  }
}

const SOURCE_KIND_LABEL: Record<Source["kind"], string> = {
  device: "device · BLE",
  file_import: "file import",
  gadgetbridge: "via Gadgetbridge",
  unknown: "source",
};

/* --------------------------------------------------------- date helpers */

function todayCrumb(): string {
  const now = new Date();
  const date = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return `${date} · all data resolved locally`;
}

function shortDay(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = sameDay
    ? "Today"
    : d.toLocaleDateString(undefined, { weekday: "short" });
  return `${day} · ${time}`;
}

/* ============================================================== screen */

export function Dashboard() {
  const [range, setRange] = useState<Range>("week");
  const { activities } = useActivities();
  const tl = useTrainingLoad();
  const tlData = tl.kind === "ok" ? tl.data : null;
  const tlReady = tlData ? hasTrainingLoad(tlData) : false;

  const recent = [...activities]
    .sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0))
    .slice(0, 6);

  return (
    <AppShell
      title="Dashboard"
      crumb={todayCrumb()}
      actions={
        <>
          <Seg options={RANGES} value={range} onChange={setRange} aria-label="Date range" />
          <button type="button" className="iconbtn" aria-label="Search">
            <SearchIcon />
          </button>
        </>
      }
    >
      {/* training status / readiness banner — bound to the analytics engine. */}
      <ReadinessSection data={tlData} />

      {/* stat tiles — training load / resting HR / HRV / body battery */}
      <div className="grid grid--stats" style={{ marginBottom: "var(--gap)" }}>
        <TrainingLoadTile data={tlData} ready={tlReady} />
        <WellnessLatestTile kind="resting_heart_rate" label="Resting HR" unit="bpm" tint="t-hr" icon={<WellnessIcon />} />
        <HrvTile data={tlData} />
        <WellnessLatestTile kind="body_battery" label="Body battery" unit="%" tint="t-elev" icon={<BatteryGlyph />} />
      </div>

      {/* main grid */}
      <div className="grid grid--main">
        {/* LEFT column */}
        <div className="grid" style={{ gap: "var(--gap)" }}>
          {/* training load & fitness chart */}
          <section className="card">
            <div className="card__head">
              <h2 className="card__title">
                Training load &amp; fitness<span className="sub">6 weeks</span>
              </h2>
              <div className="card__tools">
                <div className="legend">
                  <i>
                    <b style={{ background: "var(--accent)" }} />
                    Fitness (CTL)
                  </i>
                  <i>
                    <b style={{ background: "var(--cal)" }} />
                    Fatigue (ATL)
                  </i>
                  <i>
                    <b style={{ background: "var(--elev)" }} />
                    Form (TSB)
                  </i>
                </div>
              </div>
            </div>
            {tl.kind === "loading" ? (
              <EmptyState label="Loading training load…" compact />
            ) : tlReady && tlData ? (
              <TrainingLoadChart data={tlData} />
            ) : (
              <EmptyState
                label="No data yet"
                phase="Phase 3"
                hint="CTL / ATL / TSB are computed from fused training load. Import activities, then Recompute on the Algorithms screen."
              />
            )}
          </section>

          {/* weekly volume chart — REAL DATA (time by sport, last 8 weeks) */}
          <WeeklyVolumeCard activities={activities} />

          {/* recent activities — REAL DATA */}
          <section className="card card--pad0">
            <div className="card__head" style={{ padding: "18px 20px 0", marginBottom: 8 }}>
              <h2 className="card__title">Recent activities</h2>
              <div className="card__tools">
                <Link to="/activities" className="pill">
                  {activities.length > 0 ? `View all ${activities.length} →` : "View all →"}
                </Link>
              </div>
            </div>
            {recent.length === 0 ? (
              <div style={{ padding: "0 20px 18px" }}>
                <EmptyState
                  label="No activities yet"
                  phase="Phase 2"
                  hint="Import a .fit / .gpx / .tcx file, or wire BLE ingestion, to populate this list."
                />
              </div>
            ) : (
              recent.map((a) => (
                <Link key={a.id} className="act" to={`/activities/${a.id}`}>
                  <div className={`act__ico ${SPORT_TINT[a.sport]}`}>
                    <SportGlyph sport={a.sport} />
                  </div>
                  <div className="act__body">
                    <div className="act__name">{sportLabel(a.sport)}</div>
                    <div className="act__meta">
                      <span>{shortDay(a.started_at)}</span>
                      {a.recording_count > 1 ? (
                        <span className="pill" style={{ padding: "1px 7px" }}>
                          {a.recording_count} sources merged
                        </span>
                      ) : (
                        <span className="pill" style={{ padding: "1px 7px" }}>
                          1 source
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="act__stat">
                    <b className="mono">{formatDuration(a.duration_secs)}</b>
                    <span>duration</span>
                  </div>
                  <div className="act__stat">
                    <b className="mono">{a.recording_count}</b>
                    <span>recordings</span>
                  </div>
                </Link>
              ))
            )}
          </section>
        </div>

        {/* RIGHT column */}
        <div className="grid" style={{ gap: "var(--gap)" }}>
          {/* today — REAL DATA (steps so far today) */}
          <TodayCard />

          {/* wellness 7-day mini trends — REAL DATA */}
          <Wellness7Card />

          {/* connected sources — REAL DATA */}
          <ConnectedSources />
        </div>
      </div>
    </AppShell>
  );
}

/* ----------------------------------------------------- training load UI */
// All bound to GET /api/analytics/training-load. Numbers are rounded for display
// but never invented — when analytics haven't been computed the tiles fall back
// to the on-brand empty state (a "—" value + "No data" tag).

function latest<T>(arr: T[]): T | undefined {
  return arr.length ? arr[arr.length - 1] : undefined;
}


/** "Training load · 7d" tile = latest ATL (acute / fatigue, 7-day EWMA). */
function TrainingLoadTile({
  data,
  ready,
}: {
  data: TrainingLoadResponseDto | null;
  ready: boolean;
}) {
  if (!ready || !data) {
    return (
      <StatTileEmpty tint="t-acc" label="Training load · 7d" phase="Phase 3" icon={<TrendsGlyph />} />
    );
  }
  const last = latest(data.series);
  const atl = last ? last.atl : 0;
  const tsb = last ? last.tsb : 0;
  // Positive form (TSB) = fresh; negative = fatigued.
  const fresh = tsb >= 0;
  return (
    <div className="card stat">
      <div className="stat__ico t-acc">
        <TrendsGlyph />
      </div>
      <div className="stat__label">Training load · 7d</div>
      <div className="stat__val num" style={{ fontSize: 22 }}>
        {Math.round(atl)}
      </div>
      <div className={`stat__delta ${fresh ? "up" : "down"}`}>
        <span className="tag" style={{ fontFamily: "var(--font-mono)" }}>
          form {tsb >= 0 ? "+" : ""}
          {Math.round(tsb)}
        </span>
      </div>
    </div>
  );
}

/** "HRV · overnight" tile = latest HRV RMSSD vs baseline. */
function HrvTile({ data }: { data: TrainingLoadResponseDto | null }) {
  const rmssd = data?.hrv_rmssd ?? null;
  if (rmssd == null) {
    return <StatTileEmpty tint="t-pow" label="HRV · overnight" phase="Phase 3" icon={<ArrowGlyph />} />;
  }
  const baseline = data?.hrv_baseline ?? null;
  const delta = baseline != null ? rmssd - baseline : null;
  const up = delta == null || delta >= 0;
  return (
    <div className="card stat">
      <div className="stat__ico t-pow">
        <ArrowGlyph />
      </div>
      <div className="stat__label">HRV · overnight</div>
      <div className="stat__val num" style={{ fontSize: 22 }}>
        {Math.round(rmssd)}
        <span style={{ fontSize: 12, color: "var(--muted)" }}> ms</span>
      </div>
      <div className={`stat__delta ${up ? "up" : "down"}`}>
        <span className="tag" style={{ fontFamily: "var(--font-mono)" }}>
          {baseline != null
            ? `base ${Math.round(baseline)} ms`
            : "baseline pending"}
        </span>
      </div>
    </div>
  );
}

/** CTL / ATL / TSB multi-series chart from the dated training-load series. */
function TrainingLoadChart({ data }: { data: TrainingLoadResponseDto }) {
  const x = data.series.map((p) => Date.parse(`${p.date}T00:00:00Z`) / 1000);
  const series: MultiSeries[] = [
    { label: "Fitness (CTL)", values: data.series.map((p) => p.ctl), stroke: "var(--accent)" },
    { label: "Fatigue (ATL)", values: data.series.map((p) => p.atl), stroke: "var(--cal)" },
    { label: "Form (TSB)", values: data.series.map((p) => p.tsb), stroke: "var(--elev)" },
  ];
  return <MultiLineChart x={x} series={series} height={220} />;
}

/** Latest value of a continuous wellness kind (resting HR, body battery, …).
 * Shows the most recent reading when present; falls back to the empty state. */
/* --------------------------------------------------- weekly volume (time) */
// The activity list carries duration + sport (distance isn't resolved per-row),
// so "weekly volume" is training TIME by sport over the last 8 weeks — always
// available and meaningful across every sport (distance is 0 for strength/yoga).

const SPORT_COLOR: Record<Sport, string> = {
  running: "var(--pace)",
  cycling: "var(--power)",
  swimming: "var(--accent)",
  walking: "var(--cadence)",
  strength: "var(--hr)",
  other: "var(--elev)",
};

/** Monday-anchored week key (YYYY-MM-DD of that week's Monday, in local time). */
function weekMondayISO(d: Date): string {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - dow);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

function WeeklyVolumeCard({ activities }: { activities: ActivitySummary[] }) {
  const WEEKS = 8;
  // Build the last 8 Monday week-keys (oldest → newest).
  const weeks: string[] = [];
  {
    const d = new Date();
    d.setDate(d.getDate() - (((d.getDay() + 6) % 7))); // back to this Monday
    for (let i = 0; i < WEEKS; i++) {
      weeks.unshift(weekMondayISO(d));
      d.setDate(d.getDate() - 7);
    }
  }
  const idx = new Map(weeks.map((w, i) => [w, i]));
  const perWeek: Map<Sport, number>[] = weeks.map(() => new Map());
  const sportsPresent = new Set<Sport>();
  for (const a of activities) {
    const i = idx.get(weekMondayISO(new Date(a.started_at)));
    if (i === undefined) continue;
    perWeek[i].set(a.sport, (perWeek[i].get(a.sport) ?? 0) + a.duration_secs);
    sportsPresent.add(a.sport);
  }
  const totals = perWeek.map((m) => [...m.values()].reduce((x, y) => x + y, 0));
  const maxTotal = Math.max(...totals, 1);
  const hasAny = totals.some((t) => t > 0);

  const fmtWeek = (iso: string) => {
    const [, m, day] = iso.split("-");
    return `${day}/${m}`;
  };

  return (
    <section className="card">
      <div className="card__head">
        <h2 className="card__title">
          Weekly volume<span className="sub">training time by sport · 8 weeks</span>
        </h2>
        <div className="card__tools">
          <div className="legend">
            {[...sportsPresent].map((s) => (
              <i key={s}>
                <b style={{ background: SPORT_COLOR[s] }} />
                {sportLabel(s)}
              </i>
            ))}
          </div>
        </div>
      </div>
      {!hasAny ? (
        <EmptyState
          label="No data yet"
          hint="Per-week training time by sport, aggregated from your activities."
        />
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 170, padding: "8px 0 0" }}>
            {weeks.map((w, i) => {
              const m = perWeek[i];
              const total = totals[i];
              const entries = [...m.entries()].sort((a, b) => b[1] - a[1]);
              return (
                <div key={w} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      height: `${(total / maxTotal) * 100}%`,
                      minHeight: total > 0 ? 3 : 0,
                      borderRadius: 5,
                      overflow: "hidden",
                    }}
                    title={`${fmtWeek(w)} · ${formatDuration(total)}`}
                  >
                    {entries.map(([sport, sec]) => (
                      <div key={sport} style={{ height: `${(sec / total) * 100}%`, background: SPORT_COLOR[sport] }} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
            {weeks.map((w) => (
              <span key={w} style={{ flex: 1, textAlign: "center", fontSize: 10, color: "var(--muted)" }}>
                {fmtWeek(w)}
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------- today (steps) */

/** Today's step count, summed from the per-minute feed since local midnight
 *  (falls back to a daily-total snapshot if one exists). Rendered as a ring
 *  toward a 10k goal. */
function TodayCard() {
  const [steps, setSteps] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [goal, setGoal] = useState(getStepsGoal());

  // Live-update when the goal is changed in Settings.
  useEffect(() => {
    const onPrefs = () => setGoal(getStepsGoal());
    window.addEventListener("ofit:prefs", onPrefs);
    return () => window.removeEventListener("ofit:prefs", onPrefs);
  }, []);

  useEffect(() => {
    let alive = true;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    getWellness("steps", start.toISOString())
      .then((s) => {
        if (!alive) return;
        let incr = 0;
        let snap = 0;
        for (const x of s.samples) {
          if (x.date.slice(11, 19) === "00:00:00") snap = Math.max(snap, x.value);
          else incr += x.value;
        }
        setSteps(Math.round(Math.max(incr, snap)));
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  const pct = steps != null ? Math.min(1, steps / goal) : 0;
  const r = 46;
  const circ = 2 * Math.PI * r;

  return (
    <section className="card">
      <div className="card__head">
        <h2 className="card__title">Today</h2>
      </div>
      {!loaded ? (
        <EmptyState label="Loading…" compact />
      ) : steps == null || steps === 0 ? (
        <EmptyState label="No steps yet today" hint="Steps stream in from your connected strap." compact />
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 20, padding: "6px 2px" }}>
          <svg width="116" height="116" viewBox="0 0 116 116" aria-hidden style={{ flex: "0 0 auto" }}>
            <circle cx="58" cy="58" r={r} fill="none" stroke="var(--surface-2, #1a1d28)" strokeWidth="10" />
            <circle
              cx="58"
              cy="58"
              r={r}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="10"
              strokeLinecap="round"
              strokeDasharray={circ}
              strokeDashoffset={circ * (1 - pct)}
              transform="rotate(-90 58 58)"
            />
            <text
              x="58"
              y="58"
              textAnchor="middle"
              dominantBaseline="central"
              className="num"
              style={{ fontSize: 26, fontWeight: 800, fill: "var(--fg)" }}
            >
              {Math.round(pct * 100)}%
            </text>
          </svg>
          <div>
            <div className="num" style={{ fontSize: 28, fontWeight: 800, lineHeight: 1 }}>
              {steps.toLocaleString()}
            </div>
            <div className="stat__label" style={{ marginTop: 4 }}>steps today</div>
            <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
              Goal {goal.toLocaleString()}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------ wellness 7-day mini trends */

/** A tiny no-axis sparkline (latest-value label rendered by the caller). */
function MiniSpark({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <div style={{ width: 90, height: 28 }} />;
  const w = 90;
  const h = 28;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - min) / span) * (h - 4) - 2).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden style={{ flex: "0 0 auto" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function MiniTrendRow({
  kind,
  label,
  unit,
  color,
}: {
  kind: WellnessKind;
  label: string;
  unit: string;
  color: string;
}) {
  const [vals, setVals] = useState<number[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const from = new Date(Date.now() - 8 * 86_400_000).toISOString();
    getWellness(kind, from)
      .then((s) => {
        if (!alive) return;
        const sorted = [...s.samples].sort((a, b) => a.date.localeCompare(b.date)).map((x) => x.value);
        // thin to <= 60 points for a clean mini line
        const stride = Math.max(1, Math.ceil(sorted.length / 60));
        setVals(sorted.filter((_, i) => i % stride === 0));
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [kind]);

  const latest = vals.length ? vals[vals.length - 1] : null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 0", borderBottom: "1px solid var(--border, #1c2030)" }}>
      <div style={{ minWidth: 78 }}>
        <div className="stat__label">{label}</div>
        <div className="num" style={{ fontSize: 17, fontWeight: 700 }}>
          {latest != null ? Math.round(latest) : "—"}
          {latest != null ? <small style={{ fontSize: 10, opacity: 0.5, marginLeft: 2 }}>{unit}</small> : null}
        </div>
      </div>
      <div style={{ marginLeft: "auto" }}>
        {loaded && vals.length >= 2 ? (
          <MiniSpark values={vals} color={color} />
        ) : (
          <span className="faint" style={{ fontSize: 10.5 }}>{loaded ? "no data" : "…"}</span>
        )}
      </div>
    </div>
  );
}

function Wellness7Card() {
  return (
    <section className="card">
      <div className="card__head">
        <h2 className="card__title">Wellness · 7-day</h2>
        <div className="card__tools">
          <Link to="/wellness" className="pill">
            Open →
          </Link>
        </div>
      </div>
      <div style={{ marginTop: 2 }}>
        <MiniTrendRow kind="resting_heart_rate" label="Resting HR" unit="bpm" color="var(--hr)" />
        <MiniTrendRow kind="hrv" label="HRV" unit="ms" color="var(--power)" />
        <MiniTrendRow kind="stress" label="Stress" unit="" color="var(--cal)" />
      </div>
    </section>
  );
}

function WellnessLatestTile({
  kind,
  label,
  unit,
  tint,
  icon,
}: {
  kind: WellnessKind;
  label: string;
  unit: string;
  tint: string;
  icon: ReactNode;
}) {
  const [val, setVal] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    getWellness(kind)
      .then((s) => {
        if (!alive) return;
        const last = s.samples.length ? s.samples[s.samples.length - 1].value : null;
        setVal(last);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [kind]);

  if (!loaded || val == null) {
    return <StatTileEmpty tint={tint} label={label} phase="Phase 4" icon={icon} />;
  }
  return (
    <div className="card stat">
      <div className={`stat__ico ${tint}`}>{icon}</div>
      <div className="stat__label">{label}</div>
      <div className="stat__val num" style={{ fontSize: 22 }}>
        {Math.round(val)}
        <span style={{ fontSize: 12, color: "var(--muted)" }}> {unit}</span>
      </div>
      <div className="stat__delta flat">
        <span className="tag" style={{ fontFamily: "var(--font-mono)" }}>
          latest reading
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------- stat tile empty */

function StatTileEmpty({
  tint,
  label,
  icon,
}: {
  tint: string;
  label: string;
  /** Ignored — kept so call sites still type-check. */
  phase?: string;
  icon: ReactNode;
}) {
  return (
    <div className="card stat">
      <div className={`stat__ico ${tint}`}>{icon}</div>
      <div className="stat__label">{label}</div>
      <div className="stat__val num muted" style={{ fontSize: 22 }}>
        —
      </div>
      <div className="stat__delta flat">
        <span className="tag" style={{ fontFamily: "var(--font-mono)" }}>
          No data yet
        </span>
      </div>
    </div>
  );
}

/* --------------------------------------------------- connected sources card */

function ConnectedSources() {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "ok"; sources: Source[] } | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    listSources()
      .then((sources) => alive && setState({ kind: "ok", sources }))
      .catch((e: unknown) =>
        alive && setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      alive = false;
    };
  }, []);

  const sources = state.kind === "ok" ? state.sources : [];

  return (
    <section className="card">
      <div className="card__head">
        <h2 className="card__title">Connected sources</h2>
        <div className="card__tools">
          <span className="pill pill--good">
            <span className="dot-live" />
            local
          </span>
        </div>
      </div>

      {state.kind === "loading" ? (
        <EmptyState label="Loading sources…" compact />
      ) : state.kind === "error" ? (
        <EmptyState label="Couldn't load sources" hint={state.message} compact />
      ) : sources.length === 0 ? (
        <EmptyState
          label="No sources yet"
          phase="Phase 2"
          hint="Devices and file imports register here as data arrives."
          compact
        />
      ) : (
        sources.map((s) => (
          <div className="dev" key={s.id}>
            <div className="dev__ic">{deviceKindGlyph(s.kind)}</div>
            <div className="dev__b">
              <b>{s.name}</b>
              <span>{s.manufacturer ? `${s.manufacturer} · ` : ""}{SOURCE_KIND_LABEL[s.kind]}</span>
            </div>
            {/* battery % is not exposed by the API yet — omit (no fake numbers) */}
          </div>
        ))
      )}

      <hr className="hr-line" style={{ margin: "14px 0 12px" }} />
      <Link
        to="/settings"
        className="btn btn--ghost"
        style={{ width: "100%", justifyContent: "center" }}
      >
        Manage source priorities
      </Link>
    </section>
  );
}

/* ----------------------------------------------------- stat-tile glyphs */

function TrendsGlyph(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <path d="M4 19V5m0 14h16M8 16V9m4 7V6m4 10v-4" strokeLinecap="round" />
    </svg>
  );
}
function ArrowGlyph(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function BatteryGlyph(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <rect x="6" y="3" width="12" height="18" rx="3" />
      <path d="M9 8h6" strokeLinecap="round" />
    </svg>
  );
}
