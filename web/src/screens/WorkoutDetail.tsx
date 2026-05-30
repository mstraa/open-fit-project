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
import {
  getActivity,
  getDerived,
  listSources,
  putPreference,
  removeRecording,
} from "../api/endpoints";
import type { DerivedMetricDto } from "../api/schema";
import type {
  ActivityDetail,
  ScalarSample,
  Source,
  Sport,
  StreamKind,
} from "../api/types";
import { LineChart } from "../charts/LineChart";
import { TrackMap } from "../charts/TrackMap";
import { valueAtMs } from "../charts/series";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { EmptyState } from "../ui/EmptyState";
import {
  METRIC_ORDER,
  DEFAULT_VISIBLE,
  formatDuration,
  formatPace,
  metricLabel,
  metricMeta,
  speedLabel,
  speedModeFor,
  speedToMode,
  speedUnit,
  type MetricMeta,
  type SpeedMode,
} from "../ui/format";
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

function FusionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <circle cx="8" cy="8" r="4" />
      <circle cx="16" cy="16" r="4" />
      <path d="M11 11l2 2" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Sport-aware presentation for one resolved metric: label, unit, a per-sample
 * value transform (raw m/s → pace s/km or km/h for `speed`), and optional
 * chart formatters (min:ss pace axis, inverted so faster sits higher).
 * Everything except `speed` passes through unchanged.
 */
interface MetricPresentation {
  meta: MetricMeta;
  label: string;
  unit: string;
  /** Transform raw resolved samples into display samples. */
  transform: (samples: ScalarSample[] | undefined) => ScalarSample[];
  valueFormat?: (v: number) => string;
  yAxisFormat?: (v: number) => string;
  invertY?: boolean;
  /** Format an average (already in display units) for the summary tile. */
  formatAvg: (v: number) => string;
}

const identity = (s: ScalarSample[] | undefined): ScalarSample[] => s ?? [];

function presentMetric(meta: MetricMeta, sport: Sport | undefined): MetricPresentation {
  if (meta.kind === "speed") {
    const mode: SpeedMode = speedModeFor(sport);
    const unit = speedUnit(mode);
    const label = speedLabel(mode);
    const transform = (samples: ScalarSample[] | undefined): ScalarSample[] =>
      (samples ?? []).map((s) => ({
        t_offset_ms: s.t_offset_ms,
        value: speedToMode(s.value, mode),
      }));
    if (mode === "pace") {
      return {
        meta,
        label,
        unit,
        transform,
        valueFormat: (v) => `${formatPace(v)} ${unit}`,
        yAxisFormat: (v) => formatPace(v),
        invertY: true,
        formatAvg: (v) => formatPace(v),
      };
    }
    return {
      meta,
      label,
      unit,
      transform,
      valueFormat: (v) => `${v.toFixed(1)} ${unit}`,
      formatAvg: (v) => v.toFixed(1),
    };
  }
  return {
    meta,
    label: meta.label,
    unit: meta.unit,
    transform: identity,
    valueFormat: (v) => `${v.toFixed(0)} ${meta.unit}`,
    formatAvg: (v) => v.toFixed(meta.kind === "leg_spring_stiffness" ? 1 : 0),
  };
}

/* ------------------------------------------------------------------ screen */

