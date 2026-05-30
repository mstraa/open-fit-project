// Subscribe to the live wellness WebSocket (/api/wellness/live). Keeps the latest
// sample per kind plus a short rolling buffer (for sparklines), and reconnects.

import { useEffect, useRef, useState } from "react";
import { API_BASE } from "../api/client";
import type { WellnessKind } from "../api/types";

export interface LiveSample {
  kind: WellnessKind;
  value: number;
  ts: string;
  source_id: string;
}

export interface WellnessLive {
  connected: boolean;
  /** Latest sample seen per kind. */
  last: Partial<Record<WellnessKind, LiveSample>>;
  /** Rolling buffer of recent samples per kind (oldest → newest). */
  buffer: Partial<Record<WellnessKind, LiveSample[]>>;
}

const MAX_BUFFER = 120;

function wsUrl(): string {
  // http(s)://host → ws(s)://host, same path under /api.
  return `${API_BASE.replace(/^http/, "ws")}/api/wellness/live`;
}

export function useWellnessLive(): WellnessLive {
  const [state, setState] = useState<WellnessLive>({ connected: false, last: {}, buffer: {} });
  const wsRef = useRef<WebSocket | null>(null);

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
      wsRef.current = ws;

      ws.onopen = () => setState((s) => ({ ...s, connected: true }));
      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (!closed) retry = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        let msg: LiveSample;
        try {
          msg = JSON.parse(ev.data as string) as LiveSample;
        } catch {
          return;
        }
        setState((s) => {
          const prev = s.buffer[msg.kind] ?? [];
          const next = [...prev, msg].slice(-MAX_BUFFER);
          return {
            connected: s.connected,
            last: { ...s.last, [msg.kind]: msg },
            buffer: { ...s.buffer, [msg.kind]: next },
          };
        });
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  return state;
}
