/* ============================================================
   OpenFit — Activities page + Record flow + Garmin-style detail.
   Ported from the design bundle's js/activities.jsx into typed TSX.

   Real data:
     • Activities list  → useActivitiesList() (rows / counts / total)
     • "This week" hero + TrainingSummary → useTrainingSummary()
     • ActivityDetail summary/stats/training-effect/graphs/map → useActivityDetailData()
       (resolved streams + derived metrics; honest empty states when absent)
     • Gear tab         → useGear() + the in-memory GEAR store
   SIMULATED (no native plugin in the web shell):
     • RecordFlow live ticking
   ============================================================ */
import { useState, useEffect, useRef, useMemo, type ReactNode } from "react";
import { Bars, CountUp, AreaChart } from "../charts";
import { Card, SectionLabel, SegTabs, Chip, useNav, Icon, DetailHeader, SportBadge, useGear, NoData } from "../ui";
import { RECORD_TYPES, SPORTS, type Gear } from "../data";
import {
  useActivitiesList,
  useActivityDetailData,
  useTrainingSummary,
  type ActivityRow,
  type ActivityDetailVM,
  type SummaryPeriod,
} from "../wiring";
import { tint, fmtDur } from "../util";
import { TrackMap } from "../../charts/TrackMapLazy";
import type { Sport, StreamKind, LatLngSample, RecordingInfo } from "../../api/types";
import {
  deleteActivity,
  deleteSource,
  exportActivityFit,
  getDerived,
  getVariants,
  importFiles,
  setSelection,
  type DerivationVariant,
} from "../../api/endpoints";
import { OpenFitRecording } from "../../ble/native/OpenFitRecording";
import { OpenFitBle } from "../../ble/native/OpenFitBle";
import { isNativeApp } from "../../app/isNativeApp";
import { API_BASE, getToken } from "../../api/client";

/* ---------- RECORD_TYPES label → lowercase Sport meta ---------- */
const RECORD_SPORT: Record<string, Sport> = {
  Running: "running",
  Cycling: "cycling",
  Walking: "walking",
  Hiking: "walking", // no dedicated Sport; share the walking visuals
  Strength: "strength",
};

/* ============================================================
   TRAINING SUMMARY (period browser) — REAL (useTrainingSummary)
   ============================================================ */
