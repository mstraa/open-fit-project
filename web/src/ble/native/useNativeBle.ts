// React hook driving the native OpenFitBle plugin (M0). Scans, connects, and
// relays live samples to POST /api/wellness — the native-path proof that the
// Helio/Garmin protocols (M1+) will build on. Native (Android app) only.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginListenerHandle } from "@capacitor/core";
import { OpenFitBle, type NativeScanResult, type NativeStatus } from "./OpenFitBle";
import { ingestWellness } from "../../api/endpoints";
import { isNativeApp } from "../../gadgetbridge/autoImportConfig";

export type NativeBleStatus = "idle" | "scanning" | "connecting" | "connected" | "error";

interface NativeBleState {
  status: NativeBleStatus;
  found: NativeScanResult[];
  hr: number | null;
  message?: string;
  deviceName?: string;
}

export function useNativeBle() {
  const [state, setState] = useState<NativeBleState>({ status: "idle", found: [], hr: null });
  const listeners = useRef<PluginListenerHandle[]>([]);
  const lastPush = useRef(0);
  const available = isNativeApp();

  useEffect(() => {
    if (!available) return;
    let alive = true;
    (async () => {
      const subs = await Promise.all([
        OpenFitBle.addListener("scanResult", (r) => {
          setState((s) => {
            if (s.found.some((f) => f.deviceId === r.deviceId)) return s;
            return { ...s, found: [...s.found, r].sort((a, b) => b.rssi - a.rssi) };
          });
        }),
        OpenFitBle.addListener("status", (e: NativeStatus) => {
          setState((s) => {
            if (e.status === "connected") return { ...s, status: "connected", message: e.message };
            if (e.status === "ready") return { ...s, status: "connected", message: e.message };
            if (e.status === "disconnected") return { ...s, status: "idle", hr: null };
            if (e.status === "error") return { ...s, status: "error", message: e.message };
            return s;
          });
        }),
        OpenFitBle.addListener("sample", (e) => {
          if (e.kind === "heart_rate") {
            setState((s) => ({ ...s, hr: Math.round(e.value) }));
            const now = Date.now();
            if (now - lastPush.current > 900) {
              lastPush.current = now;
              void ingestWellness([{ kind: "heart_rate", value: e.value }]).catch(() => undefined);
            }
          }
        }),
      ]);
      if (!alive) {
        subs.forEach((h) => void h.remove());
        return;
      }
      listeners.current = subs;
    })();
    return () => {
      alive = false;
      listeners.current.forEach((h) => void h.remove());
      listeners.current = [];
      void OpenFitBle.disconnect().catch(() => undefined);
    };
  }, [available]);

  const scan = useCallback(async () => {
    if (!available) return;
    setState((s) => ({ ...s, status: "scanning", found: [], message: undefined }));
    try {
      await OpenFitBle.startScan();
      window.setTimeout(() => setState((s) => (s.status === "scanning" ? { ...s, status: "idle" } : s)), 10_500);
    } catch (e) {
      setState((s) => ({ ...s, status: "error", message: e instanceof Error ? e.message : String(e) }));
    }
  }, [available]);

  const connect = useCallback(
    async (dev: NativeScanResult, huami?: { authKey: string }) => {
      if (!available) return;
      setState((s) => ({ ...s, status: "connecting", deviceName: dev.name, message: undefined }));
      try {
        await OpenFitBle.stopScan().catch(() => undefined);
        await OpenFitBle.connect(
          huami
            ? { deviceId: dev.deviceId, deviceType: "huami", authKey: huami.authKey }
            : { deviceId: dev.deviceId },
        );
      } catch (e) {
        setState((s) => ({ ...s, status: "error", message: e instanceof Error ? e.message : String(e) }));
      }
    },
    [available],
  );

  const disconnect = useCallback(async () => {
    await OpenFitBle.disconnect().catch(() => undefined);
    setState((s) => ({ ...s, status: "idle", hr: null }));
  }, []);

  return { ...state, available, scan, connect, disconnect };
}
