import { useEffect, useState } from "react";

/** A counter that bumps when `ofit:data-updated` fires (e.g. after a manual strap
 *  sync writes new history). Key a subtree with it to remount + re-fetch — a soft
 *  refresh that avoids a full `window.location.reload()` (which would re-run the
 *  boot and bounce an offline session back to the connect screen). */
export function useDataRefresh(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const on = () => setV((x) => x + 1);
    window.addEventListener("ofit:data-updated", on);
    return () => window.removeEventListener("ofit:data-updated", on);
  }, []);
  return v;
}
