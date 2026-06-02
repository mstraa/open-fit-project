// App preferences. The source of truth is the SERVER (so a setting follows your
// account across devices/reinstalls), with a localStorage cache so the UI renders
// instantly and keeps working offline. Components read the cached value via
// getStepsGoal() and refresh on the "ofit:prefs" event; setStepsGoal() updates
// the cache immediately and persists to the server in the background.

import { getSettings, setSetting } from "./api/endpoints";

const CACHE_KEY = "ofit_steps_goal"; // localStorage cache
const SERVER_KEY = "steps_goal"; // /api/settings key
export const DEFAULT_STEPS_GOAL = 10000;

export function getStepsGoal(): number {
  const v = Number(localStorage.getItem(CACHE_KEY));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_STEPS_GOAL;
}

function cacheGoal(value: number): void {
  try {
    localStorage.setItem(CACHE_KEY, String(Math.round(value)));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("ofit:prefs"));
}

export function setStepsGoal(value: number): void {
  if (!(Number.isFinite(value) && value > 0)) return;
  cacheGoal(value); // instant + offline-safe
  void setSetting(SERVER_KEY, String(Math.round(value))).catch(() => undefined); // persist server-side
}

/* ---- generic UI preferences (theme / accent / units / week start) ---- */
// Same server-backed-with-local-cache model as the step goal: instant local
// read, persisted to /api/settings in the background so it follows the account.
export const UI_PREF_KEYS = ["ui_theme", "ui_accent", "ui_units", "ui_week_start"] as const;
export type UiPrefKey = (typeof UI_PREF_KEYS)[number];

export function getPref(key: UiPrefKey, fallback: string): string {
  try {
    const v = localStorage.getItem("ofit_" + key);
    return v != null && v !== "" ? v : fallback;
  } catch {
    return fallback;
  }
}

export function setPref(key: UiPrefKey, value: string): void {
  try {
    localStorage.setItem("ofit_" + key, value);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event("ofit:prefs"));
  void setSetting(key, value).catch(() => undefined); // persist server-side
}

/** Pull server-bound prefs into the local cache (call once on app start). Offline
 *  → keeps whatever is cached. Bumps "ofit:prefs" if anything changed. */
export async function syncPrefs(): Promise<void> {
  try {
    const s = await getSettings();
    const v = Number(s[SERVER_KEY]);
    if (Number.isFinite(v) && v > 0 && v !== getStepsGoal()) cacheGoal(v);
    let changed = false;
    for (const k of UI_PREF_KEYS) {
      const sv = s[k];
      if (typeof sv === "string" && sv !== "" && sv !== getPref(k, "")) {
        try {
          localStorage.setItem("ofit_" + k, sv);
          changed = true;
        } catch {
          /* ignore */
        }
      }
    }
    if (changed) window.dispatchEvent(new Event("ofit:prefs"));
  } catch {
    /* server unreachable → keep the cached value */
  }
}
