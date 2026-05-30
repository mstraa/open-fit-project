// App shell — implements the design's .app / .rail / .topbar / .main / .content.
//
// The RAIL holds the brand, the full nav (with route-driven is-active via
// react-router NavLink) and the user/footer chip with a LIVE health dot.
// The TOPBAR is a slot driven by props { title, crumb?, actions? }.
// The mobile drawer behavior is ported from docs/designs/js/app.js as React
// state (menu button toggles .rail.is-open + .scrim.is-open; tapping a nav link
// or the scrim closes it).

import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useHealth } from "../hooks/useHealth";
import { useActivities } from "../hooks/useActivities";
import { useAuth } from "../auth/AuthProvider";
import {
  ActivitiesIcon,
  AlgorithmsIcon,
  DashboardIcon,
  DevicesIcon,
  LogoMark,
  MenuIcon,
  SettingsIcon,
  SleepIcon,
  TrendsIcon,
  WellnessIcon,
} from "./icons";

export interface TopbarProps {
  title: ReactNode;
  crumb?: ReactNode;
  actions?: ReactNode;
}

export interface AppShellProps extends TopbarProps {
  children: ReactNode;
}

/** The system-section algorithm count is static (no backend yet) — Phase 4+. */
const ALGORITHM_COUNT = 7;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "··";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function AppShell({ title, crumb, actions, children }: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  // Close the mobile drawer whenever the route changes (matches the design's
  // "tap a nav link closes the drawer" behavior).
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  return (
    <>
      <div
        className={drawerOpen ? "scrim is-open" : "scrim"}
        onClick={() => setDrawerOpen(false)}
      />
      <div className="app">
        <Rail open={drawerOpen} />
        <div className="main">
          <header className="topbar">
            <button
              type="button"
              className="iconbtn menu-btn"
              aria-label="Menu"
              onClick={() => setDrawerOpen(true)}
            >
              <MenuIcon />
            </button>
            <div>
              <div className="topbar__title">{title}</div>
              {crumb ? <div className="topbar__crumb">{crumb}</div> : null}
            </div>
            <div className="topbar__spacer" />
            {actions}
          </header>
          <div className="content">{children}</div>
        </div>
      </div>
    </>
  );
}

/* ----------------------------------------------------------------- rail */

function Rail({ open }: { open: boolean }) {
  const health = useHealth();
  const { activities } = useActivities();
  const { username, logout } = useAuth();
  const activityBadge = activities.length > 0 ? String(activities.length) : undefined;

  return (
    <aside className={open ? "rail is-open" : "rail"}>
      <div className="rail__brand">
        <div className="rail__logo">
          <LogoMark />
        </div>
        <div>
          <div className="rail__name">
            Open<span>Fit</span>
          </div>
          <div className="rail__sub">self-hosted · cloudless</div>
        </div>
      </div>

      <nav className="nav">
        <NavItem to="/dashboard" icon={<DashboardIcon />} label="Dashboard" />
        <NavItem to="/activities" icon={<ActivitiesIcon />} label="Activities" badge={activityBadge} />
        <NavItem to="/wellness" icon={<WellnessIcon />} label="Wellness" />
        <NavItem to="/sleep" icon={<SleepIcon />} label="Sleep" />
        <NavItem to="/trends" icon={<TrendsIcon />} label="Trends" />
        <div className="nav__label">System</div>
        <NavItem to="/devices" icon={<DevicesIcon />} label="Devices & sources" />
        <NavItem to="/algorithms" icon={<AlgorithmsIcon />} label="Algorithms" badge={String(ALGORITHM_COUNT)} />
        <NavItem to="/settings" icon={<SettingsIcon />} label="Settings" />
      </nav>

      <div className="rail__foot">
        <div className="userchip">
          <div className="userchip__av">{initials(username)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="userchip__name">{username || "Local user"}</div>
            <div className="userchip__meta">self-hosted · local</div>
          </div>
          {username ? (
            <button
              type="button"
              onClick={() => void logout()}
              title="Log out"
              aria-label="Log out"
              style={{
                background: "transparent",
                border: "none",
                color: "var(--muted)",
                cursor: "pointer",
                display: "grid",
                placeItems: "center",
                padding: 4,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
                <path d="M16 17l5-5-5-5M21 12H9M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : (
            <HealthDot health={health} />
          )}
        </div>
      </div>
    </aside>
  );
}

function NavItem({
  to,
  icon,
  label,
  badge,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  badge?: string;
}) {
  return (
    <NavLink to={to} className={({ isActive }) => (isActive ? "is-active" : undefined)}>
      {icon}
      {label}
      {badge ? <span className="nav__badge">{badge}</span> : null}
    </NavLink>
  );
}

function HealthDot({ health }: { health: ReturnType<typeof useHealth> }) {
  const title =
    health.kind === "ok"
      ? `Live · server ${health.status}`
      : health.kind === "error"
        ? `Offline · ${health.message}`
        : "Connecting…";
  const color =
    health.kind === "ok"
      ? "var(--good)"
      : health.kind === "error"
        ? "var(--bad)"
        : "var(--faint)";
  return (
    <div
      className="dot-live"
      title={title}
      style={{ background: color, boxShadow: `0 0 0 3px color-mix(in oklch, ${color} 22%, transparent)` }}
    />
  );
}
