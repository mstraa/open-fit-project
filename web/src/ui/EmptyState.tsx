// On-brand empty state — used everywhere a future module has no backend data.
// Styled with the design tokens (muted text, a dashed hairline border on a faint
// card). HARD RULE: render the real module styled per design but never fake
// numbers. Use this with label="No data yet" + an optional phase tag.

import type { ReactNode } from "react";
import { NoDataIcon } from "../app/icons";

export interface EmptyStateProps {
  /** Short headline, e.g. "No data yet". */
  label?: string;
  /** Optional supporting line, e.g. "Wellness ingestion lands next phase." */
  hint?: ReactNode;
  /** Deprecated/ignored: roadmap "Phase N" tags are no longer rendered. Kept so
   *  existing call sites still type-check; remove the props at leisure. */
  phase?: string;
  /** Override the default glyph. */
  icon?: ReactNode;
  /** Compact variant (smaller padding) for inline / tile use. */
  compact?: boolean;
}

export function EmptyState({
  label = "No data yet",
  hint,
  icon,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: 10,
        padding: compact ? "20px 16px" : "40px 24px",
        border: "1px dashed var(--border-2)",
        borderRadius: "var(--r)",
        background: "var(--surface)",
        color: "var(--muted)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 34,
          height: 34,
          borderRadius: "var(--r-sm)",
          display: "grid",
          placeItems: "center",
          background: "var(--surface-2)",
          color: "var(--faint)",
        }}
      >
        {icon ?? <NoDataIcon style={{ width: 18, height: 18 }} />}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>{label}</span>
      </div>
      {hint ? (
        <div style={{ fontSize: 11.5, color: "var(--faint)", maxWidth: "44ch" }}>{hint}</div>
      ) : null}
    </div>
  );
}
