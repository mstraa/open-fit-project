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
  useEffect,
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
  /** Step-by-step diagnostic log of the last scan/connect (newest last). */
  steps: string[];
}

/** Connection/status slice — everything EXCEPT the high-frequency live samples. */
type BleConnState = Omit<BleState, "live">;

/** Connection/status + actions (re-renders on connect/scan, NOT on every sample). */
interface BleConnectionApi extends BleConnState {
  scan: () => Promise<void>;
  connect: (dev: Found) => Promise<void>;
  disconnect: () => Promise<void>;
}

/** The combined surface kept for existing `useBle()` consumers. */
interface BleApi extends BleState {
  scan: () => Promise<void>;
  connect: (dev: Found) => Promise<void>;
  disconnect: () => Promise<void>;
}

// Two contexts so live-sample subscribers re-render on samples while
// status-only subscribers don't churn at the ~1Hz+ BLE notification rate.
const ConnCtx = createContext<BleConnectionApi | null>(null);
const LiveCtx = createContext<Live | null>(null);

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

/** Compact an error into a one-line string for the diagnostic log. */
function shortErr(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 90 ? `${m.slice(0, 90)}…` : m;
}

export function BleProvider({ children }: { children: ReactNode }) {
  // Connection/status slice (low-frequency). `live` is a SEPARATE state so that
  // ~1Hz sample updates don't churn the connection context value (which would
  // re-render status-only consumers on every heartbeat).
  const [state, setState] = useState<BleConnState>({ status: "idle", found: [], device: null, steps: [] });
  const [live, setLive] = useState<Live>({});

  // Long-lived handles. These live in the provider (mounted above the router),
  // so they are NOT recreated on navigation — the connection genuinely persists.
  const clientRef = useRef<BleClient | null>(null);
  const liveRef = useRef<Live>({});
  const lastPushRef = useRef(0);
  const userDisconnectRef = useRef(false); // distinguish intentional vs dropped
  const scanningRef = useRef(false);
  const connectingRef = useRef(false);
  // Pending reconnect timers — tracked so they can be cleared if the provider
  // unmounts (or the user disconnects) before they fire, otherwise a queued
  // open() would run against an unmounted provider.
  const reconnectTimersRef = useRef<number[]>([]);
  const statusRef = useRef<BleStatus>("idle");
  statusRef.current = state.status;

  // Append a diagnostic step (also mirrored to the console). Surfaced in the UI
  // so a connection failure shows exactly which step failed and with what error.
  const step = useCallback((msg: string, reset = false) => {
    // eslint-disable-next-line no-console
    console.log(`[BLE] ${msg}`);
    setState((s) => ({ ...s, steps: (reset ? [] : s.steps).concat(msg).slice(-14) }));
  }, []);

  const ble = useCallback(async () => {
    if (!clientRef.current) {
      step("Initializing Bluetooth…");
      const mod = await import("@capacitor-community/bluetooth-le");
      await mod.BleClient.initialize({ androidNeverForLocation: true });
      clientRef.current = mod.BleClient;
      step("Bluetooth ready.");
    }
    return clientRef.current;
  }, [step]);

  const pushHr = useCallback((hr: number) => {
    const now = Date.now();
    if (now - lastPushRef.current > 900) {
      lastPushRef.current = now;
      void ingestWellness([{ kind: "heart_rate", value: hr }]).catch(() => undefined);
    }
  }, []);

  const emitLive = useCallback(() => {
    // Only the live context updates here — the connection context is untouched,
    // so status-only consumers don't re-render on samples.
    if (statusRef.current === "connected") setLive({ ...liveRef.current });
  }, []);

  // Subscribe to whatever standard measurement services the device exposes. We
  // ATTEMPT all three directly (this is what works for the Helio — its HR
  // service is readable even though getServices() reports it in a form that's
  // awkward to match), and return how many subscriptions actually succeeded so
  // the caller can show a helpful message only when truly nothing is readable.
  const subscribe = useCallback(
    async (client: BleClient, id: string): Promise<number> => {
      let subscribed = 0;
      try {
        await client.startNotifications(id, HR_SERVICE, HR_MEASUREMENT, (v) => {
          liveRef.current.hr = parseHr(v);
          emitLive();
          pushHr(liveRef.current.hr);
        });
        subscribed++;
        step("Subscribed: Heart Rate.");
      } catch (e) {
        step(`No Heart Rate service (${shortErr(e)}).`);
      }
      try {
        await client.startNotifications(id, CP_SERVICE, CP_MEASUREMENT, (v) => {
          liveRef.current.power = parsePower(v);
          emitLive();
        });
        subscribed++;
        step("Subscribed: Power.");
      } catch {
        /* no power — common, don't clutter the log */
      }
      try {
        await client.startNotifications(id, RSC_SERVICE, RSC_MEASUREMENT, (v) => {
          const { speed, cadence } = parseRsc(v);
          liveRef.current.speed = speed;
          liveRef.current.cadence = cadence;
          emitLive();
        });
        subscribed++;
        step("Subscribed: Speed/Cadence.");
      } catch {
        /* no RSC */
      }
      return subscribed;
    },
    [emitLive, pushHr, step],
  );

  // Open (or re-open) the GATT connection. On an unexpected drop we attempt a
  // few silent reconnects before giving up — this is what kills the visible
  // "connect/disconnect" churn the user hit (BLE links drop routinely; the app
  // should heal instead of bouncing the UI to an empty list).
  const open = useCallback(
    async (dev: Found, attempt = 0) => {
      const client = await ble();
      // Clear any stale GATT for this device id first (a half-open connection
      // from a previous failed attempt makes the next connect throw).
      try {
        await client.disconnect(dev.deviceId);
      } catch {
        /* nothing to clear */
      }
      step(attempt === 0 ? `Connecting to ${dev.name}…` : `Reconnecting (try ${attempt + 1})…`);
      await client.connect(
        dev.deviceId,
        () => {
          if (userDisconnectRef.current) return; // we asked for it — stay quiet
          step("Link dropped.");
          // Unexpected drop: try to heal up to 3 times with backoff.
          if (attempt < 3) {
            setState((s) => ({ ...s, status: "reconnecting", message: undefined }));
            const timer = window.setTimeout(() => {
              // Drop self from the pending list (we're firing now).
              reconnectTimersRef.current = reconnectTimersRef.current.filter((t) => t !== timer);
              if (userDisconnectRef.current) return; // disconnected while we waited
              void open(dev, attempt + 1).catch((e) => {
                setState((s) => ({ ...s, status: "error", message: `Connection lost — tap to reconnect. (${shortErr(e)})` }));
              });
            }, 800 * (attempt + 1));
            reconnectTimersRef.current.push(timer);
          } else {
            setState((s) => ({ ...s, status: "error", message: "Connection lost — tap to reconnect." }));
          }
        },
        { timeout: 10_000 }, // fail fast with a clear error, not a hang
      );
      step("Connected — discovering services…");
      const subscribed = await subscribe(client, dev.deviceId);
      // Stay connected regardless (notifications can also start a beat late). When
      // nothing subscribed, show a soft hint rather than tearing the link down —
      // a hard disconnect here is what was wrongly killing the readable Helio.
      setState((s) => ({
        ...s,
        status: "connected",
        found: [],
        device: dev,
        message:
          subscribed === 0
            ? `Connected — no standard HR/power/cadence data yet. If readings don't appear, this device (e.g. a full Garmin) may use a proprietary protocol; use the Zepp/Gadgetbridge export for it.`
            : undefined,
      }));
      setLive({ ...liveRef.current });
    },
    [ble, subscribe],
  );

  const connect = useCallback(
    async (dev: Found) => {
      if (connectingRef.current) return;
      connectingRef.current = true;
      userDisconnectRef.current = false;
      liveRef.current = {};
      setState((s) => ({ ...s, status: "connecting", device: dev, message: undefined, steps: [] }));
      setLive({});
      try {
        // Android can't connect while a scan is running — stop it first.
        if (scanningRef.current) {
          scanningRef.current = false;
          try {
            const c = await ble();
            await c.stopLEScan();
            step("Stopped scan before connecting.");
          } catch {
            /* ignore */
          }
        }
        await open(dev);
      } catch (e) {
        step(`ERROR: ${shortErr(e)}`);
        setState((s) => ({ ...s, status: "error", message: e instanceof Error ? e.message : String(e) }));
      } finally {
        connectingRef.current = false;
      }
    },
    [ble, open, step],
  );

  const scan = useCallback(async () => {
    if (scanningRef.current || connectingRef.current) return;
    try {
      const client = await ble();
      const found: Found[] = [];
      scanningRef.current = true;
      setState((s) => ({ ...s, status: "scanning", found, message: undefined, steps: [] }));
      step("Scanning for nearby devices…");
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
        if (!scanningRef.current) return; // a connect already stopped the scan
        try {
          await client.stopLEScan();
        } catch {
          /* ignore */
        }
        scanningRef.current = false;
        setState((s) => ({
          ...s,
          status: s.status === "scanning" ? "scanned" : s.status,
          found: [...found].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999)),
        }));
      }, 8000);
    } catch {
      // Desktop Chrome (Web Bluetooth) has no continuous scan → OS device picker.
      scanningRef.current = false;
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
  }, [ble, connect, step]);

  const disconnect = useCallback(async () => {
    userDisconnectRef.current = true;
    // Cancel any queued reconnect attempts so they don't re-open after disconnect.
    reconnectTimersRef.current.forEach((t) => window.clearTimeout(t));
    reconnectTimersRef.current = [];
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
    setState({ status: "idle", found: [], device: null, steps: [] });
    setLive({});
  }, [state.device]);

  // On unmount, cancel any pending reconnect timers (the provider — and its
  // open() closure — would otherwise be gone when they fire).
  useEffect(() => {
    const timers = reconnectTimersRef;
    return () => {
      timers.current.forEach((t) => window.clearTimeout(t));
      timers.current = [];
    };
  }, []);

  // Connection context: changes only on connect/scan/status transitions.
  const connValue = useMemo<BleConnectionApi>(
    () => ({ ...state, scan, connect, disconnect }),
    [state, scan, connect, disconnect],
  );

  return (
    <ConnCtx.Provider value={connValue}>
      <LiveCtx.Provider value={live}>{children}</LiveCtx.Provider>
    </ConnCtx.Provider>
  );
}

/** Connection/status + actions only — does NOT re-render on live samples. */
export function useBleConnection(): BleConnectionApi {
  const ctx = useContext(ConnCtx);
  if (!ctx) throw new Error("useBleConnection must be used within <BleProvider>");
  return ctx;
}

/** Live samples only — re-renders on every BLE sample. */
export function useBleLive(): Live {
  const ctx = useContext(LiveCtx);
  if (ctx == null) throw new Error("useBleLive must be used within <BleProvider>");
  return ctx;
}

/** Convenience hook combining both contexts; kept for existing consumers.
 *  Subscribes to BOTH, so it re-renders on samples — prefer the granular
 *  useBleConnection()/useBleLive() where you only need one slice. */
export function useBle(): BleApi {
  const conn = useBleConnection();
  const live = useBleLive();
  return { ...conn, live };
}

export function serviceLabel(services: string[]): string[] {
  const labels: string[] = [];
  const has = (short: string) => services.some((s) => s.toLowerCase() === uuid(short) || s.toLowerCase() === short);
  if (has("180d")) labels.push("Heart Rate");
  if (has("1818")) labels.push("Power");
  if (has("1814")) labels.push("Speed/Cadence");
  return labels;
}
