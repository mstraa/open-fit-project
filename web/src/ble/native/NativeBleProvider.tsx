// App-global native-BLE connections (mounted ABOVE the router, see main.tsx) so
// connected devices keep streaming as you move between screens. Supports MULTIPLE
// devices at once — e.g. the Helio (Zepp-OS) and a Garmin 945 streaming live HR
// simultaneously. Each added device is persisted and auto-reconnected when its
// link drops or on app start. Android app only.

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
import { isNativeApp } from "../../app/isNativeApp";

export type NativeConnStatus = "idle" | "scanning" | "connecting" | "connected" | "reconnecting" | "error";

/** A device the user has "added" — auto-reconnected on drop / app start. */
export interface SavedDevice {
  deviceId: string;
  name: string;
  type: "standard" | "huami" | "garmin";
  authKey?: string;
}

interface NativeBleApi {
  available: boolean;
  status: NativeConnStatus; // aggregate (for the global indicator)
  found: NativeScanResult[];
  hr: number | null; // latest HR from any device
  devices: SavedDevice[];
  connectedCount: number;
  syncing: boolean;
  /** Per-device link state. */
  statusOf: (deviceId: string) => NativeConnStatus;
  messageOf: (deviceId: string) => string | undefined;
  hrOf: (deviceId: string) => number | null;
  scan: () => Promise<void>;
  addAndConnect: (dev: NativeScanResult, opts?: { type?: "huami" | "garmin"; authKey?: string }) => Promise<void>;
  forget: (deviceId: string) => Promise<void>;
  sync: (days?: number) => Promise<void>;
}

const Ctx = createContext<NativeBleApi | null>(null);
const STORE = "ofit_native_devices";
const LEGACY_STORE = "ofit_native_device"; // pre-multi-device single-device key

function loadSaved(): SavedDevice[] {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) return JSON.parse(raw) as SavedDevice[];
    // One-time migration from the old single-device key.
    const legacy = localStorage.getItem(LEGACY_STORE);
    if (legacy) {
      const d = JSON.parse(legacy) as SavedDevice;
      localStorage.setItem(STORE, JSON.stringify([d]));
      localStorage.removeItem(LEGACY_STORE);
      return [d];
    }
    return [];
  } catch {
    return [];
  }
}
function saveSaved(d: SavedDevice[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(d));
  } catch {
    /* ignore */
  }
}

