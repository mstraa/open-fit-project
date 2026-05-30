// Launcher / overview — the design's `index.html` (open-fit-launcher) surface.
// This is the standalone entry page (route "/"), NOT inside the AppShell rail.
// It links into each product screen as a card/tile and shows a couple of REAL
// cheap counts (activities via listActivities, sources via listSources). No
// fake stats: where no data exists we render a neutral "—".
//
// The launcher-specific classes (.lhead .hero .feat .screen .mk …) live in the
// design export's inline <style> (docs/designs/index.html), not the shared
// app.css, so they are ported here as a scoped <style> block. Everything else
// reuses the canonical design tokens/classes (.card .pill .btn .rail__* etc.).

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { LogoMark } from "../app/icons";
import { useHealth } from "../hooks/useHealth";
import { listActivities, listSources } from "../api/endpoints";

type Counts = { activities: number | null; sources: number | null };

export function Launcher() {
  const health = useHealth();
  const [counts, setCounts] = useState<Counts>({ activities: null, sources: null });

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([listActivities(), listSources()]).then(([acts, srcs]) => {
      if (cancelled) return;
      setCounts({
        activities: acts.status === "fulfilled" ? acts.value.length : null,
        sources: srcs.status === "fulfilled" ? srcs.value.length : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const online = health.kind === "ok";
  const countLabel = (n: number | null) => (n === null ? "—" : String(n));

  return (
    <div className="launcher">
      <style>{LAUNCHER_CSS}</style>
      <div className="glow" />
      <div className="wrap">
        <header className="lhead">
          <div className="rail__logo">
            <LogoMark />
          </div>
          <div>
            <div className="rail__name">
              Open<span>Fit</span>
            </div>
            <div className="rail__sub">self-hosted · cloudless · GPL</div>
          </div>
          <div className="right">
            <span className={online ? "pill pill--good" : "pill"}>
              <span className="dot-live" />
              {online ? "server online" : "server offline"}
            </span>
            <Link to="/dashboard" className="btn">
              Open dashboard
            </Link>
          </div>
        </header>

        <section className="hero">
          <h1>
            Your training data, <em>fused</em> and entirely yours.
          </h1>
          <p>
            A Garmin Connect-class fitness platform you run yourself. Every device's raw
            stream is kept, the best source is resolved <b>per metric</b>, and your analysis
            runs on sandboxed plugins you choose — with zero cloud, by design.
          </p>
          <div className="meta">
            <span className="pill">
              {countLabel(counts.activities)} fused {counts.activities === 1 ? "activity" : "activities"}
            </span>
            <span className="pill">
              {countLabel(counts.sources)} {counts.sources === 1 ? "source" : "sources"}
            </span>
            <span className="pill">via Gadgetbridge · BLE</span>
          </div>
        </section>

        <section className="feat">
          <div className="card">
            <div className="card__title">
              <span className="ic t-acc">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path
                    d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              Multi-device fusion
            </div>
            <p>
              Several devices on one effort collapse into a single logical activity. Keep all
              raw streams; pick the best source per metric — persistent defaults, per-activity
              overrides, retroactive on demand.
            </p>
          </div>
          <div className="card">
            <div className="card__title">
              <span className="ic t-pow">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" />
                </svg>
              </span>
              Plugin algorithms
            </div>
            <p>
              Recovery, HRV, sleep staging, training load — all sandboxed WASM plugins,
              versioned and recomputable. Install more from a community registry, filtered by
              your hardware.
            </p>
          </div>
          <div className="card">
            <div className="card__title">
              <span className="ic t-elev">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 3l8 4v6c0 4-3.5 7-8 8-4.5-1-8-4-8-8V7z" strokeLinejoin="round" />
                </svg>
              </span>
              Cloudless by design
            </div>
            <p>
              No Garmin Connect, no Zepp, no PowerCenter. Local BLE ingestion through
              Gadgetbridge plus a one-time FIT import. Runs as a single binary or full Docker
              stack.
            </p>
          </div>
        </section>

        <p className="seclabel">Screens</p>
        <section className="screens">
          <Link className="screen" to="/dashboard">
            <div className="screen__shot">
              <div className="mk">
                <div className="mk-col" style={{ flex: 0.4 }}>
                  <div className="mk-tile" />
                  <div className="mk-tile" />
                  <div className="mk-tile" />
                </div>
                <div className="mk-col">
                  <div style={{ display: "flex", gap: 8, flex: 0.5 }}>
                    <div className="mk-tile" />
                    <div className="mk-tile" />
                    <div className="mk-tile" />
                  </div>
                  <div
                    className="mk-tile"
                    style={{ flex: 1.4, position: "relative", overflow: "hidden" }}
                  >
                    <svg
                      viewBox="0 0 200 60"
                      preserveAspectRatio="none"
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
                    >
                      <path
                        d="M0 50 C40 40 60 20 100 28 C140 36 160 12 200 18"
                        fill="none"
                        stroke="var(--accent)"
                        strokeWidth="2.5"
                      />
                    </svg>
                  </div>
                </div>
              </div>
            </div>
            <div className="screen__body">
              <div>
                <b>Dashboard</b>
                <span>Training load, wellness, recent fused activities</span>
              </div>
              <span className="screen__arrow">→</span>
            </div>
          </Link>

          <Link className="screen" to="/activities">
            <div className="screen__shot">
              <div className="mk">
                <div className="mk-col">
                  <div
                    className="mk-tile"
                    style={{ flex: 1.3, position: "relative", overflow: "hidden" }}
                  >
                    <svg
                      viewBox="0 0 200 70"
                      preserveAspectRatio="none"
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
                    >
                      <path
                        d="M10 60 C50 30 70 50 110 25 C150 5 170 40 195 30"
                        fill="none"
                        stroke="url(#lch-g1)"
                        strokeWidth="3"
                      />
                      <defs>
                        <linearGradient id="lch-g1" x1="0" x2="1">
                          <stop offset="0" stopColor="var(--pace)" />
                          <stop offset="1" stopColor="var(--power)" />
                        </linearGradient>
                      </defs>
                    </svg>
                  </div>
                  <div className="mk-tile" style={{ flex: 0.6 }} />
                </div>
                <div className="mk-col" style={{ flex: 0.55 }}>
                  <div className="mk-tile" style={{ borderColor: "var(--accent-dim)" }} />
                  <div className="mk-tile" />
                </div>
              </div>
            </div>
            <div className="screen__body">
              <div>
                <b>Activities</b>
                <span>Every fused effort, filterable by sport</span>
              </div>
              <span className="screen__arrow">→</span>
            </div>
          </Link>

          <Link className="screen" to="/wellness">
            <div className="screen__shot">
              <div className="mk">
                <div className="mk-col">
                  <div
                    className="mk-tile"
                    style={{
                      flex: 0.7,
                      display: "flex",
                      alignItems: "flex-end",
                      gap: 3,
                      padding: 8,
                    }}
                  >
                    <i style={{ flex: 1, height: "60%", background: "var(--accent)", borderRadius: 2 }} />
                    <i style={{ flex: 1, height: "90%", background: "var(--pace)", borderRadius: 2 }} />
                    <i style={{ flex: 1, height: "40%", background: "var(--power)", borderRadius: 2 }} />
                    <i style={{ flex: 1, height: "75%", background: "var(--accent)", borderRadius: 2 }} />
                    <i style={{ flex: 1, height: "55%", background: "var(--pace)", borderRadius: 2 }} />
                  </div>
                  <div className="mk-tile" style={{ position: "relative", overflow: "hidden" }}>
                    <svg
                      viewBox="0 0 200 50"
                      preserveAspectRatio="none"
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
                    >
                      <path
                        d="M0 30 C40 20 70 36 110 24 C150 14 170 30 200 22"
                        fill="none"
                        stroke="var(--power)"
                        strokeWidth="2.5"
                      />
                    </svg>
                  </div>
                </div>
                <div className="mk-col" style={{ flex: 0.45 }}>
                  <div className="mk-tile" />
                  <div className="mk-tile" />
                  <div className="mk-tile" />
                </div>
              </div>
            </div>
            <div className="screen__body">
              <div>
                <b>Wellness</b>
                <span>Sleep, HRV, body battery, stress &amp; readiness</span>
              </div>
              <span className="screen__arrow">→</span>
            </div>
          </Link>

          <Link className="screen" to="/settings">
            <div className="screen__shot">
              <div className="mk">
                <div className="mk-col" style={{ flex: 0.35 }}>
                  <div className="mk-line" style={{ background: "var(--accent-ghost)" }} />
                  <div className="mk-line" />
                  <div className="mk-line" />
                  <div className="mk-line" />
                </div>
                <div className="mk-col">
                  <div className="mk-tile" />
                  <div className="mk-tile" style={{ flex: 0.5 }} />
                </div>
              </div>
            </div>
            <div className="screen__body">
              <div>
                <b>Settings</b>
                <span>Source priority, devices, plugins, storage tier</span>
              </div>
              <span className="screen__arrow">→</span>
            </div>
          </Link>
        </section>

        <footer className="lfoot">
          <span>OpenFit · self-hosted fitness platform</span>
          <span>·</span>
          <span>AGPLv3 server / GPLv3 mobile</span>
          <span>·</span>
          <span>Rust + axum · React + TS · uPlot · MapLibre</span>
        </footer>
      </div>
    </div>
  );
}

// Ported verbatim from the inline <style> in docs/designs/index.html, scoped
// under `.launcher` so it never leaks into the AppShell screens.
const LAUNCHER_CSS = `
.launcher { min-height: 100%; overflow-y: auto; position: relative; }
.launcher .wrap { max-width: 1100px; margin: 0 auto; padding: 0 28px; }

.launcher .lhead { display: flex; align-items: center; gap: 14px; padding: 26px 0; }
.launcher .lhead .rail__logo { width: 38px; height: 38px; }
.launcher .lhead .rail__logo svg { width: 22px; height: 22px; }
.launcher .lhead .rail__name { font-size: 19px; }
.launcher .lhead .right { margin-left: auto; display: flex; gap: 10px; align-items: center; }

.launcher .hero { padding: 54px 0 40px; }
.launcher .hero h1 { font-size: clamp(38px, 6vw, 68px); font-weight: 780; letter-spacing: -0.04em; line-height: 1.02; max-width: 14ch; }
.launcher .hero h1 em { font-style: normal; color: var(--accent); }
.launcher .hero p { font-size: clamp(16px, 2vw, 19px); color: var(--muted); max-width: 60ch; margin-top: 22px; line-height: 1.55; }
.launcher .hero .meta { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 26px; }

.launcher .glow { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: -1; }
.launcher .glow::before { content: ""; position: absolute; top: -180px; right: -120px; width: 560px; height: 560px; border-radius: 50%;
  background: radial-gradient(circle, var(--accent-ghost), transparent 65%); filter: blur(20px); }
.launcher .glow::after { content: ""; position: absolute; top: 80px; left: -160px; width: 420px; height: 420px; border-radius: 50%;
  background: radial-gradient(circle, oklch(64% 0.130 200 / .10), transparent 65%); filter: blur(20px); }

.launcher .feat { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--gap); margin: 8px 0 48px; }
.launcher .feat .card__title { font-size: 15px; margin-bottom: 8px; display: flex; align-items: center; gap: 9px; }
.launcher .feat .ic { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; }
.launcher .feat .ic svg { width: 17px; height: 17px; }
.launcher .feat p { font-size: 13px; color: var(--muted); line-height: 1.55; }

.launcher .seclabel { font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: var(--faint); margin: 0 0 16px; }
.launcher .screens { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--gap); }
.launcher .screen { display: block; border: 1px solid var(--border); border-radius: var(--r-lg); overflow: hidden; background: var(--surface); transition: .16s; text-decoration: none; color: inherit; }
.launcher .screen:hover { border-color: var(--border-2); transform: translateY(-3px); box-shadow: var(--shadow-pop); }
.launcher .screen:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.launcher .screen__shot { height: 188px; position: relative; overflow: hidden; border-bottom: 1px solid var(--border);
  background: radial-gradient(120% 120% at 20% 0%, oklch(24% 0.03 255), oklch(16% 0.02 255)); }
.launcher .screen__body { padding: 16px 18px; display: flex; align-items: center; gap: 12px; }
.launcher .screen__body b { font-size: 15px; font-weight: 650; }
.launcher .screen__body span { font-size: 12.5px; color: var(--faint); display: block; }
.launcher .screen__arrow { margin-left: auto; color: var(--accent); }

.launcher .mk { position: absolute; inset: 18px; display: flex; gap: 8px; }
.launcher .mk-col { display: flex; flex-direction: column; gap: 8px; flex: 1; }
.launcher .mk-tile { background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; flex: 1; }
.launcher .mk-line { height: 6px; border-radius: 99px; background: var(--surface-3); }

.launcher .lfoot { padding: 40px 0 60px; color: var(--faint); font-size: 12.5px; display: flex; gap: 16px; flex-wrap: wrap; align-items: center; }

@media (max-width: 820px) {
  .launcher .feat { grid-template-columns: 1fr; }
  .launcher .screens { grid-template-columns: 1fr; }
}
`;
