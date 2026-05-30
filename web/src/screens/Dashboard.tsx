// Dashboard screen — faithful port of docs/designs/dashboard.html.
//
// REAL DATA (via the typed endpoint wrappers): the "Recent activities" list
// (top ~6 from listActivities(), each a design .act row linking to
// /activities/:id) and the "Connected sources" card (from listSources()).
// EVERYTHING that has no backend data yet — the training-status banner, the 4
// stat tiles, the training-load + weekly-volume charts, the Today rings, and the
// 7-day wellness mini-trends — renders the module styled per design with an
// on-brand <EmptyState> ("No data yet · Phase N"). NEVER fake numbers.

import { useEffect, useRef, useState, type ReactNode, type SVGProps } from "react";
import { Link } from "react-router-dom";
import { AppShell } from "../app/AppShell";
import { ImportIcon, SearchIcon, ActivitiesIcon, WellnessIcon } from "../app/icons";
import { Seg } from "../ui/Seg";
import { EmptyState } from "../ui/EmptyState";
import { useActivities } from "../hooks/useActivities";
import { importFiles, listSources } from "../api/endpoints";
import type { Source, Sport } from "../api/types";
import { formatDuration, sportLabel } from "../ui/format";

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
  const { activities, reload } = useActivities();

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
          <ImportButton onImported={reload} />
        </>
      }
    >
      {/* training status banner — no backend training-status model yet */}
      <div className="banner" style={{ marginBottom: 24 }}>
        <ActivitiesIcon />
        <div>
          <b>Training status</b>
          <span className="muted">
            {" "}
            Fused training load, fitness/fatigue balance and form land with the
            algorithms engine.
          </span>
        </div>
        <span className="pill" style={{ marginLeft: "auto", fontFamily: "var(--font-mono)" }}>
          Phase 4
        </span>
      </div>

      {/* stat tiles — training load / resting HR / HRV / body battery */}
      <div className="grid grid--stats" style={{ marginBottom: "var(--gap)" }}>
        <StatTileEmpty tint="t-acc" label="Training load · 7d" phase="Phase 4" icon={<TrendsGlyph />} />
        <StatTileEmpty tint="t-hr" label="Resting HR" phase="Phase 3" icon={<WellnessIcon />} />
        <StatTileEmpty tint="t-pow" label="HRV · overnight" phase="Phase 3" icon={<ArrowGlyph />} />
        <StatTileEmpty tint="t-elev" label="Body battery" phase="Phase 3" icon={<BatteryGlyph />} />
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
            <EmptyState
              label="No data yet"
              phase="Phase 4"
              hint="CTL / ATL / TSB are computed from fused training load."
            />
          </section>

          {/* weekly volume chart */}
          <section className="card">
            <div className="card__head">
              <h2 className="card__title">
                Weekly volume<span className="sub">distance by sport</span>
              </h2>
            </div>
            <EmptyState
              label="No data yet"
              phase="Phase 4"
              hint="Per-week distance by sport is aggregated from resolved activity streams."
            />
          </section>

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
          {/* today rings */}
          <section className="card">
            <div className="card__head">
              <h2 className="card__title">Today</h2>
            </div>
            <EmptyState
              label="No data yet"
              phase="Phase 3"
              hint="Steps, intensity minutes and floors stream from wellness ingestion."
            />
          </section>

          {/* wellness 7-day mini trends */}
          <section className="card">
            <div className="card__head">
              <h2 className="card__title">Wellness · 7-day</h2>
              <div className="card__tools">
                <Link to="/wellness" className="pill">
                  Open →
                </Link>
              </div>
            </div>
            <EmptyState
              label="No data yet"
              phase="Phase 3"
              hint="Resting HR, HRV and stress trends arrive with wellness ingestion."
            />
          </section>

          {/* connected sources — REAL DATA */}
          <ConnectedSources />
        </div>
      </div>
    </AppShell>
  );
}

/* -------------------------------------------------------- stat tile empty */

function StatTileEmpty({
  tint,
  label,
  phase,
  icon,
}: {
  tint: string;
  label: string;
  phase: string;
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
          No data · {phase}
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

/* --------------------------------------------------------- import button */
// Reuses the import flow (importFiles → reload) behind the design's topbar .btn,
// via a hidden multi-file input. Same network path as views/ImportControl.

function ImportButton({ onImported }: { onImported: () => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      await importFiles(files);
      onImported();
    } catch {
      /* surfaced elsewhere; the topbar button stays quiet on failure */
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".fit,.gpx,.tcx"
        hidden
        onChange={(e) => handleFiles(e.target.files)}
      />
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        <ImportIcon />
        {busy ? "Importing…" : "Import .FIT"}
      </button>
    </>
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
