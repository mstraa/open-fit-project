// Live backend health probe, used by the rail footer dot and anywhere a
// connection indicator is needed. Polls GET /health on an interval.

import { useEffect, useState } from "react";
import { getHealth } from "../api/client";

export type HealthState =
  | { kind: "loading" }
  | { kind: "ok"; status: string }
  | { kind: "error"; message: string };

export function useHealth(pollMs = 30_000): HealthState {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const probe = () => {
      getHealth()
        .then((res) => !cancelled && setHealth({ kind: "ok", status: res.status }))
        .catch((err: unknown) => {
          if (!cancelled)
            setHealth({
              kind: "error",
              message: err instanceof Error ? err.message : String(err),
            });
        });
    };
    probe();
    const id = pollMs > 0 ? window.setInterval(probe, pollMs) : undefined;
    return () => {
      cancelled = true;
      if (id) window.clearInterval(id);
    };
  }, [pollMs]);

  return health;
}
