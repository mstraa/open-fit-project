// App-global BLE connection. Mounted ABOVE the router (see main.tsx) so the
// live GATT connection and its notification handlers survive route changes —
// previously the connection lived inside the /devices screen and was torn down
// the instant you navigated to Wellness (the component unmounted). Now the
// stream keeps flowing into /api/wellness no matter which screen is showing,
// and the connection state is shared so any screen can render the live tiles.
//
// Streams STANDARD GATT services — Heart Rate (0x180D), Cycling Power (0x1818,
// Stryd power), Running Speed & Cadence (0x1814). All BLE is verified
// on-device; there is no BLE in CI.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ingestWellness } from "../api/endpoints";

// Standard 16-bit GATT UUIDs expanded to the full 128-bit base form.
const uuid = (short: string) => `0000${short}-0000-1000-8000-00805f9b34fb`;
const HR_SERVICE = uuid("180d");
const HR_MEASUREMENT = uuid("2a37");
const CP_SERVICE = uuid("1818"); // Cycling Power (Stryd reports running power here)
const CP_MEASUREMENT = uuid("2a63");
const RSC_SERVICE = uuid("1814"); // Running Speed and Cadence
const RSC_MEASUREMENT = uuid("2a53");

export interface Found {
  deviceId: string;
  name: string;
  rssi?: number;
  services: string[];
}

export interface Live {
  hr?: number;
  power?: number;
  cadence?: number;
  speed?: number;
}

export type BleStatus =
  | "idle"
  | "scanning"
  | "scanned"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

interface BleState {
  status: BleStatus;
  found: Found[];
  live: Live;
  device: Found | null;
  message?: string;
}

interface BleApi extends BleState {
  scan: () => Promise<void>;
  connect: (dev: Found) => Promise<void>;
  disconnect: () => Promise<void>;
}

const Ctx = createContext<BleApi | null>(null);

/** Heart Rate Measurement (0x2A37): flags byte, then uint8 or uint16 HR. */
function parseHr(v: DataView): number {
  const flags = v.getUint8(0);
  return flags & 0x01 ? v.getUint16(1, true) : v.getUint8(1);
}
/** Cycling Power Measurement (0x2A63): flags (2), instantaneous power sint16 @2. */
function parsePower(v: DataView): number {
  return v.getInt16(2, true);
}
/** RSC Measurement (0x2A53): flags, speed uint16 (1/256 m/s) @1, cadence uint8 @3. */
function parseRsc(v: DataView): { speed: number; cadence: number } {
  return { speed: v.getUint16(1, true) / 256, cadence: v.getUint8(3) };
}

type BleClient = typeof import("@capacitor-community/bluetooth-le").BleClient;

