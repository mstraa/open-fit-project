/* ============================================================
   OpenFit — DESKTOP Dashboard (ported from js/desktop.jsx → DDashboard).
   Reuses the 12-col grid (.dgrid / .cN) from openfit.css. Live data
   uses the SAME wiring hooks the mobile Dashboard uses
   (useStepsToday / useTrainingLoadSeries / useSleepNights) plus the
   body-battery + wellness hooks (useBodyBattery / useWellnessLatest /
   useDailyTrend). No mocks: real values when present, honest empty
   states ("—" / <NoData/> / no sparkline) otherwise.
   ============================================================ */
import { Card, StatTile, Legend, Icon, NoData, useNav } from "../ui";
import { Ring, MultiLine, StackedBars, Spark, AreaChart, type MultiSeries } from "../charts";
import { MetricDetail } from "../shared";
import { TrainingLoadDetail, VolumeDetail } from "../pages/Dashboard";
import {
  VOL_KEYS,
  VOL_COLORS,
} from "../data";
import { tint } from "../util";
import {
  useStepsToday,
  useTrainingLoadSeries,
  useSleepNights,
  useBodyBattery,
  useWellnessLatest,
  useDailyTrend,
  useWeeklyVolume,
} from "../wiring";

/* Keys/colors for the stacked weekly-volume chart. */
const VOLUME_KEYS = VOL_KEYS as unknown as ("running" | "cycling" | "walking" | "strength" | "activity")[];
const VOLUME_COLORS = VOL_COLORS;

interface GlanceRow {
  icon: string;
  label: string;
  value: string;
  unit: string;
  spark: number[];
  color: string;
}

