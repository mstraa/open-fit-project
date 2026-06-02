// Workout recorder UI (Stage 3). React is controller + display only — all capture
// is native (RecordingService). Per-sport metric layout with a big main metric +
// selectable secondaries (tap a tile to change it, long-press the main to swap),
// persisted per sport. Start / Pause / Resume / Stop(hold-2s). Android app only.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { PluginListenerHandle } from "@capacitor/core";
import { AppShell } from "../app/AppShell";
import { EmptyState } from "../ui/EmptyState";
import { OpenFitRecording, type RecordingTick } from "../ble/native/OpenFitRecording";
import { OpenFitBle } from "../ble/native/OpenFitBle";
import { API_BASE, getToken } from "../api/client";
import { isNativeApp } from "../app/isNativeApp";

const SPORTS = [
  { key: "running", label: "Running" },
  { key: "cycling", label: "Bike" },
  { key: "walking", label: "Walking" },
  { key: "hiking", label: "Hiking" },
  { key: "calisthenics", label: "Calisthenics" },
] as const;

type State = "idle" | "recording" | "paused" | "saved";
type MK = "pace" | "speed" | "hr" | "distance" | "duration" | "cadence" | "power" | "altitude" | "ascent";

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

const METRICS: Record<MK, { label: string; unit: string; val: (t: RecordingTick | null) => string }> = {
  pace: { label: "Pace", unit: "min/km", val: (t) => (t ? paceMinPerKm(t.speedMps) : "—") },
  speed: { label: "Speed", unit: "km/h", val: (t) => (t && t.speedMps >= 0 ? (t.speedMps * 3.6).toFixed(1) : "—") },
  hr: { label: "Heart rate", unit: "bpm", val: (t) => (t && t.hr ? String(t.hr) : "—") },
  distance: { label: "Distance", unit: "km", val: (t) => (t ? (t.distanceM / 1000).toFixed(2) : "—") },
  duration: { label: "Duration", unit: "", val: (t) => fmtTime(t?.elapsedMs ?? 0) },
  cadence: { label: "Cadence", unit: "rpm", val: (t) => (t && t.cadence ? String(t.cadence) : "—") },
  power: { label: "Power", unit: "W", val: (t) => (t && t.power ? String(t.power) : "—") },
  altitude: { label: "Altitude", unit: "m", val: (t) => (t && t.altitudeM ? String(Math.round(t.altitudeM)) : "—") },
  ascent: { label: "Ascent", unit: "m", val: (t) => (t ? String(Math.round(t.ascentM)) : "—") },
};

const SPORT_CONFIG: Record<string, { main: MK; secondaries: MK[]; pool: MK[] }> = {
  running: { main: "pace", secondaries: ["hr", "distance", "duration"], pool: ["pace", "hr", "distance", "duration", "cadence", "altitude"] },
  cycling: { main: "speed", secondaries: ["power", "cadence", "hr"], pool: ["speed", "power", "cadence", "hr", "distance", "duration", "altitude"] },
  walking: { main: "duration", secondaries: ["distance", "hr", "pace"], pool: ["duration", "distance", "hr", "pace", "altitude"] },
  hiking: { main: "distance", secondaries: ["ascent", "duration", "hr"], pool: ["distance", "ascent", "altitude", "duration", "hr", "pace"] },
  calisthenics: { main: "duration", secondaries: ["hr"], pool: ["duration", "hr"] },
};

interface Layout {
  main: MK;
  secondaries: MK[];
}
function loadLayout(sport: string): Layout {
  const c = SPORT_CONFIG[sport] ?? SPORT_CONFIG.running;
  try {
    const raw = localStorage.getItem(`ofit_workout_layout_${sport}`);
    if (raw) {
      const l = JSON.parse(raw) as Layout;
      if (l.main && Array.isArray(l.secondaries)) return l;
    }
  } catch {
    /* ignore */
  }
  return { main: c.main, secondaries: c.secondaries };
}
function saveLayout(sport: string, l: Layout) {
  try {
    localStorage.setItem(`ofit_workout_layout_${sport}`, JSON.stringify(l));
  } catch {
    /* ignore */
  }
}
/** Assign metric m to slot 0 (main) or i (secondary i-1), swapping if m is already shown. */
function assignMetric(l: Layout, slotIdx: number, m: MK): Layout {
  const arr = [l.main, ...l.secondaries];
  const other = arr.indexOf(m);
  if (other === slotIdx) return l;
  if (other >= 0) {
    const tmp = arr[slotIdx];
    arr[slotIdx] = m;
    arr[other] = tmp;
  } else {
    arr[slotIdx] = m;
  }
  return { main: arr[0], secondaries: arr.slice(1) };
}

