// Shared algorithm-registry loader — used by the Algorithms screen's rail badge
// (the real count of registered built-in + WASM-plugin algorithms) and anywhere
// else that needs the registry. One fetch + manual reload, mirroring
// useActivities.

import { useCallback, useEffect, useState } from "react";
import { listAlgorithms } from "../api/endpoints";
import type { AlgorithmDto } from "../api/schema";

export type AlgorithmsState =
  | { kind: "loading" }
  | { kind: "ok"; algorithms: AlgorithmDto[] }
  | { kind: "error"; message: string };

export interface UseAlgorithms {
  state: AlgorithmsState;
  algorithms: AlgorithmDto[];
  reload: () => void;
}

export function useAlgorithms(): UseAlgorithms {
  const [state, setState] = useState<AlgorithmsState>({ kind: "loading" });

  const reload = useCallback(() => {
    setState({ kind: "loading" });
    listAlgorithms()
      .then((algorithms) => setState({ kind: "ok", algorithms }))
      .catch((e: unknown) =>
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
      );
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const algorithms = state.kind === "ok" ? state.algorithms : [];
  return { state, algorithms, reload };
}
