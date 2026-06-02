// Subscribe to the background analytics worker's progress over
// /api/analytics/status (WebSocket). Drives the "computing…" indicator: the
// worker pushes a frame when it starts/finishes a recompute pass.

import { useEffect, useState } from "react";
import { API_BASE, getToken } from "../api/client";

export interface AnalyticsStatus {
  /** True while the worker is actively recomputing. */
  working: boolean;
  /** Units still queued (dirty). */
  queued: number;
  /** Human labels of what's being computed (e.g. "3 activities"). */
  current: string[];
}

function wsUrl(): string {
  const base = API_BASE
    ? `${API_BASE.replace(/^http/, "ws")}/api/analytics/status`
    : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/analytics/status`;
  const token = getToken();
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function useAnalyticsStatus(): AnalyticsStatus {
  const [state, setState] = useState<AnalyticsStatus>({ working: false, queued: 0, current: [] });

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl());
      } catch {
        retry = setTimeout(connect, 3000);
        return;
      }
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        try {
          setState(JSON.parse(ev.data as string) as AnalyticsStatus);
        } catch {
          /* ignore malformed frame */
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
    };
  }, []);

  return state;
}