export function DDashboard() {
  const nav = useNav();

  // Steps today (real → "—" when no data).
  const stepsToday = useStepsToday();

  // Sleep score (real nights → "—" when no data).
  const sleep = useSleepNights();
  const sleepScore = sleep.nights[0]?.score;
  const hasSleepScore = sleep.real && sleepScore != null;

  // Training load CTL/ATL/TSB series (real → empty state). Guard tl.real
  // before reading tl.last / rendering the chart.
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
  const battery = useBodyBattery();

  // Weekly volume by sport (real → empty state when no activities).
  const volume = useWeeklyVolume();

  // Wellness glance rows (real → "—" / no spark when absent).
  const rhr = useWellnessLatest("resting_heart_rate");
  const rhrTrend = useDailyTrend("resting_heart_rate", 7);
  const rhrSpark = rhrTrend.days.length ? rhrTrend.days.map((d) => d.avg) : [];
  const hrv = useWellnessLatest("hrv");
  const hrvTrend = useDailyTrend("hrv", 7);
  const hrvSpark = hrvTrend.days.length ? hrvTrend.days.map((d) => d.avg) : [];
  const stress = useWellnessLatest("stress");
  const stressTrend = useDailyTrend("stress", 7);
  const stressSpark = stressTrend.days.length ? stressTrend.days.map((d) => d.avg) : [];
  const sleepWeekScores = sleep.nights.slice(0, 7).reverse().map((n) => n.score);

  const glance: GlanceRow[] = [
    { icon: "drop", label: "Resting HR", value: rhr.real ? String(rhr.value) : "—", unit: "bpm", spark: rhrSpark, color: "var(--rhr)" },
    { icon: "pulse", label: "HRV", value: hrv.real ? String(hrv.value) : "—", unit: "ms", spark: hrvSpark, color: "var(--hrv)" },
    { icon: "gauge", label: "Stress", value: stress.real ? String(stress.value) : "—", unit: "", spark: stressSpark, color: "var(--stress)" },
    { icon: "moon", label: "Sleep score", value: hasSleepScore ? String(sleepScore) : "—", unit: "", spark: sleepWeekScores, color: "var(--light)" },
  ];

  return (
    <div className="dgrid">
      {/* HERO — body battery ring */}
      <Card
        className="c4 hover-card tappable"
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
        {battery.real ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "4px 0 2px" }}>
            <Ring value={battery.now} size={150} stroke={13} bands={[40, 72]} label="Body battery" sub="reserve" />
            <div style={{ width: "100%" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                <span className="kpi-label">Throughout today</span>
                <span className="pill" style={{ color: "var(--good)" }}>+{battery.charged} charged</span>
              </div>
              <AreaChart data={battery.curve} color="var(--good)" height={104} durSec={battery.spanSec} valueFmt={(v) => Math.round(v)} ticks={2} />
            </div>
            <div style={{ display: "flex", gap: 30 }}>
              <div className="kpi" style={{ alignItems: "center", gap: 4 }}>
                <span className="kpi-label">Peak</span>
                <span className="kpi-val">{battery.atWake}<small>%</small></span>
              </div>
              <div className="kpi" style={{ alignItems: "center", gap: 4 }}>
                <span className="kpi-label">Drained</span>
                <span className="kpi-val">{battery.drained}</span>
              </div>
            </div>
          </div>
        ) : (
          <NoData label="Body battery not computed" hint="Run a recompute to model energy from your stress data." height={200} />
        )}
      </Card>

      {/* PRIORITY TILES + TRAINING LOAD CHART */}
      <div className="c8 dgrid tight" style={{ alignContent: "start" }}>
        <div className="c3">
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
        </div>
        <div className="c3">
          <StatTile icon="moon" label="Sleep score" value={hasSleepScore ? sleepScore : "—"} accent="var(--light)" sub="last night" onClick={() => nav.go("sleep")} />
        </div>
        <div className="c3">
          <StatTile
            icon="pulse"
            label="Training load · 7d"
            value={loadValue}
            accent="var(--blue)"
            sub={tl.real ? `form ${loadForm}` : "not computed"}
            onClick={() => nav.push(<TrainingLoadDetail />)}
          />
        </div>
        <div className="c3">
          <StatTile
            icon="drop"
            label="Resting HR"
            value={rhr.real ? rhr.value : "—"}
            unit={rhr.real ? "bpm" : undefined}
            accent="var(--rhr)"
            sub="latest"
            spark={rhrSpark.length ? rhrSpark : undefined}
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
        <Card
          className="c12 hover-card tappable"
          title="Training load & fitness"
          sub="18 weeks"
          onClick={() => nav.push(<TrainingLoadDetail />)}
        >
          {tl.real ? (
            <>
              <MultiLine series={series} height={188} interactive={false} />
              <Legend
                items={[
                  { color: "var(--blue)", label: "Fitness (CTL)" },
                  { color: "var(--ok)", label: "Fatigue (ATL)" },
                  { color: "var(--good)", label: "Form (TSB)" },
                ]}
              />
            </>
          ) : (
            <NoData label="No training load yet" hint="Import activities with heart-rate data, then recompute." height={188} />
          )}
        </Card>
      </div>

      {/* WEEKLY VOLUME */}
      <Card
        className="c7 hover-card tappable"
        title="Weekly volume"
        sub="training time by sport · 8 wk"
        onClick={() => nav.push(<VolumeDetail />)}
      >
        {volume.real && volume.data.length ? (
          <>
            <StackedBars data={volume.data} keys={VOLUME_KEYS} colors={VOLUME_COLORS} height={190} />
            <Legend
              items={[
                { color: "var(--run)", label: "Running" },
                { color: "var(--cycle)", label: "Cycling" },
                { color: "var(--walk)", label: "Walking" },
                { color: "var(--strength)", label: "Strength" },
                { color: "var(--activity)", label: "Activity" },
              ]}
            />
          </>
        ) : (
          <NoData label="No activities yet" height={190} />
        )}
      </Card>

      {/* WELLNESS GLANCE (real wellness latest + daily-trend sparklines) */}
      <Card
        className="c5"
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
        <div style={{ display: "flex", flexDirection: "column" }}>
          {glance.map((row, i) => (
            <div
              key={row.label}
              style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 0", borderTop: i ? "1px solid var(--line)" : "none" }}
            >
              <span className="tile-ic" style={{ width: 32, height: 32, background: tint(row.color, 13), color: row.color, flex: "none" }}>
                <Icon name={row.icon} size={16} />
              </span>
              <div style={{ minWidth: 96 }}>
                <div className="kpi-label">{row.label}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 700 }}>
                  {row.value}
                  {row.unit && row.value !== "—" && (
                    <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-sans)", marginLeft: 2 }}>{row.unit}</span>
                  )}
                </div>
              </div>
              <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>
                {row.spark.length > 0 && <Spark data={row.spark} color={row.color} width={130} height={34} />}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
