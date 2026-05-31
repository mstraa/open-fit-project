// Sleep screen — the user-facing payoff of the `sleep` built-in algorithm
// (ofit-analytics): nightly sleep score + stage breakdown (deep / REM / light /
// awake), derived from per-minute SleepStage wellness (Zepp / Gadgetbridge
// imports). We pull the last few weeks of day-subject derived metrics and render
// the nights that have data; if none do, the on-brand empty state.

import { useEffect, useState } from "react";
import { AppShell } from "../app/AppShell";
import { EmptyState } from "../ui/EmptyState";
import { Spinner } from "../ui/primitives";
import { getDerived } from "../api/endpoints";

interface NightSummary {
  date: string; // YYYY-MM-DD (wake-up date)
  score: number;
  totalMin: number;
  deepMin: number;
  remMin: number;
  lightMin: number;
  awakeMin: number;
}

const LOOKBACK_DAYS = 21;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtDur(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

function useSleepNights(): { loading: boolean; nights: NightSummary[] } {
  const [loading, setLoading] = useState(true);
  const [nights, setNights] = useState<NightSummary[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const today = new Date();
      const days = Array.from({ length: LOOKBACK_DAYS }, (_, i) => {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - i);
        return isoDay(d);
      });
      const results = await Promise.all(
        days.map(async (date) => {
          try {
            const r = await getDerived(`day:${date}`);
            const by = new Map(r.metrics.map((m) => [m.name, m.value]));
            if (by.get("sleep_available") !== 1) return null;
            return {
              date,
              score: by.get("sleep_score") ?? 0,
              totalMin: by.get("sleep_total_min") ?? 0,
              deepMin: by.get("sleep_deep_min") ?? 0,
              remMin: by.get("sleep_rem_min") ?? 0,
              lightMin: by.get("sleep_light_min") ?? 0,
              awakeMin: by.get("sleep_awake_min") ?? 0,
            } satisfies NightSummary;
          } catch {
            return null;
          }
        }),
      );
      if (!alive) return;
      setNights(results.filter((n): n is NightSummary => n !== null));
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  return { loading, nights };
}

const STAGE_TINT: Record<string, string> = {
  deep: "var(--hr, #6c8cff)",
  rem: "var(--acc, #8e7bff)",
  light: "var(--pace, #46c3a6)",
  awake: "var(--muted, #5a6072)",
};

function StageBar({ n }: { n: NightSummary }) {
  const staged = n.deepMin + n.remMin + n.lightMin + n.awakeMin || 1;
  const seg = (min: number, tint: string, label: string) =>
    min > 0 ? (
      <span
        title={`${label}: ${fmtDur(min)}`}
        style={{ width: `${(min / staged) * 100}%`, background: tint, display: "block", height: "100%" }}
      />
    ) : null;
  return (
    <div
      style={{ display: "flex", height: 10, borderRadius: 999, overflow: "hidden", width: "100%", background: "var(--surface-2, #1a1d28)" }}
    >
      {seg(n.deepMin, STAGE_TINT.deep, "Deep")}
      {seg(n.remMin, STAGE_TINT.rem, "REM")}
      {seg(n.lightMin, STAGE_TINT.light, "Light")}
      {seg(n.awakeMin, STAGE_TINT.awake, "Awake")}
    </div>
  );
}

function scoreTint(score: number): string {
  if (score >= 85) return "t-pace";
  if (score >= 70) return "t-acc";
  return "t-hr";
}

export function Sleep() {
  const { loading, nights } = useSleepNights();
  const latest = nights[0];

  return (
    <AppShell title="Sleep" crumb="Sleep staging & overnight recovery">
      {loading ? (
        <Spinner label="Loading sleep…" />
      ) : nights.length === 0 ? (
        <EmptyState
          label="No sleep data yet"
          hint="Import a Zepp export or Gadgetbridge DB with sleep tracking (Wellness → Import), then Recompute on the Algorithms screen."
        />
      ) : (
        <>
          {latest && (
            <div className="grid grid--stats" style={{ marginBottom: 24 }}>
              <div className="card stat">
                <div className={`stat__ico ${scoreTint(latest.score)}`}>
                  <MoonGlyph />
                </div>
                <div className="stat__label">Last night score</div>
                <div className="stat__val num">{Math.round(latest.score)}<small> /100</small></div>
              </div>
              <div className="card stat">
                <div className="stat__ico t-acc"><MoonGlyph /></div>
                <div className="stat__label">Time asleep</div>
                <div className="stat__val num">{fmtDur(latest.totalMin)}</div>
              </div>
              <div className="card stat">
                <div className="stat__ico t-hr"><MoonGlyph /></div>
                <div className="stat__label">Deep</div>
                <div className="stat__val num">{fmtDur(latest.deepMin)}</div>
              </div>
              <div className="card stat">
                <div className="stat__ico t-pace"><MoonGlyph /></div>
                <div className="stat__label">REM</div>
                <div className="stat__val num">{fmtDur(latest.remMin)}</div>
              </div>
            </div>
          )}

          <div className="card">
            <div className="card__head">
              <div className="card__title">
                Recent nights<span className="sub">deep · REM · light · awake</span>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 8 }}>
              {nights.map((n) => (
                <div key={n.date} style={{ display: "grid", gridTemplateColumns: "92px 1fr 56px", alignItems: "center", gap: 14 }}>
                  <span className="muted" style={{ fontSize: 12.5 }}>{n.date}</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <StageBar n={n} />
                    <span className="faint" style={{ fontSize: 11 }}>{fmtDur(n.totalMin)} asleep</span>
                  </div>
                  <span className="num" style={{ fontWeight: 700, textAlign: "right" }}>{Math.round(n.score)}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}

function MoonGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
