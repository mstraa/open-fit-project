// Workout / activity detail screen. Route: /activities/:id.
//
// Faithful port of docs/designs/workout-detail.html. Renders REAL data for a
// single activity fetched via getActivity(id):
//   - header (sport, date, duration, recording_count, fused pill)
//   - a summary row with one tile per resolved scalar metric (avg computed from
//     the resolved samples) carrying the winning source as a .src badge
//   - the GPS track (TrackMap) + per-metric uPlot line charts (LineChart)
//   - the FUSION CORE: per-metric source picker (.srcopt buttons) that PUTs a
//     per-activity preference and re-resolves the activity so charts re-render
// Modules that need data we don't have yet (splits, HR zones, derived plugins)
// render an on-brand EmptyState with the right phase tag — never fake numbers.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { AppShell } from "../app/AppShell";
import { getActivity, listSources, putPreference } from "../api/endpoints";
import type {
  ActivityDetail,
  ScalarSample,
  Source,
  StreamKind,
} from "../api/types";
import { LineChart } from "../charts/LineChart";
import { TrackMap } from "../charts/TrackMap";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { EmptyState } from "../ui/EmptyState";
import { Seg } from "../ui/Seg";
import { CHART_METRICS, formatDuration, metricLabel } from "../ui/format";
import "./WorkoutDetail.css";

/* ----------------------------------------------------------------- helpers */

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; detail: ActivityDetail }
  | { kind: "error"; message: string };

/** Map a device/source NAME to the design's .src--* class by heuristic. */
function srcClass(name: string | undefined): string {
  const n = (name ?? "").toLowerCase();
  if (n.includes("stryd")) return "src--stryd";
  if (n.includes("helio") || n.includes("polar") || n.includes("hrm")) return "src--helio";
  if (n.includes("garmin") || /\b\d{3}\b/.test(n)) return "src--garmin";
  return "";
}

function avg(samples: ScalarSample[] | undefined): number | null {
  if (!samples || samples.length === 0) return null;
  let sum = 0;
  for (const s of samples) sum += s.value;
  return sum / samples.length;
}

/** Sport → header tint class (matches the design's .t-* palette). */
const SPORT_TINT: Record<string, string> = {
  running: "t-pace",
  cycling: "t-pow",
  swimming: "t-acc",
  walking: "t-elev",
  strength: "t-cal",
  other: "t-acc",
};

const SPORT_TITLE: Record<string, string> = {
  running: "Run",
  cycling: "Ride",
  swimming: "Swim",
  walking: "Walk",
  strength: "Strength",
  other: "Activity",
};

/** Inline sport glyph (the design uses a runner mark for the header icon). */
function SportGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path d="M13 4l-2 6h4l-3 10" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="5" r="1.6" fill="currentColor" />
    </svg>
  );
}

function CalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" strokeLinecap="round" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path d="M12 21s-7-5-7-11a7 7 0 0114 0c0 6-7 11-7 11z" strokeLinejoin="round" />
    </svg>
  );
}

const SUMMARY_UNIT: Partial<Record<StreamKind, string>> = {
  heart_rate: "bpm",
  power: "W",
  cadence: "spm",
  speed: "m/s",
  altitude: "m",
};

/* ------------------------------------------------------------------ screen */

