/* ============================================================
   OpenFit redesign — MOBILE shell (phone frame, bottom-tab nav,
   drawer, push/pop detail stack, bottom sheet, swipe gestures).
   Ported/expanded from js/app.jsx. Auth is the REAL AuthProvider
   (this shell only renders when already authed), so the logout
   button calls useAuth().logout().
   ============================================================ */
import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
  type CSSProperties,
  type TouchEvent as RTouchEvent,
} from "react";
import { useAuth } from "../auth/AuthProvider";
import { Nav, TopBar, BottomNav, Sheet, Icon, TABS, type NavApi, type TabId } from "./ui";
import { Dashboard } from "./pages/Dashboard";
import { Wellness } from "./pages/Wellness";
import { Activities } from "./pages/Activities";
import { Sleep } from "./pages/Sleep";
import { Settings } from "./pages/System";

const PAGE_META: Record<TabId, { title: string; sub: string; Comp: () => JSX.Element }> = {
  dashboard: { title: "Dashboard", sub: "Lun. 1 juin · all data local", Comp: Dashboard },
  wellness: { title: "Wellness", sub: "Recovery, sleep & daily health", Comp: Wellness },
  activities: { title: "Activities", sub: "Resolved locally", Comp: Activities },
  sleep: { title: "Sleep", sub: "Staging & overnight recovery", Comp: Sleep },
};
const TAB_ORDER: TabId[] = ["dashboard", "wellness", "activities", "sleep"];

function dItem(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 13,
    padding: "11px 12px",
    borderRadius: 12,
    fontSize: 15,
    fontWeight: 700,
    textAlign: "left",
    width: "100%",
    color: active ? "var(--text)" : "var(--text-dim)",
    background: active ? "var(--bg-elev)" : "transparent",
  };
}

