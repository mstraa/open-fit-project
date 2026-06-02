/* ============================================================
   OpenFit — Wellness page (ported from js/wellness.jsx).
   All metrics are wired to the real API via the hooks in ../wiring
   (live HR, readiness, HR 24h, resting-HR / HRV / stress / body-battery
   tiles, HRV trend band, sleep score). When a hook has no real data it
   reports real:false and we render an honest empty state ("—" / <NoData/>)
   instead of fabricated numbers.
   ============================================================ */
import { Card, StatTile, Legend, MMM, NoData, useNav } from "../ui";
import { Ring, LineChart, BandChart } from "../charts";
import { MetricDetail } from "../shared";
import {
  useLiveHR,
  useReadiness,
  useHR24h,
  hr24hTick,
  hr24hTime,
  useWellnessLatest,
  useSleepNights,
  useBodyBattery,
  useDailyTrend,
  useIntradayLatestDay,
  useWeightTrend,
} from "../wiring";
import { fmtH } from "../util";

/* streaming live HR line — exported for reuse (e.g. dashboard hero). */
export function LiveHR() {
  const nav = useNav();
  const { hr, series, streaming } = useLiveHR();
  return (
    <Card
      className="tappable"
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
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 6 }}>
        <div>
          <div className="kpi-label" style={{ color: "var(--text-faint)" }}>
            Live heart rate
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 2 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 38, fontWeight: 700, color: "var(--rhr)", letterSpacing: "-.02em" }}>
              {hr ?? "—"}
            </span>
            <span style={{ fontSize: 14, color: "var(--text-dim)", fontWeight: 600 }}>bpm</span>
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
        <LineChart data={series} height={88} color="var(--rhr)" interactive={false} fill padTop={14} padBottom={8} />
      ) : (
        <NoData label="No live heart rate" hint="Connect a device to stream your heart rate." height={88} />
      )}
    </Card>
  );
}

