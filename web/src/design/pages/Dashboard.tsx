/* ============================================================
   OpenFit — Dashboard page (ported from js/dashboard.jsx).
   Mock D.* reads are replaced with real wiring hooks where noted;
   each hook already falls back to the design mocks internally.
   ============================================================ */
import { useState } from "react";
import {
  Card,
  SectionLabel,
  StatTile,
  SegTabs,
  Legend,
  useNav,
  Icon,
  SportBadge,
  DetailHeader,
  NoData,
} from "../ui";
import { Ring, MultiLine, StackedBars, Spark, Bars, AreaChart, type MultiSeries } from "../charts";
import { MetricDetail } from "../shared";
import {
  VOL_KEYS,
  VOL_COLORS,
} from "../data";
import { fmtDay } from "../util";
import {
  useTrainingLoadSeries,
  useStepsToday,
  useStepsWeek,
  useSleepNights,
  useBodyBattery,
  useWellnessLatest,
  useDailyTrend,
  useWeeklyVolume,
} from "../wiring";
import type { Sport } from "../../api/types";

/* Keys/colors for the stacked weekly-volume chart (mock — no per-sport endpoint). */
const VOLUME_KEYS = VOL_KEYS as unknown as ("running" | "cycling" | "walking" | "strength" | "activity")[];
const VOLUME_COLORS = VOL_COLORS;

/* Labels used by the 8-week totals list → real lowercase Sport for the badge. */
const VOL_LABELS: { label: string; sport: Sport }[] = [
  { label: "Running", sport: "running" },
  { label: "Cycling", sport: "cycling" },
  { label: "Walking", sport: "walking" },
  { label: "Strength", sport: "strength" },
  { label: "Activity", sport: "other" },
];

type TLRange = "6w" | "12w" | "26w";

