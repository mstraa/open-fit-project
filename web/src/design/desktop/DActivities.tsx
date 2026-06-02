/* ============================================================
   OpenFit redesign — DESKTOP Activities screen.
   Ported from js/desktop.jsx → DActivities.
   • "This week" hero = REAL (useTrainingSummary): sessions / mins /
     distance (km, "—" when null) + per-day Bars.
   • Table + by-sport breakdown + filter chips use REAL rows
     via useActivitiesList(); row distance is real (a.dist km, "—").
   • Activity rows open a full-page ActivityDetail overlay.
   ============================================================ */
import { useState } from "react";
import { Card, Chip, SportBadge, useNav } from "../ui";
import { CountUp, Bars } from "../charts";
import { MetricDetail } from "../shared";
import { useActivitiesList, useTrainingSummary, type ActivityRow } from "../wiring";
import { fmtDur } from "../util";
import { ActivityDetail } from "../pages/Activities";

const FILTERS = ["All", "Running", "Cycling", "Walking", "Strength", "Activity"] as const;

export function DActivities() {
  const nav = useNav();
  const [filter, setFilter] = useState<string>("All");
  const { rows, counts, total, reload } = useActivitiesList();
  const week = useTrainingSummary("Week", 0);

  const list = filter === "All" ? rows : rows.filter((r) => r.sportLabel === filter);

  // By-sport breakdown = this week's training VOLUME (minutes) per sport, from
  // the same useTrainingSummary hook that feeds the "This week" hero.
  const maxSportMins = Math.max(1, ...week.bySport.map((s) => s.mins));

  return (
    <div className="dgrid">
      <Card
        className="c8"
        title="This week"
        sub="training"
        onClick={() =>
          nav.push(
            <MetricDetail
              title="Training time"
              sub="Per day"
              accent="var(--run)"
              unit="min"
              chart="bar"
              source={{ src: "trainingMinutes" }}
            />,
          )
        }
      >
        <div style={{ display: "flex", gap: 34, marginBottom: 14 }}>
          <div className="kpi">
            <span className="kpi-label">Sessions</span>
            <span className="kpi-val" style={{ fontSize: 30 }}>
              <CountUp to={week.sessions} />
            </span>
          </div>
          <div className="kpi">
            <span className="kpi-label">Total time</span>
            <span className="kpi-val" style={{ fontSize: 30 }}>
              <CountUp to={week.mins} />
              <small>min</small>
            </span>
          </div>
          <div className="kpi">
            <span className="kpi-label">Distance</span>
            <span className="kpi-val" style={{ fontSize: 30 }}>
              {week.dist != null ? (
                <>
                  {week.dist}
                  <small>km</small>
                </>
              ) : (
                "—"
              )}
            </span>
          </div>
        </div>
        <Bars
          data={week.bars}
          height={150}
          colorFn={() => "var(--run)"}
          valueFmt={(v) => v || ""}
        />
      </Card>

      <Card className="c4" title="By sport" sub="this week" noPad>
        <div style={{ padding: "4px 18px 10px" }}>
          {week.bySport.length === 0 ? (
            <div style={{ padding: "22px 0", textAlign: "center", color: "var(--text-faint)", fontSize: 13 }}>
              No training this week.
            </div>
          ) : (
            week.bySport.map((s) => {
              const sport = rows.find((r) => r.sportLabel === s.sport)?.sport ?? "other";
              return (
                <div className="lrow" key={s.sport} style={{ cursor: "pointer" }} onClick={() => setFilter(s.sport)}>
                  <SportBadge sport={sport} size={34} />
                  <div className="lrow-main">
                    <div className="lrow-title" style={{ fontSize: 14 }}>
                      {s.sport}
                    </div>
                    <div style={{ height: 5, borderRadius: 3, background: "var(--track)", marginTop: 6, overflow: "hidden" }}>
                      <div style={{ width: `${(s.mins / maxSportMins) * 100}%`, height: "100%", background: s.color }} />
                    </div>
                  </div>
                  <div className="lrow-dur">
                    {s.mins}
                    <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-sans)", marginLeft: 2 }}>min</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </Card>

      <div className="c12" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {FILTERS.map((f) => {
          const n = f === "All" ? total : counts[f];
          return (
            <Chip key={f} active={filter === f} onClick={() => setFilter(f)}>
              {f}
              {n != null ? ` · ${n}` : ""}
            </Chip>
          );
        })}
      </div>

      <Card className="c12" noPad>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "2fr 2fr 1fr 1fr 1fr",
            padding: "12px 20px",
            borderBottom: "1px solid var(--line)",
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: "var(--text-faint)",
          }}
        >
          <span>Sport</span>
          <span>Started</span>
          <span>Distance</span>
          <span style={{ textAlign: "right" }}>Duration</span>
          <span style={{ textAlign: "right" }}>Sources</span>
        </div>
        {list.map((a: ActivityRow) => (
          <div
            key={a.id}
            onClick={() => nav.pushPage(<ActivityDetail act={a} onChanged={reload} />)}
            style={{
              display: "grid",
              gridTemplateColumns: "2fr 2fr 1fr 1fr 1fr",
              alignItems: "center",
              padding: "12px 20px",
              borderBottom: "1px solid var(--line)",
              cursor: "pointer",
            }}
            className="drow"
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <SportBadge sport={a.sport} size={34} />
              <span style={{ fontWeight: 700, fontSize: 14 }}>{a.sportLabel}</span>
            </div>
            <span style={{ fontSize: 13, color: "var(--text-dim)", fontWeight: 600 }}>{a.when}</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>{a.dist ? a.dist + " km" : "—"}</span>
            <span className="lrow-dur" style={{ textAlign: "right" }}>
              {fmtDur(a.dur)}
            </span>
            <span style={{ textAlign: "right" }}>
              {a.rec > 1 ? (
                <span className="lrow-tag">{a.rec} merged</span>
              ) : (
                <span style={{ color: "var(--text-faint)", fontSize: 13 }}>{a.rec}</span>
              )}
            </span>
          </div>
        ))}
      </Card>
    </div>
  );
}
