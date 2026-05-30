import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ThemeProvider } from "./theme/ThemeProvider";
import { App } from "./App";
// app.css = canonical design system (defines --bg/--surface/--accent/--hr…).
// tokens.css = legacy --color-*/--space-*/--radius-* bridge → design tokens.
// Import app.css FIRST so its :root tokens exist when tokens.css remaps onto them.
import "./theme/app.css";
import "./theme/tokens.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element not found");

createRoot(rootEl).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
