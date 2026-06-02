/* ============================================================
   OpenFit — Sleep page (Zepp-style).
   Ported from the design bundle's js/sleep.jsx into typed TSX.
   Nights / hero / recent / all-nights + weekly duration/regularity/
   hr/breathing come from useSleepData(). When there's no real
   sleep_stage data the hooks return real:false + empty arrays, so we
   render honest empty states (<NoData/> for charts, "—" for scalars)
   instead of fabricated numbers. Hypopnea has no data source at all,
   so it is always shown empty (never mocked).
   ============================================================ */
import { Card, SectionLabel, Legend, Icon, DetailHeader, NoData, useNav } from "../ui";
import { Ring, LineChart, StackedBars, RegularityBars, Hypnogram, SegBar } from "../charts";
import { MetricDetail } from "../shared";
import { useSleepData, useRecomputeTrigger } from "../wiring";
import type { SleepNightVM } from "../wiring";
import type { Night } from "../data";
import { tint, fmtHM, fmtH } from "../util";

/* Zepp-style metric row */
function MetricRow({
  icon,
  name,
  value,
  sub,
  status,
  color,
  onClick,
}: {
  icon: string;
  name: string;
  value: string;
  sub?: string;
  status?: string;
  color: string;
  onClick?: () => void;
}) {
  return (
    <button className="lrow" style={{ width: "100%", textAlign: "left" }} onClick={onClick}>
      <span className="tile-ic" style={{ width: 34, height: 34, background: tint(color, 13), color }}>
        <Icon name={icon} size={17} />
      </span>
      <div className="lrow-main">
        <div className="lrow-title" style={{ fontSize: 14.5 }}>
          {name}
        </div>
        {sub && <div className="lrow-meta">{sub}</div>}
      </div>
      <div className="lrow-right">
        <div className="lrow-dur" style={{ fontSize: 16 }}>
          {value}
        </div>
        {status && (
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".05em", color }}>{status}</span>
        )}
      </div>
    </button>
  );
}

