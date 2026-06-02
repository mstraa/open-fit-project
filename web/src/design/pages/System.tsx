/* ============================================================
   OpenFit — Settings page (one screen, sectioned sidebar).
   Ported from the design bundle's js/system.jsx into typed TSX.
   --------------------------------------------------------------
   This screen WIRES REAL BACKEND (it is not a mock page):
     • Sources : listSources() + listPreferences()/putPreference()
                 drive the persistent per-metric default-source resolver.
     • Devices : DevicesManager — backend device-sources (with a per-source
                 last-sync from listSources()) merged with live BLE devices
                 (useBle()/useNativeBle()), grouped Connected vs Historical,
                 + scan/sync, Helio auth key, offline-buffer card.
     • Imports : importZepp(file) + importGarmin(zip/path) background job.
     • Goals   : getStepsGoal()/setStepsGoal() + Max HR.
     • About   : getVersion() + useHealth() live pill.
   ============================================================ */
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
import { Card, SectionLabel, Icon, DetailHeader, SegTabs, useGear } from "../ui";
import { tint } from "../util";
import {
  listSources,
  listPreferences,
  putPreference,
  getVersion,
  importZepp,
  importGarmin,
  importGarminZip,
  getGarminImportStatus,
  getPersonalRecords,
  getSettings,
  setSetting,
  clampHr,
  listAlgorithms,
  getParameters,
  setParameters,
  getVariants,
  setSelection,
} from "../../api/endpoints";
import type {
  PersonalRecord,
  GarminJobState,
  AnalyticsParameter,
  DerivationVariant,
} from "../../api/endpoints";
import type { AlgorithmDto } from "../../api/schema";
import type {
  MetricSourcePreference,
  Source,
  StreamKind,
  VersionInfo,
} from "../../api/types";
import { useBle } from "../../ble/BleProvider";
import { useNativeBle } from "../../ble/native/NativeBleProvider";
import { OpenFitBle } from "../../ble/native/OpenFitBle";
import { useHealth } from "../../hooks/useHealth";
import { getStepsGoal, setStepsGoal, getPref, setPref } from "../../prefs";

/* ---------- controls (ported from the design) ---------- */
function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button className={"toggle" + (on ? " on" : "")} onClick={() => onChange(!on)} />;
}
function OfSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <select className="of-select" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
function Field({ label, dot, children }: { label: ReactNode; dot?: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">
        {dot && <i style={{ background: dot }} />}
        {label}
      </div>
      {children}
    </div>
  );
}
function Row({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="sr-main">
        <div className="sr-title">{title}</div>
        {sub && <div className="sr-sub">{sub}</div>}
      </div>
      <div style={{ flex: "none" }}>{right}</div>
    </div>
  );
}
function Empty({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="empty-state">
      <div className="empty-ic">
        <Icon name="dot" size={20} stroke={2.5} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{title}</div>
      <div
        style={{
          fontSize: 12.5,
          color: "var(--text-faint)",
          lineHeight: 1.5,
          maxWidth: 280,
          margin: "0 auto",
        }}
      >
        {desc}
      </div>
    </div>
  );
}
function Btn({
  children,
  primary,
  onClick,
  color,
  disabled,
}: {
  children: ReactNode;
  primary?: boolean;
  onClick?: () => void;
  color?: string;
  disabled?: boolean;
}) {
  return (
    <button
      className={"btn " + (primary ? "btn-primary" : "btn-ghost")}
      style={color ? { background: color, color: "#fff" } : undefined}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function GearBar({ used, max, color = "var(--good)" }: { used: number; max: number; color?: string }) {
  const pct = Math.min(100, (used / max) * 100);
  const c = pct > 90 ? "var(--low)" : pct > 75 ? "var(--ok)" : color;
  return (
    <div style={{ height: 8, borderRadius: 4, background: "var(--track)", overflow: "hidden" }}>
      <div style={{ width: pct + "%", height: "100%", background: c }} />
    </div>
  );
}

/* ---------- Gear manager (MOCK store via useGear) ---------- */
function GearManager() {
  const gear = useGear();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<{ name: string; type: string; initialKm: string; max: string }>({
    name: "",
    type: "Running",
    initialKm: "0",
    max: "1000",
  });
  const types = ["Running", "Cycling", "Walking", "Hiking"];
  const save = () => {
    if (!form.name.trim()) return;
    gear.addGear(form);
    setForm({ name: "", type: "Running", initialKm: "0", max: "1000" });
    setAdding(false);
  };
  return (
    <>
      <Card
        title="Gear"
        sub="track mileage"
        action={
          <button className="pill" style={{ color: "var(--blue)" }} onClick={() => setAdding((a) => !a)}>
            <Icon name={adding ? "x" : "plus"} size={13} />
            {adding ? "Cancel" : "Add gear"}
          </button>
        }
      >
        <p style={{ margin: "0 0 14px", fontSize: 13, lineHeight: 1.5, color: "var(--text-dim)" }}>
          Track how far each pair of shoes or bike has run. Mileage adds up automatically from
          activities; set a retirement distance to get a wear warning.
        </p>
        {adding && (
          <div
            style={{
              background: "var(--bg-elev-2)",
              borderRadius: 14,
              padding: 14,
              marginBottom: 14,
              display: "flex",
              flexDirection: "column",
              gap: 11,
            }}
          >
            <Field label="Name">
              <input
                className="of-input"
                placeholder="e.g. Pegasus 41"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Activity type">
              <OfSelect value={form.type} onChange={(v) => setForm({ ...form, type: v })} options={types} />
            </Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 11 }}>
              <Field label="Initial mileage (km)">
                <input
                  className="of-input"
                  style={{ fontFamily: "var(--font-mono)" }}
                  value={form.initialKm}
                  onChange={(e) => setForm({ ...form, initialKm: e.target.value.replace(/[^\d.]/g, "") })}
                />
              </Field>
              <Field label="Retire at (km)">
                <input
                  className="of-input"
                  style={{ fontFamily: "var(--font-mono)" }}
                  value={form.max}
                  onChange={(e) => setForm({ ...form, max: e.target.value.replace(/[^\d.]/g, "") })}
                />
              </Field>
            </div>
            <Btn primary onClick={save}>
              <Icon name="plus" size={16} />
              Add gear
            </Btn>
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {gear.gears.map((g) => (
            <div
              key={g.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 14,
                padding: "12px 0",
                borderTop: "1px solid var(--line)",
              }}
            >
              <span
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: 12,
                  background: "var(--bg-elev-2)",
                  display: "grid",
                  placeItems: "center",
                  flex: "none",
                }}
              >
                <Icon name={g.icon} size={24} color="var(--text-dim)" />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 14.5 }}>{g.name}</span>
                  {gear.defaults[g.type] === g.id && (
                    <span className="pill" style={{ color: "var(--blue)", fontSize: 10 }}>
                      default · {g.type}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "3px 0 7px" }}>{g.desc}</div>
                <GearBar used={g.used} max={g.max} />
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11.5,
                    color: "var(--text-dim)",
                    marginTop: 6,
                  }}
                >
                  {g.used.toFixed(0)} / {(+g.max).toLocaleString("fr")} km
                </div>
              </div>
              <button
                className="icon-btn"
                style={{ flex: "none", color: "var(--low)" }}
                onClick={() => gear.removeGear(g.id)}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Default gear" sub="per activity type">
        <p style={{ margin: "0 0 12px", fontSize: 13, lineHeight: 1.5, color: "var(--text-dim)" }}>
          New activities of each type are assigned this gear automatically.
        </p>
        {types.map((t) => {
          const opts = gear.gears.filter((g) => g.type === t);
          return (
            <Field key={t} label={t}>
              <select
                className="of-select"
                value={gear.defaults[t] || ""}
                onChange={(e) => gear.setDefault(t, e.target.value)}
              >
                <option value="">None</option>
                {opts.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </Field>
          );
        })}
      </Card>
    </>
  );
}

