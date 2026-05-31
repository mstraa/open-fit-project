// Foreground scheduler for the hourly Gadgetbridge auto-import. Mounted ONCE high
// in the tree (App.tsx) so it survives navigation and runs inside the auth
// provider (the upload carries the session token).
//
// LIMITATION: setInterval is frozen while the Android WebView is backgrounded or
// the app is killed — this is a FOREGROUND scheduler. It fires at the configured
// minute while the app is open, and a visibility/focus listener catches up (one
// import for the current hour) when you reopen the app. True background hourly
// execution needs a native plugin (@capacitor/background-runner / AlarmManager).

import { useEffect } from "react";
import {
  loadGbConfig,
  loadLastRun,
  currentHourKey,
  isNativeApp,
} from "./autoImportConfig";
import { runGadgetbridgeImport } from "./runImport";

let running = false;

async function tick(reason: "schedule" | "resume"): Promise<void> {
  if (running) return;
  const cfg = loadGbConfig();
  if (!cfg.autoImportEnabled || !isNativeApp()) return;

  const now = new Date();
  // On a scheduled tick, only fire during the configured minute. On resume, allow
  // a catch-up regardless of minute (covers an hour missed while backgrounded).
  if (reason === "schedule" && now.getMinutes() !== cfg.minute) return;
  // Dedupe: at most one auto-import per calendar hour.
  if (loadLastRun()?.hourKey === currentHourKey(now)) return;

  running = true;
  try {
    await runGadgetbridgeImport(cfg.gbFilePath);
  } finally {
    running = false;
  }
}

export function useGadgetbridgeAutoImport(): void {
  useEffect(() => {
    // Poll every 30s so the target minute is observed despite timer drift; the
    // per-hour dedupe guard prevents the two ticks inside that minute re-importing.
    const id = window.setInterval(() => void tick("schedule"), 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick("resume");
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);
}

/** Null-rendering component to mount the scheduler once at the app root. */
export function GadgetbridgeAutoImportRunner(): null {
  useGadgetbridgeAutoImport();
  return null;
}
