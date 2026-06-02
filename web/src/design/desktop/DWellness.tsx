/* ============================================================
   OpenFit redesign — Desktop Wellness screen (sidebar + grid).
   Ported from the design bundle's js/desktop.jsx (DWellness + DLiveHR).
   Live HR hero → useLiveHR(); readiness ring → useReadiness();
   tiles → useWellnessLatest + useSleepNights; HRV band → useDailyTrend;
   24h HR → useHR24h(); stress → useIntradayLatestDay; steps → useStepsWeek.
   When a hook has no real data it reports real:false and we render an honest
   empty state ("—" / <NoData/>) instead of fabricated numbers.
   ============================================================ */
import { Card, StatTile, MMM, NoData, useNav } from "../ui";
import { Ring, LineChart, BandChart, Bars } from "../charts";
import { MetricDetail } from "../shared";
import { scoreColor, fmtDay } from "../util";
import {
  useLiveHR,
  useReadiness,
  useHR24h,
  hr24hTick,
  hr24hTime,
  useWellnessLatest,
  useSleepNights,
  useDailyTrend,
  useIntradayLatestDay,
  useStepsWeek,
  useMetricHistory,
  useWeightTrend,
} from "../wiring";

/* =================== LIVE HR HERO =================== */
function DLiveHR() {
  const nav = useNav();
  const { hr, series, streaming } = useLiveHR();
  return (
    <Card
      className="c8 hover-card tappable"
      onClick={() =>
        nav.push(
          <MetricDetail
            title="Heart rate"
            sub="Last 24 hours"
            accent="var(--rhr)"
            unit="bpm"
            source={{ src: "wellness", kind: "heart_rate", intraday: true }}
          />,
        )
      }
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 4 }}>
        <div>
          <div className="kpi-label">Live heart rate</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 2 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 40, fontWeight: 700, color: "var(--rhr)" }}>{hr ?? "—"}</span>
            <span style={{ fontSize: 15, color: "var(--text-dim)", fontWeight: 600 }}>bpm</span>
          </div>
        </div>
        {streaming ? (
          <span className="pill live">
            <i />
            streaming
          </span>
        ) : (
          <span className="pill">not streaming</span>
        )}
      </div>
      {series.length > 0 ? (
        <LineChart data={series} height={120} color="var(--rhr)" interactive={false} fill padTop={14} padBottom={8} />
      ) : (
        <NoData label="No live heart rate" hint="Connect a device to stream your heart rate." height={120} />
      )}
    </Card>
  );
}