/* ---------- per-metric default-source rows ---------- */
const AUTO = "Auto (priority)";
/** Design's METRIC_DOTS, mapped to the REAL StreamKind they resolve. */
const METRIC_DOTS: { label: string; color: string; kind: StreamKind }[] = [
  { label: "Heart rate", color: "var(--rhr)", kind: "heart_rate" },
  { label: "Power", color: "var(--activity)", kind: "power" },
  { label: "Speed", color: "var(--run)", kind: "speed" },
  { label: "Cadence", color: "var(--strength)", kind: "cadence" },
  { label: "Altitude", color: "var(--walk)", kind: "altitude" },
];

/* ---------- Plugins / computed-values manager (REAL backend) ----------
   Every algorithm constant is a tunable parameter; a "derivation" = plugin +
   code version + parameter set. Editing a parameter forks a new comparable
   variant (full recompute) that becomes active; the Versions card switches the
   active variant back/forth without recomputing. */
const GROUP_LABELS: Record<string, string> = {
  athlete: "Athlete profile",
  training_load: "Training load",
  training_effect: "Training effect",
  readiness: "Readiness & HRV",
  sleep: "Sleep score",
  anomaly: "Resting-HR anomaly",
  body_battery: "Body battery",
  resting_hr: "Resting HR",
  hr_sleep: "HR-derived sleep",
};
const PLUGIN_LABELS: Record<string, string> = {
  training_load: "Training Load (TSS · CTL/ATL/TSB)",
  training_effect: "Training Effect",
  readiness: "HRV & Readiness",
  sleep: "Sleep Summary & Score",
  anomaly: "Resting-HR Anomaly",
};

function fmtNum(n: number): string {
  // Compact: drop trailing zeros; keep small decimals readable.
  return Number.isInteger(n) ? String(n) : String(+n.toFixed(6));
}

/** Short summary of how a variant's parameters differ from the factory defaults. */
function variantSummary(v: DerivationVariant, defaults: Map<string, AnalyticsParameter>): string {
  const diffs: string[] = [];
  for (const [key, val] of Object.entries(v.params)) {
    const def = defaults.get(key);
    if (def && Math.abs(val - def.default) > 1e-9) {
      diffs.push(`${def.label} ${fmtNum(val)}`);
    }
  }
  return diffs.length ? diffs.join(" · ") : "factory defaults";
}

