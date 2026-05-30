// App router. The web app is a typed client of ofit-api; this file only wires
// the route table for the design's screens. Each route renders its own screen
// file under ./screens (the in-shell screens mount the AppShell themselves so
// each screen owns its topbar title/crumb/actions and active nav).

import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Launcher } from "./screens/Launcher";
import { Dashboard } from "./screens/Dashboard";
import { Activities } from "./screens/Activities";
import { Wellness } from "./screens/Wellness";
import { Settings } from "./screens/Settings";
import { Algorithms } from "./screens/Algorithms";
import { ComingSoon } from "./screens/ComingSoon";
import { Spinner } from "./ui/primitives";

// Code-split the detail screen: it pulls in uPlot + MapLibre GL, which are heavy.
const WorkoutDetail = lazy(() =>
  import("./screens/WorkoutDetail").then((m) => ({ default: m.WorkoutDetail })),
);

export function App() {
  return (
    <Routes>
      {/* index.html is the launcher/overview surface (no rail). */}
      <Route path="/" element={<Launcher />} />

      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/activities" element={<Activities />} />
      <Route
        path="/activities/:id"
        element={
          <Suspense fallback={<Spinner label="Loading activity…" />}>
            <WorkoutDetail />
          </Suspense>
        }
      />
      <Route path="/wellness" element={<Wellness />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/algorithms" element={<Algorithms />} />

      {/* Nav items without a module yet → generic empty-state screen. */}
      <Route
        path="/sleep"
        element={
          <ComingSoon
            title="Sleep"
            crumb="Sleep staging & overnight recovery"
            phase="Phase 4"
            hint="Sleep staging arrives with the wellness ingestion phase."
          />
        }
      />
      <Route
        path="/trends"
        element={
          <ComingSoon
            title="Trends"
            crumb="Long-term fitness & wellness trends"
            phase="Phase 4"
            hint="Trend analysis builds on accumulated activity and wellness history."
          />
        }
      />
      <Route
        path="/devices"
        element={
          <ComingSoon
            title="Devices & sources"
            crumb="Connected devices & data sources"
            phase="Phase 3"
            hint="BLE ingestion via Gadgetbridge and per-source priority configure here."
          />
        }
      />

      {/* Unknown routes redirect to the launcher. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
