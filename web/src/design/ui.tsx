/* ============================================================
   OpenFit redesign — UI primitives, icons, navigation context.
   Ported from the design bundle's js/ui.jsx into typed TSX.
   ============================================================ */
import {
  useState,
  useEffect,
  useContext,
  createContext,
  type ReactNode,
  type CSSProperties,
} from "react";
import type { Sport } from "../api/types";
import { CountUp, Spark } from "./charts";
import { SPORTS } from "./data";
import { tint } from "./util";

/* ---------------- ICONS ---------------- */
export const ICONS: Record<string, string> = {
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",
  heart:
    "M12 21.35l-1.45-1.32C5.4 15.36 2 12.27 2 8.5 2 5.41 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.41 22 8.5c0 3.77-3.4 6.86-8.55 11.53L12 21.35z",
  pulse: "M3 12h4l3 8 4-16 3 8h4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  run: "M13 4a1.6 1.6 0 1 0 0-.1M7 21l3-5 2-3 3 2 1 5M6 11l3-2 4 1 2 3 3 1",
  bike: "M5.5 18.5a3 3 0 1 0 0-.1M18.5 18.5a3 3 0 1 0 0-.1M6 18l4-7h5l-2-4M14 7h3",
  walk: "M13 4.5a1.4 1.4 0 1 0 0-.1M9 21l2-6-2-2 1-5 3 2 2 3M11 13l-2 3",
  strength: "M6.5 6.5l11 11M4 9l-1 1 2 2M20 15l1-1-2-2M8 4L5 7M16 20l3-3",
  swim: "M3 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 17c2-2 4-2 6 0s4 2 6 0 4-2 6 0M14 7a2 2 0 1 0 0-.1",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  chevR: "M9 6l6 6-6 6",
  chevL: "M15 6l-6 6 6 6",
  chevD: "M6 9l6 6 6-6",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  plus: "M12 5v14M5 12h14",
  x: "M18 6L6 18M6 6l12 12",
  menu: "M3 6h18M3 12h18M3 18h18",
  cal: "M7 3v4M17 3v4M3 9h18M5 5h14v16H5z",
  arrowUR: "M7 17L17 7M9 7h8v8",
  expand: "M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5",
  flame: "M12 3c1 3-2 4-2 7a4 4 0 0 0 8 0c0-2-1-3-1-3 2 3 1 8-3 9s-7-2-7-6c0-5 5-5 5-7z",
  steps: "M7 4a2 2 0 0 0-2 2v5l2 3 3-1V6a2 2 0 0 0-3-2zM16 8a2 2 0 0 0-2 2v5l2 3 3-1v-7a2 2 0 0 0-3-2z",
  battery: "M3 8h14v8H3zM17 11h2v2h-2z",
  drop: "M12 3s6 6 6 10a6 6 0 0 1-12 0c0-4 6-10 6-10z",
  bolt: "M13 2L3 14h7l-1 8 10-12h-7z",
  bed: "M3 7v11M3 12h18v6M21 12v6M7 12V9h7a4 4 0 0 1 4 3",
  lungs: "M12 4v8M9 8c0 6-1 9-4 9-2 0-2-2-2-4 0-3 2-6 6-7M15 8c0 6 1 9 4 9 2 0 2-2 2-4 0-3-2-6-6-7",
  wind: "M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h9a3 3 0 1 1-3 3",
  refresh: "M21 12a9 9 0 1 1-3-6.7M21 4v4h-4",
  play: "M7 4l13 8-13 8z",
  pause: "M7 5h3v14H7zM14 5h3v14h-3z",
  stop: "M6 6h12v12H6z",
  upload: "M12 16V4M7 9l5-5 5 5M5 20h14",
  logout: "M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2M9 12h12M18 9l3 3-3 3",
  lock: "M6 10V7a6 6 0 0 1 12 0v3M5 10h14v11H5zM12 14v3",
  dot: "M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  gauge: "M12 13l4-4M5 19a9 9 0 1 1 14 0",
  tag: "M3 8l6-5h12v18H9l-6-5z",
  trend: "M3 17l6-6 4 4 8-8M21 7v5h-5",
  zzz: "M5 16h5l-5 5h6M13 4h5l-5 6h6",
};
export function Icon({
  name,
  size = 20,
  stroke = 2,
  fill = "none",
  style,
  color = "currentColor",
}: {
  name: string;
  size?: number;
  stroke?: number;
  fill?: string;
  style?: CSSProperties;
  color?: string;
}) {
  const d = ICONS[name] || ICONS.dot;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {d
        .split("M")
        .filter(Boolean)
        .map((seg, i) => (
          <path key={i} d={"M" + seg} />
        ))}
    </svg>
  );
}

