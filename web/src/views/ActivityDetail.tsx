// Activity detail view: uPlot line charts for each resolved scalar stream, a
// MapLibre map of the resolved LatLng track, and a per-metric source picker.
//
// Picking a source PUTs a per-activity override (or a default) and re-fetches
// the resolved view so the charts/map re-render from the new source.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getActivity,
  listSources,
  putPreference,
} from "../api/endpoints";
import type {
  ActivityDetail as ActivityDetailData,
  MetricSourcePreference,
  Source,
  StreamKind,
} from "../api/types";
import { LineChart } from "../charts/LineChart";
import { TrackMap } from "../charts/TrackMapLazy";
import { CHART_METRICS, metricLabel } from "../ui/format";
import { Banner, Button, Card, Spinner } from "../ui/primitives";
import { SourcePicker } from "./SourcePicker";

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; detail: ActivityDetailData }
  | { kind: "error"; message: string };

export function ActivityDetail({
  activityId,
  onBack,
}: {
  activityId: string;
  onBack: () => void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [sources, setSources] = useState<Source[]>([]);

  const load = useCallback(() => {
    setState({ kind: "loading" });
    Promise.all([getActivity(activityId), listSources().catch(() => [])])
      .then(([detail, srcs]) => {
        setSources(srcs);
        setState({ kind: "ok", detail });
      })
      .catch((e: unknown) =>
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        }),
      );
  }, [activityId]);

  useEffect(() => {
    load();
  }, [load]);

  // Build a lookup: which sources offer a given metric for this activity.
  const candidatesByMetric = useMemo(() => {
    const map = new Map<StreamKind, Source[]>();
    if (state.kind !== "ok") return map;
    const byId = new Map(sources.map((s) => [s.id, s]));
    for (const rec of state.detail.recordings) {
      const src =
        byId.get(rec.source_id) ??
        ({
          id: rec.source_id,
          kind: "unknown",
          name: rec.source_name,
          default_priority: 0,
        } as Source);
      for (const kind of rec.stream_kinds) {
        const list = map.get(kind) ?? [];
        if (!list.some((s) => s.id === src.id)) list.push(src);
        map.set(kind, list);
      }
    }
    return map;
  }, [state, sources]);

  const defaultPrefByMetric = useMemo(() => {
    const map = new Map<StreamKind, MetricSourcePreference>();
    if (state.kind !== "ok") return map;
    for (const p of state.detail.preferences) {
      if (p.scope === "default") map.set(p.metric, p);
    }
    return map;
  }, [state]);

  const onPickActivity = useCallback(
    async (metric: StreamKind, sourceId: string) => {
      await putPreference({
        metric,
        scope: "activity",
        activity_id: activityId,
        source_id: sourceId,
        retroactive: false,
      });
      load();
    },
    [activityId, load],
  );

  const onSetDefault = useCallback(
    async (metric: StreamKind, sourceId: string, retroactive: boolean) => {
      await putPreference({
        metric,
        scope: "default",
        source_id: sourceId,
        retroactive,
      });
      load();
    },
    [load],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <Button onClick={onBack} style={{ alignSelf: "flex-start" }}>
        ← Back to activities
      </Button>

      {state.kind === "loading" && (
        <Card>
          <Spinner label="Loading activity…" />
        </Card>
      )}

      {state.kind === "error" && (
        <Card>
          <Banner kind="error">
            Couldn’t load this activity — {state.message}.
          </Banner>
        </Card>
      )}

      {state.kind === "ok" && (
        <DetailBody
          detail={state.detail}
          candidatesByMetric={candidatesByMetric}
          defaultPrefByMetric={defaultPrefByMetric}
          onPickActivity={onPickActivity}
          onSetDefault={onSetDefault}
        />
      )}
    </div>
  );
}

