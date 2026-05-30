import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// API-first: the dev server proxies API calls to ofit-api so the browser can
// talk to the backend without CORS during development. In production the app is
// served separately and reads VITE_API_BASE directly (see src/api/client.ts).
export default defineConfig({
  plugins: [react()],
  build: {
    // The lazy-loaded detail chunk bundles MapLibre GL (large by nature);
    // raise the warning threshold rather than fight a vendor lib's size.
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    proxy: {
      // Proxy backend routes to ofit-api (axum) during `npm run dev` so the app
      // is SAME-ORIGIN (session cookies + the live WebSocket work without CORS).
      "/health": "http://localhost:8087",
      "/api": { target: "http://localhost:8087", ws: true },
      "/api-docs": "http://localhost:8087",
    },
  },
});