export function WorkoutDetail() {
  const { id = "" } = useParams();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [sources, setSources] = useState<Source[]>([]);
  const [derived, setDerived] = useState<DerivedMetricDto[]>([]);

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

  // Per-activity derived metrics (TSS, etc.) from the analytics engine. Best-
  // effort: an empty result (or unreachable API) just leaves the Analysis card
  // in its on-brand empty state.
  useEffect(() => {
    if (!id) return;
    let alive = true;
    getDerived(`activity:${id}`)
      .then((res) => alive && setDerived(res.metrics))
      .catch(() => alive && setDerived([]));
    return () => {
      alive = false;
    };
  }, [id]);

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

  // Remove (detach) a recording from this activity, then refetch so charts and
  // sources re-resolve. The detached recording lives on in its own activity.
  const onRemoveRecording = useCallback(
    async (recordingId: string) => {
      const res = await removeRecording(id, recordingId);
      // Re-resolved trimmed original comes back in the response; reuse it
      // directly so the view updates without an extra round-trip, then refresh
      // sources (a source may no longer back any metric here).
      setState({ kind: "ok", detail: res.activity });
      listSources()
        .then(setSources)
        .catch(() => {});
    },
    [id],
  );

  // The fusion / sources panel is hidden by default behind this toggle.
  const [showFusion, setShowFusion] = useState(false);

  // Topbar bits. ActivityDetail has no sport/name field, so the crumb shows the
  // activity id; the in-page header derives a label below.
  const crumb = <>Activities / {id ? id.slice(0, 8) : "—"}</>;

  return (
    <AppShell
      title="Activity detail"
      crumb={crumb}
      actions={
        <>
          <button
            type="button"
            className={showFusion ? "btn" : "btn btn--ghost"}
            aria-pressed={showFusion}
            onClick={() => setShowFusion((v) => !v)}
          >
            <FusionIcon />
            Sources &amp; fusion
          </button>
          <Link to="/activities" className="btn btn--ghost">
            <BackIcon />
            Back to activities
          </Link>
        </>
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
          derived={derived}
          showFusion={showFusion}
          candidatesByMetric={candidatesByMetric}
          sourceName={sourceName}
          srcClassFor={(sid) => srcClass(sourceName(sid))}
          onPick={onPick}
          onRemoveRecording={onRemoveRecording}
        />
      )}
    </AppShell>
  );
}

/* ------------------------------------------------------------------- body */