export function Wellness() {
  const nav = useNav();
  const R = useReadiness();
  const restingHR = useWellnessLatest("resting_heart_rate");
  const hrvOvernight = useWellnessLatest("hrv");
  const sleepNights = useSleepNights();
  const lastNight = sleepNights.nights[0];
  const bodyBattery = useBodyBattery();
  const hrvTrend = useDailyTrend("hrv", 30);
  const hr = useHR24h();
  const stress = useIntradayLatestDay("stress");
  const weight = useWeightTrend(90);
  return (
    <div className="stack fade-up">
      {/* HERO — live HR */}
      <LiveHR />

      {/* READINESS strip */}
      <Card
        onClick={() =>
          nav.push(
            <MetricDetail title="Readiness" sub="HRV + resting-HR vs baseline" accent="var(--ok)" source={{ src: "readiness" }} />,
          )
        }
      >
        {R.real ? (
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Ring value={R.score} size={104} stroke={10} bands={[50, 75]} label={R.label} glow={false} />
            <div style={{ flex: 1 }} className="kpi-grid">
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
        ) : (
          <NoData label="Readiness unavailable" hint="Needs more overnight HRV data to compute a score." height={104} />
        )}
      </Card>

      {/* TILES — real (resting HR / HRV / sleep score / body battery) */}
      <div className="row2">
        <StatTile
          icon="drop"
          label="Resting HR"
          value={restingHR.real ? restingHR.value : "—"}
          unit={restingHR.real ? "bpm" : undefined}
          accent="var(--rhr)"
          onClick={() =>
            nav.push(
              <MetricDetail title="Resting heart rate" sub="7-day trend" accent="var(--rhr)" unit="bpm" source={{ src: "wellness", kind: "resting_heart_rate" }} />,
            )
          }
        />
        <StatTile
          icon="pulse"
          label="HRV overnight"
          value={hrvOvernight.real ? hrvOvernight.value : "—"}
          unit={hrvOvernight.real ? "ms" : undefined}
          accent="var(--hrv)"
          onClick={() =>
            nav.push(
              <MetricDetail title="HRV" sub="30-day trend · balanced band" accent="var(--hrv)" unit="ms" source={{ src: "wellness", kind: "hrv" }} />,
            )
          }
        />
        <StatTile
          icon="moon"
          label="Sleep score"
          value={lastNight ? lastNight.score : "—"}
          accent="var(--light)"
          sub={lastNight ? `${fmtH(lastNight.asleep)} asleep` : ""}
          onClick={() => nav.go("sleep")}
        />
        <StatTile
          icon="battery"
          label="Body battery"
          value={bodyBattery.real ? bodyBattery.now : "—"}
          unit={bodyBattery.real ? "%" : undefined}
          accent="var(--good)"
          onClick={() =>
            nav.push(<MetricDetail title="Body battery" sub="Energy reserve" accent="var(--good)" unit="%" source={{ src: "wellness", kind: "body_battery", intraday: true }} />)
          }
        />
      </div>

      {/* HRV TREND BAND — real (30-day per-day min/avg/max) */}
      <Card
        title="HRV trend"
        sub="30 days · balanced band"
        onClick={() =>
          nav.push(<MetricDetail title="HRV" sub="30-day trend" accent="var(--hrv)" unit="ms" source={{ src: "wellness", kind: "hrv" }} />)
        }
      >
        {hrvTrend.real && hrvTrend.days.length ? (
          <>
            <MMM min={hrvTrend.min} avg={hrvTrend.avg} max={hrvTrend.max} unit="ms" />
            <BandChart
              data={hrvTrend.days.map((d) => ({ min: d.min, avg: d.avg, max: d.max }))}
              color="var(--hrv)"
              height={150}
              dateFmt={(i) => hrvTrend.days[i]?.date ?? ""}
            />
          </>
        ) : (
          <NoData label="No HRV history yet" hint="Record overnight HRV for a few nights to see your trend." height={150} />
        )}
      </Card>

      {/* HEART RATE 24H — real points + min/avg/max */}
      <Card
        title="Heart rate"
        sub="last 24 hours"
        onClick={() =>
          nav.push(<MetricDetail title="Heart rate" sub="Last 24 hours" accent="var(--rhr)" unit="bpm" source={{ src: "wellness", kind: "heart_rate", intraday: true }} />)
        }
      >
        {hr.real && hr.points.length ? (
          <>
            <MMM min={hr.min} avg={hr.avg} max={hr.max} unit="bpm" />
            <LineChart
              data={hr.points.map((p) => p.v)}
              height={140}
              color="var(--rhr)"
              fill
              xLabels={hr.points.map((p) => hr24hTick(p.ts))}
              dateFmt={(i) => hr24hTime(hr.points[i].ts)}
            />
          </>
        ) : (
          <NoData label="No heart-rate data today" hint="Wear your device to record a 24-hour heart-rate curve." height={140} />
        )}
      </Card>

      {/* STRESS TODAY — real (latest day intraday) */}
      <Card
        title="Stress"
        sub="today"
        onClick={() => nav.push(<MetricDetail title="Stress" sub="Today" accent="var(--stress)" source={{ src: "wellness", kind: "stress", intraday: true }} />)}
      >
        {stress.real && stress.points.length ? (
          <>
            <MMM min={stress.min} avg={stress.avg} max={stress.max} />
            <LineChart
              data={stress.points.map((p) => p.v)}
              height={140}
              color="var(--stress)"
              fill
              xLabels={stress.points.map((p, i) => (i % 24 === 0 ? p.t.toFixed(0) + "h" : null))}
              dateFmt={(i) => stress.points[i].t.toFixed(0) + "h"}
            />
            <Legend
              items={[
                { color: "var(--good)", label: "Rest" },
                { color: "var(--light)", label: "Low" },
                { color: "var(--stress)", label: "Medium" },
                { color: "var(--low)", label: "High" },
              ]}
            />
          </>
        ) : (
          <NoData label="No stress data today" hint="Wear your device to track stress through the day." height={140} />
        )}
      </Card>

      {/* WEIGHT — body-weight trend (sparse, kg). Real from Garmin / Zepp imports. */}
      <Card
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
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 32, fontWeight: 700, color: "var(--weight)", letterSpacing: "-.02em" }}>
                {weight.latest.toFixed(1)}
              </span>
              <span style={{ fontSize: 13, color: "var(--text-dim)", fontWeight: 600 }}>kg</span>
              {weight.days.length > 1 && weight.delta !== 0 && (
                <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 600, color: "var(--text-dim)" }}>
                  {weight.delta > 0 ? "+" : ""}
                  {weight.delta.toFixed(1)} kg · 90d
                </span>
              )}
            </div>
            <LineChart
              data={weight.days.map((d) => d.value)}
              height={150}
              color="var(--weight)"
              fill
              valueFmt={(v) => v.toFixed(1)}
              xLabels={weight.days.map((d, i) => (i % Math.ceil(weight.days.length / 5) === 0 ? d.date.slice(5) : null))}
              dateFmt={(i) => weight.days[i]?.date ?? ""}
            />
          </>
        ) : (
          <NoData label="No weight data yet" hint="Import a Garmin or Zepp export — or log your weight — to see your trend." height={150} />
        )}
      </Card>
    </div>
  );
}
