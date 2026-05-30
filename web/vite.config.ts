import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// API-first: the dev server proxies API calls to ofit-api so the browser can
// talk to the backend without CORS during development. In production the app is
// served separately and reads VITE_API_BASE directly (see src/api/client.ts).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxy backend routes to ofit-api (axum) during `npm run dev`.
      "/health": "http://localhost:8080",
      "/api": "http://localhost:8080",
      "/api-docs": "http://localhost:8080",
    },
  },
});
