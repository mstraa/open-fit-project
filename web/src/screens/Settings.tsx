// Settings screen — faithful port of docs/designs/settings.html.
//
// REAL backend data:
//   • Sources & fusion: listSources() + GET/PUT default-scope preferences set the
//     persistent per-metric resolver (the core feature). Each scalar metric gets a
//     <select> of candidate sources; changing it PUTs a `default`-scope
//     MetricSourcePreference (with the retroactive flag).
//   • Appearance / theme: the real ThemeProvider toggle (Midnight=dark, Paper=light).
//     The design also shows a "Terminal" swatch — included as a selectable option
//     but disabled (visual-only) since no token set exists for it yet.
//   • Backend & about: getVersion() + live GET /health (via useHealth) + the API base.
//
// EMPTY / disabled (no backend yet → on-brand empty states, NO fake numbers):
//   Devices, Algorithm plugins, Data & storage, Privacy toggles, accent/units/week.
//
// STRICT: this file only. Reuses AppShell, EmptyState, Seg, the typed endpoints
// (read-only) and the ThemeProvider. Design CSS classes + tokens only.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppShell } from "../app/AppShell";
import { Link } from "react-router-dom";
import { EmptyState } from "../ui/EmptyState";
import { useHealth } from "../hooks/useHealth";
import { useTheme, type Theme } from "../theme/ThemeProvider";
import { API_BASE } from "../api/client";
import { listSources, listPreferences, putPreference, getVersion } from "../api/endpoints";
import { GadgetbridgeImportCard, ZeppImportCard } from "../ui/ImportCards";
import { GadgetbridgeAutoImportCard } from "../gadgetbridge/GadgetbridgeAutoImportCard";
import { CHART_METRICS, metricLabel } from "../ui/format";
import type {
  MetricSourcePreference,
  Source,
  StreamKind,
  VersionInfo,
} from "../api/types";

/* ------------------------------------------------------------- helpers */

/** Map a source to the design's .src--garmin/stryd/helio dot color variant. */
function srcVariant(s: Source): string {
  const hay = `${s.manufacturer ?? ""} ${s.name}`.toLowerCase();
  if (hay.includes("stryd")) return "src--stryd";
  if (hay.includes("helio") || hay.includes("amazfit") || hay.includes("zepp"))
    return "src--helio";
  if (hay.includes("garmin") || hay.includes("forerunner")) return "src--garmin";
  return "";
}

/** Token color for a metric's swatch dot (matches CHART_METRICS / per-metric tokens). */
const METRIC_DOT: Partial<Record<StreamKind, string>> = {
  heart_rate: "var(--hr)",
  power: "var(--power)",
  cadence: "var(--cadence)",
  speed: "var(--pace)",
  altitude: "var(--elev)",
};

/* ----------------------------------------------------------- subnav data */

interface SubLink {
  id: string;
  label: string;
  icon: ReactNode;
}

const SUBNAV: SubLink[] = [
  {
    id: "sources",
    label: "Sources & fusion",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
        <path d="M12 8a4 4 0 100 8 4 4 0 000-8z" />
        <path d="M12 3v3m0 12v3M3 12h3m12 0h3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "devices",
    label: "Devices",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
        <rect x="7" y="2" width="10" height="20" rx="3" />
        <path d="M11 18h2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "imports",
    label: "Imports & sync",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
        <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: "algos",
    label: "Algorithms",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
        <path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "data",
    label: "Data & storage",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
        <ellipse cx="12" cy="6" rx="8" ry="3" />
        <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      </svg>
    ),
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v3m0 14v3M2 12h3m14 0h3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "backend",
    label: "Backend & about",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
        <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" strokeLinejoin="round" />
      </svg>
    ),
  },
];

/* ---------------------------------------------------------------- screen */

