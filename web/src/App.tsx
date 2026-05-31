// App router. The web app is a typed client of ofit-api; this file only wires
// the route table for the design's screens. Each route renders its own screen
// file under ./screens (the in-shell screens mount the AppShell themselves so
// each screen owns its topbar title/crumb/actions and active nav).

import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Dashboard } from "./screens/Dashboard";
import { Activities } from "./screens/Activities";
import { Wellness } from "./screens/Wellness";
import { Settings } from "./screens/Settings";
import { Algorithms } from "./screens/Algorithms";
import { Sleep } from "./screens/Sleep";
import { Spinner } from "./ui/primitives";

// Code-split the detail screen: it pulls in uPlot + MapLibre GL, which are heavy.
const WorkoutDetail = lazy(() =>
  import("./screens/WorkoutDetail").then((m) => ({ default: m.WorkoutDetail })),
);

// Code-split the BLE screen: it pulls the Capacitor BLE plugin (native/Web BT).
const BleDevices = lazy(() =>
  import("./screens/BleDevices").then((m) => ({ default: m.BleDevices })),
);

export function App() {
  return (
    <Routes>
      {/* App opens directly to the dashboard (no separate launcher page). */}
      <Route path="/" element={<Navigate to="/dashboard" replace />} />

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

      <Route path="/sleep" element={<Sleep />} />
      <Route
        path="/devices"
        element={
          <Suspense fallback={<Spinner label="Loading devices…" />}>
            <BleDevices />
          </Suspense>
        }
      />

      {/* Unknown routes redirect to the dashboard. */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