/* ---------------- NAVIGATION CONTEXT ---------------- */
export type TabId = "dashboard" | "wellness" | "activities" | "sleep";
export interface NavApi {
  /** Push a detail page onto the stack (mobile) / open as a modal (desktop). */
  push: (el: ReactNode) => void;
  /** Open a full-page overlay (desktop) / same as push (mobile). */
  pushPage: (el: ReactNode) => void;
  /** Pop the top detail / close the modal/page. */
  pop: () => void;
  /** Switch the primary tab. */
  go: (tab: TabId) => void;
  openSheet?: (title: string, content: ReactNode) => void;
  closeSheet?: () => void;
}
export const Nav = createContext<NavApi | null>(null);
export const useNav = (): NavApi => {
  const v = useContext(Nav);
  if (!v) throw new Error("useNav must be used within a Nav.Provider");
  return v;
};

/* ---------------- CARD ---------------- */
export function Card({
  title,
  sub,
  action,
  onClick,
  children,
  className = "",
  style,
  accent,
  noPad,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
  onClick?: () => void;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  accent?: string;
  noPad?: boolean;
}) {
  return (
    <div className={`card ${onClick ? "tappable" : ""} ${className}`} style={style} onClick={onClick}>
      {(title || action) && (
        <div className="card-head">
          <div className="card-title-wrap">
            {accent && <span className="card-accent" style={{ background: accent }} />}
            <span className="card-title">{title}</span>
            {sub && <span className="card-sub">{sub}</span>}
          </div>
          {action || (onClick && <Icon name="chevR" size={16} color="var(--text-faint)" />)}
        </div>
      )}
      <div className={noPad ? "" : "card-body"}>{children}</div>
    </div>
  );
}

/* ---------------- NO-DATA / EMPTY STATE ----------------
   Shown wherever a metric has no real data yet, instead of mock numbers. */
export function NoData({
  label = "No data yet",
  hint,
  height,
}: {
  label?: string;
  hint?: string;
  height?: number;
}) {
  return (
    <div
      className="empty-state"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: 4,
        padding: "22px 12px",
        minHeight: height,
        color: "var(--text-faint)",
      }}
    >
      <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-dim)" }}>{label}</div>
      {hint && <div style={{ fontSize: 12, opacity: 0.85 }}>{hint}</div>}
    </div>
  );
}

/* ---------------- SECTION LABEL ---------------- */
export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="section-label">
      <span>{children}</span>
      {right}
    </div>
  );
}

/* ---------------- STAT TILE ---------------- */
export function StatTile({
  icon,
  label,
  value,
  unit,
  accent = "var(--blue)",
  sub,
  onClick,
  spark,
  sparkColor,
  decimals,
}: {
  icon: string;
  label: string;
  value: number | string;
  unit?: string;
  accent?: string;
  sub?: string;
  onClick?: () => void;
  spark?: number[];
  sparkColor?: string;
  decimals?: number;
}) {
  return (
    <button className="tile" onClick={onClick}>
      <div className="tile-top">
        <span className="tile-ic" style={{ background: tint(accent, 13), color: accent }}>
          <Icon name={icon} size={16} />
        </span>
        {spark && (
          <span className="tile-spark">
            <Spark data={spark} color={sparkColor || accent} />
          </span>
        )}
      </div>
      <div className="tile-label">{label}</div>
      <div className="tile-val">
        {typeof value === "number" ? <CountUp to={value} decimals={decimals || 0} /> : value}
        {unit && <span className="tile-unit">{unit}</span>}
      </div>
      {sub && <div className="tile-sub">{sub}</div>}
    </button>
  );
}

