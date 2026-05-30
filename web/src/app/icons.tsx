// SVG icons ported verbatim from the design export (docs/designs/*.html).
// Each is a tiny presentational component sized by the consuming CSS (.nav a svg,
// .iconbtn svg, .btn svg, .stat__ico svg ...). They take currentColor strokes.

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/** The OpenFit logo mark (filled path on the accent square). */
export function LogoMark(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M3 13h3l2-7 4 14 3-9 2 2h4"
        stroke="#04121f"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
} as const;

export function DashboardIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  );
}

export function ActivitiesIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <path d="M3 12h4l3 7 4-14 3 7h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function WellnessIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <path
        d="M12 21s-7-4.5-7-9.5A3.5 3.5 0 0112 8a3.5 3.5 0 017 3.5C19 16.5 12 21 12 21z"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SleepIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" strokeLinecap="round" />
    </svg>
  );
}

export function TrendsIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <path d="M4 19V5m0 14h16M8 16V9m4 7V6m4 10v-4" strokeLinecap="round" />
    </svg>
  );
}

export function DevicesIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <path d="M12 8a4 4 0 100 8 4 4 0 000-8z" />
      <path d="M3 12l2-1m14 1l2-1M12 3v3m0 12v3" strokeLinecap="round" />
    </svg>
  );
}

export function AlgorithmsIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" />
    </svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 13a7.7 7.7 0 000-2l2-1.5-2-3.5-2.4 1a7.6 7.6 0 00-1.7-1L15 0h-4l-.3 2.5a7.6 7.6 0 00-1.7 1l-2.4-1-2 3.5L4.6 11a7.7 7.7 0 000 2l-2 1.5 2 3.5 2.4-1a7.6 7.6 0 001.7 1L11 24h4l.3-2.5a7.6 7.6 0 001.7-1l2.4 1 2-3.5z"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4-4" strokeLinecap="round" />
    </svg>
  );
}

export function ImportIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <path d="M12 16V4m0 0L8 8m4-4l4 4M4 20h16" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Generic "no data" glyph for empty states. */
export function NoDataIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8" strokeLinecap="round" />
    </svg>
  );
}