export function NativeBleProvider({ children }: { children: ReactNode }) {
  const available = isNativeApp();
  const [devices, setDevices] = useState<SavedDevice[]>(() => loadSaved());
  const [found, setFound] = useState<NativeScanResult[]>([]);
  const [scanning, setScanning] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, NativeConnStatus>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [hrById, setHrById] = useState<Record<string, number>>({});
  const [hr, setHr] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);

  const subs = useRef<PluginListenerHandle[]>([]);
  const devicesRef = useRef<SavedDevice[]>(devices);
  devicesRef.current = devices;
  // Devices the user explicitly disconnected — don't auto-reconnect these.
  const userDisconnect = useRef<Set<string>>(new Set());
  // True only while a user-tapped sync is in flight, so background/periodic syncs
  // don't reload the page out from under the user.
  const userSync = useRef(false);

  const setStatus = useCallback((id: string, s: NativeConnStatus) => {
    setStatuses((m) => ({ ...m, [id]: s }));
  }, []);

  // Open (or re-open) the connection for one saved device.
  const open = useCallback(async (d: SavedDevice) => {
    userDisconnect.current.delete(d.deviceId);
    setStatus(d.deviceId, "connecting");
    setMessages((m) => ({ ...m, [d.deviceId]: "" }));
    try {
      // Give the native side the server URL + token so it can POST samples even
      // while the screen is locked (the WebView/JS is suspended then).
      await OpenFitBle.configure({ apiBase: API_BASE, token: getToken() }).catch(() => undefined);
      await OpenFitBle.connect(
        d.type === "huami"
          ? { deviceId: d.deviceId, deviceType: "huami", authKey: d.authKey }
          : d.type === "garmin"
            ? { deviceId: d.deviceId, deviceType: "garmin" }
            : { deviceId: d.deviceId },
      );
    } catch (e) {
      setStatus(d.deviceId, "error");
      setMessages((m) => ({ ...m, [d.deviceId]: e instanceof Error ? e.message : String(e) }));
    }
  }, [setStatus]);

  // Register native listeners ONCE for the provider's lifetime.
  useEffect(() => {
    if (!available) return;
    let alive = true;
    (async () => {
      const handles = await Promise.all([
        OpenFitBle.addListener("scanResult", (r) => {
          setFound((f) => (f.some((x) => x.deviceId === r.deviceId) ? f : [...f, r].sort((a, b) => b.rssi - a.rssi)));
        }),
        OpenFitBle.addListener("status", (e: NativeStatus) => {
          const id = e.deviceId;
          if (e.status === "connected" || e.status === "ready") {
            const done =
              e.message === "sync complete" ||
              e.message === "sync up to date" ||
              e.message === "sync failed" ||
              e.message === "sync timed out";
            if (id) setStatus(id, "connected");
            if (e.message) setMessages((m) => (id ? { ...m, [id]: e.message! } : m));
            if (done) setSyncing(false);
            // Surface new history after a user-tapped sync with a SOFT refresh (a
            // data-updated event that remounts the screen) — not a page reload.
            if (e.message === "sync complete" && userSync.current) {
              userSync.current = false;
              window.setTimeout(() => window.dispatchEvent(new Event("ofit:data-updated")), 800);
            }
            // The native side ran an analytics recompute — soft-refresh so the
            // views pick up the derived metrics. (Global, no deviceId.)
            if (e.message === "recomputed") {
              window.dispatchEvent(new Event("ofit:data-updated"));
            }
            if (done) userSync.current = false;
          } else if (e.status === "error") {
            if (id) {
              setStatus(id, "error");
              if (e.message) setMessages((m) => ({ ...m, [id]: e.message! }));
            }
            setSyncing(false);
          } else if (e.status === "disconnected") {
            if (!id) return;
            // Auto-reconnect a saved device unless the user asked to disconnect.
            const saved = devicesRef.current.find((d) => d.deviceId === id);
            if (saved && !userDisconnect.current.has(id)) {
              setStatus(id, "reconnecting");
              setHrById((m) => ({ ...m, [id]: 0 }));
              window.setTimeout(() => {
                const still = devicesRef.current.find((d) => d.deviceId === id);
                if (still && !userDisconnect.current.has(id)) void open(still);
              }, 2500);
            } else {
              setStatus(id, "idle");
            }
          }
        }),
        OpenFitBle.addListener("sample", (e) => {
          // Native side POSTs to /api/wellness; here we only mirror the latest HR.
          if (e.kind === "heart_rate") {
            const v = Math.round(e.value);
            setHr(v);
            if (e.deviceId) setHrById((m) => ({ ...m, [e.deviceId]: v }));
          }
        }),
      ]);
      if (!alive) {
        handles.forEach((h) => void h.remove());
        return;
      }
      subs.current = handles;
      // Auto-connect every previously added device on app start.
      for (const d of devicesRef.current) void open(d);
    })();
    return () => {
      alive = false;
      subs.current.forEach((h) => void h.remove());
      subs.current = [];
    };
  }, [available, open, setStatus]);

  const scan = useCallback(async () => {
    if (!available) return;
    setScanning(true);
    setFound([]);
    try {
      await OpenFitBle.startScan();
      window.setTimeout(() => setScanning(false), 10_500);
    } catch {
      setScanning(false);
    }
  }, [available]);

  const addAndConnect = useCallback(
    async (dev: NativeScanResult, opts?: { type?: "huami" | "garmin"; authKey?: string }) => {
      const saved: SavedDevice = {
        deviceId: dev.deviceId,
        name: dev.name,
        type: opts?.type ?? "standard",
        authKey: opts?.authKey,
      };
      // Add (or replace) without dropping other connected devices.
      setDevices((list) => {
        const next = [...list.filter((d) => d.deviceId !== saved.deviceId), saved];
        saveSaved(next);
        devicesRef.current = next;
        return next;
      });
      await OpenFitBle.stopScan().catch(() => undefined);
      setScanning(false);
      await open(saved);
    },
    [open],
  );

  // Incremental by default; pass `days` to force a full re-sync window. Syncs
  // every connected Zepp-OS device (Garmin links are live-only).
  const sync = useCallback(async (days?: number) => {
    if (!available) return;
    userSync.current = true;
    setSyncing(true);
    try {
      await OpenFitBle.syncNow(days ? { sinceMillis: Date.now() - days * 86_400_000 } : {});
    } catch (e) {
      setSyncing(false);
      console.warn("sync error", e);
    }
  }, [available]);

  const forget = useCallback(async (deviceId: string) => {
    userDisconnect.current.add(deviceId);
    setDevices((list) => {
      const next = list.filter((d) => d.deviceId !== deviceId);
      saveSaved(next);
      devicesRef.current = next;
      return next;
    });
    setStatuses((m) => {
      const next = { ...m };
      delete next[deviceId];
      return next;
    });
    setHrById((m) => {
      const next = { ...m };
      delete next[deviceId];
      return next;
    });
    await OpenFitBle.disconnect({ deviceId }).catch(() => undefined);
  }, []);

  const connectedCount = useMemo(
    () => devices.filter((d) => statuses[d.deviceId] === "connected").length,
    [devices, statuses],
  );

  // Aggregate status for the global indicator.
  const status: NativeConnStatus = useMemo(() => {
    if (scanning) return "scanning";
    const vals = devices.map((d) => statuses[d.deviceId]);
    if (vals.some((v) => v === "connected")) return "connected";
    if (vals.some((v) => v === "connecting" || v === "reconnecting")) return "reconnecting";
    if (vals.some((v) => v === "error")) return "error";
    return "idle";
  }, [devices, statuses, scanning]);

  const statusOf = useCallback((id: string): NativeConnStatus => statuses[id] ?? "idle", [statuses]);
  const messageOf = useCallback((id: string) => messages[id], [messages]);
  const hrOf = useCallback((id: string) => (hrById[id] ? hrById[id] : null), [hrById]);

  const value = useMemo<NativeBleApi>(
    () => ({
      available,
      status,
      found,
      hr,
      devices,
      connectedCount,
      syncing,
      statusOf,
      messageOf,
      hrOf,
      scan,
      addAndConnect,
      forget,
      sync,
    }),
    [available, status, found, hr, devices, connectedCount, syncing, statusOf, messageOf, hrOf, scan, addAndConnect, forget, sync],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNativeBle(): NativeBleApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useNativeBle must be used within <NativeBleProvider>");
  return ctx;
}
