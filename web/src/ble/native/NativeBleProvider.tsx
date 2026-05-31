// App-global native-BLE connection (mounted ABOVE the router, see main.tsx) so a
// connected device keeps streaming as you move between screens — previously the
// connection lived in the Devices screen and was torn down on navigation (the
// "preview works but Wellness shows nothing" bug). It also persists an "added"
// device and auto-reconnects it when the link drops, and exposes a connected
// count for the dashboard/wellness indicator. Android app only.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PluginListenerHandle } from "@capacitor/core";
import { OpenFitBle, type NativeScanResult, type NativeStatus } from "./OpenFitBle";
import { API_BASE, getToken } from "../../api/client";
import { isNativeApp } from "../../gadgetbridge/autoImportConfig";

export type NativeConnStatus = "idle" | "scanning" | "connecting" | "connected" | "reconnecting" | "error";

/** A device the user has "added" — auto-reconnected on drop / app start. */
export interface SavedDevice {
  deviceId: string;
  name: string;
  type: "standard" | "huami";
  authKey?: string;
}

interface NativeBleState {
  status: NativeConnStatus;
  found: NativeScanResult[];
  hr: number | null;
  message?: string;
  device: SavedDevice | null; // the active/added device
  syncing: boolean;
}

interface NativeBleApi extends NativeBleState {
  available: boolean;
  connectedCount: number;
  scan: () => Promise<void>;
  addAndConnect: (dev: NativeScanResult, huami?: { authKey: string }) => Promise<void>;
  forget: () => Promise<void>;
  sync: (days?: number) => Promise<void>;
}

const Ctx = createContext<NativeBleApi | null>(null);
const STORE = "ofit_native_device";

function loadSaved(): SavedDevice | null {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as SavedDevice) : null;
  } catch {
    return null;
  }
}
function saveSaved(d: SavedDevice | null) {
  try {
    if (d) localStorage.setItem(STORE, JSON.stringify(d));
    else localStorage.removeItem(STORE);
  } catch {
    /* ignore */
  }
}

export function NativeBleProvider({ children }: { children: ReactNode }) {
  const available = isNativeApp();
  const [state, setState] = useState<NativeBleState>(() => ({
    status: "idle",
    found: [],
    hr: null,
    device: loadSaved(),
    syncing: false,
  }));
  const subs = useRef<PluginListenerHandle[]>([]);
  const userDisconnect = useRef(false);
  const deviceRef = useRef<SavedDevice | null>(state.device);
  deviceRef.current = state.device;

  // Open (or re-open) the connection for a saved device.
  const open = useCallback(async (d: SavedDevice) => {
    userDisconnect.current = false;
    setState((s) => ({ ...s, status: "connecting", device: d, message: undefined }));
    try {
      // Give the native side the server URL + token so it can POST samples even
      // while the screen is locked (the WebView/JS is suspended then).
      await OpenFitBle.configure({ apiBase: API_BASE, token: getToken() }).catch(() => undefined);
      await OpenFitBle.connect(
        d.type === "huami"
          ? { deviceId: d.deviceId, deviceType: "huami", authKey: d.authKey }
          : { deviceId: d.deviceId },
      );
    } catch (e) {
      setState((s) => ({ ...s, status: "error", message: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  // Register native listeners ONCE for the provider's lifetime.
  useEffect(() => {
    if (!available) return;
    let alive = true;
    (async () => {
      const handles = await Promise.all([
        OpenFitBle.addListener("scanResult", (r) => {
          setState((s) =>
            s.found.some((f) => f.deviceId === r.deviceId)
              ? s
              : { ...s, found: [...s.found, r].sort((a, b) => b.rssi - a.rssi) },
          );
        }),
        OpenFitBle.addListener("status", (e: NativeStatus) => {
          if (e.status === "connected" || e.status === "ready") {
            const done = e.message === "sync complete" || e.message === "sync failed";
            setState((s) => ({ ...s, status: "connected", message: e.message, syncing: done ? false : s.syncing }));
            // A completed sync wrote new history — reload so the wellness views
            // (which fetch on mount) pick it up.
            if (e.message === "sync complete") {
              window.setTimeout(() => window.location.reload(), 1500);
            }
          } else if (e.status === "error") {
            setState((s) => ({ ...s, status: "error", message: e.message, syncing: false }));
          } else if (e.status === "disconnected") {
            // Auto-reconnect an added device unless the user asked to disconnect.
            const d = deviceRef.current;
            if (d && !userDisconnect.current) {
              setState((s) => ({ ...s, status: "reconnecting", hr: null, syncing: false }));
              window.setTimeout(() => {
                if (deviceRef.current && !userDisconnect.current) void open(deviceRef.current);
              }, 2500);
            } else {
              setState((s) => ({ ...s, status: "idle", hr: null }));
            }
          }
        }),
        OpenFitBle.addListener("sample", (e) => {
          // Native side POSTs to /api/wellness (so it survives screen-lock); here
          // we only mirror the latest HR for the UI.
          if (e.kind === "heart_rate") setState((s) => ({ ...s, hr: Math.round(e.value) }));
        }),
      ]);
      if (!alive) {
        handles.forEach((h) => void h.remove());
        return;
      }
      subs.current = handles;
      // Auto-connect a previously added device on app start.
      if (deviceRef.current) void open(deviceRef.current);
    })();
    return () => {
      alive = false;
      subs.current.forEach((h) => void h.remove());
      subs.current = [];
    };
  }, [available, open]);

  const scan = useCallback(async () => {
    if (!available) return;
    setState((s) => ({ ...s, status: s.status === "connected" ? s.status : "scanning", found: [], message: undefined }));
    try {
      await OpenFitBle.startScan();
      window.setTimeout(() => setState((s) => (s.status === "scanning" ? { ...s, status: "idle" } : s)), 10_500);
    } catch (e) {
      setState((s) => ({ ...s, status: "error", message: e instanceof Error ? e.message : String(e) }));
    }
  }, [available]);

  const addAndConnect = useCallback(
    async (dev: NativeScanResult, huami?: { authKey: string }) => {
      const saved: SavedDevice = {
        deviceId: dev.deviceId,
        name: dev.name,
        type: huami ? "huami" : "standard",
        authKey: huami?.authKey,
      };
      saveSaved(saved);
      await OpenFitBle.stopScan().catch(() => undefined);
      await open(saved);
    },
    [open],
  );

  const sync = useCallback(async (days = 2) => {
    if (!available) return;
    setState((s) => ({ ...s, syncing: true, message: "Syncing stored data…" }));
    try {
      await OpenFitBle.syncNow({ sinceMillis: Date.now() - days * 86_400_000 });
    } catch (e) {
      setState((s) => ({ ...s, syncing: false, message: `sync error: ${e instanceof Error ? e.message : String(e)}` }));
    }
  }, [available]);

  const forget = useCallback(async () => {
    userDisconnect.current = true;
    saveSaved(null);
    setState((s) => ({ ...s, device: null, status: "idle", hr: null }));
    await OpenFitBle.disconnect().catch(() => undefined);
  }, []);

  const connectedCount = state.status === "connected" ? 1 : 0;

  const value = useMemo<NativeBleApi>(
    () => ({ ...state, available, connectedCount, scan, addAndConnect, forget, sync }),
    [state, available, connectedCount, scan, addAndConnect, forget, sync],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNativeBle(): NativeBleApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useNativeBle must be used within <NativeBleProvider>");
  return ctx;
}
