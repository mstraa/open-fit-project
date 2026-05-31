// Lightweight client-side UI preferences (no server round-trip). Components read
// these on mount and can subscribe to the "ofit:prefs" event to update live.

const STEPS_GOAL_KEY = "ofit_steps_goal";
export const DEFAULT_STEPS_GOAL = 10000;

export function getStepsGoal(): number {
  const v = Number(localStorage.getItem(STEPS_GOAL_KEY));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_STEPS_GOAL;
}

export function setStepsGoal(value: number): void {
  if (Number.isFinite(value) && value > 0) {
    localStorage.setItem(STEPS_GOAL_KEY, String(Math.round(value)));
    window.dispatchEvent(new Event("ofit:prefs"));
  }
}