/* Night detail (also reused by desktop) */
export function NightDetail({ night, idx }: { night: SleepNightVM; idx: number }) {
  void idx;
  return (
    <div className="detail">
      <DetailHeader title={night.date} sub={`${fmtH(night.asleep)} asleep`} accent="var(--light)" />
      <div className="scroll">
        <div className="stack">
          <Card>
            <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
              <Ring
                value={night.score}
                size={120}
                stroke={11}
                color={night.score >= 90 ? "var(--good)" : night.score >= 75 ? "var(--light)" : "var(--ok)"}
                label="Score"
              />
              <div style={{ flex: 1 }} className="kpi-grid">
                <div className="kpi">
                  <span className="kpi-label">Asleep</span>
                  <span className="kpi-val">{fmtHM(night.asleep)}</span>
                </div>
                <div className="kpi">
                  <span className="kpi-label">Avg HR</span>
                  <span className="kpi-val">
                    {night.hr || "—"}
                    <small>bpm</small>
                  </span>
                </div>
                <div className="kpi">
                  <span className="kpi-label">SpO₂</span>
                  <span className="kpi-val">
                    {night.spo2 || "—"}
                    <small>%</small>
                  </span>
                </div>
                <div className="kpi">
                  <span className="kpi-label">Breath</span>
                  <span className="kpi-val">
                    {night.breath || "—"}
                    <small>/m</small>
                  </span>
                </div>
              </div>
            </div>
          </Card>
          <Card title="Sleep stages" sub="hypnogram">
            <Hypnogram segs={night.segments} height={130} start={night.start} end={night.end} />
            <Legend
              items={[
                { color: "var(--deep)", label: "Deep" },
                { color: "var(--rem)", label: "REM" },
                { color: "var(--light)", label: "Light" },
                { color: "var(--awake)", label: "Awake" },
              ]}
            />
          </Card>
          <div className="row2">
            {(
              [
                ["Deep", night.deep, "var(--deep)"],
                ["REM", night.rem, "var(--rem)"],
                ["Light", night.light, "var(--light)"],
                ["Awake", night.awake, "var(--awake)"],
              ] as [string, number, string][]
            ).map(([k, v, c]) => (
              <div className="tile" key={k}>
                <div className="tile-label" style={{ color: c }}>
                  {k}
                </div>
                <div className="tile-val" style={{ fontSize: 22 }}>
                  {fmtHM(v)}
                </div>
                <div className="tile-sub">{Math.round((v / night.asleep) * 100)}% of night</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function NightRow({ n, onClick }: { n: Night; onClick?: () => void }) {
  return (
    <div className="lrow" onClick={onClick}>
      <div className="lrow-main">
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>{n.date}</span>
          <span style={{ fontSize: 12, color: "var(--text-faint)", fontWeight: 600 }}>{fmtH(n.asleep)}</span>
        </div>
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
      <div className="lrow-dur" style={{ minWidth: 30, textAlign: "right" }}>
        {n.score}
      </div>
    </div>
  );
}

/* All nights detail — full backlog (wide sleep_stage window). */
export function AllNights() {
  const nav = useNav();
  const { nights } = useSleepData(365);
  return (
    <div className="detail">
      <DetailHeader title="All nights" sub={`${nights.length} night${nights.length === 1 ? "" : "s"}`} accent="var(--light)" />
      <div className="scroll">
        <div className="stack">
          <Card noPad>
            {nights.length ? (
              <div className="list" style={{ padding: "0 16px" }}>
                {nights.map((n, i) => (
                  <NightRow key={n.date} n={n} onClick={() => nav.push(<NightDetail night={n} idx={i} />)} />
                ))}
              </div>
            ) : (
              <NoData label="No sleep nights yet" hint="Sync a device that records sleep stages." height={160} />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* Duration detail (stacked weekly + insight) */
export function DurationDetail() {
  const sleep = useSleepData();
  const SW = sleep.weekly;
  const hasDuration = sleep.real && SW.duration.length > 0;
  const nDays = SW.duration.length || 1;
  const avgTotal = Math.round(SW.duration.reduce((s, d) => s + d.total, 0) / nDays);
  const avgDeep = SW.duration.reduce((s, d) => s + d.deep, 0) / nDays;
  const avgAsleep = SW.duration.reduce((s, d) => s + d.total, 0) / nDays;
  const deepPct = avgAsleep ? Math.round((avgDeep / avgAsleep) * 100) : 0;
  const rangeNote =
    avgTotal >= 420 && avgTotal <= 540
      ? "comfortably in the optimal range"
      : avgTotal >= 360
        ? "a touch below the optimal range"
        : "well under the recommended range";
  return (
    <div className="detail">
      <DetailHeader title="Sleep duration" sub="vs last 7 days" accent="var(--light)" />
      <div className="scroll">
        <div className="stack">
          <Card>
            {hasDuration ? (
              <>
                <StackedBars
                  data={SW.duration.map((d) => ({ d: d.d, deep: d.deep, light: d.light, rem: d.rem, awake: d.awake }))}
                  keys={["deep", "light", "rem", "awake"]}
                  colors={["var(--deep)", "var(--light)", "var(--rem)", "var(--awake)"]}
                  height={230}
                />
                <Legend
                  items={[
                    { color: "var(--deep)", label: "Deep" },
                    { color: "var(--light)", label: "Light" },
                    { color: "var(--rem)", label: "REM" },
                    { color: "var(--awake)", label: "Awake" },
                  ]}
                />
              </>
            ) : (
              <NoData label="No sleep duration data" hint="Sync a device that records sleep stages." height={230} />
            )}
          </Card>
          {hasDuration && (
            <Card>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: "var(--text-dim)" }}>
                You averaged <b style={{ color: "var(--text)" }}>{fmtHM(avgTotal)}</b> over the last{" "}
                {nDays} night{nDays === 1 ? "" : "s"} — {rangeNote}. Deep sleep averaged about {deepPct}% of the night.
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

export function RegularityDetail() {
  const sleep = useSleepData();
  const SW = sleep.weekly;
  // regularity is 0 when there aren't enough nights to judge → show "—".
  const hasRegularity = sleep.real && sleep.regularity > 0 && SW.regularity.length > 0;
  // Spread of bed & wake times across the week, in minutes (range = max − min).
  const reg = SW.regularity;
  const unwrap = (h: number) => (h < 12 ? h + 24 : h) * 60; // bed times past midnight unwrap
  const spread = (vals: number[]) => (vals.length ? Math.round(Math.max(...vals) - Math.min(...vals)) : 0);
  const bedSpread = spread(reg.map((r) => unwrap(r.bed)));
  const wakeSpread = spread(reg.map((r) => r.wake * 60));
  const maxSpread = Math.max(bedSpread, wakeSpread);
  const spreadNote =
    maxSpread < 60
      ? "varied by under an hour this week — excellent"
      : `varied by up to about ${fmtHM(maxSpread)} this week`;
  const qual = sleep.regularity >= 85 ? "strong" : sleep.regularity >= 70 ? "fairly steady" : "irregular";
  return (
    <div className="detail">
      <DetailHeader
        title="Sleep regularity"
        sub={hasRegularity ? `${sleep.regularity}% · ${sleep.regularity >= 85 ? "optimal" : "variable"}` : "—"}
        accent="var(--good)"
      />
      <div className="scroll">
        <div className="stack">
          <Card>
            {hasRegularity ? (
              <RegularityBars data={SW.regularity} height={240} />
            ) : (
              <NoData label="Not enough nights yet" hint="A few nights of sleep tracking are needed to judge regularity." height={240} />
            )}
          </Card>
          {hasRegularity && (
            <Card>
              <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5, color: "var(--text-dim)" }}>
                Consistent bed and wake times keep your circadian rhythm {qual}. At{" "}
                <b style={{ color: "var(--text)" }}>{sleep.regularity}%</b>, your schedule {spreadNote}.
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

export function Sleep() {
  const nav = useNav();
  const { recomputing, nonce, trigger } = useRecomputeTrigger();
  const sleep = useSleepData(30, nonce);
  const { nights } = sleep;
  const LN = nights[0];

  // No real sleep data → honest empty state (no mock night/week).
  if (!sleep.real || !LN) {
    return (
      <div className="stack fade-up">
        <Card>
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
  const deepPct = Math.round((LN.deep / LN.asleep) * 100);
  const remPct = Math.round((LN.rem / LN.asleep) * 100);

  // STATUS pills derived from the real last-night figures.
  const deepStatus =
    deepPct >= 13 && deepPct <= 23
      ? { label: "OPTIMAL", color: "var(--good)" }
      : deepPct >= 10
        ? { label: "GOOD", color: "var(--light)" }
        : { label: "LOW", color: "var(--ok)" };
  const remStatus =
    remPct >= 20 && remPct <= 25
      ? { label: "OPTIMAL", color: "var(--good)" }
      : remPct >= 15
        ? { label: "GOOD", color: "var(--light)" }
        : { label: "WATCH", color: "var(--ok)" };
  const awakeSegs = LN.segments.filter((s) => s.stage === "awake").length;
  const awakeStatus =
    awakeSegs >= 4 || LN.awake >= 30
      ? { label: "WATCH", color: "var(--ok)" }
      : awakeSegs >= 2
        ? { label: "GOOD", color: "var(--light)" }
        : { label: "OPTIMAL", color: "var(--good)" };
  const durStatus =
    LN.asleep >= 420 && LN.asleep <= 540
      ? { label: "OPTIMAL", color: "var(--good)" }
      : LN.asleep >= 360
        ? { label: "GOOD", color: "var(--light)" }
        : { label: "WATCH", color: "var(--ok)" };

  return (
    <div className="stack fade-up">
      {/* HERO — score ring */}
      <Card>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 6 }}>
          <Ring value={LN.score} size={172} stroke={13} color="var(--light)" glow label="Sleep score" sub="last night" />
          <div style={{ display: "flex", gap: 26, marginTop: 14 }}>
            <div className="kpi" style={{ alignItems: "center" }}>
              <span className="kpi-label">Asleep</span>
              <span className="kpi-val">{fmtHM(LN.asleep)}</span>
            </div>
            <div className="kpi" style={{ alignItems: "center" }}>
              <span className="kpi-label">Avg HR</span>
              <span className="kpi-val">
                {LN.hr || "—"}
                <small>bpm</small>
              </span>
            </div>
            <div className="kpi" style={{ alignItems: "center" }}>
              <span className="kpi-label">Breath</span>
              <span className="kpi-val">
                {LN.breath || "—"}
                <small>/m</small>
              </span>
            </div>
          </div>
        </div>
      </Card>

      {/* HYPNOGRAM */}
      <Card
        title="Sleep stages"
        sub="last night · hypnogram"
        onClick={() => nav.push(<NightDetail night={LN} idx={0} />)}
        action={
          <button
            className="pill"
            disabled={recomputing}
            onClick={(e) => {
              e.stopPropagation();
              trigger();
            }}
            style={{ opacity: recomputing ? 0.6 : 1 }}
          >
            {recomputing ? "Computing…" : "Recompute"} <Icon name="refresh" size={12} />
          </button>
        }
      >
        <Hypnogram segs={LN.segments} height={120} start={LN.start} end={LN.end} />
        <Legend
          items={[
            { color: "var(--deep)", label: "Deep" },
            { color: "var(--rem)", label: "REM" },
            { color: "var(--light)", label: "Light" },
            { color: "var(--awake)", label: "Awake" },
          ]}
        />
      </Card>

      {/* METRICS */}
      <SectionLabel>Sleep metrics</SectionLabel>
      <Card noPad>
        <div className="list" style={{ padding: "0 14px" }}>
          <MetricRow
            icon="zzz"
            name="Sleep duration"
            value={fmtHM(LN.asleep)}
            status={durStatus.label}
            color={durStatus.color}
            onClick={() => nav.push(<DurationDetail />)}
          />
          <MetricRow
            icon="moon"
            name="Sleep regularity"
            value={sleep.regularity > 0 ? `${sleep.regularity}%` : "—"}
            status={sleep.regularity <= 0 ? undefined : sleep.regularity >= 85 ? "OPTIMAL" : sleep.regularity >= 70 ? "GOOD" : "WATCH"}
            color={sleep.regularity >= 85 ? "var(--good)" : sleep.regularity >= 70 ? "var(--light)" : "var(--ok)"}
            onClick={() => nav.push(<RegularityDetail />)}
          />
          <MetricRow
            icon="bed"
            name="Deep sleep"
            value={fmtHM(LN.deep)}
            sub={`${deepPct}% of night`}
            status={deepStatus.label}
            color={deepStatus.color}
            onClick={() =>
              nav.push(
                <MetricDetail
                  title="Deep sleep"
                  sub="Per night"
                  accent="var(--deep)"
                  unit="min"
                  source={{ src: "sleep", field: "deep" }}
                />,
              )
            }
          />
          <MetricRow
            icon="zzz"
            name="REM sleep"
            value={fmtHM(LN.rem)}
            sub={`${remPct}% of night`}
            status={remStatus.label}
            color={remStatus.color}
            onClick={() =>
              nav.push(
                <MetricDetail
                  title="REM sleep"
                  sub="Per night"
                  accent="var(--rem)"
                  unit="min"
                  source={{ src: "sleep", field: "rem" }}
                />,
              )
            }
          />
          <MetricRow
            icon="clock"
            name="Awake"
            value={fmtHM(LN.awake)}
            sub={`${awakeSegs} time${awakeSegs === 1 ? "" : "s"}`}
            status={awakeStatus.label}
            color={awakeStatus.color}
            onClick={() =>
              nav.push(
                <MetricDetail
                  title="Awake time"
                  sub="Per night"
                  accent="var(--ok)"
                  unit="min"
                  source={{ src: "sleep", field: "awake" }}
                />,
              )
            }
          />
        </div>
      </Card>

      {/* WEEKLY — DURATION */}
      <Card title="Sleep duration" sub="vs last 7 days" onClick={() => nav.push(<DurationDetail />)}>
        <StackedBars
          data={SW.duration.map((d) => ({ d: d.d, deep: d.deep, light: d.light, rem: d.rem, awake: d.awake }))}
          keys={["deep", "light", "rem", "awake"]}
          colors={["var(--deep)", "var(--light)", "var(--rem)", "var(--awake)"]}
          height={155}
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

      {/* WEEKLY — REGULARITY */}
      <Card title="Sleep regularity" sub="bed & wake" onClick={() => nav.push(<RegularityDetail />)}>
        {SW.regularity.length ? (
          <RegularityBars data={SW.regularity} height={165} />
        ) : (
          <NoData label="No regularity data yet" height={165} />
        )}
      </Card>

      {/* WEEKLY — HR DURING SLEEP */}
      <Card
        title="Sleep heart rate"
        sub="bpm"
        onClick={() =>
          nav.push(
            <MetricDetail
              title="Sleep heart rate"
              sub="Per night"
              accent="var(--good)"
              unit="bpm"
              source={{ src: "sleep", field: "hr" }}
            />,
          )
        }
      >
        {SW.hr.length ? (
          <LineChart data={SW.hr} xLabels={SW.hr.map((x) => x.d)} height={140} color="var(--good)" showDots valueLabels />
        ) : (
          <NoData label="No sleep heart-rate data" height={140} />
        )}
      </Card>

      {/* WEEKLY — HYPOPNEA — no data source; always empty (never mocked) */}
      <Card
        title="Hypopnea"
        sub="events / h"
        onClick={() =>
          nav.push(
            <MetricDetail
              title="Hypopnea"
              sub="Events per hour"
              accent="var(--ok)"
              decimals={1}
              source={{ src: "none" }}
            />,
          )
        }
      >
        <NoData label="No hypopnea data" hint="No device on this account reports hypopnea events." height={140} />
      </Card>

      {/* WEEKLY — BREATHING */}
      <Card
        title="Breathing rate"
        sub="brpm"
        onClick={() =>
          nav.push(
            <MetricDetail
              title="Breathing rate"
              sub="Per night"
              accent="var(--light)"
              unit="brpm"
              source={{ src: "sleep", field: "breath" }}
            />,
          )
        }
      >
        {SW.breath.length ? (
          <LineChart data={SW.breath} xLabels={SW.breath.map((x) => x.d)} height={140} color="var(--light)" showDots valueLabels />
        ) : (
          <NoData label="No breathing-rate data" height={140} />
        )}
      </Card>

      {/* RECENT NIGHTS */}
      <Card
        title="Recent nights"
        action={
          <button
            className="pill"
            onClick={(e) => {
              e.stopPropagation();
              nav.push(<AllNights />);
            }}
          >
            All nights <Icon name="arrowUR" size={12} />
          </button>
        }
        noPad
      >
        <div className="list" style={{ padding: "0 16px 4px" }}>
          {nights.slice(0, 6).map((n, i) => (
            <NightRow
              key={n.date}
              n={n}
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
            />
          ))}
        </div>
      </Card>
    </div>
  );
}
