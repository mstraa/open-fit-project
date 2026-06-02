// App root. The web app is a typed client of ofit-api. The UI is the OpenFit
// redesign (see ./design): a phone shell on narrow viewports and a desktop
// sidebar+grid shell on wide ones, sharing one data/charts/UI layer and wired
// to the real API. Auth gating + live BLE wiring live above this component
// (AuthProvider, BleProvider, NativeBleProvider in main.tsx).

import { useEffect } from "react";
import { useDataRefresh } from "./hooks/useDataRefresh";
import { syncPrefs } from "./prefs";
import { DesignRoot } from "./design/Root";

export function App() {
  // Bumps after a manual strap sync → remounts the shell so it re-fetches the
  // new history WITHOUT a full page reload (see useDataRefresh).
  const refresh = useDataRefresh();
  // Pull server-bound preferences (e.g. the step goal) into the local cache once.
  useEffect(() => {
    void syncPrefs();
  }, []);
  return <DesignRoot key={refresh} />;
}