export function Settings() {
  const [sources, setSources] = useState<Source[]>([]);
  const [prefs, setPrefs] = useState<MetricSourcePreference[]>([]);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<string>(SUBNAV[0].id);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1800);
  };

  // Load real data once.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.allSettled([listSources(), listPreferences(), getVersion()]).then(
      ([s, p, v]) => {
        if (cancelled) return;
        if (s.status === "fulfilled") setSources(s.value);
        if (p.status === "fulfilled") setPrefs(p.value);
        if (v.status === "fulfilled") setVersion(v.value);
        const firstErr =
          s.status === "rejected"
            ? s.reason
            : p.status === "rejected"
              ? p.reason
              : null;
        if (firstErr)
          setLoadError(firstErr instanceof Error ? firstErr.message : String(firstErr));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  // Scroll-spy across panels (ported from settings.html, as effect).
  useEffect(() => {
    const onScroll = () => {
      let cur = SUBNAV[0].id;
      const pos = window.scrollY + 120;
      for (const link of SUBNAV) {
        const el = document.getElementById(link.id);
        if (el && el.offsetTop <= pos) cur = link.id;
      }
      setActive(cur);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) {
      window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 84, behavior: "smooth" });
      setActive(id);
    }
  };

  // Default-scope preference per metric.
  const defaultPrefByMetric = useMemo(() => {
    const m = new Map<StreamKind, MetricSourcePreference>();
    for (const p of prefs) if (p.scope === "default") m.set(p.metric, p);
    return m;
  }, [prefs]);

  const [retroactive, setRetroactive] = useState(false);
  const [savingMetric, setSavingMetric] = useState<StreamKind | null>(null);

  const setDefaultSource = async (metric: StreamKind, sourceId: string) => {
      const next: MetricSourcePreference = {
        ...defaultPrefByMetric.get(metric),
        metric,
        scope: "default",
        activity_id: null,
        source_id: sourceId,
        retroactive,
      };
      setSavingMetric(metric);
      try {
        const saved = await putPreference(next);
        setPrefs((cur) => {
          const rest = cur.filter((p) => !(p.scope === "default" && p.metric === metric));
          return [...rest, saved];
        });
        showToast("Saved locally · default source updated");
      } catch (e) {
        showToast(`Save failed · ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSavingMetric(null);
      }
  };

  const hasSources = sources.length > 0;

  return (
    <AppShell
      title="Settings"
      crumb="Single-user · everything stored on this machine"
      actions={
        <button type="button" className="btn" onClick={() => showToast("Settings saved locally")}>
          Save changes
        </button>
      }
    >
      <div className="settings">
        {/* subnav */}
        <nav className="subnav" aria-label="Settings sections">
          {SUBNAV.map((l) => (
            <a
              key={l.id}
              href={`#${l.id}`}
              className={active === l.id ? "is-active" : undefined}
              aria-current={active === l.id ? "true" : undefined}
              onClick={(e) => {
                e.preventDefault();
                scrollTo(l.id);
              }}
            >
              {l.icon}
              {l.label}
            </a>
          ))}
        </nav>

        {/* panels */}
        <div>
          {/* SOURCES & FUSION — REAL */}
          <section className="panel card" id="sources">
            <div className="card__head">
              <div className="card__title">
                Default source priority<span className="sub">per-metric fusion</span>
              </div>
            </div>
            <p className="faint" style={{ fontSize: 12.5, margin: "-6px 0 16px", lineHeight: 1.55 }}>
              When several devices record the same metric, Open Fit keeps every raw
              stream and picks your chosen default source. Set the default per metric
              below. Per-activity overrides live on each activity page.
            </p>

            {loading ? (
              <EmptyState label="Loading sources…" compact />
            ) : !hasSources ? (
              <EmptyState
                label="No sources yet"
                phase="Phase 1"
                hint={
                  loadError
                    ? `Could not reach the backend: ${loadError}`
                    : "Import a .FIT file or pair a device to register data sources."
                }
              />
            ) : (
              <>
                <div className="prio-grid">
                  {CHART_METRICS.map((m) => {
                    const pref = defaultPrefByMetric.get(m.kind);
                    const selected = pref?.source_id ?? "";
                    return (
                      <div key={m.kind}>
                        <div
                          className="faint"
                          style={{
                            fontSize: 11,
                            textTransform: "uppercase",
                            letterSpacing: ".06em",
                            marginBottom: 8,
                            display: "flex",
                            alignItems: "center",
                            gap: 7,
                          }}
                        >
                          <i
                            style={{
                              width: 9,
                              height: 9,
                              borderRadius: 3,
                              background: METRIC_DOT[m.kind] ?? "var(--accent)",
                              display: "inline-block",
                            }}
                          />
                          {metricLabel(m.kind)}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <select
                            className="inp"
                            style={{ flex: 1 }}
                            value={selected}
                            disabled={savingMetric === m.kind}
                            aria-label={`Default source for ${metricLabel(m.kind)}`}
                            onChange={(e) => setDefaultSource(m.kind, e.target.value)}
                          >
                            <option value="">Auto (priority order)</option>
                            {sources.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </select>
                          {selected ? (
                            (() => {
                              const s = sources.find((x) => x.id === selected);
                              return s ? (
                                <span className={`src ${srcVariant(s)}`.trim()}>
                                  <span className="src__dot" />
                                  {s.name}
                                </span>
                              ) : null;
                            })()
                          ) : (
                            <span className="tag">auto</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="row" style={{ marginTop: 8 }}>
                  <div className="row__b">
                    <b>Apply changes retroactively</b>
                    <span>Re-resolve stored activities when the default source changes</span>
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={retroactive}
                      onChange={(e) => setRetroactive(e.target.checked)}
                    />
                    <span className="sl" />
                  </label>
                </div>
              </>
            )}
            {loadError && hasSources ? (
              <div className="banner" style={{ marginTop: 14 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                  <path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" strokeLinejoin="round" />
                </svg>
                <span className="muted">Some settings could not load: {loadError}</span>
              </div>
            ) : null}
          </section>

          {/* DEVICES — link to the BLE scanner + Gadgetbridge import */}
          <section className="panel card" id="devices">
            <div className="card__head">
              <div className="card__title">Devices</div>
            </div>
            <p className="muted" style={{ fontSize: 12.5, margin: "0 0 14px" }}>
              Connect a sensor live over Bluetooth, or import from Gadgetbridge — both stream
              into your wellness data. Registered import sources appear under Sources &amp; fusion
              above.
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Link to="/devices" className="btn">
                Scan for BLE devices →
              </Link>
              <a href="#imports" className="btn btn--ghost">
                Imports &amp; sync →
              </a>
            </div>
          </section>

          {/* IMPORTS & SYNC — Gadgetbridge auto-import + manual GB/Zepp imports */}
          <section className="panel card" id="imports">
            <div className="card__head">
              <div className="card__title">
                Imports &amp; sync<span className="sub">wellness · workouts · cloudless</span>
              </div>
            </div>
            <GadgetbridgeAutoImportCard />
            <GadgetbridgeImportCard />
            <ZeppImportCard />
          </section>

          {/* ALGORITHMS — EMPTY (no plugin backend yet) */}
          <section className="panel card" id="algos">
            <div className="card__head">
              <div className="card__title">
                Algorithm plugins<span className="sub">sandboxed WASM</span>
              </div>
            </div>
            <EmptyState
              label="No data yet"
              phase="Phase 4"
              hint="Recovery, training load, sleep staging and anomaly-scan plugins (sandboxed WASM) will be managed here."
            />
            <div className="banner" style={{ marginTop: 14 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                <path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" strokeLinejoin="round" />
              </svg>
              <span className="muted">
                Community plugins run sandboxed — no network, capped CPU/memory. Only
                signed, verified-author plugins enable retroactive recompute by default.
              </span>
            </div>
          </section>

          {/* DATA & STORAGE — EMPTY (no storage stats backend yet) */}
          <section className="panel card" id="data">
            <div className="card__head">
              <div className="card__title">Data &amp; storage</div>
            </div>
            <EmptyState
              label="No data yet"
              phase="Phase 6"
              hint="Database size, retention windows, backfill import and full-archive export will surface here. Backend version and the live API endpoint are shown under Backend & about."
            />
          </section>

          {/* APPEARANCE — REAL theme toggle */}
          <section className="panel card" id="appearance">
            <div className="card__head">
              <div className="card__title">
                Appearance<span className="sub">themable via design tokens</span>
              </div>
            </div>
            <ThemePicker onPick={(label) => showToast(`Theme · ${label}`)} />
            <div className="row">
              <div className="row__b">
                <b>Accent color</b>
                <span>Used for highlights, charts &amp; primary actions</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <span
                  title="Electric blue (active)"
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 8,
                    background: "var(--accent)",
                    boxShadow: "0 0 0 2px var(--accent),0 0 0 4px var(--bg)",
                  }}
                />
                <span style={{ width: 26, height: 26, borderRadius: 8, background: "var(--power)", opacity: 0.5 }} />
                <span style={{ width: 26, height: 26, borderRadius: 8, background: "var(--elev)", opacity: 0.5 }} />
                <span style={{ width: 26, height: 26, borderRadius: 8, background: "var(--cal)", opacity: 0.5 }} />
              </div>
            </div>
            <div className="row">
              <div className="row__b">
                <b>Units</b>
                <span>Distance, pace &amp; elevation · no preference backend yet</span>
              </div>
              <div className="seg" aria-disabled>
                <button type="button" className="is-active" disabled>
                  Metric
                </button>
                <button type="button" disabled>
                  Imperial
                </button>
              </div>
            </div>
            <div className="row">
              <div className="row__b">
                <b>Week starts on</b>
                <span>No preference backend yet</span>
              </div>
              <select className="inp" disabled defaultValue="Monday">
                <option>Monday</option>
                <option>Sunday</option>
              </select>
            </div>
          </section>

          {/* BACKEND & ABOUT — REAL version + health + api base */}
          <section className="panel card" id="backend">
            <div className="card__head">
              <div className="card__title">Backend &amp; about</div>
              <div className="card__tools">
                <span className="pill pill--good">100% cloudless</span>
              </div>
            </div>
            <BackendRows version={version} loading={loading} />
            <div className="row">
              <div className="row__b">
                <b>Cloud connections</b>
                <span>Garmin Connect, Zepp &amp; Stryd PowerCenter are disabled by design</span>
              </div>
              <span className="pill pill--bad" style={{ opacity: 0.9 }}>
                Blocked
              </span>
            </div>
            <div className="row">
              <div className="row__b">
                <b>License</b>
                <span>AGPLv3 (server) · GPLv3 (mobile) — open source</span>
              </div>
              <a
                href="https://github.com/openfit"
                target="_blank"
                rel="noreferrer"
                className="tag"
              >
                View source
              </a>
            </div>
          </section>
        </div>
      </div>

      {/* toast */}
      <div
        role="status"
        aria-live="polite"
        style={{
          position: "fixed",
          bottom: 24,
          left: "50%",
          transform: `translateX(-50%) translateY(${toast ? 0 : 20}px)`,
          opacity: toast ? 1 : 0,
          pointerEvents: "none",
          background: "var(--surface-3)",
          border: "1px solid var(--border-2)",
          color: "var(--fg)",
          padding: "11px 18px",
          borderRadius: 11,
          fontSize: 13,
          boxShadow: "var(--shadow-pop)",
          transition: "all .25s",
          zIndex: 300,
          display: "flex",
          gap: 10,
          alignItems: "center",
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth={2.5} aria-hidden>
          <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{toast ?? "Settings saved locally"}</span>
      </div>

      {/* local layout styles for design-only selectors not in app.css */}
      <SettingsStyles />
    </AppShell>
  );
}

/* --------------------------------------------------------- theme picker */

interface ThemeCard {
  id: Theme | "terminal";
  label: string;
  swatch: [string, string, string];
  disabled?: boolean;
}

const THEME_CARDS: ThemeCard[] = [
  { id: "dark", label: "Midnight (default)", swatch: ["oklch(15% 0.018 260)", "oklch(22% 0.022 260)", "var(--accent)"] },
  { id: "light", label: "Paper", swatch: ["#f6f6f4", "#fff", "#2f6df0"] },
  {
    id: "terminal",
    label: "Terminal",
    swatch: ["oklch(13% 0.004 60)", "oklch(19% 0.005 60)", "oklch(70% 0.175 55)"],
    disabled: true,
  },
];

function ThemePicker({ onPick }: { onPick: (label: string) => void }) {
  const { theme, setTheme } = useTheme();
  return (
    <div className="theme-opt" style={{ marginBottom: 18 }}>
      {THEME_CARDS.map((c) => {
        const selected = !c.disabled && c.id === theme;
        return (
          <button
            key={c.id}
            type="button"
            className={`theme-card${selected ? " is-sel" : ""}`}
            aria-pressed={selected}
            disabled={c.disabled}
            title={c.disabled ? "Not implemented yet" : `Use ${c.label}`}
            style={c.disabled ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
            onClick={() => {
              if (c.disabled) return;
              setTheme(c.id as Theme);
              onPick(c.label);
            }}
          >
            <div className="sw">
              {c.swatch.map((bg, i) => (
                <i key={i} style={{ background: bg }} />
              ))}
            </div>
            <p>{c.label}</p>
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------- backend rows */

function BackendRows({ version, loading }: { version: VersionInfo | null; loading: boolean }) {
  const health = useHealth();
  const statusPill: { cls: string; text: string } =
    health.kind === "ok"
      ? { cls: "pill--good", text: `Online · ${health.status}` }
      : health.kind === "error"
        ? { cls: "pill--bad", text: "Offline" }
        : { cls: "", text: "Connecting…" };

  return (
    <>
      <div className="row">
        <div className="row__b">
          <b>Backend service</b>
          <span>ofit-api · the web app is a typed client of this server</span>
        </div>
        <span className={`pill ${statusPill.cls}`.trim()}>
          {health.kind === "ok" ? <span className="dot-live" /> : null}
          {statusPill.text}
        </span>
      </div>
      <div className="row">
        <div className="row__b">
          <b>API endpoint</b>
          <span>Resolved from VITE_API_BASE</span>
        </div>
        <span className="tag mono">{API_BASE || "(relative · proxied)"}</span>
      </div>
      <div className="row">
        <div className="row__b">
          <b>Version</b>
          <span>Server build reported by GET /api/version</span>
        </div>
        {loading ? (
          <span className="tag">loading…</span>
        ) : version ? (
          <span className="tag mono">
            {version.version}
            {version.commit ? ` · ${String(version.commit).slice(0, 7)}` : ""}
          </span>
        ) : (
          <span className="tag">unavailable</span>
        )}
      </div>
    </>
  );
}

/* ------------------------------------- design-only layout styles (scoped) */
// These selectors (.settings/.subnav/.panel/.row/.switch/.theme-card/.inp/.prio-grid)
// are inline-styled in the design's <style> block, not in app.css. Inline them here
// so the screen matches the export pixel-for-pixel without editing shared CSS.

function SettingsStyles() {
  return (
    <style>{`
.settings { display:grid; grid-template-columns:220px 1fr; gap:var(--gap); align-items:start; }
.subnav { position:sticky; top:90px; display:flex; flex-direction:column; gap:2px; }
.subnav a { display:flex; align-items:center; gap:10px; padding:9px 12px; border-radius:var(--r-sm); font-size:13.5px; font-weight:550; color:var(--muted); transition:.14s; cursor:pointer; }
.subnav a svg { width:16px; height:16px; opacity:.8; }
.subnav a:hover { background:var(--surface-2); color:var(--fg); }
.subnav a.is-active { background:var(--accent-ghost); color:var(--fg); }
.subnav a.is-active svg { color:var(--accent); }
.panel { scroll-margin-top:90px; }
.panel + .panel { margin-top:var(--gap); }
.prio-grid { display:grid; grid-template-columns:1fr 1fr; gap:24px 24px; margin-bottom:8px; }
.row { display:flex; align-items:center; gap:16px; padding:15px 0; border-bottom:1px solid var(--border); }
.row:last-child { border-bottom:0; }
.row__b { flex:1; min-width:0; }
.row__b b { font-size:14px; font-weight:600; display:block; }
.row__b span { font-size:12.5px; color:var(--faint); }
.switch { position:relative; width:44px; height:25px; flex:none; display:inline-block; }
.switch input { opacity:0; width:0; height:0; }
.switch .sl { position:absolute; inset:0; background:var(--surface-3); border:1px solid var(--border); border-radius:99px; transition:.2s; cursor:pointer; }
.switch .sl::before { content:""; position:absolute; width:19px; height:19px; left:2px; top:2px; border-radius:50%; background:var(--muted); transition:.2s; }
.switch input:checked + .sl { background:var(--accent); border-color:var(--accent); }
.switch input:checked + .sl::before { transform:translateX(19px); background:#04121f; }
.switch input:focus-visible + .sl { outline:2px solid var(--accent); outline-offset:2px; }
select.inp, input.inp { background:var(--surface-2); border:1px solid var(--border); color:var(--fg); border-radius:9px; padding:8px 12px; font-family:inherit; font-size:13px; }
select.inp:focus { outline:none; border-color:var(--accent); }
select.inp:disabled { opacity:.5; cursor:not-allowed; }
.theme-opt { display:flex; gap:12px; }
.theme-card { flex:1; border:1px solid var(--border); border-radius:12px; overflow:hidden; cursor:pointer; transition:.14s; background:transparent; padding:0; text-align:inherit; color:inherit; font:inherit; }
.theme-card.is-sel { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-ghost); }
.theme-card .sw { height:54px; display:flex; }
.theme-card .sw i { flex:1; }
.theme-card p { font-size:12px; font-weight:600; padding:8px 10px; text-align:center; }
@media (max-width:920px){ .settings{grid-template-columns:1fr;} .subnav{position:static;flex-direction:row;overflow-x:auto;} .prio-grid{grid-template-columns:1fr;} }
`}</style>
  );
}