function PluginsManager() {
  const [algos, setAlgos] = useState<AlgorithmDto[]>([]);
  const [params, setParams] = useState<AnalyticsParameter[]>([]);
  const [variants, setVariants] = useState<DerivationVariant[]>([]);
  const [pending, setPending] = useState<Record<string, string>>({});
  const [tier, setTier] = useState<"Curated" | "All">("Curated");
  const [busy, setBusy] = useState<"idle" | "recomputing" | "switching">("idle");
  const [status, setStatus] = useState<string>("");

  const reload = useCallback(async () => {
    const [a, p, v] = await Promise.allSettled([listAlgorithms(), getParameters(), getVariants()]);
    if (a.status === "fulfilled") setAlgos(a.value);
    if (p.status === "fulfilled") setParams(p.value);
    if (v.status === "fulfilled") setVariants(v.value);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const defaultsByKey = new Map(params.map((p) => [p.key, p]));
  const shown = params.filter((p) => tier === "All" || p.tier === "curated");
  const groups: string[] = [];
  for (const p of shown) if (!groups.includes(p.group)) groups.push(p.group);

  const edits = Object.entries(pending).filter(([key, raw]) => {
    const p = defaultsByKey.get(key);
    const n = Number(raw);
    return p && raw.trim() !== "" && Number.isFinite(n) && Math.abs(n - p.value) > 1e-9;
  });

  const apply = async () => {
    if (!edits.length) return;
    setBusy("recomputing");
    setStatus("Recomputing all history with the new parameters…");
    try {
      const res = await setParameters(edits.map(([key, raw]) => ({ key, value: Number(raw) })));
      setPending({});
      await reload();
      setStatus(
        `Applied ${res.applied.length} change${res.applied.length === 1 ? "" : "s"} · recomputed ${res.recompute.total_metrics} metrics. New variant is now active.`,
      );
    } catch {
      setStatus("Recompute failed — is the backend running?");
    } finally {
      setBusy("idle");
    }
  };

  const resetAll = async () => {
    setBusy("recomputing");
    setStatus("Resetting every parameter to its default…");
    try {
      await setParameters([], true);
      setPending({});
      await reload();
      setStatus("All parameters reset to defaults · recomputed.");
    } catch {
      setStatus("Reset failed — is the backend running?");
    } finally {
      setBusy("idle");
    }
  };

  const pickVariant = async (plugin: string, version: string, params_hash: string) => {
    setBusy("switching");
    try {
      await setSelection({ scope: "default", plugin_id: plugin, version, params_hash });
      await reload();
      setStatus(`Active version for ${PLUGIN_LABELS[plugin] ?? plugin} switched.`);
    } catch {
      setStatus("Could not switch version.");
    } finally {
      setBusy("idle");
    }
  };

  // variants grouped by plugin (only plugins that actually have a catalogued variant)
  const byPlugin = new Map<string, DerivationVariant[]>();
  for (const v of variants) {
    const arr = byPlugin.get(v.plugin_id) ?? [];
    arr.push(v);
    byPlugin.set(v.plugin_id, arr);
  }

  return (
    <>
      {/* ---- registered algorithms ---- */}
      <Card title="Algorithms" sub="built-in + plugins">
        <p style={{ margin: "0 0 12px", fontSize: 13, lineHeight: 1.5, color: "var(--text-dim)" }}>
          Every computed value is produced by a versioned algorithm. Built-ins are compiled in;
          sandboxed WASM plugins can add more.
        </p>
        {algos.length === 0 && <Empty title="No data yet" desc="Algorithms appear once the backend is reachable." />}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {algos.map((a) => (
            <div key={a.id} style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{a.name}</span>
                <span className="pill" style={{ fontSize: 10, color: "var(--text-dim)" }}>v{a.version}</span>
                <span
                  className="pill"
                  style={{ fontSize: 10, color: a.kind === "wasm" ? "var(--strength)" : "var(--good)" }}
                >
                  {a.kind === "wasm" ? "wasm" : "built-in"}
                </span>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-faint)", margin: "4px 0 6px", lineHeight: 1.45 }}>
                {a.description}
              </div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {a.outputs.map((o) => (
                  <span
                    key={o}
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10.5,
                      padding: "2px 7px",
                      borderRadius: 6,
                      background: "var(--bg-elev-2)",
                      color: "var(--text-dim)",
                    }}
                  >
                    {o}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* ---- parameters editor ---- */}
      <Card
        title="Parameters"
        sub="every constant is a setting"
        action={
          <SegTabs small options={["Curated", "All"] as const} value={tier} onChange={setTier} />
        }
      >
        <p style={{ margin: "0 0 6px", fontSize: 13, lineHeight: 1.5, color: "var(--text-dim)" }}>
          Tune any algorithm constant. Applying changes runs a full recompute and forks a new,
          comparable <b style={{ color: "var(--text)" }}>version</b> of every affected metric — the
          old one is kept so you can switch back or diff (Versions, below).
        </p>
        {params.length === 0 && (
          <Empty title="No data yet" desc="Parameters load once the backend is reachable." />
        )}
        {groups.map((g) => (
          <div key={g} style={{ marginTop: 14 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: 0.4,
                textTransform: "uppercase",
                color: "var(--text-faint)",
                marginBottom: 4,
              }}
            >
              {GROUP_LABELS[g] ?? g}
            </div>
            {shown
              .filter((p) => p.group === g)
              .map((p) => {
                const raw = pending[p.key] ?? fmtNum(p.value);
                const modified = Math.abs(p.value - p.default) > 1e-9;
                const dirty = edits.some(([k]) => k === p.key);
                return (
                  <Row
                    key={p.key}
                    title={
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        {p.label}
                        {(modified || dirty) && (
                          <i
                            title={dirty ? "unsaved" : "non-default"}
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: 6,
                              background: dirty ? "var(--ok)" : "var(--blue)",
                            }}
                          />
                        )}
                      </span>
                    }
                    sub={
                      <>
                        {p.description}
                        {"  "}
                        <span style={{ color: "var(--text-faint)" }}>
                          (default {fmtNum(p.default)}
                          {p.min != null || p.max != null
                            ? `, ${p.min ?? "−∞"}–${p.max ?? "∞"}`
                            : ""}
                          )
                        </span>
                      </>
                    }
                    right={
                      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                        <input
                          className="of-input"
                          inputMode="decimal"
                          style={{ width: 86, textAlign: "right", fontFamily: "var(--font-mono)" }}
                          value={raw}
                          disabled={busy !== "idle"}
                          onChange={(e) =>
                            setPending((cur) => ({
                              ...cur,
                              [p.key]: e.target.value.replace(/[^\d.\-]/g, ""),
                            }))
                          }
                        />
                        {p.unit && (
                          <span style={{ fontSize: 11.5, color: "var(--text-faint)", width: 30 }}>
                            {p.unit}
                          </span>
                        )}
                      </div>
                    }
                  />
                );
              })}
          </div>
        ))}
        {params.length > 0 && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 16, flexWrap: "wrap" }}>
            <Btn primary disabled={!edits.length || busy !== "idle"} onClick={() => void apply()}>
              {busy === "recomputing" ? (
                <>
                  <Icon name="refresh" size={15} />
                  Recomputing…
                </>
              ) : (
                <>Apply {edits.length || ""} change{edits.length === 1 ? "" : "s"} &amp; recompute</>
              )}
            </Btn>
            <Btn disabled={busy !== "idle"} onClick={() => void resetAll()}>
              Reset all to defaults
            </Btn>
            {status && (
              <span style={{ fontSize: 12, color: "var(--text-dim)", flex: 1, minWidth: 160 }}>{status}</span>
            )}
          </div>
        )}
      </Card>

      {/* ---- versions / variant switcher ---- */}
      <Card title="Versions" sub="switch the active variant">
        <p style={{ margin: "0 0 12px", fontSize: 13, lineHeight: 1.5, color: "var(--text-dim)" }}>
          Each parameter change you apply is kept as a switchable version. Pick which one each
          metric resolves to on your dashboards — switching is instant (no recompute).
        </p>
        {byPlugin.size === 0 && (
          <Empty title="One version so far" desc="Change a parameter above to create a second, comparable version here." />
        )}
        {[...byPlugin.entries()].map(([plugin, vs]) => (
          <div key={plugin} style={{ borderTop: "1px solid var(--line)", padding: "12px 0" }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
              {PLUGIN_LABELS[plugin] ?? plugin}
              <span style={{ fontSize: 11.5, color: "var(--text-faint)", fontWeight: 500 }}>
                {"  "}· {vs.length} version{vs.length === 1 ? "" : "s"}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {vs.map((v) => (
                <button
                  key={v.params_hash}
                  disabled={busy !== "idle"}
                  onClick={() => void pickVariant(plugin, v.version, v.params_hash)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    textAlign: "left",
                    padding: "9px 11px",
                    borderRadius: 11,
                    cursor: busy === "idle" ? "pointer" : "default",
                    border: `1px solid ${v.active_default ? "var(--blue)" : "var(--line)"}`,
                    background: v.active_default ? tint("var(--blue)", 10) : "var(--bg-elev-2)",
                  }}
                >
                  <i
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: 9,
                      flex: "none",
                      background: v.active_default ? "var(--blue)" : "var(--track)",
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: "var(--text)" }}>{variantSummary(v, defaultsByKey)}</div>
                    <div style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>
                      v{v.version} · {v.params_hash.slice(0, 8)} · {v.last_computed_at.slice(0, 10)}
                    </div>
                  </div>
                  {v.active_default && (
                    <span className="pill" style={{ color: "var(--blue)", fontSize: 10 }}>
                      active
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </Card>

      <div className="note-card">
        <Icon name="dot" size={18} color="var(--blue)" stroke={2.5} style={{ flex: "none", marginTop: 1 }} />
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: "var(--text-dim)" }}>
          A derivation's identity is <b style={{ color: "var(--text)" }}>plugin + code version + parameter set</b>.
          Changing any tunable forks a new version rather than overwriting, so every result stays
          reproducible and comparable. Per-activity version overrides live on each activity's Verify tab.
        </p>
      </div>
    </>
  );
}

/* ====================== SETTINGS ====================== */
export function Settings() {
  const sections = ["Sources", "Devices", "Imports", "Gear", "Plugins", "Goals", "Appearance", "About"] as const;
  type Section = (typeof sections)[number];
  const [section, setSection] = useState<Section>("Sources");

  /* ---- real backend: sources + per-metric default prefs ---- */
  const [sources, setSources] = useState<Source[]>([]);
  const [prefs, setPrefs] = useState<MetricSourcePreference[]>([]);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [retro, setRetro] = useState(false);
  const [savingMetric, setSavingMetric] = useState<StreamKind | null>(null);

  const [maxHr, setMaxHr] = useState<number>(200);
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([listSources(), listPreferences(), getVersion(), getSettings()]).then(
      ([s, p, v, st]) => {
        if (cancelled) return;
        if (s.status === "fulfilled") setSources(s.value);
        if (p.status === "fulfilled") setPrefs(p.value);
        if (v.status === "fulfilled") setVersion(v.value);
        if (st.status === "fulfilled") {
          const m = Number(st.value["max_hr_allowed"]);
          if (Number.isFinite(m) && m > 0) setMaxHr(m);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /** Display name → source id (or "" for Auto). */
  const optionsFor = (): string[] => [AUTO, ...sources.map((s) => s.name)];
  const valueFor = (kind: StreamKind): string => {
    const pref = prefs.find((p) => p.scope === "default" && p.metric === kind);
    const src = pref ? sources.find((s) => s.id === pref.source_id) : undefined;
    return src ? src.name : AUTO;
  };
  const onPickSource = async (kind: StreamKind, name: string) => {
    const sourceId = name === AUTO ? "" : (sources.find((s) => s.name === name)?.id ?? "");
    const next: MetricSourcePreference = {
      ...prefs.find((p) => p.scope === "default" && p.metric === kind),
      metric: kind,
      scope: "default",
      activity_id: null,
      source_id: sourceId,
      retroactive: retro,
    };
    setSavingMetric(kind);
    try {
      const saved = await putPreference(next);
      setPrefs((cur) => [...cur.filter((p) => !(p.scope === "default" && p.metric === kind)), saved]);
    } finally {
      setSavingMetric(null);
    }
  };

  /* ---- goals ---- */
  const [stepGoal, setStepGoal] = useState<number>(() => getStepsGoal());

  /* ---- appearance (persisted via /api/settings; live accent recolor) ---- */
  const [theme, setThemeState] = useState(() => getPref("ui_theme", "Midnight"));
  const [accent, setAccent] = useState(() => getPref("ui_accent", "#38a4f5"));
  const [units, setUnitsState] = useState<"Metric" | "Imperial">(
    () => (getPref("ui_units", "Metric") as "Metric" | "Imperial"),
  );
  const [weekStart, setWeekStartState] = useState(() => getPref("ui_week_start", "Monday"));
  const setTheme = (name: string) => {
    setThemeState(name);
    setPref("ui_theme", name);
  };
  const setUnits = (u: "Metric" | "Imperial") => {
    setUnitsState(u);
    setPref("ui_units", u);
  };
  const setWeekStart = (d: string) => {
    setWeekStartState(d);
    setPref("ui_week_start", d);
  };
  const applyAccent = (c: string) => {
    setAccent(c);
    setPref("ui_accent", c);
    document.documentElement.style.setProperty("--blue", c);
  };
  // Apply the stored accent on mount so the persisted choice survives reload.
  useEffect(() => {
    document.documentElement.style.setProperty("--blue", getPref("ui_accent", "#38a4f5"));
  }, []);

  /* ---- about: live health pill ---- */
  const health = useHealth();
  const online = health.kind === "ok";

  return (
    <div className="detail">
      <DetailHeader
        title="Settings"
        sub="single-user · stored on device"
        accent="var(--blue)"
        right={
          <button className="pill" style={{ color: "var(--blue)" }}>
            Save
          </button>
        }
      />
      <div className="scroll">
        <div className="stack">
          <div className="subnav">
            {sections.map((s) => (
              <button
                key={s}
                className={"chip" + (section === s ? " on" : "")}
                onClick={() => setSection(s)}
              >
                {s}
              </button>
            ))}
          </div>

          {section === "Sources" && (
            <>
              <Card title="Default source priority" sub="per-metric fusion">
                <p style={{ margin: "0 0 16px", fontSize: 13, lineHeight: 1.5, color: "var(--text-dim)" }}>
                  When several devices record the same metric, OpenFit keeps every raw stream and picks
                  your default source. Per-activity overrides live on each activity page.
                </p>
                {METRIC_DOTS.map((m) => (
                  <Field key={m.kind} label={m.label} dot={m.color}>
                    <OfSelect
                      value={valueFor(m.kind)}
                      onChange={(v) => void onPickSource(m.kind, v)}
                      options={optionsFor()}
                    />
                  </Field>
                ))}
                {!sources.length && (
                  <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 4 }}>
                    No sources registered yet — import a .FIT file or pair a device.
                  </div>
                )}
              </Card>
              <Card>
                <Row
                  title="Apply changes retroactively"
                  sub="Re-resolve stored activities when the default source changes"
                  right={<Toggle on={retro} onChange={setRetro} />}
                />
                {savingMetric && (
                  <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 8 }}>Saving…</div>
                )}
              </Card>
            </>
          )}

          {section === "Devices" && <DevicesManager />}

          {section === "Imports" && (
            <>
              <SectionLabel>Imports & sync · cloudless</SectionLabel>
              <ManualImportCard
                title="Import from Zepp / Amazfit"
                sub="app export"
                desc={
                  <>
                    In Zepp → <b style={{ color: "var(--text)" }}>Profile → Settings → About → Export data</b>,
                    zip the folder and upload to ingest HR, sleep staging, steps, weight & workouts.
                  </>
                }
                buttonLabel="Choose Zepp export (.zip)"
                accept=".zip,application/zip"
                onFile={(f) =>
                  importZepp(f).then(
                    (r) => `Imported ${r.ingested} samples · ${r.activities_imported} activities`,
                  )
                }
              />
              <GarminImportCard />
              <PersonalRecordsCard />
            </>
          )}

          {section === "Plugins" && <PluginsManager />}

          {section === "Gear" && <GearManager />}

          {section === "Goals" && (
            <Card title="Goals" sub="used by the dashboard">
              <Row
                title="Daily step goal"
                sub="The Today ring on the dashboard fills toward this."
                right={
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <input
                      className="of-input"
                      style={{ width: 92, textAlign: "right", fontFamily: "var(--font-mono)" }}
                      value={stepGoal}
                      onChange={(e) => {
                        const v = Number(e.target.value.replace(/\D/g, ""));
                        setStepGoal(v);
                        if (v > 0) setStepsGoal(v);
                      }}
                    />
                    <span style={{ fontSize: 12, color: "var(--text-faint)" }}>steps</span>
                  </div>
                }
              />
              <Row
                title="Max HR allowed"
                sub="Heart-rate readings above this are rejected as device artifacts (and scrubbed from history when you change it)."
                right={
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <input
                      className="of-input"
                      style={{ width: 92, textAlign: "right", fontFamily: "var(--font-mono)" }}
                      value={maxHr}
                      onChange={(e) => {
                        const v = Number(e.target.value.replace(/\D/g, ""));
                        setMaxHr(v);
                        if (v > 0) {
                          void setSetting("max_hr_allowed", String(v)).then(() => clampHr());
                        }
                      }}
                    />
                    <span style={{ fontSize: 12, color: "var(--text-faint)" }}>bpm</span>
                  </div>
                }
              />
            </Card>
          )}

          {section === "Appearance" && (
            <Card title="Appearance" sub="themable via design tokens">
              <Field label="Theme">
                <div className="theme-grid">
                  {(
                    [
                      ["Midnight", ["#0b0e14", "#171c27", "#38a4f5"]],
                      ["Paper", ["#f4f4f2", "#fff", "#2f6df0"]],
                      ["Terminal", ["#0a0a0a", "#1a1a1a", "#c8722f"]],
                    ] as [string, string[]][]
                  ).map(([name, cols]) => (
                    <div
                      key={name}
                      className={"theme-card" + (theme === name ? " on" : "")}
                      onClick={() => setTheme(name)}
                    >
                      <div className="theme-prev">
                        {cols.map((c, i) => (
                          <span key={i} style={{ background: c }} />
                        ))}
                      </div>
                      <div className="theme-name">{name}</div>
                    </div>
                  ))}
                </div>
              </Field>
              <div className="divider" style={{ margin: "4px 0 16px" }} />
              <Field label="Accent color">
                <div className="swatch-row">
                  {["#38a4f5", "#7c6ff0", "#34a06a", "#c8722f"].map((c) => (
                    <button
                      key={c}
                      className={"swatch" + (accent === c ? " on" : "")}
                      style={{ background: c }}
                      onClick={() => applyAccent(c)}
                    />
                  ))}
                </div>
              </Field>
              <div className="divider" style={{ margin: "14px 0" }} />
              <Row
                title="Units"
                sub="Distance, pace & elevation"
                right={<SegTabs small options={["Metric", "Imperial"] as const} value={units} onChange={setUnits} />}
              />
              <Row
                title="Week starts on"
                right={
                  <select
                    className="of-select"
                    style={{ width: 130 }}
                    value={weekStart}
                    onChange={(e) => setWeekStart(e.target.value)}
                  >
                    <option>Monday</option>
                    <option>Sunday</option>
                  </select>
                }
              />
            </Card>
          )}

          {section === "About" && (
            <Card
              title="Backend & about"
              action={
                <span className="pill" style={{ color: "var(--good)" }}>
                  100% cloudless
                </span>
              }
            >
              <Row
                title="Backend service"
                sub="ofit-api · the web app is a typed client"
                right={
                  online ? (
                    <span className="pill live">
                      <i />
                      Online
                    </span>
                  ) : (
                    <span className="pill" style={{ color: "var(--low)" }}>
                      {health.kind === "error" ? "Offline" : "Connecting…"}
                    </span>
                  )
                }
              />
              <Row title="API endpoint" sub="Resolved from VITE_API_BASE" right={<span className="pill">relative</span>} />
              <Row
                title="Version"
                sub="Server build via GET /api/version"
                right={<span className="pill mono">{version ? version.version : "0.0.0"}</span>}
              />
              <Row
                title="Cloud connections"
                sub="Garmin, Zepp & Stryd disabled by design"
                right={
                  <span className="pill" style={{ color: "var(--low)" }}>
                    Blocked
                  </span>
                }
              />
              <Row
                title="License"
                sub="AGPLv3 (server) · GPLv3 (mobile)"
                right={
                  <span className="pill" style={{ color: "var(--blue)" }}>
                    View source
                  </span>
                }
              />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- manual import card (hidden <input type=file>) ---------- */
function ManualImportCard({
  title,
  sub,
  desc,
  buttonLabel,
  accept,
  onFile,
}: {
  title: string;
  sub: string;
  desc: ReactNode;
  buttonLabel: string;
  accept: string;
  onFile: (f: File) => Promise<string>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const pick = () => inputRef.current?.click();
  const onChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setBusy(true);
    setResult(null);
    try {
      const msg = await onFile(f);
      setResult({ ok: true, msg });
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={title} sub={sub}>
      <p style={{ margin: "0 0 14px", fontSize: 13, lineHeight: 1.5, color: "var(--text-dim)" }}>{desc}</p>
      <input ref={inputRef} type="file" accept={accept} style={{ display: "none" }} onChange={onChange} />
      <Btn primary onClick={pick} disabled={busy}>
        <Icon name="upload" size={16} />
        {busy ? "Importing…" : buttonLabel}
      </Btn>
      {result && (
        <div
          style={{
            marginTop: 12,
            fontSize: 12.5,
            color: result.ok ? "var(--good)" : "var(--low)",
          }}
        >
          {result.ok ? "✓ " : "✕ "}
          {result.msg}
        </div>
      )}
    </Card>
  );
}

/** One-time Garmin GDPR-export backfill. Runs as a background job (it takes
 *  minutes), so we START it then POLL status — no request to time out. Source is
 *  either an uploaded `.zip` or an export folder already on the server's disk. */
function GarminImportCard() {
  const DEFAULT_PATH = "imports/Garmin Full Export/1ca64efe-f834-4b7b-b65c-d398a1aa87e3_1";
  const [path, setPath] = useState(DEFAULT_PATH);
  const [job, setJob] = useState<GarminJobState | null>(null);
  const [starting, setStarting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);

  // Self-scheduling poll: refresh status, keep going while a job runs.
  const poll = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    const tick = async () => {
      try {
        const s = await getGarminImportStatus();
        setJob(s);
        pollRef.current = s.running ? window.setTimeout(tick, 2000) : null;
      } catch {
        pollRef.current = window.setTimeout(tick, 4000);
      }
    };
    void tick();
  }, []);

  // Resume an in-progress job if the user navigates back to this page.
  useEffect(() => {
    poll();
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [poll]);

  const startPath = async () => {
    setStarting(true);
    try {
      setJob(await importGarmin(path.trim()));
      poll();
    } catch (err) {
      setJob({ running: false, started: true, phase: "Error", result: null, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setStarting(false);
    }
  };

  const startZip = async (f: File) => {
    setStarting(true);
    try {
      setJob(await importGarminZip(f));
      poll();
    } catch (err) {
      setJob({ running: false, started: true, phase: "Error", result: null, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setStarting(false);
    }
  };

  const running = starting || job?.running;
  const r = !job?.running ? job?.result : null;

  return (
    <Card title="Import Garmin history" sub="one-time GDPR export backfill">
      <p style={{ margin: "0 0 12px", fontSize: 13, lineHeight: 1.5, color: "var(--text-dim)" }}>
        Request your archive at{" "}
        <b style={{ color: "var(--text)" }}>Garmin → Account → Export Your Data</b>. Upload the
        downloaded <code>.zip</code> below (or point at an export folder already on the server). It
        imports activities, daily wellness, sleep, body composition, VO₂max / training-load /
        race-prediction trends, gear &amp; personal records, then recomputes analytics once. Runs in
        the background — safe to leave this page. Re-importing the same export is idempotent (no
        duplicates).
      </p>

      <input
        ref={fileRef}
        type="file"
        accept=".zip,application/zip"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void startZip(f);
        }}
      />
      <Btn primary onClick={() => fileRef.current?.click()} disabled={!!running}>
        <Icon name="upload" size={16} />
        {running ? "Importing…" : "Upload Garmin export (.zip)"}
      </Btn>

      <input
        className="of-input"
        style={{ width: "100%", marginTop: 12, boxSizing: "border-box", fontFamily: "var(--font-mono)", fontSize: 12 }}
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder="…or a server-side export folder path"
      />
      <div style={{ marginTop: 8 }}>
        <Btn onClick={startPath} disabled={!!running || !path.trim()}>
          Run from path
        </Btn>
      </div>

      {running && (
        <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--blue)" }}>
          ⏳ {job?.phase || "Starting…"} — this can take a few minutes.
        </div>
      )}
      {!running && job?.error && (
        <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--low)" }}>✕ {job.error}</div>
      )}
      {!running && r && (
        <div style={{ marginTop: 12, fontSize: 12.5, color: "var(--good)" }}>
          ✓ {r.fit_activities_imported} activities · {r.wellness_ingested.toLocaleString()} wellness
          pts · {r.nights} sleep nights · {r.gear_imported} gear · {r.personal_records} PRs
          {r.fit_duplicates > 0 ? ` · ${r.fit_duplicates} already present` : ""}
        </div>
      )}
    </Card>
  );
}

/** Format a personal-record value by its (type-dependent) unit. */
function fmtPrValue(pr: PersonalRecord): string {
  if (pr.unit === "seconds") {
    const s = Math.round(pr.value);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${m}:${String(sec).padStart(2, "0")}`;
  }
  if (pr.unit === "meters") {
    return pr.value >= 1000 ? `${(pr.value / 1000).toFixed(2)} km` : `${Math.round(pr.value)} m`;
  }
  return Math.round(pr.value).toLocaleString();
}

/** Current personal records (imported from Garmin). */
function PersonalRecordsCard() {
  const [prs, setPrs] = useState<PersonalRecord[] | null>(null);
  useEffect(() => {
    let live = true;
    getPersonalRecords()
      .then((r) => live && setPrs(r))
      .catch(() => live && setPrs([]));
    return () => {
      live = false;
    };
  }, []);
  if (prs === null) return null;
  if (prs.length === 0) {
    return (
      <Card title="Personal records" sub="from Garmin import">
        <Empty
          title="No personal records yet"
          desc="Run the Garmin history import to bring in your best-ever performances."
        />
      </Card>
    );
  }
  return (
    <Card title="Personal records" sub={`${prs.length} current`}>
      {prs.map((pr) => (
        <Row
          key={pr.id}
          title={pr.record_type}
          sub={new Date(pr.occurred_at).toLocaleDateString()}
          right={
            <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--text)" }}>
              {fmtPrValue(pr)}
            </span>
          }
        />
      ))}
    </Card>
  );
}

/* ====================== DEVICES ====================== */
const HELIO_KEY_STORE = "ofit_helio_authkey";

/** Relative last-sync label: "just now" / "12m ago" / "3h ago" / "5d ago" / date. */
function fmtLastSync(iso: string | null): string {
  if (!iso) return "no data yet";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const mins = Math.floor((Date.now() - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Devices manager (rendered inline in Settings → Devices): one line per native
 *  BLE device, each with its last-sync time and a Forget action. */
function DevicesManager() {
  const native = useNativeBle();
  const ble = useBle();
  const [sources, setSources] = useState<Source[]>([]);
  useEffect(() => {
    let alive = true;
    listSources()
      .then((s) => alive && setSources(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /* Masked Helio auth key, read/written to localStorage. */
  const [authKey, setAuthKey] = useState<string>(() => {
    try {
      return localStorage.getItem(HELIO_KEY_STORE) ?? "";
    } catch {
      return "";
    }
  });
  const [editKey, setEditKey] = useState(false);
  const saveKey = (v: string) => {
    setAuthKey(v);
    try {
      localStorage.setItem(HELIO_KEY_STORE, v);
    } catch {
      /* ignore */
    }
  };

  /* Offline buffer status (native plugin; web → fall back to zeros). */
  const [outbox, setOutbox] = useState<{ count: number; maxLines: number; bytes: number }>({
    count: 0,
    maxLines: 300000,
    bytes: 0,
  });
  useEffect(() => {
    let alive = true;
    const poll = () =>
      OpenFitBle.getOutboxStatus()
        .then((r) => {
          if (alive) setOutbox(r);
        })
        .catch(() => {
          /* web (or unsupported) → keep zeros */
        });
    poll();
    const id = window.setInterval(poll, 8000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const bufPct = outbox.maxLines > 0 ? Math.min(100, (outbox.count / outbox.maxLines) * 100) : 0;
  const mb = outbox.bytes / 1_000_000;
  const empty = outbox.count === 0;

  // Per-source last-sync for the device lines (matched by normalised name).
  const lastSyncByName = new Map<string, string | null>();
  for (const s of sources) {
    if (s.kind === "device") lastSyncByName.set(s.name.trim().toLowerCase(), s.last_synced_at ?? null);
  }

  // Device-type detection + the freshly discovered (not-yet-added) devices a
  // scan turned up, so the user has something to select. (This rendering was
  // dropped in the redesign — the scan ran but nothing showed.)
  const isZeppOs = (name: string) => /helio|amazfit|zepp|band|mi/i.test(name);
  const isGarmin = (name: string) => /garmin|forerunner|fenix|epix|venu|instinct|fr\d|945/i.test(name);
  const keyOk = /^[0-9a-f]{32}$/i.test(authKey.trim());
  const addable = native.found.filter((d) => !native.devices.some((x) => x.deviceId === d.deviceId));
  const scanning = native.status === "scanning";

  return (
    <div className="stack">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <SectionLabel>Bluetooth devices</SectionLabel>
        <div style={{ display: "flex", gap: 7 }}>
          <button
            className="pill"
            style={{ color: "var(--blue)", background: tint("var(--blue)", 13) }}
            onClick={() => {
              void native.scan();
              void ble.scan();
            }}
          >
            <Icon name="bolt" size={13} />
            Scan
          </button>
          <button
            className="pill"
            style={{ color: "#fff", background: "var(--blue)" }}
            onClick={() => void native.sync()}
          >
            <Icon name="refresh" size={13} />
            {native.syncing ? "Syncing…" : "Sync"}
          </button>
        </div>
      </div>

      <Card title="Native BLE" sub="direct gatt · auto-reconnect">
        <p style={{ margin: "0 0 14px", fontSize: 12.5, lineHeight: 1.55, color: "var(--text-dim)" }}>
          Direct device sync. Standard HR works on any strap in{" "}
          <b style={{ color: "var(--text)" }}>Broadcast HR</b>; for the Helio, paste its 32-hex auth
          key and add it with Zepp-OS.
        </p>
        <Field label="Helio auth key (32 hex)">
          <div style={{ position: "relative" }}>
            <input
              className="of-input mono"
              type={editKey ? "text" : "password"}
              readOnly={!editKey}
              value={authKey}
              onChange={(e) => saveKey(e.target.value)}
              spellCheck={false}
              autoCapitalize="none"
              placeholder="0123456789abcdef0123456789abcdef"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12.5,
                paddingRight: 58,
                color: editKey ? "var(--text)" : "var(--text-dim)",
              }}
            />
            <button
              onClick={() => setEditKey((v) => !v)}
              style={{
                position: "absolute",
                right: 12,
                top: "50%",
                transform: "translateY(-50%)",
                fontSize: 12.5,
                fontWeight: 700,
                color: "var(--blue)",
              }}
            >
              {editKey ? "Done" : "Edit"}
            </button>
          </div>
        </Field>
        {/* One line per added device: status · last-sync · Forget. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
          {native.devices.length > 0 ? (
            native.devices.map((d) => {
              const st = native.statusOf(d.deviceId);
              const hr = native.hrOf(d.deviceId);
              const last = lastSyncByName.get(d.name.trim().toLowerCase()) ?? null;
              return (
                <Row
                  key={d.deviceId}
                  title={d.name}
                  sub={
                    st === "connected"
                      ? hr != null
                        ? `streaming · ${hr} bpm`
                        : "streaming → wellness"
                      : st === "reconnecting"
                        ? "reconnecting…"
                        : d.type === "huami"
                          ? "Helio · added"
                          : d.type === "garmin"
                            ? "Garmin · added"
                            : "added"
                  }
                  right={
                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      {st === "connected" && (
                        <span className="pill live">
                          <i />
                          live
                        </span>
                      )}
                      <span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>{fmtLastSync(last)}</span>
                      <span
                        className="pill"
                        style={{ cursor: "pointer" }}
                        onClick={() => void native.forget(d.deviceId)}
                      >
                        Forget
                      </span>
                    </div>
                  }
                />
              );
            })
          ) : (
            <Row title="No devices added" sub="Tap Scan above to pair a sensor over Bluetooth" right={<span className="pill">idle</span>} />
          )}
        </div>

        {/* Discovered devices from the latest scan — select one to pair. The Helio
            needs its 32-hex auth key (above) before Add · Zepp-OS is enabled. */}
        {(scanning || addable.length > 0) && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
            <SectionLabel>
              {scanning ? "Scanning…" : `Discovered (${addable.length})`}
            </SectionLabel>
            {scanning && addable.length === 0 && (
              <Row
                title="Looking for sensors…"
                sub="Make sure the device is awake and nearby"
                right={
                  <span className="pill live">
                    <i />
                    scanning
                  </span>
                }
              />
            )}
            {addable.map((d) => (
              <Row
                key={d.deviceId}
                title={d.name || d.deviceId}
                sub={`${d.rssi} dBm signal`}
                right={
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {isZeppOs(d.name) && (
                      <button
                        className="pill"
                        disabled={!keyOk}
                        title={keyOk ? "" : "Enter the 32-hex Helio auth key first"}
                        style={{
                          color: keyOk ? "var(--blue)" : "var(--text-faint)",
                          background: tint("var(--blue)", keyOk ? 13 : 6),
                          cursor: keyOk ? "pointer" : "not-allowed",
                        }}
                        onClick={() => void native.addAndConnect(d, { type: "huami", authKey: authKey.trim() })}
                      >
                        Add · Zepp-OS
                      </button>
                    )}
                    {isGarmin(d.name) && (
                      <button
                        className="pill"
                        style={{ color: "var(--blue)", background: tint("var(--blue)", 13) }}
                        onClick={() => void native.addAndConnect(d, { type: "garmin" })}
                      >
                        Add · Garmin
                      </button>
                    )}
                    <button className="pill" onClick={() => void native.addAndConnect(d)}>
                      Add · HR
                    </button>
                  </div>
                }
              />
            ))}
          </div>
        )}
      </Card>

          <Card
            title="Offline buffer"
            sub="on-device safety net"
            action={
              <span className="pill" style={{ color: empty ? "var(--good)" : "var(--ok)" }}>
                {empty ? "all backed up" : `${Math.round(bufPct)}% full`}
              </span>
            }
          >
            <p style={{ margin: "0 0 14px", fontSize: 12.5, lineHeight: 1.5, color: "var(--text-dim)" }}>
              Readings captured while off your network are saved here and uploaded automatically when
              you reconnect.
            </p>
            <div style={{ height: 6, borderRadius: 3, background: "var(--track)", marginBottom: 14, overflow: "hidden" }}>
              <div
                style={{
                  width: `${bufPct}%`,
                  height: "100%",
                  background: empty ? "var(--good)" : bufPct >= 75 ? "var(--ok)" : "var(--blue)",
                  transition: "width .3s",
                }}
              />
            </div>
            <div className="kpi-grid" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
              <div className="kpi">
                <span className="kpi-label">Buffered</span>
                <span className="kpi-val" style={{ fontSize: 16 }}>
                  {outbox.count.toLocaleString()} / {(outbox.maxLines / 1000).toFixed(0)}k
                </span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Size</span>
                <span className="kpi-val" style={{ fontSize: 16 }}>
                  {mb < 0.1 ? mb.toFixed(2) : mb.toFixed(1)}
                  <small>MB</small>
                </span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Status</span>
                <span className="kpi-val" style={{ fontSize: 16 }}>
                  {empty ? "Empty" : "Queued"}
                </span>
              </div>
            </div>
          </Card>
        </div>
  );
}
