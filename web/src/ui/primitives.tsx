// Small token-styled building blocks shared across views. Inline styles read
// design tokens so light/dark are handled automatically by the ThemeProvider.

import type { CSSProperties, ReactNode } from "react";

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <section
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-1)",
        padding: "var(--space-6)",
        ...style,
      }}
    >
      {children}
    </section>
  );
}

type ButtonKind = "primary" | "ghost";

export function Button({
  children,
  onClick,
  kind = "ghost",
  disabled,
  type = "button",
  style,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: ButtonKind;
  disabled?: boolean;
  type?: "button" | "submit";
  style?: CSSProperties;
}) {
  const primary = kind === "primary";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        background: primary ? "var(--color-accent)" : "var(--color-surface-alt)",
        color: primary ? "var(--color-accent-contrast)" : "var(--color-text)",
        border: `1px solid ${primary ? "var(--color-accent)" : "var(--color-border)"}`,
        borderRadius: "var(--radius-sm)",
        padding: "var(--space-2) var(--space-3)",
        font: "inherit",
        fontWeight: "var(--font-weight-bold)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

type BannerKind = "info" | "error" | "success";

export function Banner({
  kind,
  children,
}: {
  kind: BannerKind;
  children: ReactNode;
}) {
  const color =
    kind === "error"
      ? "var(--color-danger)"
      : kind === "success"
        ? "var(--color-success)"
        : "var(--color-text-muted)";
  return (
    <div
      role={kind === "error" ? "alert" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        border: `1px solid ${color}`,
        borderRadius: "var(--radius-sm)",
        padding: "var(--space-2) var(--space-3)",
        color,
        background: "var(--color-surface-alt)",
        fontSize: "var(--font-size-sm)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: "0.5rem",
          height: "0.5rem",
          borderRadius: "50%",
          background: "currentColor",
          flex: "0 0 auto",
        }}
      />
      <span>{children}</span>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        color: "var(--color-text-muted)",
        fontSize: "var(--font-size-sm)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: "0.875rem",
          height: "0.875rem",
          border: "2px solid var(--color-border)",
          borderTopColor: "var(--color-accent)",
          borderRadius: "50%",
          animation: "ofit-spin 0.7s linear infinite",
        }}
      />
      {label ?? "Loading…"}
    </span>
  );
}