function DetailBody({
  detail,
  candidatesByMetric,
  defaultPrefByMetric,
  onPickActivity,
  onSetDefault,
}: {
  detail: ActivityDetailData;
  candidatesByMetric: Map<StreamKind, Source[]>;
  defaultPrefByMetric: Map<StreamKind, MetricSourcePreference>;
  onPickActivity: (metric: StreamKind, sourceId: string) => Promise<void>;
  onSetDefault: (
    metric: StreamKind,
    sourceId: string,
    retroactive: boolean,
  ) => Promise<void>;
}) {
  const track = detail.resolved.lat_lng?.track ?? [];
  const availableMetrics = CHART_METRICS.filter(
    (m) => (detail.resolved[m.kind]?.samples?.length ?? 0) > 0,
  );

  // Metrics that have a picker: any resolved metric (scalar or track).
  const pickerMetrics = (Object.keys(detail.resolved) as StreamKind[]).filter(
    (k) => (candidatesByMetric.get(k)?.length ?? 0) > 0,
  );

  return (
    <>
      <Card>
        <h2 style={{ margin: 0, marginBottom: "var(--space-2)", fontSize: "var(--font-size-lg)" }}>
          Recordings
        </h2>
        <p style={{ margin: 0, marginBottom: "var(--space-3)", color: "var(--color-text-muted)", fontSize: "var(--font-size-sm)" }}>
          {detail.recordings.length} source recording
          {detail.recordings.length === 1 ? "" : "s"} merged into this activity.
        </p>
        <ul style={{ margin: 0, paddingLeft: "var(--space-4)", fontSize: "var(--font-size-sm)" }}>
          {detail.recordings.map((r) => (
            <li key={r.id} style={{ marginBottom: "var(--space-1)" }}>
              <strong>{r.source_name}</strong>{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>{r.format}</code>
              {" — "}
              <span style={{ color: "var(--color-text-muted)" }}>
                {r.stream_kinds.map(metricLabel).join(", ") || "no streams"}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      {pickerMetrics.length > 0 && (
        <Card>
          <h2 style={{ margin: 0, marginBottom: "var(--space-2)", fontSize: "var(--font-size-lg)" }}>
            Source per metric
          </h2>
          <p style={{ margin: 0, marginBottom: "var(--space-4)", color: "var(--color-text-muted)", fontSize: "var(--font-size-sm)" }}>
            Choose which device wins for each metric. Charts re-render from the
            selected source.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 220px), 1fr))",
              gap: "var(--space-3)",
            }}
          >
            {pickerMetrics.map((metric) => (
              <SourcePicker
                key={metric}
                metric={metric}
                resolved={detail.resolved[metric]}
                candidates={candidatesByMetric.get(metric) ?? []}
                defaultPref={defaultPrefByMetric.get(metric)}
                onPickActivity={onPickActivity}
                onSetDefault={onSetDefault}
              />
            ))}
          </div>
        </Card>
      )}

      {track.length > 0 && (
        <Card>
          <h2 style={{ margin: 0, marginBottom: "var(--space-4)", fontSize: "var(--font-size-lg)" }}>
            Route
          </h2>
          <TrackMap track={track} />
        </Card>
      )}

      {availableMetrics.length > 0 ? (
        <Card>
          <h2 style={{ margin: 0, marginBottom: "var(--space-4)", fontSize: "var(--font-size-lg)" }}>
            Streams
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
            {availableMetrics.map((m) => {
              const resolved = detail.resolved[m.kind];
              return (
                <div key={m.kind}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      marginBottom: "var(--space-2)",
                    }}
                  >
                    <strong>
                      {m.label}{" "}
                      <span style={{ color: "var(--color-text-muted)", fontWeight: "var(--font-weight-normal)" }}>
                        ({m.unit})
                      </span>
                    </strong>
                  </div>
                  <LineChart
                    samples={resolved?.samples ?? []}
                    stroke={m.color}
                    unit={m.unit}
                    label={m.label}
                  />
                </div>
              );
            })}
          </div>
        </Card>
      ) : (
        track.length === 0 && (
          <Card>
            <Banner kind="info">
              No resolved streams to chart for this activity yet.
            </Banner>
          </Card>
        )
      )}
    </>
  );
}