export function WorkoutDetail() {
  const { id = "" } = useParams();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [sources, setSources] = useState<Source[]>([]);
  const [metricView, setMetricView] = useState<"all" | StreamKind>("all");

  const load = useCallback(() => {
    if (!id) return;
    setState({ kind: "loading" });
    Promise.all([getActivity(id), listSources().catch(() => [] as Source[])])
      .then(([detail, srcs]) => {
        setSources(srcs);
        setState({ kind: "ok", detail });
      })
      .catch((e: unknown) =>
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
      );
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const detail = state.kind === "ok" ? state.detail : undefined;

  // Per-metric candidate sources for this activity (from the recordings).
  const candidatesByMetric = useMemo(() => {
    const map = new Map<StreamKind, Source[]>();
    if (!detail) return map;
    const byId = new Map(sources.map((s) => [s.id, s]));
    for (const rec of detail.recordings) {
      const src =
        byId.get(rec.source_id) ??
        ({ id: rec.source_id, kind: "unknown", name: rec.source_name, default_priority: 0 } as Source);
      for (const kind of rec.stream_kinds) {
        const list = map.get(kind) ?? [];
        if (!list.some((s) => s.id === src.id)) list.push(src);
        map.set(kind, list);
      }
    }
    return map;
  }, [detail, sources]);

  const sourceName = useCallback(
    (sourceId: string | undefined): string => {
      if (!sourceId) return "—";
      const s = sources.find((x) => x.id === sourceId);
      if (s) return s.name;
      const rec = detail?.recordings.find((r) => r.source_id === sourceId);
      return rec?.source_name ?? sourceId.slice(0, 8);
    },
    [sources, detail],
  );

  const onPick = useCallback(
    async (metric: StreamKind, sourceId: string) => {
      await putPreference({
        metric,
        scope: "activity",
        activity_id: id,
        source_id: sourceId,
        retroactive: false,
      });
      load();
    },
    [id, load],
  );

  // Topbar bits. ActivityDetail has no sport/name field, so the crumb shows the
  // activity id; the in-page header derives a label below.
  const crumb = <>Activities / {id ? id.slice(0, 8) : "—"}</>;

  return (
    <AppShell
      title="Activity detail"
      crumb={crumb}
      actions={
        <Link to="/activities" className="btn btn--ghost">
          <BackIcon />
          Back to activities
        </Link>
      }
    >
      {state.kind === "loading" && <EmptyState label="Loading activity…" icon={<span />} />}

      {state.kind === "error" && (
        <EmptyState
          label="Couldn’t load this activity"
          hint={state.message}
          phase="API"
        />
      )}

      {state.kind === "ok" && (
        <DetailBody
          detail={state.detail}
          metricView={metricView}
          onMetricView={setMetricView}
          candidatesByMetric={candidatesByMetric}
          sourceName={sourceName}
          srcClassFor={(sid) => srcClass(sourceName(sid))}
          onPick={onPick}
        />
      )}
    </AppShell>
  );
}

/* ------------------------------------------------------------------- body */

function DetailBody({
  detail,
  metricView,
  onMetricView,
  candidatesByMetric,
  sourceName,
  srcClassFor,
  onPick,
}: {
  detail: ActivityDetail;
  metricView: "all" | StreamKind;
  onMetricView: (v: "all" | StreamKind) => void;
  candidatesByMetric: Map<StreamKind, Source[]>;
  sourceName: (id: string | undefined) => string;
  srcClassFor: (id: string | undefined) => string;
  onPick: (metric: StreamKind, sourceId: string) => Promise<void>;
}) {
  const track = detail.resolved.lat_lng?.track ?? [];

  const scalarMetrics = CHART_METRICS.filter(
    (m) => (detail.resolved[m.kind]?.samples?.length ?? 0) > 0,
  );

  // Approximate total duration from the longest resolved scalar stream.
  const durationSecs = useMemo(() => {
    let maxMs = 0;
    for (const m of CHART_METRICS) {
      const ss = detail.resolved[m.kind]?.samples;
      if (ss && ss.length) maxMs = Math.max(maxMs, ss[ss.length - 1].t_offset_ms);
    }
    if (track.length) maxMs = Math.max(maxMs, track[track.length - 1].t_offset_ms);
    return Math.round(maxMs / 1000);
  }, [detail, track]);

  const recordingCount = detail.recordings.length;

  // Metrics that get a fusion-picker row: any resolved metric with >1 candidate
  // (or any candidate at all, so the user can confirm the active source).
  const pickerMetrics = (Object.keys(detail.resolved) as StreamKind[]).filter(
    (k) => (candidatesByMetric.get(k)?.length ?? 0) > 0,
  );

  const visibleCharts =
    metricView === "all"
      ? scalarMetrics
      : scalarMetrics.filter((m) => m.kind === metricView);

  const segOptions = [
    { value: "all" as const, label: "All" },
    ...scalarMetrics.map((m) => ({ value: m.kind, label: m.label })),
  ];

  return (
    <>
      {/* ---- header ---- */}
      <div className="wd-head">
        <div className={`wd-head__ic ${SPORT_TINT.running}`}>
          <SportGlyph />
        </div>
        <div style={{ flex: 1 }}>
          <div className="wd-title">{SPORT_TITLE.running} — Activity</div>
          <div className="wd-sub">
            <span>
              <CalIcon /> {durationSecs > 0 ? formatDuration(durationSecs) : "—"}
            </span>
            <span className={recordingCount > 1 ? "pill pill--good" : "pill"}>
              {recordingCount > 1
                ? `fused · ${recordingCount} sources`
                : `${recordingCount} source`}
            </span>
          </div>
        </div>
      </div>

      {/* ---- summary tiles (avg per resolved metric + winning source) ---- */}
      <div className="summary">
        <SummaryTile label="Duration" value={durationSecs > 0 ? formatDuration(durationSecs) : "—"} />
        <SummaryTile label="Recordings" value={String(recordingCount)} suffix=" merged" />
        {scalarMetrics.map((m) => {
          const resolved = detail.resolved[m.kind];
          const a = avg(resolved?.samples);
          const sid = resolved?.source_id;
          const name = sourceName(sid);
          return (
            <div key={m.kind}>
              <div className="lbl">Avg {m.label}</div>
              <div className="val">
                {a == null ? "—" : a.toFixed(0)}
                <small> {SUMMARY_UNIT[m.kind] ?? m.unit}</small>
              </div>
              {sid ? (
                <span className={`src ${srcClassFor(sid)}`} style={{ marginTop: 7 }}>
                  <span className="src__dot" />
                  {name}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="layout">
        {/* ===================== LEFT column ===================== */}
        <div className="grid" style={{ gap: "var(--gap)" }}>
          {/* map */}
          <div className="card card--pad0">
            {track.length > 0 ? (
              <>
                <div style={{ position: "relative" }}>
                  <span className="pill" style={{ position: "absolute", left: 12, top: 12, zIndex: 2 }}>
                    <PinIcon /> GPS · {sourceName(detail.resolved.lat_lng?.source_id)}
                  </span>
                  <ErrorBoundary
                    fallback={
                      <div style={{ padding: 16 }}>
                        <EmptyState
                          label="Map unavailable"
                          hint="The map could not be initialized (no WebGL context). Charts below are unaffected."
                        />
                      </div>
                    }
                  >
                    <TrackMap track={track} height={300} />
                  </ErrorBoundary>
                </div>
              </>
            ) : (
              <div style={{ padding: 16 }}>
                <div className="card__head" style={{ marginBottom: 10 }}>
                  <div className="card__title">Route</div>
                </div>
                <EmptyState
                  label="No GPS track"
                  hint="This activity has no resolved lat/lng stream."
                  compact
                />
              </div>
            )}
          </div>

          {/* multi-metric chart */}
          <div className="card">
            <div className="card__head">
              <div className="card__title">
                Metrics<span className="sub">over time</span>
              </div>
              {scalarMetrics.length > 0 ? (
                <div className="card__tools">
                  <Seg<"all" | StreamKind>
                    options={segOptions}
                    value={metricView}
                    onChange={onMetricView}
                    aria-label="Metric"
                  />
                </div>
              ) : null}
            </div>

            {scalarMetrics.length > 0 ? (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                  {visibleCharts.map((m) => {
                    const resolved = detail.resolved[m.kind];
                    return (
                      <div key={m.kind}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            marginBottom: 6,
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          <i
                            aria-hidden
                            style={{
                              width: 9,
                              height: 9,
                              borderRadius: 3,
                              background: m.color,
                              display: "inline-block",
                            }}
                          />
                          {m.label}
                          <span className="muted" style={{ fontWeight: 500 }}>
                            · {sourceName(resolved?.source_id)}
                          </span>
                        </div>
                        <LineChart
                          samples={resolved?.samples ?? []}
                          stroke={m.color}
                          unit={SUMMARY_UNIT[m.kind] ?? m.unit}
                          label={m.label}
                          height={150}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="legend" style={{ marginTop: 12, justifyContent: "center" }}>
                  {scalarMetrics.map((m) => (
                    <i key={m.kind}>
                      <b style={{ background: m.color }} />
                      {m.label} · {sourceName(detail.resolved[m.kind]?.source_id)}
                    </i>
                  ))}
                </div>
              </>
            ) : (
              <EmptyState
                label="No metric streams"
                hint="No resolved scalar streams (HR / power / cadence / speed / altitude) for this activity yet."
                compact
              />
            )}
          </div>

          {/* splits — needs per-km aggregation we don't have yet */}
          <div className="card card--pad0">
            <div className="card__head" style={{ padding: "18px 20px 6px" }}>
              <div className="card__title">
                Splits<span className="sub">per kilometre</span>
              </div>
            </div>
            <div style={{ padding: "0 20px 20px" }}>
              <EmptyState
                label="No data yet"
                phase="Phase 4"
                hint="Per-kilometre splits land with the lap/segment aggregation engine."
                compact
              />
            </div>
          </div>
        </div>

        {/* ===================== RIGHT column ===================== */}
        <div className="grid" style={{ gap: "var(--gap)" }}>
          {/* ===== THE FUSION CORE ===== */}
          <div className="card" style={{ borderColor: "var(--accent-dim)" }}>
            <div className="card__head">
              <div className="card__title">
                Metric sources<span className="sub">multi-device fusion</span>
              </div>
              <div className="card__tools">
                <span className={recordingCount > 1 ? "pill pill--good" : "pill"}>
                  {recordingCount} {recordingCount === 1 ? "device" : "devices"}
                </span>
              </div>
            </div>
            <p className="faint" style={{ fontSize: 12, margin: "-6px 0 14px", lineHeight: 1.5 }}>
              Open Fit keeps every raw stream and resolves the best source <b>per metric</b>. Change
              any pick below to re-interpret this activity.
            </p>

            {pickerMetrics.length > 0 ? (
              <div>
                {pickerMetrics.map((metric) => (
                  <FusionRow
                    key={metric}
                    metric={metric}
                    color={CHART_METRICS.find((m) => m.kind === metric)?.color ?? "var(--accent)"}
                    candidates={candidatesByMetric.get(metric) ?? []}
                    selectedId={detail.resolved[metric]?.source_id}
                    srcClassFor={srcClassFor}
                    onPick={onPick}
                  />
                ))}
              </div>
            ) : (
              <EmptyState label="No multi-source metrics" compact />
            )}

            <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "16px 0 0" }} />
            <p className="faint" style={{ fontSize: 11.5, margin: "12px 0 0", lineHeight: 1.5 }}>
              Per-activity overrides apply immediately. Default source priority &amp; retroactive
              re-resolve live in Settings.
            </p>
          </div>

          {/* HR zones — needs zone-boundary config + time-in-zone aggregation */}
          <div className="card">
            <div className="card__head">
              <div className="card__title">
                Heart-rate zones
                <span className="sub">
                  source · {sourceName(detail.resolved.heart_rate?.source_id)}
                </span>
              </div>
            </div>
            <EmptyState
              label="No data yet"
              phase="Phase 4"
              hint="Time-in-zone needs configurable HR zone boundaries."
              compact
            />
          </div>

          {/* Derived metrics — algorithm plugins */}
          <div className="card">
            <div className="card__head">
              <div className="card__title">
                Derived<span className="sub">algorithm plugins</span>
              </div>
            </div>
            <EmptyState
              label="No data yet"
              phase="Phase 4"
              hint="Training Effect, VO₂ contribution and other plugin outputs render here once the algorithm engine ships."
              compact
            />
          </div>
        </div>
      </div>
    </>
  );
}

/* --------------------------------------------------------------- subviews */

function SummaryTile({
  label,
  value,
  suffix,
}: {
  label: string;
  value: ReactNode;
  suffix?: string;
}) {
  return (
    <div>
      <div className="lbl">{label}</div>
      <div className="val">
        {value}
        {suffix ? <small>{suffix}</small> : null}
      </div>
    </div>
  );
}

/** One fusion row: metric label + a row of .srcopt source buttons. */
function FusionRow({
  metric,
  color,
  candidates,
  selectedId,
  srcClassFor,
  onPick,
}: {
  metric: StreamKind;
  color: string;
  candidates: Source[];
  selectedId: string | undefined;
  srcClassFor: (id: string | undefined) => string;
  onPick: (metric: StreamKind, sourceId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const pick = async (sourceId: string) => {
    if (busy || sourceId === selectedId) return;
    setBusy(true);
    try {
      await onPick(metric, sourceId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fusion__row" data-metric={metric}>
      <div className="fusion__metric">
        <i style={{ background: color }} />
        {metricLabel(metric)}
      </div>
      <div className="srcpick" role="radiogroup" aria-label={`${metricLabel(metric)} source`}>
        {candidates.map((s) => {
          const sel = s.id === selectedId;
          const dotClass = srcClassFor(s.id);
          return (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={sel}
              disabled={busy}
              className={`srcopt${sel ? " is-sel" : ""}`}
              onClick={() => pick(s.id)}
            >
              <span
                className="d"
                aria-hidden
                style={{
                  background:
                    dotClass === "src--stryd"
                      ? "var(--power)"
                      : dotClass === "src--helio"
                        ? "var(--hr)"
                        : "var(--pace)",
                }}
              />
              {s.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