export function BleProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BleState>({ status: "idle", found: [], live: {}, device: null });

  // Long-lived handles. These live in the provider (mounted above the router),
  // so they are NOT recreated on navigation — the connection genuinely persists.
  const clientRef = useRef<BleClient | null>(null);
  const liveRef = useRef<Live>({});
  const lastPushRef = useRef(0);
  const userDisconnectRef = useRef(false); // distinguish intentional vs dropped
  const busyRef = useRef(false); // guard against overlapping scan/connect churn

  const ble = useCallback(async () => {
    if (!clientRef.current) {
      const mod = await import("@capacitor-community/bluetooth-le");
      await mod.BleClient.initialize({ androidNeverForLocation: true });
      clientRef.current = mod.BleClient;
    }
    return clientRef.current;
  }, []);

  const pushHr = useCallback((hr: number) => {
    const now = Date.now();
    if (now - lastPushRef.current > 900) {
      lastPushRef.current = now;
      void ingestWellness([{ kind: "heart_rate", value: hr }]).catch(() => undefined);
    }
  }, []);

  const emitLive = useCallback(() => {
    setState((s) => (s.status === "connected" ? { ...s, live: { ...liveRef.current } } : s));
  }, []);

  // Subscribe to whatever standard services the device exposes. Each is
  // independent — a HR strap has only HR, a Stryd only power, etc.
  const subscribe = useCallback(
    async (client: BleClient, id: string) => {
      try {
        await client.startNotifications(id, HR_SERVICE, HR_MEASUREMENT, (v) => {
          liveRef.current.hr = parseHr(v);
          emitLive();
          pushHr(liveRef.current.hr);
        });
      } catch {
        /* no HR service */
      }
      try {
        await client.startNotifications(id, CP_SERVICE, CP_MEASUREMENT, (v) => {
          liveRef.current.power = parsePower(v);
          emitLive();
        });
      } catch {
        /* no power */
      }
      try {
        await client.startNotifications(id, RSC_SERVICE, RSC_MEASUREMENT, (v) => {
          const { speed, cadence } = parseRsc(v);
          liveRef.current.speed = speed;
          liveRef.current.cadence = cadence;
          emitLive();
        });
      } catch {
        /* no RSC */
      }
    },
    [emitLive, pushHr],
  );

  // Open (or re-open) the GATT connection. On an unexpected drop we attempt a
  // few silent reconnects before giving up — this is what kills the visible
  // "connect/disconnect" churn the user hit (BLE links drop routinely; the app
  // should heal instead of bouncing the UI to an empty list).
  const open = useCallback(
    async (dev: Found, attempt = 0) => {
      const client = await ble();
      await client.connect(dev.deviceId, () => {
        if (userDisconnectRef.current) return; // we asked for it — stay quiet
        // Unexpected drop: try to heal up to 3 times with backoff.
        if (attempt < 3) {
          setState((s) => ({ ...s, status: "reconnecting", message: undefined }));
          window.setTimeout(() => {
            void open(dev, attempt + 1).catch(() => {
              setState((s) => ({ ...s, status: "error", message: "Connection lost — tap to reconnect." }));
            });
          }, 800 * (attempt + 1));
        } else {
          setState((s) => ({ ...s, status: "error", message: "Connection lost — tap to reconnect." }));
        }
      });
      await subscribe(client, dev.deviceId);
      setState({ status: "connected", found: [], live: { ...liveRef.current }, device: dev });
    },
    [ble, subscribe],
  );

  const connect = useCallback(
    async (dev: Found) => {
      if (busyRef.current) return;
      busyRef.current = true;
      userDisconnectRef.current = false;
      liveRef.current = {};
      setState((s) => ({ ...s, status: "connecting", device: dev, live: {}, message: undefined }));
      try {
        await open(dev);
      } catch (e) {
        setState((s) => ({ ...s, status: "error", message: e instanceof Error ? e.message : String(e) }));
      } finally {
        busyRef.current = false;
      }
    },
    [open],
  );

  const scan = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const client = await ble();
      const found: Found[] = [];
      setState((s) => ({ ...s, status: "scanning", found, message: undefined }));
      await client.requestLEScan({}, (r) => {
        const id = r.device.deviceId;
        if (found.some((f) => f.deviceId === id)) return;
        found.push({
          deviceId: id,
          name: r.device.name || r.localName || "(unnamed)",
          rssi: r.rssi,
          services: (r.uuids ?? []).map((u) => u.toLowerCase()),
        });
        setState((s) => ({ ...s, found: [...found] }));
      });
      window.setTimeout(async () => {
        try {
          await client.stopLEScan();
        } catch {
          /* ignore */
        }
        setState((s) => ({
          ...s,
          status: "scanned",
          found: [...found].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999)),
        }));
        busyRef.current = false;
      }, 8000);
    } catch {
      // Desktop Chrome (Web Bluetooth) has no continuous scan → OS device picker.
      busyRef.current = false;
      try {
        const client = await ble();
        const device = await client.requestDevice({
          services: [HR_SERVICE],
          optionalServices: [CP_SERVICE, RSC_SERVICE],
        });
        await connect({ deviceId: device.deviceId, name: device.name || "(device)", services: [HR_SERVICE] });
      } catch (e) {
        setState((s) => ({ ...s, status: "error", message: e instanceof Error ? e.message : String(e) }));
      }
    }
  }, [ble, connect]);

  const disconnect = useCallback(async () => {
    userDisconnectRef.current = true;
    const client = clientRef.current;
    const id = state.device?.deviceId;
    if (client && id) {
      try {
        await client.disconnect(id);
      } catch {
        /* ignore */
      }
    }
    liveRef.current = {};
    setState({ status: "idle", found: [], live: {}, device: null });
  }, [state.device]);

  const value = useMemo<BleApi>(
    () => ({ ...state, scan, connect, disconnect }),
    [state, scan, connect, disconnect],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBle(): BleApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useBle must be used within <BleProvider>");
  return ctx;
}

export function serviceLabel(services: string[]): string[] {
  const labels: string[] = [];
  const has = (short: string) => services.some((s) => s.toLowerCase() === uuid(short) || s.toLowerCase() === short);
  if (has("180d")) labels.push("Heart Rate");
  if (has("1818")) labels.push("Power");
  if (has("1814")) labels.push("Speed/Cadence");
  return labels;
}
