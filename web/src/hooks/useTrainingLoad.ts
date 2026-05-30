// Training-load loader for the dashboard. Wraps GET /api/analytics/training-load
// (the dated CTL/ATL/TSB series + latest readiness / HRV summary). The endpoint
// wrapper already degrades to an EMPTY result on an unreachable API or
// uncomputed analytics, so this hook never surfaces an error for the common
// "no data yet" case — the dashboard renders its on-brand empty state instead.

import { useEffect, useState } from "react";
import { getTrainingLoad } from "../api/endpoints";
import type { TrainingLoadResponseDto } from "../api/schema";

export type TrainingLoadState =
  | { kind: "loading" }
  | { kind: "ok"; data: TrainingLoadResponseDto }
  | { kind: "error"; message: string };

export function useTrainingLoad(): TrainingLoadState {
  const [state, setState] = useState<TrainingLoadState>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    getTrainingLoad()
      .then((data) => alive && setState({ kind: "ok", data }))
      .catch(
        (e: unknown) =>
          alive &&
          setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      alive = false;
    };
  }, []);

  return state;
}

/** True when the series has at least one dated CTL/ATL/TSB point. */
export function hasTrainingLoad(data: TrainingLoadResponseDto): boolean {
  return Array.isArray(data.series) && data.series.length > 0;
}
