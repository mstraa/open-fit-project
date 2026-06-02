/* ============================================================
   OpenFit redesign — reusable "tap to expand" MetricDetail engine
   + per-metric "What this means" copy. Ported from js/shared.jsx.
   The generated series is illustrative (MOCK) — wire a real
   per-metric history endpoint later; the chrome stays the same.
   ============================================================ */
import { useState, type ReactNode } from "react";
import { DetailHeader, SegTabs, Card, MMM, Icon } from "./ui";
import { LineChart, Bars } from "./charts";
import { useMetricHistory, type HistorySpec, type Range } from "./wiring";

export const META_ABOUT: Record<string, string> = {
  readiness:
    "A 0–100 score blending last night’s HRV, resting heart-rate and recent training load, compared against your own baseline. It estimates how recovered your body is. 80–100 = primed for a hard session; 50–79 (“Balanced”) = train, but keep it moderate; below 50 = prioritise rest. A low score after hard training, poor sleep, alcohol or stress is normal — it should rebound within a day or two.",
  steps:
    "Total steps counted by the accelerometer in your watch/band. A common baseline is 7,000–10,000/day; consistently under ~5,000 is considered sedentary. Steps are the simplest measure of everyday movement — more daily activity supports heart health, metabolism and mood independent of formal workouts.",
  "body battery":
    "A 0–100 estimate of your energy reserve, derived from HRV, resting HR, stress and activity. It charges during rest and especially deep sleep, and drains with exertion and stress. Waking high (>70) means a full tank; ending the day low is normal. If you rarely recharge above ~40, you’re likely under-recovering — protect sleep and add easy days.",
  "resting heart rate":
    "Beats per minute when fully at rest, measured overnight by the optical sensor. Typical adults sit 60–100; fit endurance athletes often 40–55. Lower generally means a stronger, more efficient heart and good recovery. A resting HR trending several beats above your normal can flag fatigue, dehydration, stress or oncoming illness.",
  hrv:
    "Heart-rate variability (ms) is the tiny variation in time between heartbeats, captured overnight — a window onto your nervous system. Higher HRV usually means better recovery and a relaxed, parasympathetic state; lower means stress or fatigue. Absolute numbers vary hugely between people, so what matters is your own trend versus your baseline band, not comparing to others.",
  stress:
    "A 0–100 score inferred from HRV throughout the day. Lower is calmer. Zones: Rest (recovering), Low, Medium and High (sustained sympathetic “fight-or-flight” load). Brief spikes from exercise or coffee are fine; long stretches in Medium/High without recovery wear you down — use breathing or a walk to bring it back to Rest.",
  "heart rate":
    "Beats per minute across the day. Lows occur at rest and in deep sleep; highs during exertion or stress. Knowing your max (~220 minus age) and resting HR lets you read effort — easy aerobic work sits in the lower zones, hard intervals near the top. A resting HR that drifts up over days can signal you need recovery.",
  "deep sleep":
    "Deep (slow-wave) sleep is the most physically restorative stage — when growth hormone peaks and the body repairs muscle and tissue. Aim for roughly 13–23% of the night (about 1–2h). It’s hardest to wake from and concentrated early in the night; alcohol, late meals and stress reduce it.",
  "rem sleep":
    "REM (dream) sleep consolidates memory, learning and emotional balance. It typically makes up ~20–25% of the night and lengthens toward morning. Too little — often from short sleep or alcohol — leaves you foggy and irritable even if total time looks fine.",
  "awake time":
    "Minutes spent awake after you first fell asleep (not counting the time to drift off). A few short wake-ups per night is completely normal. Frequent or long awakenings fragment your sleep cycles and blunt recovery — watch for caffeine, a warm room, or stress as causes.",
  "sleep heart rate":
    "Your average heart rate while asleep, usually a few beats below your daytime resting HR and lowest in deep sleep. A low, stable overnight HR signals good recovery; an elevated night HR can point to late eating, alcohol, illness or stress.",
  hypopnea:
    "Events per hour where breathing became shallow or briefly paused during sleep. Under ~5/h is generally considered normal. Persistently high values can fragment sleep and lower oxygen — if consistently elevated, it’s worth discussing screening for sleep apnea with a doctor.",
  "breathing rate":
    "Breaths per minute while asleep, from chest-movement and HR patterns. Most adults sit around 12–20 and stay remarkably stable night to night. A sudden rise can reflect fever, stress or illness, so your personal baseline is the thing to watch.",
  weight:
    "Body weight (kg), from a connected scale or imported history. Watch the trend, not the daily number — weight swings 1–2 kg day to day from water, food and glycogen, so a multi-week direction is what matters. Weigh under consistent conditions (e.g. mornings) and pair it with body-fat and training to tell muscle gain from fat loss.",
};