export function Workout() {
  const [state, setState] = useState<State>("idle");
  const [sport, setSport] = useState<string>("running");
  const [tick, setTick] = useState<RecordingTick | null>(null);
  const [uploaded, setUploaded] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout>(() => loadLayout("running"));
  const [chooser, setChooser] = useState<number | null>(null); // slot index being changed
  const [holdPct, setHoldPct] = useState(0);
  const subs = useRef<PluginListenerHandle[]>([]);
  const holdTimer = useRef<number | null>(null);
  const holdRaf = useRef<number | null>(null);
  const wake = useRef<{ release: () => void } | null>(null);

  // The native recorder uploads its own .fit, so it needs the server URL + token.
  // Push them whenever we touch the Record screen / start a workout (not only on a
  // BLE connect, as before) so a finished workout always has fresh credentials to
  // upload with — otherwise the .fit silently waits forever in the queue.
  const pushCreds = useCallback(() => {
    if (!isNativeApp()) return;
    void OpenFitBle.configure({ apiBase: API_BASE, token: getToken() }).catch(() => undefined);
  }, []);

  // listeners
  useEffect(() => {
    if (!isNativeApp()) return;
    let alive = true;
    pushCreds(); // make sure the recorder can upload as soon as the screen opens
    (async () => {
      const handles = await Promise.all([
        OpenFitRecording.addListener("tick", (t) => {
          setTick(t);
          setState(t.paused ? "paused" : "recording");
        }),
        OpenFitRecording.addListener("recordingStopped", () => {
          setState("saved");
          setUploaded(false);
          setUploadError(null);
        }),
        OpenFitRecording.addListener("recordingUploaded", () => {
          setUploaded(true);
          setUploadError(null);
        }),
        OpenFitRecording.addListener("recordingUploadFailed", (e) => {
          setUploaded(false);
          setUploadError(e.reason || "Upload failed.");
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
  }, [pushCreds]);

  // keep the screen on while a workout is live (display only; capture is native)
  useEffect(() => {
    const live = state === "recording" || state === "paused";
    if (live) {
      (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<{ release: () => void }> } }).wakeLock
        ?.request("screen")
        .then((w) => (wake.current = w))
        .catch(() => undefined);
    } else {
      wake.current?.release();
      wake.current = null;
    }
    return () => {
      wake.current?.release();
      wake.current = null;
    };
  }, [state]);

  const pickSport = (s: string) => {
    setSport(s);
    setLayout(loadLayout(s));
  };

  const start = useCallback(async () => {
    setTick(null);
    setUploadError(null);
    pushCreds(); // fresh server URL + token for this workout's upload
    try {
      await OpenFitRecording.start({ sport });
      setState("recording");
    } catch (e) {
      alert(`Couldn't start: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [sport, pushCreds]);

  // Re-push fresh creds, then ask the recorder to retry the queued .fit. Used by
  // the "Retry upload" button after an upload failure (e.g. expired login).
  const retryUpload = useCallback(async () => {
    setUploadError(null);
    pushCreds();
    try {
      await OpenFitRecording.retryUploads();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    }
  }, [pushCreds]);

  const pause = useCallback(() => void OpenFitRecording.pause(), []);
  const resume = useCallback(() => void OpenFitRecording.resume(), []);

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

  const choose = (m: MK) => {
    if (chooser == null) return;
    const next = assignMetric(layout, chooser, m);
    setLayout(next);
    saveLayout(sport, next);
    setChooser(null);
  };

  if (!isNativeApp()) {
    return (
      <AppShell title="Record" crumb="Workout recording · on-device">
        <EmptyState label="Open in the app" hint="Workout recording runs in the OpenFit Android app." />
      </AppShell>
    );
  }

  const pool = (SPORT_CONFIG[sport] ?? SPORT_CONFIG.running).pool;

  return (
    <AppShell title="Record" crumb="Workout recording · on-device">
      {state === "idle" || state === "saved" ? (
        <div className="card" style={{ maxWidth: 560 }}>
          <div className="card__head">
            <div className="card__title">Start a workout</div>
          </div>
          {state === "saved" && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
              {uploadError ? (
                <>
                  <span className="pill" style={{ background: "var(--bad, #e5484d)", color: "#fff" }}>
                    Couldn't upload
                  </span>
                  <span className="sub" style={{ flexBasis: "100%", opacity: 0.85 }}>{uploadError}</span>
                  <button type="button" className="btn btn--ghost" onClick={() => void retryUpload()}>
                    Retry upload
                  </button>
                </>
              ) : (
                <>
                  <span className="pill pill--good">{uploaded ? "Synced to your activities" : "Saved · uploading…"}</span>
                  {uploaded && (
                    <Link to="/activities" className="pill">
                      View activity →
                    </Link>
                  )}
                </>
              )}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            {SPORTS.map((s) => (
              <button key={s.key} type="button" className={`btn ${sport === s.key ? "" : "btn--ghost"}`} onClick={() => pickSport(s.key)}>
                {s.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn" style={{ width: "100%", justifyContent: "center", padding: 14 }} onClick={() => void start()}>
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

          {/* MAIN metric (long-press to swap) */}
          <button
            type="button"
            onContextMenu={(e) => {
              e.preventDefault();
              setChooser(0);
            }}
            onClick={() => setChooser(0)}
            style={{ width: "100%", background: "none", border: "none", color: "inherit", cursor: "pointer", padding: "6px 0 2px" }}
          >
            <div className="num" style={{ fontSize: 64, fontWeight: 800, textAlign: "center", lineHeight: 1.05 }}>
              {METRICS[layout.main].val(tick)}
            </div>
            <div className="stat__label" style={{ textAlign: "center", marginTop: 2 }}>
              {METRICS[layout.main].label}
              {METRICS[layout.main].unit ? ` · ${METRICS[layout.main].unit}` : ""}
            </div>
          </button>

          {/* SECONDARY tiles (tap to change) */}
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(3, layout.secondaries.length || 1)}, 1fr)`, gap: 12, margin: "20px 0 22px" }}>
            {layout.secondaries.map((mk, i) => (
              <button
                key={`${mk}-${i}`}
                type="button"
                className="card"
                style={{ padding: "12px 8px", textAlign: "center", cursor: "pointer" }}
                onClick={() => setChooser(i + 1)}
              >
                <div className="num" style={{ fontSize: 24, fontWeight: 700 }}>{METRICS[mk].val(tick)}</div>
                <div className="stat__label" style={{ marginTop: 2 }}>
                  {METRICS[mk].label}
                  {METRICS[mk].unit ? <span style={{ opacity: 0.5 }}> · {METRICS[mk].unit}</span> : null}
                </div>
              </button>
            ))}
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

      {/* metric chooser sheet */}
      {chooser != null && (
        <div
          onClick={() => setChooser(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", display: "grid", placeItems: "end center", zIndex: 50 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="card"
            style={{ width: "min(560px, 96vw)", margin: 12, padding: 16 }}
          >
            <div className="card__title" style={{ marginBottom: 12 }}>
              Choose metric{chooser === 0 ? " · main" : ""}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
              {pool.map((mk) => (
                <button key={mk} type="button" className="btn btn--ghost" style={{ justifyContent: "space-between" }} onClick={() => choose(mk)}>
                  <span>{METRICS[mk].label}</span>
                  <span className="num" style={{ opacity: 0.7 }}>{METRICS[mk].val(tick)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
