/* ============================================================
   OpenFit redesign — DESKTOP shell (persistent sidebar + main
   grid, centered modal for details, full-page overlay for an
   activity). Ported/expanded from js/desktop.jsx. Logout uses
   the REAL AuthProvider.
   ============================================================ */
import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "../auth/AuthProvider";
import { Nav, Icon, type NavApi, type TabId } from "./ui";
import { useActivitiesList } from "./wiring";
import { Settings } from "./pages/System";
import { DDashboard } from "./desktop/DDashboard";
import { DWellness } from "./desktop/DWellness";
import { DSleep } from "./desktop/DSleep";
import { DActivities } from "./desktop/DActivities";

const NAVS: [TabId, string, string][] = [
  ["dashboard", "Dashboard", "grid"],
  ["wellness", "Wellness", "heart"],
  ["activities", "Activities", "pulse"],
  ["sleep", "Sleep", "moon"],
];
const META: Record<TabId, [string, string, () => JSX.Element]> = {
  dashboard: ["Dashboard", "Lundi 1 juin · all data resolved locally", DDashboard],
  wellness: ["Wellness", "Recovery, sleep & daily health", DWellness],
  activities: ["Activities", "Resolved locally", DActivities],
  sleep: ["Sleep", "Sleep staging & overnight recovery", DSleep],
};

export function DesktopApp() {
  const { username, logout } = useAuth();
  const { total } = useActivitiesList();
  const [tab, setTab] = useState<TabId>("dashboard");
  const [modal, setModal] = useState<ReactNode | null>(null);
  const [page, setPage] = useState<ReactNode | null>(null);

  const nav: NavApi = {
    push: (el) => setModal(el),
    pushPage: (el) => {
      setModal(null);
      setPage(el);
    },
    pop: () => {
      setModal(null);
      setPage(null);
    },
    go: (t) => {
      setModal(null);
      setPage(null);
      setTab(t);
    },
  };

  // Esc closes the modal.
  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setModal(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);

  const m = META[tab];
  const Comp = m[2];

  return (
    <Nav.Provider value={nav}>
      <div className="dapp">
        <aside className="dsidebar">
          <div className="dbrand">
            <span className="logo">
              <Icon name="pulse" size={22} color="#fff" />
            </span>
            <div>
              <b>
                Open<span style={{ color: "var(--blue)" }}>Fit</span>
              </b>
              <div className="sub">SELF-HOSTED · CLOUDLESS</div>
            </div>
          </div>
          <nav className="dnav">
            {NAVS.map(([id, label, ic]) => (
              <button key={id} className={"dnav-item" + (tab === id ? " on" : "")} onClick={() => nav.go(id)}>
                <Icon name={ic} size={20} fill={tab === id && id === "wellness" ? "currentColor" : "none"} />
                <span style={{ color: "inherit" }}>{label}</span>
                {id === "activities" && total > 0 && <span className="badge">{total}</span>}
              </button>
            ))}
          </nav>
          {/* Settings + the account card pinned to the bottom, Settings directly
              above the account (devices, gear, imports, goals… all live inside it). */}
          <div style={{ marginTop: "auto" }}>
            <button className="dnav-item" onClick={() => nav.pushPage(<Settings />)}>
              <Icon name="clock" size={20} />
              Settings
            </button>
            <div className="duser">
              <span className="av">{(username || "AD").slice(0, 2).toUpperCase()}</span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{username || "admin"}</div>
                <div style={{ fontSize: 11, color: "var(--text-faint)" }}>self-hosted · local</div>
              </div>
              <button className="logout-btn" title="Log out" onClick={() => void logout()}>
                <Icon name="logout" size={18} />
              </button>
            </div>
          </div>
        </aside>

        <main className="dmain">
          {page ? (
            <div className="dpage">{page}</div>
          ) : (
            <>
              <div className="dtop">
                <div>
                  <h1>{m[0]}</h1>
                  <p>{m[1]}</p>
                </div>
                {/* Recording is a mobile-only feature (needs the phone's sensors). */}
              </div>
              <div className="dcontent">
                <Comp />
              </div>
            </>
          )}
        </main>

        {modal && (
          <div className="dmodal-scrim" onClick={() => setModal(null)}>
            <div className="dmodal" onClick={(e) => e.stopPropagation()}>
              <button className="dmodal-close" onClick={() => setModal(null)}>
                <Icon name="x" size={18} />
              </button>
              {modal}
            </div>
          </div>
        )}
      </div>
    </Nav.Provider>
  );
}
