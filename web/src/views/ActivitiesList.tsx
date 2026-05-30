// Activities list view: sport icon, date, duration, #recordings. Degrades
// gracefully when the API is unreachable.

import { useCallback, useEffect, useState } from "react";
import { listActivities } from "../api/endpoints";
import type { ActivitySummary } from "../api/types";
import { formatDateTime, formatDuration, sportIcon, sportLabel } from "../ui/format";
import { Banner, Card, Spinner } from "../ui/primitives";
import { ImportControl } from "./ImportControl";

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; activities: ActivitySummary[] }
  | { kind: "error"; message: string };

export function ActivitiesList({
  onOpen,
}: {
  onOpen: (id: string) => void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(() => {
    setState({ kind: "loading" });
    listActivities()
      .then((activities) => setState({ kind: "ok", activities }))
      .catch((e: unknown) =>
        setState({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        }),
      );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}>
      <Card>
        <h2 style={{ margin: 0, marginBottom: "var(--space-3)", fontSize: "var(--font-size-lg)" }}>
          Import activities
        </h2>
        <ImportControl onImported={load} />
      </Card>

      <Card>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: "var(--space-4)",
          }}
        >
          <h2 style={{ margin: 0, fontSize: "var(--font-size-lg)" }}>Activities</h2>
          {state.kind === "ok" && (
            <span style={{ color: "var(--color-text-muted)", fontSize: "var(--font-size-sm)" }}>
              {state.activities.length} total
            </span>
          )}
        </div>

        {state.kind === "loading" && <Spinner label="Loading activities…" />}

        {state.kind === "error" && (
          <Banner kind="error">
            Couldn’t reach the API — {state.message}. Showing nothing; import to add
            data once the backend is up.
          </Banner>
        )}

        {state.kind === "ok" && state.activities.length === 0 && (
          <Banner kind="info">
            No activities yet. Import a .fit / .gpx / .tcx file above to get started.
          </Banner>
        )}

        {state.kind === "ok" && state.activities.length > 0 && (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            {state.activities.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => onOpen(a.id)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-4)",
                    textAlign: "left",
                    background: "var(--color-surface-alt)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "var(--radius-sm)",
                    padding: "var(--space-3) var(--space-4)",
                    font: "inherit",
                    color: "var(--color-text)",
                    cursor: "pointer",
                  }}
                >
                  <span aria-hidden style={{ fontSize: "1.5rem", lineHeight: 1 }}>
                    {sportIcon(a.sport)}
                  </span>
                  <span style={{ display: "flex", flexDirection: "column", gap: "2px", flex: 1 }}>
                    <strong>{sportLabel(a.sport)}</strong>
                    <span style={{ color: "var(--color-text-muted)", fontSize: "var(--font-size-sm)" }}>
                      {formatDateTime(a.started_at)}
                    </span>
                  </span>
                  <span style={{ textAlign: "right", display: "flex", flexDirection: "column", gap: "2px" }}>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>
                      {formatDuration(a.duration_secs)}
                    </span>
                    <span style={{ color: "var(--color-text-muted)", fontSize: "var(--font-size-sm)" }}>
                      {a.recording_count} recording{a.recording_count === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
