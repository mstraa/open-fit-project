import { Suspense, lazy, useEffect, useState } from "react";
import { ThemeToggle } from "./theme/ThemeToggle";
import { API_BASE, getHealth } from "./api/client";
import { ActivitiesList } from "./views/ActivitiesList";
import { Spinner } from "./ui/primitives";

// Code-split the detail view: it pulls in uPlot + MapLibre GL, which are heavy.
// The list view (the entry point) stays light.
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
      .then((res) => {
        if (!cancelled) setHealth({ kind: "ok", status: res.status });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setHealth({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main
      style={{
        maxWidth: "64rem",
        margin: "0 auto",
        padding: "var(--space-8) var(--space-4)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--space-4)",
          marginBottom: "var(--space-8)",
        }}
      >
        <button
          type="button"
          onClick={() => setView({ name: "list" })}
          style={{
            margin: 0,
            padding: 0,
            border: "none",
            background: "none",
            color: "var(--color-text)",
            fontSize: "var(--font-size-xl)",
            fontWeight: "var(--font-weight-bold)",
            cursor: "pointer",
          }}
        >
          {APP_NAME}
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }}>
          <HealthBadge state={health} />
          <ThemeToggle />
        </div>
      </header>

      {view.name === "list" ? (
        <ActivitiesList
          onOpen={(activityId) => setView({ name: "detail", activityId })}
        />
      ) : (
        <Suspense fallback={<Spinner label="Loading charts…" />}>
          <ActivityDetail
            activityId={view.activityId}
            onBack={() => setView({ name: "list" })}
          />
        </Suspense>
      )}

      <footer
        style={{
          marginTop: "var(--space-8)",
          color: "var(--color-text-muted)",
          fontSize: "var(--font-size-sm)",
          textAlign: "center",
        }}
      >
        Backend: <code style={{ fontFamily: "var(--font-mono)" }}>{API_BASE}</code>
      </footer>
    </main>
  );
}

function HealthBadge({ state }: { state: HealthState }) {
  let color = "var(--color-text-muted)";
  let label = "checking…";

  if (state.kind === "ok") {
    color = "var(--color-success)";
    label = state.status;
  } else if (state.kind === "error") {
    color = "var(--color-danger)";
    label = "offline";
  }

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
        style={{
          width: "0.5rem",
          height: "0.5rem",
          borderRadius: "50%",
          background: "currentColor",
        }}
      />
      {label}
    </span>
  );
}
