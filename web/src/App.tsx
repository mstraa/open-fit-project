import { useEffect, useState } from "react";
import { ThemeToggle } from "./theme/ThemeToggle";
import { API_BASE, getHealth } from "./api/client";

const APP_NAME = "Open Fit";

type HealthState =
  | { kind: "loading" }
  | { kind: "ok"; status: string }
  | { kind: "error"; message: string };

export function App() {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" });

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
        maxWidth: "48rem",
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
        <h1
          style={{
            margin: 0,
            fontSize: "var(--font-size-xl)",
            fontWeight: "var(--font-weight-bold)",
          }}
        >
          {APP_NAME}
        </h1>
        <ThemeToggle />
      </header>

      <section
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-md)",
          boxShadow: "var(--shadow-1)",
          padding: "var(--space-6)",
        }}
      >
        <h2
          style={{
            margin: 0,
            marginBottom: "var(--space-3)",
            fontSize: "var(--font-size-lg)",
          }}
        >
          API connection
        </h2>
        <p
          style={{
            margin: 0,
            marginBottom: "var(--space-3)",
            color: "var(--color-text-muted)",
            fontSize: "var(--font-size-sm)",
          }}
        >
          Backend:{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>{API_BASE}</code>
        </p>
        <HealthBadge state={health} />
      </section>
    </main>
  );
}

function HealthBadge({ state }: { state: HealthState }) {
  let color = "var(--color-text-muted)";
  let label = "Checking GET /health…";

  if (state.kind === "ok") {
    color = "var(--color-success)";
    label = `Healthy — status: ${state.status}`;
  } else if (state.kind === "error") {
    color = "var(--color-danger)";
    label = `Unreachable — ${state.message}`;
  }

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        color,
        fontWeight: "var(--font-weight-bold)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: "0.625rem",
          height: "0.625rem",
          borderRadius: "50%",
          background: "currentColor",
        }}
      />
      {label}
    </span>
  );
}
