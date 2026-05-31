// Stage-1 workout recorder UI: sport picker → live capture (GPS + IMU + HR via
// the native RecordingService) with Start / Pause / Resume / Stop(hold-2s). This
// is the foundation test surface; the polished per-sport layout + map land in a
// later stage. Android app only.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginListenerHandle } from "@capacitor/core";
import { AppShell } from "../app/AppShell";
import { EmptyState } from "../ui/EmptyState";
import { OpenFitRecording, type RecordingTick } from "../ble/native/OpenFitRecording";
import { isNativeApp } from "../gadgetbridge/autoImportConfig";

const SPORTS = [
  { key: "running", label: "Running" },
  { key: "cycling", label: "Bike" },
  { key: "walking", label: "Walking" },
  { key: "hiking", label: "Hiking" },
  { key: "calisthenics", label: "Calisthenics" },
] as const;

type State = "idle" | "recording" | "paused" | "saved";

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(ss).padStart(2, "0")}`;
}

function paceMinPerKm(speedMps: number): string {
  if (speedMps < 0.3) return "—";
  const secPerKm = 1000 / speedMps;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function Workout() {
  const [state, setState] = useState<State>("idle");
  const [sport, setSport] = useState<string>("running");
  const [tick, setTick] = useState<RecordingTick | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [holdPct, setHoldPct] = useState(0);
  const subs = useRef<PluginListenerHandle[]>([]);
  const holdTimer = useRef<number | null>(null);
  const holdRaf = useRef<number | null>(null);

  useEffect(() => {
    if (!isNativeApp()) return;
    let alive = true;
    (async () => {
      const handles = await Promise.all([
        OpenFitRecording.addListener("tick", (t) => {
          setTick(t);
          setState(t.paused ? "paused" : "recording");
        }),
        OpenFitRecording.addListener("recordingStopped", (s) => {
          setState("saved");
          setSaved(s.sessionDir);
        }),
      ]);
      if (!alive) {
        handles.forEach((h) => void h.remove());
        return;
      }
      subs.current = handles;
      const a = await OpenFitRecording.isActive().catch(() => ({ active: false }));
      if (alive && a.active) setState("recording");
    })();
    return () => {
      alive = false;
      subs.current.forEach((h) => void h.remove());
      subs.current = [];
    };
  }, []);

  const start = useCallback(async () => {
    setSaved(null);
    setTick(null);
    try {
      await OpenFitRecording.start({ sport });
      setState("recording");
    } catch (e) {
      alert(`Couldn't start: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [sport]);

  const pause = useCallback(() => void OpenFitRecording.pause(), []);
  const resume = useCallback(() => void OpenFitRecording.resume(), []);

  // Stop requires a 2-second press-and-hold.
  const beginHold = useCallback(() => {
    const t0 = performance.now();
    const animate = () => {
      const p = Math.min(1, (performance.now() - t0) / 2000);
      setHoldPct(p);
      if (p < 1) holdRaf.current = requestAnimationFrame(animate);
    };
    holdRaf.current = requestAnimationFrame(animate);
    holdTimer.current = window.setTimeout(() => {
      void OpenFitRecording.stop();
      setHoldPct(0);
    }, 2000);
  }, []);
  const cancelHold = useCallback(() => {
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    if (holdRaf.current) cancelAnimationFrame(holdRaf.current);
    holdTimer.current = null;
    holdRaf.current = null;
    setHoldPct(0);
  }, []);

  if (!isNativeApp()) {
    return (
      <AppShell title="Record" crumb="Workout recording · on-device">
        <EmptyState label="Open in the app" hint="Workout recording runs in the OpenFit Android app." />
      </AppShell>
    );
  }

  const showGps = sport !== "calisthenics";

  return (
    <AppShell title="Record" crumb="Workout recording · on-device">
      {state === "idle" || state === "saved" ? (
        <div className="card" style={{ maxWidth: 560 }}>
          <div className="card__head">
            <div className="card__title">Start a workout</div>
          </div>
          {state === "saved" && (
            <div className="pill pill--good" style={{ marginBottom: 14 }}>
              Saved · {fmtTime(tick?.elapsedMs ?? 0)} · {saved?.split("/").pop()}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            {SPORTS.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`btn ${sport === s.key ? "" : "btn--ghost"}`}
                onClick={() => setSport(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn" style={{ width: "100%", justifyContent: "center", padding: "14px" }} onClick={() => void start()}>
            Start {SPORTS.find((s) => s.key === sport)?.label}
          </button>
        </div>
      ) : (
        <div className="card" style={{ maxWidth: 560 }}>
          <div className="card__head">
            <div className="card__title">
              {SPORTS.find((s) => s.key === sport)?.label}
              <span className="sub">{state === "paused" ? "paused" : "recording"}</span>
            </div>
          </div>

          {/* big main metric: elapsed time */}
          <div className="num" style={{ fontSize: 56, fontWeight: 800, textAlign: "center", margin: "8px 0 4px" }}>
            {fmtTime(tick?.elapsedMs ?? 0)}
          </div>
          <div className="stat__label" style={{ textAlign: "center", marginBottom: 20 }}>elapsed</div>

          {/* secondary metrics */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 22 }}>
            <Metric label="Heart rate" value={tick?.hr ? String(tick.hr) : "—"} unit="bpm" />
            {showGps && <Metric label="Distance" value={tick ? (tick.distanceM / 1000).toFixed(2) : "—"} unit="km" />}
            {showGps && (
              <Metric
                label={sport === "cycling" ? "Speed" : "Pace"}
                value={tick ? (sport === "cycling" ? (tick.speedMps * 3.6).toFixed(1) : paceMinPerKm(tick.speedMps)) : "—"}
                unit={sport === "cycling" ? "km/h" : "/km"}
              />
            )}
          </div>

          {/* controls */}
          <div style={{ display: "flex", gap: 10 }}>
            {state === "recording" ? (
              <button type="button" className="btn btn--ghost" style={{ flex: 1, justifyContent: "center" }} onClick={pause}>
                Pause
              </button>
            ) : (
              <button type="button" className="btn" style={{ flex: 1, justifyContent: "center" }} onClick={resume}>
                Resume
              </button>
            )}
            <button
              type="button"
              className="btn"
              style={{
                flex: 1,
                justifyContent: "center",
                position: "relative",
                overflow: "hidden",
                background: `linear-gradient(90deg, var(--bad, #e5484d) ${holdPct * 100}%, var(--surface-2, #1a1d28) ${holdPct * 100}%)`,
              }}
              onPointerDown={beginHold}
              onPointerUp={cancelHold}
              onPointerLeave={cancelHold}
              onPointerCancel={cancelHold}
            >
              {holdPct > 0 ? "Hold to stop…" : "Stop (hold 2s)"}
            </button>
          </div>
        </div>
      )}
    </AppShell>
  );
}

function Metric({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div className="num" style={{ fontSize: 24, fontWeight: 700 }}>{value}</div>
      <div className="stat__label">{label}<span style={{ opacity: 0.5 }}> · {unit}</span></div>
    </div>
  );
}