function DetailBody({
  detail,
  derived,
  showFusion,
  candidatesByMetric,
  sourceName,
  srcClassFor,
  onPick,
  onRemoveRecording,
}: {
  detail: ActivityDetail;
  derived: DerivedMetricDto[];
  showFusion: boolean;
  candidatesByMetric: Map<StreamKind, Source[]>;
  sourceName: (id: string | undefined) => string;
  srcClassFor: (id: string | undefined) => string;
  onPick: (metric: StreamKind, sourceId: string) => Promise<void>;
  onRemoveRecording: (recordingId: string) => Promise<void>;
}) {
  const track = detail.resolved.lat_lng?.track ?? [];
  const sport = detail.sport ?? "other";

  // Synced graph↔map cursor (ms since start).
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  // Per-track-point speed (resolved speed stream aligned to the GPS timeline) →
  // colors the map path. undefined when there's no speed stream.
  const speedColors = useMemo(() => {
    const speed = detail.resolved.speed?.samples;
    if (!speed || speed.length === 0 || track.length === 0) return undefined;
    return track.map((p) => valueAtMs(speed, p.t_offset_ms) ?? 0);
  }, [detail, track]);

  // EVERY resolved scalar metric the API returns (lat_lng excluded — it's the
  // map track), ordered by METRIC_ORDER, with sport-aware presentation.
  const scalarMetrics = useMemo(() => {
    // Gate sparse channels: some FITs carry a metric (e.g. Stryd stride length
    // via cycle_length16) that is mostly zeros — charting it looks broken. Keep
    // a metric only if a meaningful fraction of its samples are non-zero.
    const hasEnoughData = (k: StreamKind): boolean => {
      const samples = detail.resolved[k]?.samples ?? [];
      if (samples.length === 0) return false;
      let nonZero = 0;
      for (const s of samples) if (s.value !== 0) nonZero++;
      return nonZero / samples.length >= 0.2;
    };
    const present = (Object.keys(detail.resolved) as StreamKind[])
      .filter((k) => k !== "lat_lng" && hasEnoughData(k));
    const ordered: MetricPresentation[] = [];
    for (const k of METRIC_ORDER) {
      if (present.includes(k)) {
        const meta = metricMeta(k);
        if (meta) ordered.push(presentMetric(meta, sport));
      }
    }
    // Unknown future kinds not in METRIC_ORDER → appended via the fallback meta.
    for (const k of present) {
      if (!METRIC_ORDER.includes(k as (typeof METRIC_ORDER)[number])) {
        const meta = metricMeta(k);
        if (meta) ordered.push(presentMetric(meta, sport));
      }
    }
    return ordered;
  }, [detail, sport]);

  // Per-metric show/hide. Default to a sane subset; everything else is toggled.
  const [visible, setVisible] = useState<Set<StreamKind>>(() => new Set());
  // Initialize/reconcile the visible set whenever the available metrics change.
  useEffect(() => {
    setVisible((prev) => {
      const available = new Set(scalarMetrics.map((m) => m.meta.kind));
      // Keep prior choices that are still available; if empty (first load),
      // seed with the default-visible subset intersected with what's present.
      const next = new Set<StreamKind>();
      for (const k of prev) if (available.has(k)) next.add(k);
      if (next.size === 0) {
        for (const k of DEFAULT_VISIBLE) if (available.has(k)) next.add(k);
        // If none of the defaults are present, show the first metric.
        if (next.size === 0 && scalarMetrics[0]) next.add(scalarMetrics[0].meta.kind);
      }
      return next;
    });
  }, [scalarMetrics]);

  const toggleMetric = useCallback((kind: StreamKind) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const visibleCharts = scalarMetrics.filter((m) => visible.has(m.meta.kind));

  // Approximate total duration from the longest resolved scalar stream.
  const durationSecs = useMemo(() => {
    let maxMs = 0;
    for (const m of scalarMetrics) {
      const ss = detail.resolved[m.meta.kind]?.samples;
      if (ss && ss.length) maxMs = Math.max(maxMs, ss[ss.length - 1].t_offset_ms);
    }
    if (track.length) maxMs = Math.max(maxMs, track[track.length - 1].t_offset_ms);
    return Math.round(maxMs / 1000);
  }, [detail, track, scalarMetrics]);

  const recordingCount = detail.recordings.length;

  // Metrics that get a fusion-picker row: any resolved metric with a candidate
  // source (so the user can confirm/flip the active source).
  const pickerMetrics = (Object.keys(detail.resolved) as StreamKind[]).filter(
    (k) => k !== "lat_lng" && (candidatesByMetric.get(k)?.length ?? 0) > 0,
  );

  return (
    <>
      {/* ---- header ---- */}
      <div className="wd-head">
        <div className={`wd-head__ic ${SPORT_TINT[sport] ?? SPORT_TINT.other}`}>
          <SportGlyph />
        </div>
        <div style={{ flex: 1 }}>
          <div className="wd-title">{SPORT_TITLE[sport] ?? SPORT_TITLE.other} — Activity</div>
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
        {scalarMetrics.map((p) => {
          const resolved = detail.resolved[p.meta.kind];
          // Average is computed on the DISPLAY-transformed samples so pace/kmh
          // tiles read correctly (e.g. average pace, not average m/s).
          const a = avg(p.transform(resolved?.samples));
          const sid = resolved?.source_id;
          const name = sourceName(sid);
          return (
            <div key={p.meta.kind}>
              <div className="lbl">Avg {p.label}</div>
              <div className="val">
                {a == null ? "—" : p.formatAvg(a)}
                <small> {p.unit}</small>
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
                    <TrackMap
                      track={track}
                      colorValues={speedColors}
                      cursorMs={hoverMs}
                      height={300}
                    />
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
            </div>

            {scalarMetrics.length > 0 ? (
              <>
                {/* show/hide chips — one per resolved scalar metric */}
                <div className="metric-chips" role="group" aria-label="Show or hide metrics">
                  {scalarMetrics.map((p) => {
                    const on = visible.has(p.meta.kind);
                    return (
                      <button
                        key={p.meta.kind}
                        type="button"
                        className={`metric-chip${on ? " is-on" : ""}`}
                        aria-pressed={on}
                        onClick={() => toggleMetric(p.meta.kind)}
                      >
                        <i aria-hidden style={{ background: p.meta.color }} />
                        {p.label}
                      </button>
                    );
                  })}
                </div>

                {visibleCharts.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                    {visibleCharts.map((p) => {
                      const resolved = detail.resolved[p.meta.kind];
                      const samples = p.transform(resolved?.samples);
                      return (
                        <div key={p.meta.kind}>
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
                                background: p.meta.color,
                                display: "inline-block",
                              }}
                            />
                            {p.label}
                            <span className="muted" style={{ fontWeight: 500 }}>
                              · {sourceName(resolved?.source_id)}
                            </span>
                          </div>
                          <LineChart
                            samples={samples}
                            stroke={p.meta.color}
                            unit={p.unit}
                            label={p.label}
                            valueFormat={p.valueFormat}
                            yAxisFormat={p.yAxisFormat}
                            invertY={p.invertY}
                            height={150}
                            syncKey="wd-cursor"
                            onHover={setHoverMs}
                          />
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <EmptyState
                    label="No graphs shown"
                    hint="Use the chips above to show one or more metrics."
                    compact
                  />
                )}
              </>
            ) : (
              <EmptyState
                label="No metric streams"
                hint="No resolved scalar streams for this activity yet."
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
          {/* ===== THE FUSION CORE (hidden behind the topbar toggle) ===== */}
          {showFusion ? (
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

              {/* recordings list — show device names + a remove (×) per source */}
              <div className="rec-list">
                {detail.recordings.map((rec) => (
                  <RecordingChip
                    key={rec.id}
                    name={rec.source_name}
                    format={rec.format}
                    metricCount={rec.stream_kinds.filter((k) => k !== "lat_lng").length}
                    srcClass={srcClassFor(rec.source_id)}
                    canRemove={recordingCount > 1}
                    onRemove={() => onRemoveRecording(rec.id)}
                  />
                ))}
              </div>

              <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "14px 0" }} />

              {pickerMetrics.length > 0 ? (
                <div>
                  {pickerMetrics.map((metric) => (
                    <FusionRow
                      key={metric}
                      metric={metric}
                      color={metricMeta(metric)?.color ?? "var(--accent)"}
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
          ) : null}

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

          {/* Derived metrics — algorithm plugins (TSS, etc.) — REAL DATA */}
          <div className="card">
            <div className="card__head">
              <div className="card__title">
                Analysis<span className="sub">algorithm outputs</span>
              </div>
              {derived.length > 0 ? (
                <div className="card__tools">
                  <Link to="/algorithms" className="pill">
                    Algorithms →
                  </Link>
                </div>
              ) : null}
            </div>
            {derived.length === 0 ? (
              <EmptyState
                label="No data yet"
                phase="Phase 3"
                hint="TSS and other per-activity algorithm outputs render here. Recompute on the Algorithms screen to populate them."
                compact
              />
            ) : (
              <div className="grid grid--stats" style={{ gap: 10 }}>
                {derived.map((m) => (
                  <DerivedTile key={`${m.plugin_id}:${m.name}`} metric={m} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* --------------------------------------------------------------- subviews */

/** A friendly label + value for one derived metric (e.g. tss → "TSS · 126"). */
function derivedLabel(name: string): string {
  const known: Record<string, string> = {
    tss: "TSS",
    hrv_rmssd: "HRV (RMSSD)",
    hrv_baseline: "HRV baseline",
    readiness: "Readiness",
    readiness_available: "Readiness ready",
    resting_hr_anomaly: "Resting-HR anomaly",
  };
  return known[name] ?? name.replace(/_/g, " ");
}

function derivedValue(name: string, value: number): string {
  if (name === "readiness_available" || name === "resting_hr_anomaly") {
    return value >= 0.5 ? "yes" : "no";
  }
  // Most outputs are sensible at 0–1 decimals.
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function DerivedTile({ metric }: { metric: DerivedMetricDto }) {
  return (
    <div className="card stat" style={{ padding: 14 }}>
      <div className="stat__label">{derivedLabel(metric.name)}</div>
      <div className="stat__val num" style={{ fontSize: 20 }}>
        {derivedValue(metric.name, metric.value)}
      </div>
      <div className="stat__delta flat">
        <span className="tag" style={{ fontFamily: "var(--font-mono)" }}>
          {metric.plugin_id} v{metric.version}
        </span>
      </div>
    </div>
  );
}

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

/** One recording in the activity: device name + metric count + remove (×). */
function RecordingChip({
  name,
  format,
  metricCount,
  srcClass,
  canRemove,
  onRemove,
}: {
  name: string;
  format: string;
  metricCount: number;
  srcClass: string;
  canRemove: boolean;
  onRemove: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    if (busy) return;
    const ok = window.confirm(
      `Remove “${name}” from this activity?\n\n` +
        "Its recording will be detached into its own new activity (no data is lost). " +
        "This split is durable — re-importing won't merge it back.",
    );
    if (!ok) return;
    setBusy(true);
    try {
      await onRemove();
    } catch (e) {
      window.alert(
        `Couldn't remove this source: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rec-chip" data-busy={busy ? "1" : undefined}>
      <span className={`src ${srcClass}`}>
        <span className="src__dot" />
        {name}
      </span>
      <span className="rec-chip__meta">
        {format.toUpperCase()} · {metricCount} {metricCount === 1 ? "metric" : "metrics"}
      </span>
      {canRemove ? (
        <button
          type="button"
          className="rec-chip__x"
          aria-label={`Remove ${name} from this activity`}
          title="Remove source from this activity"
          disabled={busy}
          onClick={remove}
        >
          <CloseIcon />
        </button>
      ) : null}
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
