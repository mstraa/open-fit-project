/* ============================================================
   OpenFit — Desktop Sleep screen (sidebar + grid).
   Ported from the design bundle's js/desktop.jsx (DSleep) into typed TSX.
   Hero / last-night, recent-nights table and the stage tiles come from
   useSleepData(); the weekly duration/regularity/HR/breathing charts come
   from sleep.weekly and the hypnogram uses the night's own segments.
   When there's no real sleep_stage data the hooks return real:false +
   empty arrays, so we render honest empty states (<NoData/> for charts,
   "—" for scalars) instead of fabricated numbers. Hypopnea has no data
   source at all, so it is always shown empty (never mocked).
   MetricDetails are fully real via source={…}; recent-night rows open the
   real per-night hypnogram via <NightDetail/>.
   ============================================================ */
import { Card, Legend, Icon, NoData, useNav } from "../ui";
import { Ring, LineChart, StackedBars, RegularityBars, Hypnogram, SegBar } from "../charts";
import { MetricDetail } from "../shared";
import { AllNights } from "../pages/Sleep";
import { useSleepData, useRecomputeTrigger } from "../wiring";
import { fmtHM, fmtH } from "../util";

export function DSleep() {
  const nav = useNav();
  const { recomputing, nonce, trigger } = useRecomputeTrigger();
  const sleep = useSleepData(30, nonce);
  const LN = sleep.nights[0];

  // No real sleep data → honest empty state (no mock night/week).
  if (!sleep.real || !LN) {
    return (
      <div className="dgrid">
        <Card className="c12">
          <NoData
            label="No sleep data yet"
            hint="Sync a device that records sleep stages, or recompute to derive stages from heart rate."
            height={260}
          />
          <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
            <button className="pill" disabled={recomputing} onClick={trigger} style={{ opacity: recomputing ? 0.6 : 1 }}>
              {recomputing ? "Computing…" : "Recompute sleep"} <Icon name="refresh" size={12} />
            </button>
          </div>
        </Card>
      </div>
    );
  }

  const SW = sleep.weekly;

  // De-hardcoded stage-tile statuses (mirrors the mobile Sleep page).
  const deepPct = Math.round((LN.deep / LN.asleep) * 100);
  const remPct = Math.round((LN.rem / LN.asleep) * 100);
  const wakeUps = LN.segments.filter((s) => s.stage === "awake").length;

  const tiles: [string, string, string | undefined, string][] = [
    ["Sleep duration", fmtHM(LN.asleep), LN.asleep >= 420 ? "OPTIMAL" : LN.asleep >= 360 ? "GOOD" : "SHORT", "var(--good)"],
    // regularity is 0 when there aren't enough nights to judge → show "—" with no status.
    ["Regularity", sleep.regularity > 0 ? `${sleep.regularity}%` : "—", sleep.regularity <= 0 ? undefined : sleep.regularity >= 85 ? "OPTIMAL" : sleep.regularity >= 70 ? "GOOD" : "WATCH", "var(--good)"],
    ["Deep", fmtHM(LN.deep), deepPct >= 13 ? "OPTIMAL" : deepPct >= 8 ? "NORMAL" : "LOW", "var(--deep)"],
    ["REM", fmtHM(LN.rem), remPct >= 20 ? "OPTIMAL" : remPct >= 13 ? "NORMAL" : "LOW", "var(--rem)"],
    ["Awake", fmtHM(LN.awake), LN.awake <= 20 && wakeUps <= 3 ? "NORMAL" : "WATCH", "var(--awake)"],
  ];

  return (
    <div className="dgrid">
      <Card className="c4">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "6px 0" }}>
          <Ring value={LN.score} size={158} stroke={13} color="var(--light)" glow label="Sleep score" sub="last night" />
          <div style={{ display: "flex", gap: 24, marginTop: 6 }}>
            <div className="kpi" style={{ alignItems: "center", gap: 5 }}>
              <span className="kpi-label">Asleep</span>
              <span className="kpi-val">{fmtHM(LN.asleep)}</span>
            </div>
            <div className="kpi" style={{ alignItems: "center", gap: 5 }}>
              <span className="kpi-label">Avg HR</span>
              <span className="kpi-val">
                {LN.hr || "—"}
                <small>bpm</small>
              </span>
            </div>
            <div className="kpi" style={{ alignItems: "center", gap: 5 }}>
              <span className="kpi-label">Breath</span>
              <span className="kpi-val">
                {LN.breath || "—"}
                <small>/m</small>
              </span>
            </div>
          </div>
        </div>
      </Card>

      <Card
        className="c8"
        title="Sleep stages"
        sub="last night · hypnogram"
        action={
          <button className="pill" disabled={recomputing} onClick={trigger} style={{ opacity: recomputing ? 0.6 : 1 }}>
            {recomputing ? "Computing…" : "Recompute"} <Icon name="refresh" size={12} />
          </button>
        }
      >
        <Hypnogram segs={LN.segments} height={150} start={LN.start} end={LN.end} />
        <Legend
          items={[
            { color: "var(--deep)", label: "Deep" },
            { color: "var(--rem)", label: "REM" },
            { color: "var(--light)", label: "Light" },
            { color: "var(--awake)", label: "Awake" },
          ]}
        />
      </Card>

      {tiles.map(([l, v, st, col]) => (
        <Card className="c2" key={l} style={{ padding: 14 }}>
          <div className="tile-label" style={{ color: col }}>
            {l}
          </div>
          <div className="tile-val" style={{ fontSize: 24, marginTop: 4 }}>
            {v}
          </div>
          <div className="tile-sub" style={{ color: col, fontWeight: 700, fontSize: 10.5, letterSpacing: ".04em" }}>
            {st}
          </div>
        </Card>
      ))}
      <Card className="c2" style={{ padding: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <button
          className="pill"
          onClick={() =>
            nav.push(<MetricDetail title="Deep sleep" sub="Per night" accent="var(--deep)" unit="min" source={{ src: "sleep", field: "deep" }} />)
          }
        >
          Trends <Icon name="arrowUR" size={12} />
        </button>
      </Card>

      <Card
        className="c6 hover-card tappable"
        title="Sleep duration"
        sub="vs last 7 days"
        onClick={() =>
          nav.push(<MetricDetail title="Sleep duration" sub="Per night" accent="var(--light)" unit="min" source={{ src: "sleep", field: "asleep" }} />)
        }
      >
        <StackedBars
          data={SW.duration.map((d) => ({ d: d.d, deep: d.deep, light: d.light, rem: d.rem, awake: d.awake }))}
          keys={["deep", "light", "rem", "awake"]}
          colors={["var(--deep)", "var(--light)", "var(--rem)", "var(--awake)"]}
          height={180}
        />
        <Legend
          items={[
            { color: "var(--deep)", label: "Deep" },
            { color: "var(--light)", label: "Light" },
            { color: "var(--rem)", label: "REM" },
            { color: "var(--awake)", label: "Awake" },
          ]}
        />
      </Card>

      <Card className="c6" title="Sleep regularity" sub="bed & wake">
        {SW.regularity.length ? (
          <RegularityBars data={SW.regularity} height={200} />
        ) : (
          <NoData label="No regularity data yet" height={200} />
        )}
      </Card>

      <Card
        className="c4 hover-card tappable"
        title="Sleep heart rate"
        sub="bpm"
        onClick={() =>
          nav.push(<MetricDetail title="Sleep heart rate" sub="Per night" accent="var(--good)" unit="bpm" source={{ src: "sleep", field: "hr" }} />)
        }
      >
        {SW.hr.length ? (
          <LineChart data={SW.hr} xLabels={SW.hr.map((x) => x.d)} height={150} color="var(--good)" showDots valueLabels />
        ) : (
          <NoData label="No sleep heart-rate data" height={150} />
        )}
      </Card>

      <Card
        className="c4 hover-card tappable"
        title="Hypopnea"
        sub="events / h"
        onClick={() => nav.push(<MetricDetail title="Hypopnea" sub="Events per hour" accent="var(--ok)" source={{ src: "none" }} />)}
      >
        {/* No data source for hypopnea — always empty (never mocked). */}
        <NoData label="No hypopnea data" hint="No device on this account reports hypopnea events." height={150} />
      </Card>

      <Card
        className="c4 hover-card tappable"
        title="Breathing rate"
        sub="brpm"
        onClick={() =>
          nav.push(<MetricDetail title="Breathing rate" sub="Per night" accent="var(--light)" unit="brpm" source={{ src: "sleep", field: "breath" }} />)
        }
      >
        {SW.breath.length ? (
          <LineChart data={SW.breath} xLabels={SW.breath.map((x) => x.d)} height={150} color="var(--light)" showDots valueLabels />
        ) : (
          <NoData label="No breathing-rate data" height={150} />
        )}
      </Card>

      <Card
        className="c12"
        title="Recent nights"
        action={
          <button className="pill" onClick={() => nav.push(<AllNights />)}>
            All nights <Icon name="arrowUR" size={12} />
          </button>
        }
        noPad
      >
        <div style={{ padding: "0 18px" }}>
          {sleep.nights.slice(0, 8).map((n, i) => (
            <div
              className="lrow"
              key={n.date}
              onClick={() =>
                nav.push(
                  <MetricDetail
                    title="Sleep score"
                    sub="Per night"
                    accent="var(--light)"
                    source={{ src: "sleep", field: "score" }}
                    initialOffset={-Math.floor(i / 7)}
                  />,
                )
              }
              style={{ cursor: "pointer" }}
            >
              <div style={{ minWidth: 96, fontSize: 13, fontWeight: 700 }}>{n.date}</div>
              <div style={{ flex: 1 }}>
                <SegBar
                  parts={[
                    { v: n.deep, color: "var(--deep)" },
                    { v: n.rem, color: "var(--rem)" },
                    { v: n.light, color: "var(--light)" },
                    { v: n.awake, color: "var(--awake)" },
                  ]}
                  height={9}
                />
              </div>
              <div style={{ minWidth: 70, textAlign: "right", fontSize: 12, color: "var(--text-faint)", fontWeight: 600 }}>
                {fmtH(n.asleep)}
              </div>
              <div className="lrow-dur" style={{ minWidth: 36, textAlign: "right" }}>
                {n.score}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
