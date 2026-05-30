// Algorithms screen — surfaces the Phase-3 analytics engine: the registry of
// built-in (pure-Rust) and WASM-plugin (community) algorithms, plus a Recompute
// action that re-runs every algorithm over all activities + wellness and
// persists the derived metrics/streams.
//
// REAL DATA: GET /api/algorithms → each algorithm is rendered as a design card
// (name, version, built-in vs WASM-plugin badge, required input chips, output
// chips, applicable hardware, enabled state). The WASM-plugin extension point is
// shown distinctly even when only the example/community plugin is present. The
// "Recompute" button POSTs /api/analytics/recompute and refreshes; its per-
// algorithm + total output counts are surfaced inline.

import { useEffect, useState, type ReactNode } from "react";
import { AppShell } from "../app/AppShell";
import { AlgorithmsIcon } from "../app/icons";
import { EmptyState } from "../ui/EmptyState";
import { Spinner } from "../ui/primitives";
import { listAlgorithms, recomputeAnalytics } from "../api/endpoints";
import type { AlgorithmDto, RecomputeResponseDto } from "../api/schema";
import "./Algorithms.css";

/* ------------------------------------------------------------- input chips */
// Inputs arrive as `"stream:heart_rate"` / `"wellness:hrv"` tags. Split the
// domain from the kind so the chip reads as a clean metric name + a domain tint.

function parseInput(tag: string): { domain: string; kind: string } {
  const i = tag.indexOf(":");
  if (i < 0) return { domain: "", kind: tag };
  return { domain: tag.slice(0, i), kind: tag.slice(i + 1) };
}

function humanize(s: string): string {
  return s.replace(/_/g, " ");
}

function InputChip({ tag }: { tag: string }) {
  const { domain, kind } = parseInput(tag);
  const tint = domain === "wellness" ? "t-hr" : "t-acc";
  return (
    <span className={`alg-chip ${tint}`} title={`${domain} · ${kind}`}>
      {humanize(kind)}
    </span>
  );
}

function OutputChip({ name }: { name: string }) {
  return (
    <span className="tag alg-out" title={`output: ${name}`}>
      {name}
    </span>
  );
}

/* --------------------------------------------------------------- alg card */

function AlgorithmCard({ alg }: { alg: AlgorithmDto }) {
  const isWasm = alg.kind === "wasm";
  return (
    <section className={`card alg-card${isWasm ? " alg-card--wasm" : ""}`}>
      <div className="alg-card__head">
        <div className={`stat__ico ${isWasm ? "t-elev" : "t-acc"}`}>
          <AlgorithmsIcon />
        </div>
        <div className="alg-card__title">
          <div className="alg-card__name">
            {alg.name}
            <span className="alg-ver mono">v{alg.version}</span>
          </div>
          <div className="alg-card__id mono">{alg.id}</div>
        </div>
        <div className="alg-card__badges">
          {isWasm ? (
            <span className="pill pill--warn" title="Sandboxed WASM community plugin">
              WASM plugin
            </span>
          ) : (
            <span className="pill" title="Compiled into the server (pure Rust)">
              Built-in
            </span>
          )}
          {alg.enabled ? (
            <span className="pill pill--good">
              <span className="dot-live" />
              enabled
            </span>
          ) : (
            <span className="pill">disabled</span>
          )}
        </div>
      </div>

      <p className="alg-card__desc">{alg.description}</p>

      <div className="alg-card__meta">
        <Field label="Inputs">
          {alg.inputs.length === 0 ? (
            <span className="muted">none</span>
          ) : (
            <div className="alg-chips">
              {alg.inputs.map((t) => (
                <InputChip key={t} tag={t} />
              ))}
            </div>
          )}
        </Field>

        <Field label="Outputs">
          <div className="alg-chips">
            {alg.outputs.map((n) => (
              <OutputChip key={n} name={n} />
            ))}
          </div>
        </Field>

        <Field label="Hardware">
          <div className="alg-chips">
            {alg.applicable_hardware.map((h) => (
              <span key={h} className="tag">
                {humanize(h)}
              </span>
            ))}
          </div>
        </Field>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="alg-field">
      <div className="alg-field__label">{label}</div>
      <div className="alg-field__val">{children}</div>
    </div>
  );
}