/* ---------------- SEGMENTED TABS ---------------- */
export function SegTabs<T extends string>({
  options,
  value,
  onChange,
  small,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  small?: boolean;
}) {
  return (
    <div className={`segtabs ${small ? "sm" : ""}`}>
      {options.map((o) => (
        <button key={o} className={value === o ? "on" : ""} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </div>
  );
}

/* ---------------- CHIP ---------------- */
export function Chip({
  children,
  active,
  onClick,
  color,
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  color?: string;
}) {
  return (
    <button
      className={`chip ${active ? "on" : ""}`}
      onClick={onClick}
      style={active && color ? { background: tint(color, 13), borderColor: tint(color, 33), color } : undefined}
    >
      {children}
    </button>
  );
}

/* ---------------- LEGEND ---------------- */
export function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="legend">
      {items.map((it, i) => (
        <span key={i}>
          <i style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/* ---------------- MIN/AVG/MAX ---------------- */
export function MMM({ min, avg, max, unit }: { min: number; avg: number; max: number; unit?: string }) {
  return (
    <div className="mmm">
      <div>
        <span>MIN</span>
        <b>
          {min}
          <i>{unit}</i>
        </b>
      </div>
      <div>
        <span>AVG</span>
        <b>
          {avg}
          <i>{unit}</i>
        </b>
      </div>
      <div>
        <span>MAX</span>
        <b>
          {max}
          <i>{unit}</i>
        </b>
      </div>
    </div>
  );
}

/* ---------------- BOTTOM SHEET ---------------- */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children?: ReactNode;
}) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (open) requestAnimationFrame(() => setShow(true));
    else setShow(false);
  }, [open]);
  if (!open) return null;
  return (
    <div className={`sheet-scrim ${show ? "show" : ""}`} onClick={onClose}>
      <div className={`sheet ${show ? "show" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        {title && (
          <div className="sheet-head">
            <h3>{title}</h3>
            <button className="icon-btn" onClick={onClose}>
              <Icon name="x" size={18} />
            </button>
          </div>
        )}
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

/* ---------------- TOP BAR ---------------- */
export function TopBar({
  title,
  sub,
  onMenu,
  right,
  big,
}: {
  title: ReactNode;
  sub?: ReactNode;
  onMenu?: () => void;
  right?: ReactNode;
  big?: boolean;
}) {
  return (
    <div className={`topbar ${big ? "big" : ""}`}>
      <div className="tb-left">
        {onMenu && (
          <button className="icon-btn" onClick={onMenu}>
            <Icon name="menu" size={20} />
          </button>
        )}
        <div>
          <h1>{title}</h1>
          {sub && <p>{sub}</p>}
        </div>
      </div>
      <div className="tb-right">{right}</div>
    </div>
  );
}

/* ---------------- DETAIL PAGE HEADER ---------------- */
export function DetailHeader({
  title,
  sub,
  accent,
  right,
}: {
  title: ReactNode;
  sub?: ReactNode;
  accent?: string;
  right?: ReactNode;
}) {
  const nav = useNav();
  return (
    <div className="detail-head">
      <button className="back-btn" onClick={() => nav.pop()}>
        <Icon name="chevL" size={20} />
      </button>
      <div className="dh-title">
        <h2>{title}</h2>
        {sub && <p style={accent ? { color: accent } : undefined}>{sub}</p>}
      </div>
      <div className="dh-right">{right}</div>
    </div>
  );
}

/* ---------------- BOTTOM NAV ---------------- */
export const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "grid" },
  { id: "wellness", label: "Wellness", icon: "heart" },
  { id: "activities", label: "Activities", icon: "pulse" },
  { id: "sleep", label: "Sleep", icon: "moon" },
];
export function BottomNav({ tab, setTab }: { tab: TabId; setTab: (t: TabId) => void }) {
  return (
    <nav className="bottomnav">
      {TABS.map((t) => (
        <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
          <Icon
            name={t.icon}
            size={22}
            stroke={tab === t.id ? 2.3 : 1.9}
            fill={tab === t.id && t.id === "wellness" ? "currentColor" : "none"}
          />
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

/* ---------------- SPORT ICON BADGE ---------------- */
export function SportBadge({ sport, size = 38 }: { sport: Sport; size?: number }) {
  const meta = SPORTS[sport] || SPORTS.other;
  return (
    <span className="sport-badge" style={{ width: size, height: size, background: tint(meta.color, 13), color: meta.color }}>
      <Icon name={meta.icon} size={size * 0.5} stroke={2} />
    </span>
  );
}

/* ---------------- GEAR store subscription hook ---------------- */
import { GEAR } from "./data";
export function useGear() {
  const [, setV] = useState(0);
  useEffect(() => GEAR.subscribe(() => setV((v) => v + 1)), []);
  return GEAR;
}