export function TrainingSummary() {
  const [period, setPeriod] = useState<SummaryPeriod>("Week");
  const [offset, setOffset] = useState(0);
  const vm = useTrainingSummary(period, offset);
  const relLabel =
    offset === 0 ? `This ${period.toLowerCase()}` : offset === -1 ? `Last ${period.toLowerCase()}` : `${-offset} ${period.toLowerCase()}s ago`;
  const maxMins = Math.max(1, ...vm.bySport.map((s) => s.mins));
  return (
    <div className="detail">
      <DetailHeader title="Training summary" sub={relLabel} accent="var(--run)" />
      <div className="scroll">
        <div className="stack">
          <div style={{ display: "flex", justifyContent: "center" }}>
            <SegTabs<SummaryPeriod>
              options={["Week", "Month", "Year"]}
              value={period}
              onChange={(p) => {
                setPeriod(p);
                setOffset(0);
              }}
            />
          </div>
          {/* period stepper */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <button className="icon-btn" onClick={() => setOffset((o) => o - 1)}>
              <Icon name="chevL" size={18} />
            </button>
            <div style={{ textAlign: "center", fontWeight: 700, fontSize: 15 }}>{relLabel}</div>
            <button
              className="icon-btn"
              disabled={offset === 0}
              style={{ opacity: offset === 0 ? 0.35 : 1 }}
              onClick={() => setOffset((o) => Math.min(0, o + 1))}
            >
              <Icon name="chevR" size={18} />
            </button>
          </div>
          <Card>
            <div style={{ display: "flex", gap: 18, marginBottom: 14 }}>
              <div className="kpi">
                <span className="kpi-label">Sessions</span>
                <span className="kpi-val" style={{ fontSize: 28 }}>
                  {vm.sessions}
                </span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Total time</span>
                <span className="kpi-val" style={{ fontSize: 28 }}>
                  {vm.mins}
                  <small>min</small>
                </span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Distance</span>
                <span className="kpi-val" style={{ fontSize: 28 }}>
                  {vm.dist == null ? "—" : vm.dist}
                  <small>km</small>
                </span>
              </div>
            </div>
            <Bars data={vm.bars} height={170} colorFn={() => "var(--run)"} valueFmt={(v) => v || ""} />
          </Card>
          <SectionLabel>By sport</SectionLabel>
          <Card noPad>
            <div className="list" style={{ padding: "0 16px" }}>
              {vm.bySport.map((s) => (
                <div className="lrow" key={s.sport}>
                  <SportBadge sport={(RECORD_SPORT[s.sport] ?? "other") as Sport} size={34} />
                  <div className="lrow-main">
                    <div className="lrow-title" style={{ fontSize: 14 }}>
                      {s.sport}
                    </div>
                    <div style={{ height: 5, borderRadius: 3, background: "var(--track)", marginTop: 6, overflow: "hidden" }}>
                      <div style={{ width: `${(s.mins / maxMins) * 100}%`, height: "100%", background: s.color }} />
                    </div>
                  </div>
                  <div className="lrow-dur">
                    {s.mins}
                    <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-sans)", marginLeft: 2 }}>min</span>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   RECORD FLOW — setup → live → paused (simulated ticking)
   ============================================================ */
type RecordPhase = "setup" | "live" | "paused" | "done";

/** RecordFlow sport label → the native recorder's sport key (FitEncoder sports). */
const NATIVE_SPORT: Record<string, string> = {
  Running: "running",
  Cycling: "cycling",
  Walking: "walking",
  Hiking: "hiking",
  Strength: "calisthenics",
};

export function RecordFlow() {
  const nav = useNav();
  const native = isNativeApp();
  const [sportLbl, setSportLbl] = useState<string>("Running");
  const [phase, setPhase] = useState<RecordPhase>("setup");
  const [t, setT] = useState(0);
  const [dist, setDist] = useState(0);
  const [hr, setHr] = useState(native ? 0 : 72);
  const [upload, setUpload] = useState<"pending" | "ok" | "failed">("pending");
  const [uploadMsg, setUploadMsg] = useState("");
  const holdRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The native recorder uploads its own .fit, so it needs the server URL + token.
  // Push them whenever we record (the old shell only did this on a BLE connect, so
  // a workout could finish with no credentials and never upload).
  const pushCreds = (): Promise<unknown> => {
    if (!native) return Promise.resolve();
    return OpenFitBle.configure({ apiBase: API_BASE, token: getToken() }).catch(() => undefined);
  };

  // WEB shell: simulated ticking (there is no native plugin in the browser).
  useEffect(() => {
    if (native || phase !== "live") return;
    const id = setInterval(() => {
      setT((x) => x + 1);
      setDist((d) => d + (sportLbl === "Cycling" ? 0.0075 : 0.0028));
      setHr((h) => Math.max(95, Math.min(168, h + (Math.random() - 0.45) * 8)));
    }, 1000);
    return () => clearInterval(id);
  }, [native, phase, sportLbl]);

  // NATIVE: drive the real RecordingService and reflect its live 1 Hz ticks +
  // post-stop upload status. Subscribe once.
  useEffect(() => {
    if (!native) return;
    let alive = true;
    pushCreds();
    const handles: Array<{ remove: () => void }> = [];
    (async () => {
      const hs = await Promise.all([
        OpenFitRecording.addListener("tick", (tk) => {
          setT(Math.floor(tk.elapsedMs / 1000));
          setDist(tk.distanceM / 1000);
          setHr(tk.hr);
          setPhase((p) => (p === "setup" || p === "done" ? p : tk.paused ? "paused" : "live"));
        }),
        OpenFitRecording.addListener("recordingStopped", () => {
          setUpload("pending");
          setUploadMsg("");
          setPhase("done");
        }),
        OpenFitRecording.addListener("recordingUploaded", () => setUpload("ok")),
        OpenFitRecording.addListener("recordingUploadFailed", (e) => {
          setUpload("failed");
          setUploadMsg(e.reason || "Upload failed.");
        }),
      ]);
      if (!alive) {
        hs.forEach((h) => void h.remove());
        return;
      }
      handles.push(...hs);
      const a = await OpenFitRecording.isActive().catch(() => ({ active: false }));
      if (alive && a.active) setPhase("live");
    })();
    return () => {
      alive = false;
      handles.forEach((h) => void h.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native]);

  const startRec = async () => {
    if (!native) {
      setPhase("live");
      return;
    }
    setT(0);
    setDist(0);
    setUpload("pending");
    setUploadMsg("");
    try {
      await pushCreds(); // persist server URL + token BEFORE the workout can upload
      await OpenFitRecording.start({ sport: NATIVE_SPORT[sportLbl] ?? "running" });
      setPhase("live");
    } catch (e) {
      alert(`Couldn't start: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const togglePause = () => {
    if (!native) {
      setPhase(phase === "live" ? "paused" : "live");
      return;
    }
    // Optimistic flip for instant feedback; the next tick's paused flag confirms.
    if (phase === "live") {
      void OpenFitRecording.pause();
      setPhase("paused");
    } else {
      void OpenFitRecording.resume();
      setPhase("live");
    }
  };

  const stopRec = () => {
    if (!native) {
      nav.pop(); // web preview: nothing was captured
      return;
    }
    void OpenFitRecording.stop(); // → recordingStopped flips to the "done" screen
  };

  const retryUpload = async () => {
    setUpload("pending");
    setUploadMsg("");
    try {
      await pushCreds(); // refresh creds first — a stale/expired token is the usual cause
      await OpenFitRecording.retryUploads();
    } catch (e) {
      setUpload("failed");
      setUploadMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const sport: Sport = RECORD_SPORT[sportLbl] ?? "other";
  const meta = SPORTS[sport];
  const pace = dist > 0.02 ? t / 60 / dist : 0;
  const paceStr = pace > 0 ? `${Math.floor(pace)}:${String(Math.round((pace % 1) * 60)).padStart(2, "0")}` : "—";

  return (
    <div className="detail">
      <DetailHeader
        title="Record"
        sub={phase === "setup" ? "Choose a workout" : phase === "done" ? "Workout saved" : sportLbl.toUpperCase() + " · RECORDING"}
        accent={meta.color}
      />
      {phase === "setup" ? (
        <div className="scroll">
          <div className="stack">
            <Card title="Start a workout">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
                {RECORD_TYPES.map((s) => (
                  <Chip key={s} active={sportLbl === s} color={SPORTS[RECORD_SPORT[s] ?? "other"].color} onClick={() => setSportLbl(s)}>
                    {s}
                  </Chip>
                ))}
              </div>
              <button className="btn btn-primary" style={{ marginTop: 18 }} onClick={startRec}>
                <Icon name="play" size={18} fill="currentColor" stroke={0} />
                Start {sportLbl}
              </button>
            </Card>
            <Card>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="tile-ic" style={{ width: 36, height: 36, background: tint("var(--run)", 13), color: "var(--run)" }}>
                  <Icon name="bolt" size={18} />
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>Amazfit Helio Strap</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-faint)", fontWeight: 600 }}>HR source · streaming 72 bpm</div>
                </div>
                <span className="pill live">
                  <i />
                  live
                </span>
              </div>
            </Card>
          </div>
        </div>
      ) : phase === "done" ? (
        <div className="scroll">
          <div className="stack">
            <Card title="Workout saved">
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "flex", gap: 28 }}>
                  <div>
                    <div className="tile-label">Duration</div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 26, fontWeight: 700 }}>{fmtDur(t)}</div>
                  </div>
                  <div>
                    <div className="tile-label">Distance</div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 26, fontWeight: 700 }}>
                      {dist.toFixed(2)} <span className="tile-sub">km</span>
                    </div>
                  </div>
                </div>
                {upload === "pending" && <span className="pill">Saved · uploading…</span>}
                {upload === "ok" && <span className="pill" style={{ color: "var(--ok)" }}>Synced to your activities</span>}
                {upload === "failed" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <span className="pill" style={{ color: "var(--low)" }}>Couldn't upload</span>
                    <span className="faint" style={{ fontSize: 12.5 }}>{uploadMsg}</span>
                    <button className="btn btn-ghost" style={{ alignSelf: "flex-start" }} onClick={retryUpload}>
                      Retry upload
                    </button>
                  </div>
                )}
                <button
                  className="btn btn-primary"
                  disabled={upload === "pending"}
                  onClick={() => {
                    // Re-fetch the shell so the just-uploaded activity shows in the
                    // list (same signal a strap sync fires; see useDataRefresh).
                    if (upload === "ok") window.dispatchEvent(new Event("ofit:data-updated"));
                    else nav.pop();
                  }}
                >
                  {upload === "pending" ? "Uploading…" : "Done"}
                </button>
              </div>
            </Card>
          </div>
        </div>
      ) : (
        <div
          style={{
            position: "relative",
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            padding: "0 20px 22px",
            background: `radial-gradient(125% 55% at 50% 0%, ${tint(meta.color, 13)} 0%, transparent 62%)`,
          }}
        >
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4 }}>
            <div className="kpi-label" style={{ letterSpacing: ".18em" }}>
              PACE · MIN/KM
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "clamp(76px,27vw,116px)",
                fontWeight: 700,
                letterSpacing: "-.04em",
                lineHeight: 1,
                color: meta.color,
              }}
            >
              {paceStr}
            </div>
            {phase === "paused" && (
              <span className="pill" style={{ marginTop: 10, color: "var(--ok)" }}>
                Paused
              </span>
            )}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              borderTop: "1px solid var(--line)",
              borderBottom: "1px solid var(--line)",
              padding: "20px 0",
              marginBottom: 22,
            }}
          >
            <div style={{ textAlign: "center", borderRight: "1px solid var(--line)" }}>
              <div className="tile-label">Heart rate</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 32, fontWeight: 700, color: "var(--rhr)", lineHeight: 1.2 }}>{Math.round(hr)}</div>
              <div className="tile-sub">bpm</div>
            </div>
            <div style={{ textAlign: "center", borderRight: "1px solid var(--line)" }}>
              <div className="tile-label">Distance</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 32, fontWeight: 700, lineHeight: 1.2 }}>{dist.toFixed(2)}</div>
              <div className="tile-sub">km</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div className="tile-label">Duration</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 32, fontWeight: 700, lineHeight: 1.2 }}>{fmtDur(t)}</div>
              <div className="tile-sub">time</div>
            </div>
          </div>
          <div className="row2">
            <button className="btn btn-ghost" onClick={togglePause}>
              <Icon name={phase === "live" ? "pause" : "play"} size={17} fill="currentColor" stroke={0} />
              {phase === "live" ? "Pause" : "Resume"}
            </button>
            <button
              className="btn btn-ghost"
              style={{ borderColor: tint("var(--low)", 33), color: "var(--low)" }}
              onPointerDown={() => {
                holdRef.current = setTimeout(stopRec, 800);
              }}
              onPointerUp={() => {
                if (holdRef.current) clearTimeout(holdRef.current);
              }}
              onPointerLeave={() => {
                if (holdRef.current) clearTimeout(holdRef.current);
              }}
            >
              <Icon name="stop" size={15} fill="currentColor" stroke={0} />
              Stop (hold)
            </button>
          </div>
          <p className="faint" style={{ textAlign: "center", fontSize: 12, margin: "12px 0 0" }}>
            Streaming from Amazfit Helio Strap · saved locally
          </p>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   ACTIVITY DETAIL (Garmin-style tabs) — REAL (resolved streams)
   ============================================================ */
type StatsGroup = { title: string; icon: string; rows: [string, string, string][] };
function StatGroup({ g }: { g: StatsGroup }) {
  return (
    <Card title={g.title}>
      {g.rows.map(([l, v, u], i) => (
        <div key={i} className="setting-row" style={{ padding: "9px 0" }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-dim)" }}>{l}</span>
          <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 15 }}>
            {v}
            {u && <span style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--font-sans)", marginLeft: 3 }}>{u}</span>}
          </span>
        </div>
      ))}
    </Card>
  );
}

/** Derive the Training-Effect hero label from the real aerobic/anaerobic TE values. */
function teLabel(aerobic: number, anaerobic: number): string {
  if (aerobic > 3 && anaerobic < 1) return "Tempo · high aerobic";
  if (aerobic >= 3 && anaerobic >= 3) return "Interval · mixed";
  if (anaerobic >= aerobic) return "Anaerobic · sprint";
  return "Easy · aerobic";
}

function TEBar({ value }: { value: number }) {
  return (
    <div
      style={{
        position: "relative",
        height: 10,
        borderRadius: 6,
        marginTop: 8,
        background:
          "linear-gradient(90deg,#3a3f4a 0 28%,var(--blue) 28% 48%,var(--good) 48% 68%,var(--ok) 68% 88%,var(--low) 88% 100%)",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: "50%",
          left: `${Math.min(100, (value / 5) * 100)}%`,
          transform: "translate(-50%,-50%)",
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "#fff",
          border: "2px solid var(--bg)",
          boxShadow: "0 1px 4px rgba(0,0,0,.5)",
        }}
      />
    </div>
  );
}

/** GPS route card. Renders the real OSM-tiled MapLibre map (TrackMap) with the
 *  route polyline, fit-to-bounds and grayscale toggle — the same map we built in
 *  the old design. Falls back to an honest "no track" placeholder when an
 *  activity has no GPS. */
function MapCard({ track, source }: { track?: { lat: number; lng: number }[] | null; source?: string }) {
  const pts = track && track.length > 1 ? track : null;
  // TrackMap wants LatLngSample[]; the index stands in for t_offset_ms (only used
  // for speed-coloring / cursor sync, neither of which the overview map uses).
  // Memoized so a fresh inline array isn't passed to the (memoized) map on every
  // ActivityDetail re-render — which would otherwise rebuild the MapLibre map.
  const tmTrack: LatLngSample[] = useMemo(
    () => (pts ? pts.map((p, i) => ({ t_offset_ms: i, lat: p.lat, lng: p.lng })) : []),
    [pts],
  );
  if (!pts) {
    return (
      <Card noPad>
        <div
          style={{
            position: "relative",
            height: 200,
            borderRadius: "var(--r)",
            overflow: "hidden",
            display: "grid",
            placeItems: "center",
            background: "repeating-linear-gradient(135deg,#11151e,#11151e 11px,#141925 11px,#141925 22px)",
          }}
        >
          <span className="pill">
            <Icon name="dot" size={11} color="var(--text-faint)" />
            {`GPS · ${source ?? "no track"}`}
          </span>
        </div>
      </Card>
    );
  }
  return (
    <Card noPad>
      <div style={{ position: "relative", borderRadius: "var(--r)", overflow: "hidden" }}>
        <TrackMap track={tmTrack} height={220} />
        <span style={{ position: "absolute", top: 10, left: 10, zIndex: 3 }} className="pill">
          <Icon name="dot" size={11} color="var(--run)" />
          {`GPS · ${pts.length} pts`}
        </span>
      </div>
    </Card>
  );
}

function GearBarA({ used, max }: { used: number; max: number }) {
  const pct = Math.min(100, (used / max) * 100);
  const c = pct > 90 ? "var(--low)" : pct > 75 ? "var(--ok)" : "var(--good)";
  return (
    <div style={{ height: 8, borderRadius: 4, background: "var(--track)", overflow: "hidden" }}>
      <div style={{ width: pct + "%", height: "100%", background: c }} />
    </div>
  );
}

export function GearTab({ actId, type }: { actId: string; type: string }) {
  const gear = useGear();
  const [picking, setPicking] = useState(false);
  const assigned = gear.gearsFor(actId, type);
  const assignedIds = assigned.map((g) => g.id);
  const options = gear.gears.filter((g: Gear) => g.type === type && !assignedIds.includes(g.id));
  return (
    <>
      {assigned.length === 0 && (
        <Card>
          <div style={{ textAlign: "center", padding: "20px 10px", color: "var(--text-faint)" }}>
            <Icon name="run" size={28} />
            <div style={{ marginTop: 8, fontSize: 13.5 }}>No gear on this activity yet.</div>
          </div>
        </Card>
      )}
      {assigned.map((g) => (
        <Card key={g.id}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <span
              style={{ width: 60, height: 60, borderRadius: 15, background: "var(--bg-elev-2)", display: "grid", placeItems: "center", flex: "none" }}
            >
              <Icon name={g.icon} size={28} color="var(--text-dim)" />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 16 }}>{g.name}</div>
              <div style={{ fontSize: 12.5, color: "var(--text-faint)", marginBottom: 10 }}>{g.desc}</div>
              <GearBarA used={g.used} max={g.max} />
              <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginTop: 8, fontFamily: "var(--font-mono)" }}>
                {g.used.toFixed(0)} of {(+g.max).toLocaleString("fr")} km
              </div>
            </div>
            <button className="icon-btn" style={{ flex: "none", color: "var(--low)" }} onClick={() => gear.unassign(actId, type, g.id)}>
              <Icon name="x" size={16} />
            </button>
          </div>
        </Card>
      ))}
      {picking ? (
        <Card
          title="Add gear"
          action={
            <button className="pill" onClick={() => setPicking(false)}>
              <Icon name="x" size={13} />
              Close
            </button>
          }
        >
          {options.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--text-faint)", padding: "6px 0" }}>
              No other {type.toLowerCase()} gear. Add some in Settings → Gear.
            </div>
          ) : (
            options.map((g) => (
              <button
                key={g.id}
                className="lrow"
                style={{ width: "100%", textAlign: "left" }}
                onClick={() => {
                  gear.assign(actId, type, g.id);
                  setPicking(false);
                }}
              >
                <span
                  style={{ width: 36, height: 36, borderRadius: 10, background: "var(--bg-elev-2)", display: "grid", placeItems: "center", flex: "none" }}
                >
                  <Icon name={g.icon} size={18} color="var(--text-dim)" />
                </span>
                <div className="lrow-main">
                  <div className="lrow-title" style={{ fontSize: 14 }}>
                    {g.name}
                  </div>
                  <div className="lrow-meta">{g.used.toFixed(0)} km</div>
                </div>
                <Icon name="plus" size={16} color="var(--blue)" />
              </button>
            ))
          )}
        </Card>
      ) : (
        <button className="btn btn-ghost" onClick={() => setPicking(true)}>
          <Icon name="plus" size={17} />
          Add gear
        </button>
      )}
    </>
  );
}

/* ============================================================
   EDIT TAB — gear + per-source delete + export + delete activity
   ============================================================ */
type ConfirmState = null | { kind: "activity" } | { kind: "source"; rec: RecordingInfo };

/** Centered confirm dialog over a scrim (the design has no generic modal).
 *  Escape cancels, focus moves to Cancel on open and is restored on close. */
function ConfirmModal({
  title,
  body,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Refs so the mount-only effect always sees the latest busy/onCancel.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const cancelCb = useRef(onCancel);
  cancelCb.current = onCancel;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) cancelCb.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, []);
  return (
    <div
      className="sheet-scrim show"
      style={{ display: "grid", placeItems: "center", padding: 20, zIndex: 60 }}
      onClick={busy ? undefined : onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
    >
      <div className="card" style={{ maxWidth: 360, width: "100%" }} onClick={(e) => e.stopPropagation()}>
        <div className="card-body">
          <div id="confirm-modal-title" style={{ fontWeight: 800, fontSize: 16, marginBottom: 8 }}>
            {title}
          </div>
          <div style={{ fontSize: 13.5, color: "var(--text-dim)", lineHeight: 1.55, marginBottom: 18 }}>{body}</div>
          <div className="row2">
            <button ref={cancelRef} className="btn btn-ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
            <button
              className="btn"
              disabled={busy}
              style={{ background: "var(--low)", color: "#fff" }}
              onClick={onConfirm}
            >
              {busy ? "Deleting…" : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One contributing source (recording) with a delete (×) action. */
function SourceRow({ rec, onDelete }: { rec: RecordingInfo; onDelete: () => void }) {
  const metricCount = rec.stream_kinds.filter((k) => k !== "lat_lng").length;
  return (
    <div className="lrow">
      <span
        style={{ width: 34, height: 34, borderRadius: 10, background: "var(--bg-elev-2)", display: "grid", placeItems: "center", flex: "none", color: "var(--text-dim)" }}
      >
        <Icon name="pulse" size={16} />
      </span>
      <div className="lrow-main">
        <div className="lrow-title" style={{ fontSize: 14 }}>
          {rec.source_name}
        </div>
        <div className="lrow-meta">
          {(rec.format || "?").toUpperCase()} · {metricCount} {metricCount === 1 ? "metric" : "metrics"}
        </div>
      </div>
      <button
        className="icon-btn"
        style={{ flex: "none", color: "var(--low)" }}
        aria-label={`Delete source ${rec.source_name}`}
        title="Delete this source"
        onClick={onDelete}
      >
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}

function EditTab({
  act,
  recordings,
  exportable,
  reload,
  onChanged,
}: {
  act: ActivityRow;
  recordings: RecordingInfo[];
  exportable: boolean;
  reload: () => void;
  onChanged?: () => void;
}) {
  const nav = useNav();
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const lastSource = recordings.length <= 1;

  const runDeleteActivity = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteActivity(act.id);
      onChanged?.(); // refresh the (still-mounted) list underneath
      nav.pop(); // back to the list
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      setConfirm(null);
    }
  };

  const runDeleteSource = async (rec: RecordingInfo) => {
    setBusy(true);
    setError(null);
    try {
      const res = await deleteSource(act.id, rec.id);
      onChanged?.();
      if (res.activity_deleted) {
        nav.pop(); // emptied the activity → it's gone, return to the list
      } else {
        setConfirm(null);
        setBusy(false);
        reload(); // refresh this detail in place (one source fewer)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      setConfirm(null);
    }
  };

  const onExport = async () => {
    setExporting(true);
    setError(null);
    setNotice(null);
    try {
      const r = await exportActivityFit(act.id);
      if (r.outcome === "saved") setNotice(`Saved ${r.path ?? "file"}.`);
      else if (r.outcome === "shared") setNotice("Exported.");
      else if (r.outcome === "downloaded") setNotice("Download started.");
      // "canceled" → leave no message (the user dismissed the picker)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  // Trash on a source: the *last* source can't be removed on its own — doing so
  // would empty the activity, so it opens the delete-activity confirm instead.
  const onDeleteSourceClick = (rec: RecordingInfo) =>
    setConfirm(lastSource ? { kind: "activity" } : { kind: "source", rec });

  return (
    <>
      <SectionLabel>Gear</SectionLabel>
      <GearTab actId={act.id} type={act.sportLabel} />

      <SectionLabel>Sources</SectionLabel>
      <Card noPad>
        {recordings.length === 0 ? (
          <div style={{ padding: "10px 16px" }}>
            <NoData label="No sources" hint="This activity has no contributing recordings." height={60} />
          </div>
        ) : (
          <div className="list" style={{ padding: "0 16px" }}>
            {recordings.map((rec) => (
              <SourceRow key={rec.id} rec={rec} onDelete={() => onDeleteSourceClick(rec)} />
            ))}
          </div>
        )}
      </Card>
      <p className="faint" style={{ fontSize: 11.5, margin: "-4px 2px 0", lineHeight: 1.5, color: "var(--text-faint)" }}>
        Deleting a source permanently removes that device’s recording and its data. Removing the last source deletes the whole activity.
      </p>

      <SectionLabel>Export</SectionLabel>
      <button className="btn btn-ghost" disabled={!exportable || exporting} onClick={onExport}>
        <Icon name="upload" size={17} />
        {exporting ? "Exporting…" : "Export as .fit"}
      </button>
      {!exportable && (
        <p className="faint" style={{ fontSize: 11.5, margin: "-4px 2px 0", color: "var(--text-faint)" }}>
          No resolved streams to export for this activity.
        </p>
      )}
      {notice && (
        <p style={{ fontSize: 12, color: "var(--good)", fontWeight: 600, margin: "-4px 2px 0" }}>{notice}</p>
      )}

      <SectionLabel>Danger zone</SectionLabel>
      <button
        className="btn btn-ghost"
        style={{ borderColor: tint("var(--low)", 33), color: "var(--low)" }}
        onClick={() => setConfirm({ kind: "activity" })}
      >
        <Icon name="x" size={17} />
        Delete activity
      </button>

      {error && (
        <p style={{ fontSize: 12.5, color: "var(--low)", fontWeight: 600, margin: "2px 2px 0" }}>{error}</p>
      )}

      {confirm?.kind === "activity" && (
        <ConfirmModal
          title="Are you sure you want to delete this activity?"
          body="This permanently deletes the activity and all its source recordings, streams and analysis. This can’t be undone."
          confirmLabel="Delete activity"
          busy={busy}
          onConfirm={runDeleteActivity}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === "source" && (
        <ConfirmModal
          title="Delete this source?"
          body={
            <>
              Permanently remove <b>{confirm.rec.source_name}</b> (its recording and data) from this activity? The other sources are kept.
            </>
          }
          confirmLabel="Delete source"
          busy={busy}
          onConfirm={() => runDeleteSource(confirm.rec)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}

/* ---- REAL resolved-stream → graph/summary helpers ---- */
const STREAM_META: Partial<Record<StreamKind, { label: string; color: string; unit?: string; decimals?: number }>> = {
  heart_rate: { label: "Heart rate", color: "var(--rhr)", unit: "bpm" },
  power: { label: "Power", color: "var(--activity)", unit: "W" },
  speed: { label: "Speed", color: "var(--run)", unit: "m/s", decimals: 1 },
  cadence: { label: "Cadence", color: "var(--strength)", unit: "rpm" },
  altitude: { label: "Altitude", color: "var(--walk)", unit: "m" },
  vertical_oscillation: { label: "Vertical oscillation", color: "var(--good)", unit: "mm", decimals: 1 },
  ground_contact_time: { label: "Ground contact", color: "var(--hrv)", unit: "ms" },
  form_power: { label: "Form power", color: "var(--strength)", unit: "W" },
  air_power: { label: "Air power", color: "var(--light)", unit: "W" },
  leg_spring_stiffness: { label: "Leg spring stiffness", color: "var(--rhr)", unit: "kN/m", decimals: 1 },
  stride_length: { label: "Stride length", color: "var(--cycle)", unit: "m", decimals: 2 },
  vertical_ratio: { label: "Vertical ratio", color: "var(--ok)", unit: "%", decimals: 1 },
  temperature: { label: "Temperature", color: "var(--awake)", unit: "°C", decimals: 1 },
  wind: { label: "Wind", color: "var(--ok)", unit: "m/s", decimals: 1 },
};
const GRAPH_ORDER: StreamKind[] = [
  "heart_rate", "power", "speed", "cadence", "altitude", "vertical_oscillation",
  "ground_contact_time", "form_power", "leg_spring_stiffness", "temperature", "wind",
];
interface RealGraph {
  label: string;
  color: string;
  series: number[];
  avg: string;
  max: string;
  fmt: (v: number) => string | number;
}
function buildRealGraphs(det: ActivityDetailVM): RealGraph[] {
  const out: RealGraph[] = [];
  for (const k of GRAPH_ORDER) {
    const s = det.series[k];
    const meta = STREAM_META[k];
    if (!s || !s.length || !meta) continue;
    const dec = meta.decimals ?? 0;
    const fmt = (v: number) => (dec ? v.toFixed(dec) : Math.round(v));
    out.push({
      label: meta.label,
      color: meta.color,
      series: s,
      avg: `${fmt(det.avg[k] ?? 0)}${meta.unit ? " " + meta.unit : ""}`,
      max: `${fmt(det.max[k] ?? 0)}`,
      fmt,
    });
  }
  return out;
}
function fmtPaceSecPerKm(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function buildRealSummary(det: ActivityDetailVM): [string, string, string][] | null {
  if (!det.hasReal) return null;
  const tiles: [string, string, string][] = [];
  const distSeries = det.series.distance;
  const distM = det.summary?.distance_m ?? (distSeries && distSeries.length ? distSeries[distSeries.length - 1] : undefined);
  if (distM) tiles.push(["Distance", (distM / 1000).toFixed(2), "km"]);
  tiles.push(["Duration", fmtDur(det.durationSec), ""]);
  if (det.summary?.avg_pace_s_per_m) tiles.push(["Avg pace", fmtPaceSecPerKm(det.summary.avg_pace_s_per_m * 1000), "/km"]);
  else if (det.avg.speed) tiles.push(["Avg speed", (det.avg.speed * 3.6).toFixed(1), "km/h"]);
  if (det.summary?.calories_kcal) tiles.push(["Calories", String(Math.round(det.summary.calories_kcal)), "kcal"]);
  if (det.avg.heart_rate) tiles.push(["Avg HR", String(Math.round(det.avg.heart_rate)), "bpm"]);
  if (det.avg.power) tiles.push(["Avg power", String(Math.round(det.avg.power)), "W"]);
  return tiles.length > 1 ? tiles : null;
}

/** REAL statistics groups built from resolved streams (avg/max/series). */
function buildRealStatsGroups(det: ActivityDetailVM): StatsGroup[] {
  if (!det.hasReal || !Object.keys(det.series).length) return [];
  const groups: StatsGroup[] = [];
  const r = (v: number) => Math.round(v);

  if (det.avg.heart_rate != null || det.max.heart_rate != null) {
    const rows: [string, string, string][] = [];
    if (det.avg.heart_rate != null) rows.push(["Avg HR", String(r(det.avg.heart_rate)), "bpm"]);
    if (det.max.heart_rate != null) rows.push(["Max HR", String(r(det.max.heart_rate)), "bpm"]);
    groups.push({ title: "Heart rate", icon: "drop", rows });
  }

  if (det.avg.speed != null || det.max.speed != null) {
    const rows: [string, string, string][] = [];
    if (det.avg.speed != null) rows.push(["Avg speed", (det.avg.speed * 3.6).toFixed(1), "km/h"]);
    if (det.max.speed != null) rows.push(["Max speed", (det.max.speed * 3.6).toFixed(1), "km/h"]);
    groups.push({ title: "Speed", icon: "bolt", rows });
  }

  if (det.avg.cadence != null || det.max.cadence != null) {
    const rows: [string, string, string][] = [];
    if (det.avg.cadence != null) rows.push(["Avg cadence", String(r(det.avg.cadence)), "rpm"]);
    if (det.max.cadence != null) rows.push(["Max cadence", String(r(det.max.cadence)), "rpm"]);
    groups.push({ title: "Cadence", icon: "pulse", rows });
  }

  if (det.avg.power != null || det.max.power != null) {
    const rows: [string, string, string][] = [];
    if (det.avg.power != null) rows.push(["Avg power", String(r(det.avg.power)), "W"]);
    if (det.max.power != null) rows.push(["Max power", String(r(det.max.power)), "W"]);
    groups.push({ title: "Power", icon: "bolt", rows });
  }

  const alt = det.series.altitude;
  if (alt && alt.length) {
    groups.push({
      title: "Elevation",
      icon: "trend",
      rows: [
        ["Min elevation", String(r(Math.min(...alt))), "m"],
        ["Max elevation", String(r(Math.max(...alt))), "m"],
      ],
    });
  }

  // Running dynamics — only the fields that actually have data.
  const rd: [string, string, string][] = [];
  if (det.avg.vertical_oscillation != null) rd.push(["Vert. oscillation", det.avg.vertical_oscillation.toFixed(1), "mm"]);
  if (det.avg.ground_contact_time != null) rd.push(["Ground contact", String(r(det.avg.ground_contact_time)), "ms"]);
  if (det.avg.form_power != null) rd.push(["Avg form power", String(r(det.avg.form_power)), "W"]);
  if (det.avg.leg_spring_stiffness != null) rd.push(["Leg stiffness", det.avg.leg_spring_stiffness.toFixed(1), "kN/m"]);
  if (det.avg.stride_length != null) rd.push(["Avg stride", det.avg.stride_length.toFixed(2), "m"]);
  if (rd.length) groups.push({ title: "Running dynamics", icon: "pulse", rows: rd });

  return groups;
}

/* ---------- Verify tab: per-activity old-vs-new variant diff + override ---------- */
type DerMetric = {
  plugin_id: string;
  version: string;
  params_hash: string;
  name: string;
  value: number;
  computed_at: string;
};
const VERIFY_PLUGIN_LABEL: Record<string, string> = {
  training_load: "Training Load",
  training_effect: "Training Effect",
};

function VerifyTab({ activityId }: { activityId: string }) {
  const [all, setAll] = useState<DerMetric[]>([]);
  const [active, setActive] = useState<DerMetric[]>([]);
  const [variants, setVariants] = useState<DerivationVariant[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = () => {
    const subj = `activity:${activityId}`;
    void Promise.allSettled([getDerived(subj, "all"), getDerived(subj), getVariants()]).then(
      ([a, b, v]) => {
        if (a.status === "fulfilled") setAll(a.value.metrics as unknown as DerMetric[]);
        if (b.status === "fulfilled") setActive(b.value.metrics as unknown as DerMetric[]);
        if (v.status === "fulfilled") setVariants(v.value);
      },
    );
  };
  useEffect(reload, [activityId]);

  const fnum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  const paramsByHash = new Map(variants.map((v) => [v.params_hash, v.params] as const));
  const activeHashByPlugin = new Map<string, string>();
  for (const m of active) activeHashByPlugin.set(m.plugin_id, m.params_hash);

  type PG = { version: string; hashes: string[]; metrics: Map<string, Map<string, number>> };
  const plugins = new Map<string, PG>();
  for (const m of all) {
    let pg = plugins.get(m.plugin_id);
    if (!pg) {
      pg = { version: m.version, hashes: [], metrics: new Map() };
      plugins.set(m.plugin_id, pg);
    }
    if (!pg.hashes.includes(m.params_hash)) pg.hashes.push(m.params_hash);
    let mm = pg.metrics.get(m.name);
    if (!mm) {
      mm = new Map();
      pg.metrics.set(m.name, mm);
    }
    mm.set(m.params_hash, m.value);
  }

  // Param keys that differ across a plugin's variants (drive the version labels).
  const diffKeys = (hashes: string[]): string[] => {
    const objs = hashes.map((h) => paramsByHash.get(h)).filter(Boolean) as Record<string, number>[];
    if (objs.length < 2) return [];
    const keys = new Set<string>();
    for (const o of objs) for (const k of Object.keys(o)) keys.add(k);
    return [...keys].filter((k) => {
      const vals = objs.map((o) => o[k] ?? 0);
      return vals.some((x) => Math.abs(x - vals[0]) > 1e-9);
    });
  };
  const verLabel = (h: string, keys: string[]): string => {
    const p = paramsByHash.get(h);
    if (!p || !keys.length) return h.slice(0, 8);
    return keys.map((k) => `${k.split(".").pop()} ${fnum(p[k] ?? 0)}`).join(" · ");
  };

  const setOverride = (plugin: string, version: string, hash: string | null) => {
    setBusy(true);
    const body = hash
      ? { scope: "activity" as const, subject_id: activityId, plugin_id: plugin, version, params_hash: hash }
      : { scope: "activity" as const, subject_id: activityId, plugin_id: plugin, clear: true };
    void setSelection(body).then(reload).finally(() => setBusy(false));
  };

  if (!all.length) {
    return (
      <Card>
        <NoData label="Nothing computed yet" hint="Recompute analytics to populate this activity's derived values." />
      </Card>
    );
  }

  return (
    <Card title="Verify · versions" sub="compare & override">
      <p style={{ margin: "0 0 6px", fontSize: 13, lineHeight: 1.5, color: "var(--text-dim)" }}>
        Every value here is produced by a versioned algorithm. When you've tuned a parameter, each
        version is shown side by side so you can check new vs old — and pin this single activity to
        a specific version.
      </p>
      {[...plugins.entries()].map(([plugin, pg]) => {
        const activeHash = activeHashByPlugin.get(plugin);
        const dk = diffKeys(pg.hashes);
        const multi = pg.hashes.length > 1;
        return (
          <div key={plugin} style={{ borderTop: "1px solid var(--line)", padding: "12px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>{VERIFY_PLUGIN_LABEL[plugin] ?? plugin}</span>
              <span className="pill" style={{ fontSize: 10, color: "var(--text-dim)" }}>v{pg.version}</span>
              {!multi && (
                <span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>one version</span>
              )}
            </div>
            {/* per-metric values across versions */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[...pg.metrics.entries()].map(([name, vals]) => {
                const activeVal = activeHash != null ? vals.get(activeHash) : undefined;
                return (
                  <div key={name} style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-dim)", minWidth: 150 }}>
                      {name}
                    </span>
                    {pg.hashes.map((h) => {
                      const val = vals.get(h);
                      if (val == null) return null;
                      const isActive = h === activeHash;
                      const delta = activeVal != null && !isActive ? val - activeVal : null;
                      return (
                        <span
                          key={h}
                          style={{
                            display: "inline-flex",
                            alignItems: "baseline",
                            gap: 5,
                            fontFamily: "var(--font-mono)",
                            fontSize: 13,
                            padding: "2px 9px",
                            borderRadius: 8,
                            border: `1px solid ${isActive ? "var(--blue)" : "var(--line)"}`,
                            background: isActive ? tint("var(--blue)", 10) : "transparent",
                            color: isActive ? "var(--text)" : "var(--text-dim)",
                          }}
                        >
                          {fnum(val)}
                          {delta != null && Math.abs(delta) > 1e-9 && (
                            <i
                              style={{
                                fontStyle: "normal",
                                fontSize: 11,
                                color: delta > 0 ? "var(--good)" : "var(--low)",
                              }}
                            >
                              {delta > 0 ? "+" : ""}
                              {fnum(delta)}
                            </i>
                          )}
                        </span>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            {/* version chooser for this activity */}
            {multi && (
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
                <span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>This activity uses:</span>
                {pg.hashes.map((h) => (
                  <button
                    key={h}
                    disabled={busy}
                    onClick={() => setOverride(plugin, pg.version, h)}
                    className="chip"
                    style={
                      h === activeHash
                        ? { borderColor: tint("var(--blue)", 40), color: "var(--blue)", background: tint("var(--blue)", 12) }
                        : undefined
                    }
                  >
                    {verLabel(h, dk)}
                  </button>
                ))}
                <button disabled={busy} onClick={() => setOverride(plugin, pg.version, null)} className="chip">
                  Auto
                </button>
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}

export function ActivityDetail({ act, onChanged }: { act: ActivityRow; onChanged?: () => void }) {
  const det = useActivityDetailData(act.id, act.dur);
  const [tab, setTab] = useState<string>("Overview");
  const tabs = ["Overview", "Statistics", "Graphs", "Verify", "Edit"];
  // Training Effect: only render when the real training_effect algorithm has run.
  const hasTE = det.derived.training_effect_aerobic != null;
  const TE = hasTE
    ? (() => {
        const aerobic = det.derived.training_effect_aerobic;
        const anaerobic = det.derived.training_effect_anaerobic ?? 0;
        return {
          aerobic,
          anaerobic,
          load: det.derived.exercise_load != null ? Math.round(det.derived.exercise_load) : null,
          label: teLabel(aerobic, anaerobic),
        };
      })()
    : null;
  // REAL data only — empty state where the API has nothing yet.
  const summaryTiles = buildRealSummary(det);
  const realGraphs = buildRealGraphs(det);
  const statsGroups = buildRealStatsGroups(det);
  // Heart rate is shown only when the activity actually has HR avg/series.
  const hrAvg = det.avg.heart_rate != null ? Math.round(det.avg.heart_rate) : null;
  const hrMax = det.max.heart_rate != null ? Math.round(det.max.heart_rate) : null;
  const hrSeries = det.series.heart_rate ?? null;
  // Summary-only activity: no resolved streams → no detailed Statistics/Graphs.
  const hasStreams = det.hasReal && Object.keys(det.series).length > 0;
  // Exportable to .fit when there's at least one resolved scalar stream or track.
  const exportable = hasStreams || !!det.track;
  const noStreamsEmpty = (
    <Card>
      <div style={{ textAlign: "center", padding: "28px 10px", color: "var(--text-faint)" }}>
        <Icon name="pulse" size={28} />
        <div style={{ marginTop: 8, fontSize: 13.5 }}>No detailed data for this activity</div>
      </div>
    </Card>
  );
  return (
    <div className="detail">
      <DetailHeader
        title={act.sportLabel}
        sub={act.when}
        accent="var(--good)"
        right={
          <span className="pill live">
            <i />
            local
          </span>
        }
      />
      <div className="scroll">
        <div className="stack">
          {/* hero */}
          <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
            <SportBadge sport={act.sport} size={48} />
            <div>
              <div style={{ fontSize: 12.5, color: "var(--text-dim)", fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                <Icon name="cal" size={13} />
                {act.when}
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 22, fontWeight: 700, marginTop: 2 }}>{fmtDur(act.dur)}</div>
            </div>
          </div>
          {/* tabs */}
          <div className="chiprow" style={{ borderBottom: "1px solid var(--line)", gap: 2 }}>
            {tabs.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  padding: "10px 15px",
                  fontSize: 13.5,
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                  color: tab === t ? "var(--text)" : "var(--text-faint)",
                  borderBottom: tab === t ? "2px solid var(--blue)" : "2px solid transparent",
                  marginBottom: -1,
                }}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === "Verify" && <VerifyTab activityId={act.id} />}

          {tab === "Overview" && (
            <>
              {summaryTiles ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 12 }}>
                  {summaryTiles.map(([l, v, u], i) => (
                    <Card key={i} style={{ padding: 15 }}>
                      <div className="kpi-label">{l}</div>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 26, fontWeight: 700, marginTop: 3 }}>
                        {v}
                        {u && <span style={{ fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-sans)", marginLeft: 3 }}>{u}</span>}
                      </div>
                    </Card>
                  ))}
                </div>
              ) : (
                <Card>
                  <NoData label="No summary yet" hint="This activity has no resolved stats." height={80} />
                </Card>
              )}
              <MapCard track={det.track} source={act.sportLabel} />
              {TE ? (
                <Card title="Training effect" sub={TE.label}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginBottom: 4 }}>
                    <div>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 30, fontWeight: 700, color: "var(--ok)" }}>{TE.aerobic}</div>
                      <div className="kpi-label">Aerobic</div>
                      <TEBar value={TE.aerobic} />
                    </div>
                    <div>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 30, fontWeight: 700, color: "var(--text-dim)" }}>{TE.anaerobic}</div>
                      <div className="kpi-label">Anaerobic</div>
                      <TEBar value={TE.anaerobic} />
                    </div>
                  </div>
                  <div className="setting-row" style={{ marginTop: 12 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-dim)" }}>Exercise load</span>
                    <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700 }}>{TE.load == null ? "—" : TE.load}</span>
                  </div>
                </Card>
              ) : (
                <Card title="Training effect">
                  <NoData label="Training effect not computed yet" hint="Run a recompute to estimate aerobic / anaerobic load." height={80} />
                </Card>
              )}
              {hrAvg != null && (
                <Card title="Heart rate" sub="avg · max">
                  <div style={{ display: "flex", gap: 30, marginBottom: 12 }}>
                    <div>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 28, fontWeight: 700, color: "var(--rhr)" }}>{hrAvg}</span>
                      <span style={{ fontSize: 12, color: "var(--text-dim)", marginLeft: 4 }}>bpm avg</span>
                    </div>
                    <div>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 28, fontWeight: 700 }}>{hrMax == null ? "—" : hrMax}</span>
                      <span style={{ fontSize: 12, color: "var(--text-dim)", marginLeft: 4 }}>bpm max</span>
                    </div>
                  </div>
                  {hrSeries && hrSeries.length > 0 && (
                    <AreaChart data={hrSeries} color="var(--rhr)" height={150} durSec={det.durationSec} />
                  )}
                </Card>
              )}
            </>
          )}

          {tab === "Statistics" &&
            (hasStreams ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(270px,1fr))", gap: 14, alignItems: "start" }}>
                {statsGroups.map((g, i) => (
                  <StatGroup key={i} g={g} />
                ))}
              </div>
            ) : (
              noStreamsEmpty
            ))}

          {tab === "Graphs" &&
            (!hasStreams || realGraphs.length === 0
              ? noStreamsEmpty
              : realGraphs.map((g, i) => (
                  <Card key={i}>
                    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 9, height: 9, borderRadius: 3, background: g.color }} />
                        <span style={{ fontWeight: 700, fontSize: 15 }}>{g.label}</span>
                      </div>
                      <div style={{ display: "flex", gap: 16 }}>
                        <span style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
                          <b style={{ fontFamily: "var(--font-mono)", color: "var(--text)", fontSize: 15 }}>{g.avg}</b> Avg
                        </span>
                        <span style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
                          <b style={{ fontFamily: "var(--font-mono)", color: "var(--text)", fontSize: 15 }}>{g.max}</b> Max
                        </span>
                      </div>
                    </div>
                    <AreaChart data={g.series} color={g.color} height={150} durSec={det.durationSec} valueFmt={g.fmt} />
                    <span className="src-tag" style={{ marginTop: 10 }}>
                      <i />
                      resolved · best source
                    </span>
                  </Card>
                )))}

          {tab === "Edit" && (
            <EditTab
              act={act}
              recordings={det.recordings}
              exportable={exportable}
              reload={det.reload}
              onChanged={onChanged}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   ACTIVITIES LIST (REAL) + this-week hero (REAL)
   ============================================================ */
export function Activities() {
  const nav = useNav();
  const { rows, counts, reload } = useActivitiesList();
  const wk = useTrainingSummary("Week", 0);
  const [filter, setFilter] = useState("All");
  const filters = ["All", "Running", "Cycling", "Walking", "Strength", "Activity"];
  const list = filter === "All" ? rows : rows.filter((a) => a.sportLabel === filter);

  // Manual file import (.fit/.gpx/.tcx → POST /api/import). The dedup/fusion
  // pipeline handles re-imports idempotently, so a stray duplicate is harmless.
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const onImportFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setImporting(true);
    setImportMsg(null);
    try {
      const res = await importFiles(files);
      reload();
      window.dispatchEvent(new Event("ofit:data-updated"));
      setImportMsg(`Imported ${res.length} file${res.length === 1 ? "" : "s"}.`);
    } catch (e) {
      setImportMsg(`Import failed — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="stack fade-up">
      {/* HERO — this week (REAL) */}
      <Card title="This week" sub="training" onClick={() => nav.push(<TrainingSummary />)}>
        <div style={{ display: "flex", gap: 22, marginBottom: 14 }}>
          <div className="kpi">
            <span className="kpi-label">Sessions</span>
            <span className="kpi-val" style={{ fontSize: 30 }}>
              <CountUp to={wk.sessions} />
            </span>
          </div>
          <div className="kpi">
            <span className="kpi-label">Total time</span>
            <span className="kpi-val" style={{ fontSize: 30 }}>
              <CountUp to={wk.mins} />
              <small>min</small>
            </span>
          </div>
          <div className="kpi">
            <span className="kpi-label">Distance</span>
            <span className="kpi-val" style={{ fontSize: 30 }}>
              {wk.dist == null ? "—" : wk.dist}
              <small>km</small>
            </span>
          </div>
        </div>
        <Bars data={wk.bars} height={120} colorFn={() => "var(--run)"} valueFmt={(v) => v || ""} />
      </Card>

      {/* RECORD BUTTON — pinned prominent */}
      <button className="btn btn-primary" onClick={() => nav.push(<RecordFlow />)}>
        <Icon name="play" size={18} fill="currentColor" stroke={0} />
        Record workout
      </button>

      {/* IMPORT — upload a recorded .fit / .gpx / .tcx file */}
      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".fit,.gpx,.tcx"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = "";
          void onImportFiles(f);
        }}
      />
      <button className="btn" disabled={importing} onClick={() => fileRef.current?.click()}>
        <Icon name="upload" size={17} />
        {importing ? "Importing…" : "Import .fit / .gpx / .tcx"}
      </button>
      {importMsg && (
        <div className="faint" style={{ fontSize: 13, marginTop: -6, textAlign: "center" }}>{importMsg}</div>
      )}

      {/* FILTERS */}
      <div className="chiprow">
        {filters.map((f) => {
          const n = counts[f];
          return (
            <Chip key={f} active={filter === f} onClick={() => setFilter(f)}>
              {f}
              {n != null ? ` · ${n}` : ""}
            </Chip>
          );
        })}
      </div>

      {/* LIST */}
      <Card noPad>
        <div className="list" style={{ padding: "0 16px" }}>
          {list.map((a) => (
            <div className="lrow" key={a.id} onClick={() => nav.push(<ActivityDetail act={a} onChanged={reload} />)}>
              <SportBadge sport={a.sport} />
              <div className="lrow-main">
                <div className="lrow-title">{a.sportLabel}</div>
                <div className="lrow-meta">
                  {a.when}
                  {a.dist ? ` · ${a.dist} km` : ""}
                </div>
              </div>
              <div className="lrow-right">
                <div className="lrow-dur">{fmtDur(a.dur)}</div>
                {a.rec > 1 ? <span className="lrow-tag">{a.rec} sources</span> : a.pace ? <span className="lrow-meta">{a.pace} /km</span> : null}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