/* ============================================================== screen */

type State =
  | { kind: "loading" }
  | { kind: "ok"; algorithms: AlgorithmDto[] }
  | { kind: "error"; message: string };

export function Algorithms() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RecomputeResponseDto | null>(null);
  const [recomputeError, setRecomputeError] = useState<string | null>(null);

  const load = () => {
    setState({ kind: "loading" });
    listAlgorithms()
      .then((algorithms) => setState({ kind: "ok", algorithms }))
      .catch((e: unknown) =>
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
      );
  };

  useEffect(load, []);

  const onRecompute = async () => {
    setBusy(true);
    setRecomputeError(null);
    try {
      const res = await recomputeAnalytics();
      setResult(res);
      load();
    } catch (e: unknown) {
      setRecomputeError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const algorithms = state.kind === "ok" ? state.algorithms : [];
  const builtIns = algorithms.filter((a) => a.kind === "built_in");
  const plugins = algorithms.filter((a) => a.kind === "wasm");

  return (
    <AppShell
      title="Algorithms"
      crumb="Versioned, recalculable analytics · built-in + sandboxed plugins"
      actions={
        <button type="button" className="btn" disabled={busy} onClick={onRecompute}>
          <AlgorithmsIcon />
          {busy ? "Recomputing…" : "Recompute"}
        </button>
      }
    >
      {/* recompute result / error banner */}
      {recomputeError ? (
        <div className="banner banner--bad" style={{ marginBottom: 20 }}>
          <AlgorithmsIcon />
          <div>
            <b>Recompute failed.</b>{" "}
            <span className="muted">{recomputeError}</span>
          </div>
        </div>
      ) : result ? (
        <div className="banner" style={{ marginBottom: 20 }}>
          <AlgorithmsIcon />
          <div>
            <b>Recomputed.</b>{" "}
            <span className="muted">
              {result.activities} activities · {result.wellness_points} wellness points →{" "}
              {result.total_metrics} metrics, {result.total_streams} streams persisted.
            </span>
          </div>
          <span className="pill pill--good" style={{ marginLeft: "auto" }}>
            {result.algorithms.length} algorithms
          </span>
        </div>
      ) : null}

      {state.kind === "loading" ? (
        <Spinner label="Loading algorithms…" />
      ) : state.kind === "error" ? (
        <EmptyState
          label="Couldn't load algorithms"
          hint={state.message}
          phase="Phase 3"
        />
      ) : algorithms.length === 0 ? (
        <EmptyState
          label="No algorithms registered"
          phase="Phase 3"
          hint="Built-in algorithms ship with the server; drop a WASM plugin in OFIT_PLUGINS_DIR to extend."
        />
      ) : (
        <>
          <div className="alg-section-label">
            Built-in <span className="muted">· pure Rust, always available</span>
          </div>
          <div className="alg-grid">
            {builtIns.map((a) => (
              <AlgorithmCard key={`${a.id}@${a.version}`} alg={a} />
            ))}
          </div>

          <div className="alg-section-label" style={{ marginTop: 22 }}>
            Community plugins{" "}
            <span className="muted">· sandboxed WASM · no network, no filesystem</span>
          </div>
          {plugins.length === 0 ? (
            <EmptyState
              label="No plugins loaded"
              phase="Phase 3"
              hint="Third-party algorithms run sandboxed as WASM. Point OFIT_PLUGINS_DIR at a plugins directory and they appear here, recomputing through the same path as the built-ins."
            />
          ) : (
            <div className="alg-grid">
              {plugins.map((a) => (
                <AlgorithmCard key={`${a.id}@${a.version}`} alg={a} />
              ))}
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
