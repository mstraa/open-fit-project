// Shared Readiness section — one component rendered identically on the Dashboard
// and the Wellness page (previously two divergent `.banner` "notification"
// widgets). Presentational: it takes the training-load DTO and renders a proper
// card section (heading + prominent 0–100 score + HRV vs baseline), or a
// graceful "not computed yet" prompt with a Recompute link.

import { Link } from "react-router-dom";
import type { SVGProps } from "react";
import type { TrainingLoadResponseDto } from "../api/schema";

const g = { fill: "none", stroke: "currentColor", strokeWidth: 2 } as const;

function HeartGlyph(p: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...g} aria-hidden {...p}>
      <path d="M12 21s-7-4.5-7-9.5A3.5 3.5 0 0112 8a3.5 3.5 0 017 3.5C19 16.5 12 21 12 21z" />
    </svg>
  );
}

/** Single tier scale shared by both pages. */
function tier(score: number): { word: string; tint: string } {
  if (score >= 75) return { word: "Primed", tint: "t-pace" };
  if (score >= 55) return { word: "Balanced", tint: "t-pace" };
  if (score >= 35) return { word: "Strained", tint: "t-cad" };
  return { word: "Depleted", tint: "t-hr" };
}

export function ReadinessSection({ data }: { data: TrainingLoadResponseDto | null }) {
  const ok = data != null && data.readiness_available && data.readiness != null;
  const score = ok ? Math.round(data!.readiness as number) : null;
  const t = score != null ? tier(score) : { word: "", tint: "t-acc" };

  return (
    <section className="card" style={{ marginBottom: "var(--gap)" }}>
      <div className="card__head">
        <div className={`stat__ico ${t.tint}`} style={{ marginBottom: 0 }}>
          <HeartGlyph />
        </div>
        <div className="card__title">
          Readiness{ok ? ` · ${t.word}` : ""}
          <span className="sub">recovery</span>
        </div>
        {ok && (
          <div className="card__tools">
            <span className="num" style={{ fontSize: 30, fontWeight: 800, lineHeight: 1 }}>
              {score}
              <small style={{ fontSize: 13, opacity: 0.6 }}> /100</small>
            </span>
          </div>
        )}
      </div>

      {ok ? (
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 4 }}>
          <div className="stat">
            <div className="stat__label">HRV · overnight</div>
            <div className="stat__val num">
              {data!.hrv_rmssd != null ? Math.round(data!.hrv_rmssd) : "—"} <small>ms</small>
            </div>
          </div>
          <div className="stat">
            <div className="stat__label">Baseline</div>
            <div className="stat__val num">
              {data!.hrv_baseline != null ? Math.round(data!.hrv_baseline) : "—"} <small>ms</small>
            </div>
          </div>
          <p className="muted" style={{ margin: "auto 0 0", fontSize: 12.5, minWidth: 180, flex: 1 }}>
            HRV + resting-HR vs your personal baseline.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 4 }}>
          <p className="muted" style={{ margin: 0, fontSize: 12.5, flex: 1, minWidth: 200 }}>
            Needs overnight HRV + resting HR — import a Gadgetbridge DB or Zepp export, then Recompute on
            the Algorithms screen.
          </p>
          <Link to="/algorithms" className="pill" style={{ fontFamily: "var(--font-mono)" }}>
            Recompute →
          </Link>
        </div>
      )}
    </section>
  );
}
