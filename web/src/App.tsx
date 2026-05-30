import { Suspense, lazy, useEffect, useState } from "react";
import { ThemeToggle } from "./theme/ThemeToggle";
import { API_BASE, getHealth } from "./api/client";
import { Dashboard } from "./views/Dashboard";
import { Spinner } from "./ui/primitives";

// Code-split the detail view: it pulls in uPlot + MapLibre GL, which are heavy.
const ActivityDetail = lazy(() =>
  import("./views/ActivityDetail").then((m) => ({ default: m.ActivityDetail })),
);

const APP_NAME = "Open Fit";

type HealthState =
  | { kind: "loading" }
  | { kind: "ok"; status: string }
  | { kind: "error"; message: string };

type View = { name: "list" } | { name: "detail"; activityId: string };

export function App() {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" });
  const [view, setView] = useState<View>({ name: "list" });

  useEffect(() => {
    let cancelled = false;
    getHealth()
      .then((res) => !cancelled && setHealth({ kind: "ok", status: res.status }))
      .catch((err: unknown) => {
        if (!cancelled)
          setHealth({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--color-bg)",
      }}
    >
      {/* Top toolbar */}
      <header
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-4)",
          padding: "var(--space-2) var(--space-4)",
          height: "3.25rem",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-surface)",
        }}
      >
        <button
          type="button"
          onClick={() => setView({ name: "list" })}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--space-2)",
            border: "none",
            background: "none",
            color: "var(--color-text)",
            fontSize: "var(--font-size-lg)",
            fontWeight: "var(--font-weight-bold)",
            cursor: "pointer",
            padding: 0,
          }}
        >
          <span aria-hidden style={{ color: "var(--color-accent)" }}>
            ◆
          </span>
          {APP_NAME}
        </button>

        {view.name === "detail" && (
          <span style={{ color: "var(--color-text-muted)", fontSize: "var(--font-size-sm)" }}>
            / activity
          </span>
        )}

        <div style={{ flex: 1 }} />
        <HealthBadge state={health} />
        <ThemeToggle />
      </header>

      {/* Content fills remaining height */}
      <div style={{ flex: 1, minHeight: 0 }}>
        {view.name === "list" ? (
          <Dashboard onOpen={(activityId) => setView({ name: "detail", activityId })} />
        ) : (
          <div style={{ height: "100%", overflow: "auto", padding: "var(--space-4)" }}>
            <Suspense fallback={<Spinner label="Loading charts…" />}>
              <ActivityDetail
                activityId={view.activityId}
                onBack={() => setView({ name: "list" })}
              />
            </Suspense>
          </div>
        )}
      </div>

      {/* Bottom status bar (qbit-style) */}
      <footer
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-1) var(--space-4)",
          borderTop: "1px solid var(--color-border)",
          background: "var(--color-surface)",
          color: "var(--color-text-muted)",
          fontSize: "0.75rem",
        }}
      >
        <StatusDot state={health} />
        <span>{healthLabel(health)}</span>
        <span style={{ flex: 1 }} />
        <span>
          Backend <code style={{ fontFamily: "var(--font-mono)" }}>{API_BASE}</code>
        </span>
      </footer>
    </div>
  );
}

function healthLabel(state: HealthState): string {
  if (state.kind === "ok") return `connected (${state.status})`;
  if (state.kind === "error") return "offline";
  return "connecting…";
}

function StatusDot({ state }: { state: HealthState }) {
  const color =
    state.kind === "ok"
      ? "var(--color-success)"
      : state.kind === "error"
        ? "var(--color-danger)"
        : "var(--color-text-muted)";
  return (
    <span
      aria-hidden
      style={{ width: "0.5rem", height: "0.5rem", borderRadius: "50%", background: color }}
    />
  );
}

function HealthBadge({ state }: { state: HealthState }) {
  const color =
    state.kind === "ok"
      ? "var(--color-success)"
      : state.kind === "error"
        ? "var(--color-danger)"
        : "var(--color-text-muted)";
  const label = state.kind === "ok" ? state.status : state.kind === "error" ? "offline" : "checking…";
  return (
    <span
      title={state.kind === "error" ? state.message : `GET /health: ${label}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        color,
        fontSize: "var(--font-size-sm)",
        fontWeight: "var(--font-weight-bold)",
      }}
    >
      <span
        aria-hidden
        style={{ width: "0.5rem", height: "0.5rem", borderRadius: "50%", background: "currentColor" }}
      />
      {label}
    </span>
  );
}