/** Human label for the current history window (relative to now). */
function windowLabel(range: Range, offset: number): string {
  const u = range.toLowerCase();
  if (range === "Day") {
    if (offset === 0) return "Today";
    if (offset === -1) return "Yesterday";
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  if (offset === 0) return `This ${u}`;
  if (offset === -1) return `Last ${u}`;
  return `${-offset} ${u}s ago`;
}

/** Tap-to-expand metric history. Fully REAL via useMetricHistory(source, range) —
 *  no synthetic data; an empty state renders when a metric has no recorded data. */
export function MetricDetail({
  title,
  sub,
  accent = "var(--blue)",
  unit = "",
  source,
  ranges,
  chart = "line",
  insight,
  about,
  extra,
  decimals = 0,
  initialOffset = 0,
}: {
  title: string;
  sub?: string;
  accent?: string;
  unit?: string;
  /** Real data source for the history series. */
  source: HistorySpec;
  ranges?: Range[];
  chart?: "line" | "bar";
  insight?: ReactNode;
  about?: string;
  extra?: ReactNode;
  decimals?: number;
  /** Initial period offset (0 = current); e.g. open anchored to a clicked night. */
  initialOffset?: number;
}) {
  // Per-night & per-day-only metrics have no meaningful "Day" intraday view.
  const defaults: Range[] =
    source.src === "sleep" || source.src === "readiness" ? ["Week", "Month", "Year"] : ["Day", "Week", "Month", "Year"];
  const rs = ranges ?? defaults;
  const [range, setRange] = useState<Range>(rs.includes("Week") ? "Week" : rs[0]);
  // History browsing: 0 = current period, -1 = previous, … Reset to 0 when the
  // granularity changes so you always re-enter at "now".
  const [offset, setOffset] = useState(initialOffset);
  const { data, xLabels, min, avg, max, real, loading } = useMetricHistory(source, range, decimals, offset);
  const aboutText = about || META_ABOUT[(title || "").toLowerCase()];
  const fmt = (v: number) => (decimals ? v.toFixed(decimals) : Math.round(v));
  return (
    <div className="detail">
      <DetailHeader title={title} sub={sub} accent={accent} />
      <div className="scroll">
        <div className="stack">
          <div style={{ display: "flex", justifyContent: "center" }}>
            <SegTabs
              options={rs}
              value={range}
              onChange={(r) => {
                setRange(r);
                setOffset(0);
              }}
            />
          </div>
          {/* History stepper — page back/forward through past periods. */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <button className="icon-btn" onClick={() => setOffset((o) => o - 1)} aria-label={`Previous ${range.toLowerCase()}`}>
              <Icon name="chevL" size={18} />
            </button>
            <div style={{ textAlign: "center", fontWeight: 700, fontSize: 14.5 }}>{windowLabel(range, offset)}</div>
            <button
              className="icon-btn"
              disabled={offset === 0}
              style={{ opacity: offset === 0 ? 0.35 : 1 }}
              onClick={() => setOffset((o) => Math.min(0, o + 1))}
              aria-label={`Next ${range.toLowerCase()}`}
            >
              <Icon name="chevR" size={18} />
            </button>
          </div>
          <Card>
            {real ? (
              <>
                <MMM min={min} avg={avg} max={max} unit={unit} />
                {chart === "bar" ? (
                  <Bars data={data.map((v, i) => ({ v, d: xLabels[i] ?? "" }))} color={accent} height={210} valueFmt={(v) => v || ""} />
                ) : (
                  <LineChart
                    data={data}
                    xLabels={xLabels}
                    color={accent}
                    height={210}
                    showDots={range === "Week"}
                    valueLabels={range === "Week"}
                    interactive
                    fill
                    valueFmt={fmt}
                    dateFmt={(i) => xLabels[i] || ""}
                  />
                )}
              </>
            ) : (
              <div className="empty-state">
                <div className="empty-ic">
                  <Icon name="dot" size={20} stroke={2.5} />
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{loading ? "Loading…" : "No history yet"}</div>
                <div style={{ fontSize: 12.5, color: "var(--text-faint)", lineHeight: 1.5, maxWidth: 280, margin: "0 auto" }}>
                  {loading ? "Fetching your data." : "No data is recorded for this metric yet."}
                </div>
              </div>
            )}
          </Card>
          {aboutText && (
            <div className="card">
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
                <span style={{ width: 8, height: 8, borderRadius: 3, background: accent }} />
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-faint)" }}>
                  What this means
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: "var(--text-dim)" }}>{aboutText}</p>
            </div>
          )}
          {real && (
            <Card>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: "var(--text-dim)" }}>
                {insight ??
                  `Over the ${range.toLowerCase()}, your ${title.toLowerCase()} averaged ${fmt(avg)}${unit ? " " + unit : ""} (range ${fmt(min)}–${fmt(max)}${unit ? " " + unit : ""}).`}
              </p>
            </Card>
          )}
          {extra}
        </div>
      </div>
    </div>
  );
}