/* ---- Training load detail ---- */
export function TrainingLoadDetail() {
  const [range, setRange] = useState<TLRange>("26w");
  const tl = useTrainingLoadSeries();
  const sliceN = ({ "6w": 42, "12w": 84, "26w": 182 } as const)[range];
  const slice = tl.points.slice(-sliceN);
  const series: MultiSeries[] = [
    { color: "var(--blue)", short: "CTL", data: slice.map((d) => d.ctl) },
    { color: "var(--ok)", short: "ATL", data: slice.map((d) => d.atl) },
    { color: "var(--good)", short: "TSB", data: slice.map((d) => d.tsb) },
  ];
  const dateFmt = (i: number) => fmtDay(slice[i].date);
  const last = slice[slice.length - 1];
  if (!tl.real || !last) {
    return (
      <div className="detail">
        <DetailHeader title="Training load & fitness" sub="Fitness · Fatigue · Form" accent="var(--blue)" />
        <div className="scroll">
          <div className="stack">
            <Card>
              <NoData label="No training load yet" hint="Import activities with heart-rate data, then run a recompute." height={220} />
            </Card>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="detail">
      <DetailHeader title="Training load & fitness" sub="Fitness · Fatigue · Form" accent="var(--blue)" />
      <div className="scroll">
        <div className="stack">
          <div style={{ display: "flex", justifyContent: "center" }}>
            <SegTabs options={["6w", "12w", "26w"] as const} value={range} onChange={setRange} />
          </div>
          <Card>
            <MultiLine series={series} height={220} dateFmt={dateFmt} />
            <Legend
              items={[
                { color: "var(--blue)", label: "Fitness (CTL)" },
                { color: "var(--ok)", label: "Fatigue (ATL)" },
                { color: "var(--good)", label: "Form (TSB)" },
              ]}
            />
          </Card>
          <div className="row2">
            <StatTile icon="trend" label="Fitness CTL" value={Math.round(last.ctl)} accent="var(--blue)" />
            <StatTile icon="bolt" label="Fatigue ATL" value={Math.round(last.atl)} accent="var(--ok)" />
            <StatTile icon="gauge" label="Form TSB" value={Math.round(last.tsb)} accent="var(--good)" />
            <StatTile icon="pulse" label="Load 7d" value={Math.round(last.ctl)} accent="var(--blue)" />
          </div>
          <Card>
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: "var(--text-dim)" }}>
              Your form (TSB) is at <b style={{ color: "var(--text)" }}>{Math.round(last.tsb)}</b> —{" "}
              {Math.round(last.tsb) < 0
                ? "you're carrying fatigue from recent training. Fitness is building, so this is productive overload; ease back for a couple of days to let form rebound."
                : "you're fresh and recovered. Form has rebounded above baseline — a good window for a hard session or a race effort."}
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ---- Weekly volume detail ---- */
export function VolumeDetail() {
  const volume = useWeeklyVolume();
  const totals = VOLUME_KEYS.map((k) => volume.data.reduce((s, w) => s + w[k], 0));
  if (!volume.real || !volume.data.length) {
    return (
      <div className="detail">
        <DetailHeader title="Weekly volume" sub="Training time by sport" accent="var(--run)" />
        <div className="scroll">
          <div className="stack">
            <Card>
              <NoData label="No activities yet" hint="Import activities to see weekly training volume." height={230} />
            </Card>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="detail">
      <DetailHeader title="Weekly volume" sub="Training time by sport" accent="var(--run)" />
      <div className="scroll">
        <div className="stack">
          <Card>
            <StackedBars data={volume.data} keys={VOLUME_KEYS} colors={VOLUME_COLORS} height={230} />
            <Legend
              items={[
                { color: "var(--run)", label: "Running" },
                { color: "var(--cycle)", label: "Cycling" },
                { color: "var(--walk)", label: "Walking" },
                { color: "var(--strength)", label: "Strength" },
                { color: "var(--activity)", label: "Activity" },
              ]}
            />
          </Card>
          <SectionLabel>8-week totals</SectionLabel>
          <Card noPad>
            <div className="list" style={{ padding: "0 16px" }}>
              {VOL_LABELS.map(({ label, sport }, i) => (
                <div className="lrow" key={label}>
                  <SportBadge sport={sport} size={34} />
                  <div className="lrow-main">
                    <div className="lrow-title" style={{ fontSize: 14 }}>
                      {label}
                    </div>
                  </div>
                  <div className="lrow-dur">
                    {Math.floor(totals[i] / 60)}h {totals[i] % 60}m
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

export function Dashboard() {
  const nav = useNav();

  // Steps (real → mock fallback handled by the hooks).
  const stepsToday = useStepsToday();
  const stepsWeek = useStepsWeek();

  // Sleep score (real nights → mock fallback handled by the hook).
  const sleep = useSleepNights();
  const sleepScore = sleep.nights[0]?.score;

  // Training load CTL/ATL/TSB series (real → mock).
  const tl = useTrainingLoadSeries();
  const slice = tl.points.slice(-126);
  const series: MultiSeries[] = [
    { color: "var(--blue)", short: "CTL", data: slice.map((d) => d.ctl) },
    { color: "var(--ok)", short: "ATL", data: slice.map((d) => d.atl) },
    { color: "var(--good)", short: "TSB", data: slice.map((d) => d.tsb) },
  ];
  const loadValue = tl.real ? Math.round(tl.last.ctl) : "—";
  const loadForm = Math.round(tl.last.tsb);

  // Body battery hero (real intraday only — no synthetic curve).
  const bb = useBodyBattery();

  // Weekly volume by sport (real → empty state when no activities).
  const volume = useWeeklyVolume();

  // Resting HR tile + wellness glance KPIs (real → "—" / no spark when absent).
  const restingHR = useWellnessLatest("resting_heart_rate");
  const restingHRTrend = useDailyTrend("resting_heart_rate", 7);
  const restingHRSpark = restingHRTrend.days.length ? restingHRTrend.days.map((d) => d.last) : [];
  const hrv = useWellnessLatest("hrv");
  const hrvTrend = useDailyTrend("hrv", 7);
  const hrvSpark = hrvTrend.days.length ? hrvTrend.days.map((d) => d.last) : [];
  const stress = useWellnessLatest("stress");
  const stressTrend = useDailyTrend("stress", 7);
  const stressSpark = stressTrend.days.length ? stressTrend.days.map((d) => d.last) : [];
  const sleepScoreSpark = sleep.nights.slice(0, 7).reverse().map((n) => n.score);

  return (
    <div className="stack fade-up">
      {/* HERO — body battery ring (MOCK) */}
      <Card
        onClick={() =>
          nav.push(
            <MetricDetail
              title="Body battery"
              sub="Energy reserve"
              accent="var(--good)"
              unit="%"
              source={{ src: "wellness", kind: "body_battery", intraday: true }}
            />,
          )
        }
      >
        {bb.real ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
              <Ring value={bb.now} size={150} stroke={12} bands={[40, 72]} label="Body battery" sub="reserve" />
              <div style={{ flex: 1 }}>
                <div className="kpi-grid" style={{ gridTemplateColumns: "1fr" }}>
                  <div className="kpi">
                    <span className="kpi-label">At wake</span>
                    <span className="kpi-val">
                      {bb.atWake}<small>%</small>
                    </span>
                  </div>
                  <div className="kpi">
                    <span className="kpi-label">Low today</span>
                    <span className="kpi-val">
                      {bb.lowToday}<small>%</small>
                    </span>
                  </div>
                </div>
                <span className="pill" style={{ marginTop: 12, color: "var(--good)" }}>
                  <Icon name="battery" size={13} color="var(--good)" />
                  +{bb.charged} charged
                </span>
              </div>
            </div>
            <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
              <div className="section-label" style={{ padding: "0 0 2px" }}>
                Throughout today
              </div>
              <AreaChart data={bb.curve} color="var(--good)" height={110} durSec={bb.spanSec} ticks={2} valueFmt={(v) => Math.round(v)} />
            </div>
          </>
        ) : (
          <NoData label="Body battery not computed" hint="Run a recompute to model energy from your stress data." height={200} />
        )}
      </Card>

      {/* PRIORITY TILES */}
      <div className="row2">
        <StatTile
          icon="steps"
          label="Steps today"
          value={stepsToday.real ? stepsToday.value : "—"}
          accent="var(--blue)"
          sub={`Goal ${stepsToday.goal.toLocaleString("fr")}`}
          onClick={() =>
            nav.push(
              <MetricDetail
                title="Steps"
                sub="Daily activity"
                accent="var(--blue)"
                chart="bar"
                source={{ src: "wellness", kind: "steps", agg: "sum" }}
              />,
            )
          }
        />
        <StatTile icon="moon" label="Sleep score" value={sleep.real && sleepScore != null ? sleepScore : "—"} accent="var(--light)" sub="last night" onClick={() => nav.go("sleep")} />
        <StatTile
          icon="pulse"
          label="Training load · 7d"
          value={loadValue}
          accent="var(--blue)"
          sub={tl.real ? `form ${loadForm}` : "not computed"}
          onClick={() => nav.push(<TrainingLoadDetail />)}
        />
        <StatTile
          icon="drop"
          label="Resting HR"
          value={restingHR.real ? restingHR.value : "—"}
          unit={restingHR.real ? "bpm" : undefined}
          accent="var(--rhr)"
          sub="latest reading"
          spark={restingHRSpark.length ? restingHRSpark : undefined}
          sparkColor="var(--rhr)"
          onClick={() =>
            nav.push(
              <MetricDetail
                title="Resting heart rate"
                sub="7-day trend"
                accent="var(--rhr)"
                unit="bpm"
                source={{ src: "wellness", kind: "resting_heart_rate" }}
              />,
            )
          }
        />
      </div>

      {/* STEPS THIS WEEK */}
      <Card
        title="Steps"
        sub="this week"
        onClick={() =>
          nav.push(
            <MetricDetail
              title="Steps"
              sub="Daily activity"
              accent="var(--blue)"
              chart="bar"
              source={{ src: "wellness", kind: "steps", agg: "sum" }}
            />,
          )
        }
      >
        {stepsWeek.length ? (
          <Bars data={stepsWeek} height={150} colorFn={() => "var(--blue)"} valueFmt={(v) => (v >= 1000 ? (v / 1000).toFixed(1) + "k" : v)} />
        ) : (
          <NoData label="No step data this week" height={150} />
        )}
      </Card>

      {/* TRAINING LOAD CHART */}
      <Card title="Training load & fitness" sub="18 weeks" onClick={() => nav.push(<TrainingLoadDetail />)}>
        {tl.real ? (
          <>
            <MultiLine series={series} height={150} interactive={false} />
            <Legend
              items={[
                { color: "var(--blue)", label: "Fitness" },
                { color: "var(--ok)", label: "Fatigue" },
                { color: "var(--good)", label: "Form" },
              ]}
            />
          </>
        ) : (
          <NoData label="No training load yet" hint="Import activities with heart-rate data, then recompute." height={150} />
        )}
      </Card>

      {/* WEEKLY VOLUME */}
      <Card title="Weekly volume" sub="by sport · 8 wk" onClick={() => nav.push(<VolumeDetail />)}>
        {volume.real && volume.data.length ? (
          <StackedBars data={volume.data} keys={VOLUME_KEYS} colors={VOLUME_COLORS} height={140} />
        ) : (
          <NoData label="No activities yet" height={140} />
        )}
      </Card>

      {/* WELLNESS GLANCE (real → mock fallback handled by the hooks) */}
      <Card
        title="Wellness"
        sub="7-day"
        action={
          <button
            className="pill"
            onClick={(e) => {
              e.stopPropagation();
              nav.go("wellness");
            }}
          >
            Open <Icon name="arrowUR" size={12} />
          </button>
        }
      >
        <div className="kpi-grid">
          <div className="kpi">
            <span className="kpi-label">Resting HR</span>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span className="kpi-val">
                {restingHR.real ? <>{restingHR.value}<small>bpm</small></> : "—"}
              </span>
              {restingHRSpark.length > 0 && <Spark data={restingHRSpark} color="var(--rhr)" />}
            </div>
          </div>
          <div className="kpi">
            <span className="kpi-label">HRV</span>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span className="kpi-val">
                {hrv.real ? <>{hrv.value}<small>ms</small></> : "—"}
              </span>
              {hrvSpark.length > 0 && <Spark data={hrvSpark} color="var(--hrv)" />}
            </div>
          </div>
          <div className="kpi">
            <span className="kpi-label">Stress</span>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span className="kpi-val">{stress.real ? stress.value : "—"}</span>
              {stressSpark.length > 0 && <Spark data={stressSpark} color="var(--stress)" />}
            </div>
          </div>
          <div className="kpi">
            <span className="kpi-label">Sleep score</span>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span className="kpi-val">{sleep.real && sleepScore != null ? sleepScore : "—"}</span>
              {sleepScoreSpark.length > 0 && <Spark data={sleepScoreSpark} color="var(--light)" />}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
