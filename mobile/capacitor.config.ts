import type { CapacitorConfig } from "@capacitor/cli";

// Open Fit Android app = the React web UI (built in ../web) wrapped by Capacitor,
// + native bridges (SQLite to read Gadgetbridge's exported DB; BLE later).
//
// The app talks to YOUR self-hosted ofit-api over the LAN (http), so cleartext
// is allowed and the API base is configured at runtime in-app (Settings →
// server URL) rather than baked in.
const config: CapacitorConfig = {
  appId: "org.openfit.app",
  appName: "Open Fit",
  // Reuse the web production build as the app's web assets.
  webDir: "../web/dist",
  android: {
    // Local self-hosted servers are plain http on the LAN.
    allowMixedContent: true,
  },
  server: {
    androidScheme: "http",
    cleartext: true,
  },
};

export default config;
