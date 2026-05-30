// Per-metric source picker: shows the currently-selected source for a metric
// and lets the user change it. Changing a metric writes a per-activity override
// (PUT /api/preferences, scope 'activity', activity_id); the parent re-fetches
// the resolved view so charts/map re-render from the new source.

import { useState } from "react";
import type {
  MetricSourcePreference,
  ResolvedMetric,
  Source,
  StreamKind,
} from "../api/types";
import { metricLabel, selectionReasonLabel } from "../ui/format";
import { Banner } from "../ui/primitives";

export interface SourcePickerProps {
  metric: StreamKind;
  /** Resolved info for this metric (carries the winning source + reason). */
  resolved?: ResolvedMetric;
  /** Sources that actually offer this metric for this activity. */
  candidates: Source[];
  /** The active default-scope preference for this metric, if any. */
  defaultPref?: MetricSourcePreference;
  /** Called with the chosen source for a per-activity override. */
  onPickActivity: (metric: StreamKind, sourceId: string) => Promise<void>;
  /** Called to set the persistent default + retroactive flag for this metric. */
  onSetDefault: (
    metric: StreamKind,
    sourceId: string,
    retroactive: boolean,
  ) => Promise<void>;
}

export function SourcePicker({
  metric,
  resolved,
  candidates,
  defaultPref,
  onPickActivity,
  onSetDefault,
}: SourcePickerProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retroactive, setRetroactive] = useState<boolean>(
    defaultPref?.retroactive ?? false,
  );

  const selectedId = resolved?.source_id ?? "";
  const reason = selectionReasonLabel(resolved?.selected_by);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const labelStyle = {
    fontSize: "var(--font-size-sm)",
    color: "var(--color-text-muted)",
  } as const;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        padding: "var(--space-3)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-sm)",
        background: "var(--color-surface-alt)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: "var(--space-2)",
        }}
      >
        <strong>{metricLabel(metric)}</strong>
        <span style={labelStyle}>{reason}</span>
      </div>

      <label style={labelStyle} htmlFor={`pick-${metric}`}>
        Source for this activity
      </label>
      <select
        id={`pick-${metric}`}
        value={selectedId}
        disabled={busy || candidates.length === 0}
        onChange={(e) =>
          guard(() => onPickActivity(metric, e.target.value))
        }
        style={{
          background: "var(--color-surface)",
          color: "var(--color-text)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-sm)",
          padding: "var(--space-2)",
          font: "inherit",
        }}
      >
        {candidates.length === 0 && <option value="">No source</option>}
        {candidates.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>

      <details>
        <summary style={{ ...labelStyle, cursor: "pointer" }}>
          Set as default for {metricLabel(metric).toLowerCase()}
        </summary>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
            marginTop: "var(--space-2)",
          }}
        >
          <label
            style={{
              ...labelStyle,
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
            }}
          >
            <input
              type="checkbox"
              checked={retroactive}
              onChange={(e) => setRetroactive(e.target.checked)}
            />
            Apply retroactively to past activities
          </label>
          <button
            type="button"
            disabled={busy || !selectedId}
            onClick={() =>
              guard(() => onSetDefault(metric, selectedId, retroactive))
            }
            style={{
              alignSelf: "flex-start",
              background: "var(--color-surface)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              padding: "var(--space-1) var(--space-3)",
              font: "inherit",
              cursor: busy ? "wait" : "pointer",
            }}
          >
            Save default
          </button>
        </div>
      </details>

      {error && <Banner kind="error">{error}</Banner>}
    </div>
  );
}