/* =================== WELLNESS =================== */
export function DWellness() {
  const nav = useNav();
  const R = useReadiness();
  const hr24h = useHR24h();

  // Tiles — real wellness latest / sleep score; "—" when no real data.
  const restingHR = useWellnessLatest("resting_heart_rate");
  const hrvLatest = useWellnessLatest("hrv");
  const bodyBattery = useWellnessLatest("body_battery");
  const sleep = useSleepNights();
  const lastNight = sleep.nights[0];

  // HRV trend band (30 days) + 24h HR + stress intraday + steps week.
  const hrvTrend = useDailyTrend("hrv", 30);
  const hrvBand = hrvTrend.days.map((d) => ({ date: new Date(d.date), avg: d.avg, min: d.min, max: d.max }));
  const stress = useIntradayLatestDay("stress");
  const stepsWeek = useStepsWeek();
  const weight = useWeightTrend(90);

  // 7-day readiness mini-bars — real data.
  const rdy = useMetricHistory({ src: "readiness" }, "Week");

  const tiles: [string, string, number | string, string, string, React.ReactNode][] = [
    [
      "drop",
      "Resting HR",
      restingHR.real ? restingHR.value : "—",
      restingHR.real ? "bpm" : "",
      "var(--rhr)",
      <MetricDetail title="Resting heart rate" sub="7-day trend" accent="var(--rhr)" unit="bpm" source={{ src: "wellness", kind: "resting_heart_rate" }} />,
    ],
    [
      "pulse",
      "HRV overnight",
      hrvLatest.real ? hrvLatest.value : "—",
      hrvLatest.real ? "ms" : "",
      "var(--hrv)",
      <MetricDetail title="HRV" sub="30-day trend" accent="var(--hrv)" unit="ms" source={{ src: "wellness", kind: "hrv" }} />,
    ],
    ["moon", "Sleep score", lastNight ? lastNight.score : "—", "", "var(--light)", null],
    [
      "battery",
      "Body battery",
      bodyBattery.real ? bodyBattery.value : "—",
      bodyBattery.real ? "%" : "",
      "var(--good)",
      <MetricDetail title="Body battery" sub="Energy reserve" accent="var(--good)" unit="%" source={{ src: "wellness", kind: "body_battery", intraday: true }} />,
    ],
  ];

  return (
    <div className="dgrid">
      <DLiveHR />
      <Card
        className="c4 hover-card tappable"
        onClick={() =>
          nav.push(
            <MetricDetail title="Readiness" sub="HRV + resting-HR vs baseline" accent="var(--ok)" source={{ src: "readiness" }} />,
          )
        }
      >
        {R.real ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, height: "100%" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <Ring value={R.score} size={108} stroke={10} bands={[50, 75]} label={R.label} glow={false} />
              <div className="kpi-grid" style={{ gridTemplateColumns: "1fr", flex: 1 }}>
                <div className="kpi">
                  <span className="kpi-label">HRV overnight</span>
                  <span className="kpi-val">
                    {R.hrv}
                    <small>ms</small>
                  </span>
                </div>
                <div className="kpi">
                  <span className="kpi-label">Baseline</span>
                  <span className="kpi-val">
                    {R.baseline}
                    <small>ms</small>
                  </span>
                </div>
              </div>
            </div>
            {rdy.real && rdy.data.length > 0 && (
              <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 }}>
                  <span className="kpi-label">7-day readiness</span>
                  <span style={{ fontSize: 11.5, color: "var(--text-dim)", fontWeight: 600 }}>avg {Math.round(rdy.avg)}</span>
                </div>
                <Bars
                  data={rdy.data.map((v, i) => ({ d: ["L", "M", "Me", "J", "V", "S", "D"][i], v }))}
                  height={92}
                  colorFn={(v) => scoreColor(v, [50, 72])}
                  valueFmt={(v) => v}
                />
              </div>
            )}
          </div>
        ) : (
          <NoData label="Readiness unavailable" hint="Needs more overnight HRV data to compute a score." height={200} />
        )}
      </Card>
      {tiles.map(([ic, l, v, u, col, det]) => (
        <div className="c3" key={l}>
          <StatTile icon={ic} label={l} value={v} unit={u} accent={col} onClick={() => (det ? nav.push(det) : nav.go("sleep"))} />
        </div>
      ))}
      <Card
        className="c6 hover-card tappable"
        title="HRV trend"
        sub="30 days · balanced band"
        onClick={() =>
          nav.push(<MetricDetail title="HRV" sub="30-day trend" accent="var(--hrv)" unit="ms" source={{ src: "wellness", kind: "hrv" }} />)
        }
      >
        {hrvTrend.real && hrvBand.length > 1 ? (
          <>
            <MMM min={hrvTrend.min} avg={hrvTrend.avg} max={hrvTrend.max} unit="ms" />
            <BandChart data={hrvBand} color="var(--hrv)" height={170} dateFmt={(i) => fmtDay(hrvBand[i].date)} />
          </>
        ) : (
          <NoData label="No HRV history yet" hint="Record overnight HRV for a few nights to see your trend." height={170} />
        )}
      </Card>
      <Card
        className="c6 hover-card tappable"
        title="Heart rate"
        sub="last 24 hours"
        onClick={() =>
          nav.push(<MetricDetail title="Heart rate" sub="Last 24 hours" accent="var(--rhr)" unit="bpm" source={{ src: "wellness", kind: "heart_rate", intraday: true }} />)
        }
      >
        {hr24h.real && hr24h.points.length ? (
          <>
            <MMM min={hr24h.min} avg={hr24h.avg} max={hr24h.max} unit="bpm" />
            <LineChart
              data={hr24h.points.map((p) => p.v)}
              height={170}
              color="var(--rhr)"
              fill
              xLabels={hr24h.points.map((p) => hr24hTick(p.ts))}
              dateFmt={(i) => hr24hTime(hr24h.points[i].ts)}
            />
          </>
        ) : (
          <NoData label="No heart-rate data today" hint="Wear your device to record a 24-hour heart-rate curve." height={170} />
        )}
      </Card>
      <Card
        className="c6 hover-card tappable"
        title="Stress"
        sub="today"
        onClick={() =>
          nav.push(<MetricDetail title="Stress" sub="Today" accent="var(--stress)" source={{ src: "wellness", kind: "stress", intraday: true }} />)
        }
      >
        {stress.real && stress.points.length ? (
          <>
            <MMM min={stress.min} avg={stress.avg} max={stress.max} />
            <LineChart
              data={stress.points.map((p) => p.v)}
              height={170}
              color="var(--stress)"
              fill
              xLabels={stress.points.map((p, i) => (i % 24 === 0 ? Math.round(p.t) + "h" : null))}
              dateFmt={(i) => Math.round(stress.points[i].t) + "h"}
            />
          </>
        ) : (
          <NoData label="No stress data today" hint="Wear your device to track stress through the day." height={170} />
        )}
      </Card>
      <Card
        className="c6 hover-card tappable"
        title="Steps"
        sub="this week"
        onClick={() =>
          nav.push(<MetricDetail title="Steps" sub="Daily activity" accent="var(--blue)" chart="bar" source={{ src: "wellness", kind: "steps", agg: "sum" }} />)
        }
      >
        {stepsWeek.length ? (
          <Bars data={stepsWeek} height={170} colorFn={() => "var(--blue)"} valueFmt={(v) => (v >= 1000 ? (v / 1000).toFixed(1) + "k" : v)} />
        ) : (
          <NoData label="No step data this week" height={170} />
        )}
      </Card>
      <Card
        className="c6 hover-card tappable"
        title="Weight"
        sub="last 90 days"
        onClick={() =>
          nav.push(
            <MetricDetail
              title="Weight"
              sub="Body-weight trend"
              accent="var(--weight)"
              unit="kg"
              decimals={1}
              ranges={["Week", "Month", "Year"]}
              source={{ src: "wellness", kind: "weight", agg: "avg" }}
            />,
          )
        }
      >
        {weight.real && weight.days.length ? (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 34, fontWeight: 700, color: "var(--weight)" }}>{weight.latest.toFixed(1)}</span>
              <span style={{ fontSize: 14, color: "var(--text-dim)", fontWeight: 600 }}>kg</span>
              {weight.days.length > 1 && weight.delta !== 0 && (
                <span style={{ marginLeft: "auto", fontSize: 13.5, fontWeight: 600, color: "var(--text-dim)" }}>
                  {weight.delta > 0 ? "+" : ""}
                  {weight.delta.toFixed(1)} kg · {weight.days.length} d
                </span>
              )}
            </div>
            <LineChart
              data={weight.days.map((d) => d.value)}
              height={170}
              color="var(--weight)"
              fill
              valueFmt={(v) => v.toFixed(1)}
              xLabels={weight.days.map((d, i) => (i % Math.ceil(weight.days.length / 6) === 0 ? d.date.slice(5) : null))}
              dateFmt={(i) => weight.days[i]?.date ?? ""}
            />
          </>
        ) : (
          <NoData label="No weight data yet" hint="Import a Garmin or Zepp export to see your weight trend." height={170} />
        )}
      </Card>
    </div>
  );
}