function Drawer({
  open,
  onClose,
  tab,
  setTab,
  openPage,
  onLogout,
  username,
}: {
  open: boolean;
  onClose: () => void;
  tab: TabId;
  setTab: (t: TabId) => void;
  openPage: (el: ReactNode) => void;
  onLogout: () => void;
  username: string;
}) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (open) requestAnimationFrame(() => setShow(true));
    else setShow(false);
  }, [open]);
  if (!open) return null;
  const go = (id: TabId) => {
    setTab(id);
    onClose();
  };
  // Devices, gear, imports, goals… all live inside Settings now, so it's the
  // single System entry — sitting just above the account card below.
  const systemItems: [string, string, ReactNode][] = [
    ["clock", "Settings", <Settings key="set" />],
  ];
  return (
    <div className={`drawer-scrim ${show ? "show" : ""}`} onClick={onClose}>
      <div className={`drawer ${show ? "show" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 22 }}>
          <span style={{ width: 40, height: 40, borderRadius: 12, background: "var(--blue)", display: "grid", placeItems: "center" }}>
            <Icon name="pulse" size={22} color="#fff" />
          </span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 17 }}>
              Open<span style={{ color: "var(--blue)" }}>Fit</span>
            </div>
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".1em", color: "var(--text-faint)" }}>SELF-HOSTED · CLOUDLESS</div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {TABS.map((t) => (
            <button key={t.id} onClick={() => go(t.id)} style={dItem(tab === t.id)}>
              <Icon name={t.icon} size={20} color={tab === t.id ? "var(--blue)" : "var(--text-dim)"} />
              {t.label}
            </button>
          ))}
        </div>
        <div className="divider" style={{ margin: "16px 0" }} />
        <div className="section-label" style={{ padding: "0 4px 8px" }}>
          System
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {systemItems.map(([ic, lb, el]) => (
            <button
              key={lb}
              style={dItem(false)}
              onClick={() => {
                onClose();
                openPage(el);
              }}
            >
              <Icon name={ic} size={20} color="var(--text-dim)" />
              {lb}
            </button>
          ))}
        </div>
        <div style={{ marginTop: "auto", display: "flex", alignItems: "center", gap: 10, paddingTop: 18 }}>
          <span style={{ width: 36, height: 36, borderRadius: 10, background: "var(--blue)", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 13, color: "#fff" }}>
            {(username || "AD").slice(0, 2).toUpperCase()}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{username || "admin"}</div>
            <div style={{ fontSize: 11, color: "var(--text-faint)" }}>self-hosted · local</div>
          </div>
          <button
            className="icon-btn"
            title="Log out"
            onClick={() => {
              onClose();
              onLogout();
            }}
          >
            <Icon name="logout" size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function MobileApp() {
  const { username, logout } = useAuth();
  const [tab, setTabState] = useState<TabId>("dashboard");
  const [stack, setStack] = useState<ReactNode[]>([]);
  const [closing, setClosing] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState<{ title?: string; content: ReactNode } | null>(null);

  // gesture state
  const [dragX, setDragX] = useState(0); // tab-swipe content offset
  const [edgeX, setEdgeX] = useState<number | null>(null); // edge-back top-host offset
  const g = useRef<{ x: number; y: number; mode: "" | "tab" | "edge" | "v" }>({ x: 0, y: 0, mode: "" });

  const push = useCallback((el: ReactNode) => setStack((s) => [...s, el]), []);
  const pop = useCallback(() => {
    setClosing(true);
    setTimeout(() => {
      setStack((s) => s.slice(0, -1));
      setClosing(false);
      setEdgeX(null);
    }, 240);
  }, []);
  const changeTab = useCallback((id: TabId) => {
    setStack([]);
    setTabState(id);
  }, []);

  const nav: NavApi = {
    push,
    pushPage: push,
    pop,
    go: changeTab,
    openSheet: (title, content) => setSheet({ title, content }),
    closeSheet: () => setSheet(null),
  };

  // Refs so the popstate handler always sees current state without re-binding.
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const tabRef = useRef(tab);
  tabRef.current = tab;

  // Intercept the hardware/browser BACK gesture: pop the top detail, else return
  // to Dashboard, and only exit the app from the Dashboard root. We keep one
  // sentinel history entry "ahead" and re-push it each time we handle a back, so
  // the OS back button drives in-app navigation instead of closing the app.
  useEffect(() => {
    try {
      history.pushState({ ofit: true }, "");
    } catch {
      /* ignore */
    }
    const onPop = () => {
      if (stackRef.current.length > 0) {
        pop();
        history.pushState({ ofit: true }, "");
      } else if (tabRef.current !== "dashboard") {
        changeTab("dashboard");
        history.pushState({ ofit: true }, "");
      }
      // else: at the Dashboard root with no trapped state → allow the app to exit.
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [pop, changeTab]);

  const meta = PAGE_META[tab];
  const Comp = meta.Comp;

  /* ---- content swipe (between tabs) ---- */
  const onContentStart = (e: RTouchEvent) => {
    if (stack.length) return;
    g.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, mode: "" };
  };
  const onContentMove = (e: RTouchEvent) => {
    if (stack.length) return;
    const dx = e.touches[0].clientX - g.current.x;
    const dy = e.touches[0].clientY - g.current.y;
    if (g.current.mode === "") {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      g.current.mode = Math.abs(dx) > Math.abs(dy) * 1.3 ? "tab" : "v";
    }
    if (g.current.mode === "tab") {
      const idx = TAB_ORDER.indexOf(tab);
      // resist past the ends
      let d = dx;
      if ((idx === 0 && d > 0) || (idx === TAB_ORDER.length - 1 && d < 0)) d *= 0.32;
      setDragX(Math.max(-160, Math.min(160, d)));
    }
  };
  const onContentEnd = () => {
    if (g.current.mode === "tab") {
      const idx = TAB_ORDER.indexOf(tab);
      if (dragX <= -80 && idx < TAB_ORDER.length - 1) changeTab(TAB_ORDER[idx + 1]);
      else if (dragX >= 80 && idx > 0) changeTab(TAB_ORDER[idx - 1]);
    }
    g.current.mode = "";
    setDragX(0);
  };

  /* ---- edge-swipe-from-left to pop the top detail ---- */
  const onHostStart = (e: RTouchEvent) => {
    const x = e.touches[0].clientX;
    g.current = { x, y: e.touches[0].clientY, mode: x < 26 ? "edge" : "" };
  };
  const onHostMove = (e: RTouchEvent) => {
    if (g.current.mode !== "edge") return;
    const dx = e.touches[0].clientX - g.current.x;
    setEdgeX(Math.max(0, dx));
  };
  const onHostEnd = () => {
    if (g.current.mode === "edge") {
      if ((edgeX ?? 0) > 90) pop();
      else setEdgeX(null);
    }
    g.current.mode = "";
  };

  return (
    <Nav.Provider value={nav}>
      <div className="of-stage">
        <div className="phone">
          <div className="screen">
            <TopBar title={meta.title} sub={meta.sub} onMenu={() => setDrawer(true)} big={tab === "dashboard"} />
            <div
              className="scroll"
              key={tab}
              onTouchStart={onContentStart}
              onTouchMove={onContentMove}
              onTouchEnd={onContentEnd}
              style={dragX ? { transform: `translateX(${dragX}px)`, transition: "none" } : { transition: "transform .25s cubic-bezier(.22,1,.36,1)" }}
            >
              <Comp />
            </div>
            <BottomNav tab={tab} setTab={changeTab} />

            {stack.map((el, i) => {
              const top = i === stack.length - 1;
              const dragging = top && edgeX != null;
              const style: CSSProperties = { zIndex: 20 + i };
              if (dragging) {
                style.transform = `translateX(${edgeX}px)`;
                style.animation = "none";
                style.transition = "none";
              }
              return (
                <div
                  key={i}
                  className={"detail-host" + (top && closing ? " closing" : "")}
                  style={style}
                  onTouchStart={top ? onHostStart : undefined}
                  onTouchMove={top ? onHostMove : undefined}
                  onTouchEnd={top ? onHostEnd : undefined}
                >
                  {el}
                </div>
              );
            })}

            <Drawer
              open={drawer}
              onClose={() => setDrawer(false)}
              tab={tab}
              setTab={changeTab}
              openPage={push}
              onLogout={() => void logout()}
              username={username}
            />
            <Sheet open={!!sheet} onClose={() => setSheet(null)} title={sheet?.title}>
              {sheet?.content}
            </Sheet>
          </div>
        </div>
      </div>
    </Nav.Provider>
  );
}
