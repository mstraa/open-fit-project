// Shared activities loader — extracted from the old qbit-era Dashboard view so
// the new Dashboard/Activities screens (and the rail's activity-count badge)
// can share one fetch + sport-filter + sort implementation.

import { useCallback, useEffect, useMemo, useState } from "react";
import { listActivities } from "../api/endpoints";
import type { ActivitySummary, Sport } from "../api/types";

export type ActivitiesState =
  | { kind: "loading" }
  | { kind: "ok"; activities: ActivitySummary[] }
  | { kind: "error"; message: string };

export type SortKey = "sport" | "started_at" | "duration_secs" | "recording_count";
export type SortDir = "asc" | "desc";

export interface UseActivities {
  state: ActivitiesState;
  /** All activities (empty while loading/error). */
  activities: ActivitySummary[];
  /** Per-sport counts (for sidebars / filters). */
  counts: Map<Sport, number>;
  /** Re-fetch from the API. */
  reload: () => void;
}

/** Fetch the activity list once (with a manual reload). */
export function useActivities(): UseActivities {
  const [state, setState] = useState<ActivitiesState>({ kind: "loading" });

  const reload = useCallback(() => {
    setState({ kind: "loading" });
    listActivities()
      .then((activities) => setState({ kind: "ok", activities }))
      .catch((e: unknown) =>
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
      );
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const activities = state.kind === "ok" ? state.activities : [];

  const counts = useMemo(() => {
    const m = new Map<Sport, number>();
    for (const a of activities) m.set(a.sport, (m.get(a.sport) ?? 0) + 1);
    return m;
  }, [activities]);

  return { state, activities, counts, reload };
}

/** Filter + sort an activity list (pure helper for table screens). */
export function sortActivities(
  activities: ActivitySummary[],
  sport: Sport | "all",
  sort: { key: SortKey; dir: SortDir },
): ActivitySummary[] {
  const filtered = sport === "all" ? activities : activities.filter((a) => a.sport === sport);
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...filtered].sort((a, b) => {
    const k = sort.key;
    const av = k === "sport" ? a.sport : k === "started_at" ? a.started_at : a[k];
    const bv = k === "sport" ? b.sport : k === "started_at" ? b.started_at : b[k];
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}
