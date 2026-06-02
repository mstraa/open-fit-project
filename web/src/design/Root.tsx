/* ============================================================
   OpenFit redesign — viewport switch between the two shells.
   Narrow → phone shell (bottom nav, drawer, push/pop, gestures).
   Wide   → desktop sidebar + grid shell. Both share one data/
   charts/UI layer; auth is handled by the real AuthProvider above.
   ============================================================ */
import { useEffect, useState } from "react";
import { MobileApp } from "./MobileApp";
import { DesktopApp } from "./DesktopApp";
import { RecomputeStatusPill } from "./StatusPill";

const DESKTOP_QUERY = "(min-width: 900px)";

function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia(DESKTOP_QUERY).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const on = () => setDesktop(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return desktop;
}

export function DesignRoot() {
  const isDesktop = useIsDesktop();
  return (
    <>
      {isDesktop ? <DesktopApp /> : <MobileApp />}
      <RecomputeStatusPill />
    </>
  );
}
