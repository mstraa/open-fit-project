/* Live "computing…" indicator for the background analytics worker. Shows a
   small floating pill while a recompute pass is running (push data → it quietly
   recomputes the affected units; this is the visual feedback). */
import { useEffect, useState } from "react";
import { useAnalyticsStatus } from "../hooks/useAnalyticsStatus";

/* Only surface the pill once a pass has been running long enough to be worth
   noticing. Trivial recomputes (e.g. a single dirty day) finish well under this
   and never flash; only genuinely slow passes (many days) cross the threshold. */
const SHOW_AFTER_MS = 900;

export function RecomputeStatusPill() {
  const status = useAnalyticsStatus();

  // Debounce visibility: start a timer when work begins; reveal only if still
  // working after the delay. Hide immediately when work stops.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!status.working) {
      setVisible(false);
      return;
    }
    const t = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [status.working]);

  if (!status.working || !visible) return null;
  const label = status.current.length ? status.current.join(" · ") : "analytics";
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        bottom: 18,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 14px",
        borderRadius: 999,
        background: "var(--card, #171c27)",
        border: "1px solid var(--line, #232a36)",
        boxShadow: "0 6px 24px rgba(0,0,0,.4)",
        font: "600 12.5px var(--font, system-ui)",
        color: "var(--text-dim, #aab3c0)",
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: "var(--blue, #38a4f5)",
          boxShadow: "0 0 0 0 var(--blue, #38a4f5)",
          animation: "ofitPulse 1.1s ease-out infinite",
        }}
      />
      <span>
        Computing {label}
        {status.queued > 1 ? ` · ${status.queued} queued` : ""}…
      </span>
      <style>{`@keyframes ofitPulse{0%{box-shadow:0 0 0 0 rgba(56,164,245,.5)}70%{box-shadow:0 0 0 7px rgba(56,164,245,0)}100%{box-shadow:0 0 0 0 rgba(56,164,245,0)}}`}</style>
    </div>
  );
}
