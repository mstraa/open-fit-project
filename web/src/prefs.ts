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

/** Pull server-bound prefs into the local cache (call once on app start). Offline
 *  → keeps whatever is cached. Bumps "ofit:prefs" if the goal changed. */
export async function syncPrefs(): Promise<void> {
  try {
    const s = await getSettings();
    const v = Number(s[SERVER_KEY]);
    if (Number.isFinite(v) && v > 0 && v !== getStepsGoal()) cacheGoal(v);
  } catch {
    /* server unreachable → keep the cached value */
  }
}
