// Phase 2b — direct BLE (no Gadgetbridge). Scans for nearby devices (the
// hardware-coverage "gate": see what your Helio / 945 / Stryd expose), connects
// to one, and streams live data over STANDARD GATT services — Heart Rate
// (0x180D), Cycling Power (0x1818, Stryd power), Running Speed & Cadence
// (0x1814) — straight into /api/wellness (so it shows on the live card + stores).
//
// Proprietary, device-specific protocols (full Helio/Garmin) stay on the
// Gadgetbridge-DB path (2a) until/unless we vendor those modules.
//
// Works in the Android app (Capacitor BLE) and in Chrome (Web Bluetooth). All
// BLE is verified on-device — there is no BLE in CI.

import { useCallback, useRef, useState } from "react";
import { AppShell } from "../app/AppShell";
import { EmptyState } from "../ui/EmptyState";
import { ingestWellness } from "../api/endpoints";

// Standard 16-bit GATT UUIDs (expanded to the full 128-bit base form).
const uuid = (short: string) => `0000${short}-0000-1000-8000-00805f9b34fb`;
const HR_SERVICE = uuid("180d");
const HR_MEASUREMENT = uuid("2a37");
const CP_SERVICE = uuid("1818"); // Cycling Power (Stryd reports running power here)
const CP_MEASUREMENT = uuid("2a63");
const RSC_SERVICE = uuid("1814"); // Running Speed and Cadence
const RSC_MEASUREMENT = uuid("2a53");

interface Found {
  deviceId: string;
  name: string;
  rssi?: number;
  services: string[];
}

interface Live {
  hr?: number;
  power?: number;
  cadence?: number;
  speed?: number;
}

type State =
  | { kind: "idle" }
  | { kind: "scanning"; found: Found[] }
  | { kind: "scanned"; found: Found[] }
  | { kind: "connected"; name: string; live: Live }
  | { kind: "error"; message: string };

function shortHas(services: string[], short: string): boolean {
  const u = uuid(short);
  return services.some((s) => s.toLowerCase() === u || s.toLowerCase() === short);
}

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

export function BleDevices() {
  const [state, setState] = useState<State>({ kind: "idle" });
  const apiRef = useRef<typeof import("@capacitor-community/bluetooth-le").BleClient | null>(null);
  const connectedId = useRef<string | null>(null);

  const ble = useCallback(async () => {
    if (!apiRef.current) {
      const mod = await import("@capacitor-community/bluetooth-le");
      await mod.BleClient.initialize({ androidNeverForLocation: true });
      apiRef.current = mod.BleClient;
    }
    return apiRef.current;
  }, []);

  const scan = useCallback(async () => {
    try {
      const client = await ble();
      const found: Found[] = [];
      setState({ kind: "scanning", found });
      await client.requestLEScan({}, (r) => {
        const id = r.device.deviceId;
        if (found.some((f) => f.deviceId === id)) return;
        found.push({
          deviceId: id,
          name: r.device.name || r.localName || "(unnamed)",
          rssi: r.rssi,
          services: (r.uuids ?? []).map((u) => u.toLowerCase()),
        });
        setState({ kind: "scanning", found: [...found] });
      });
      setTimeout(async () => {
        try {
          await client.stopLEScan();
        } catch {
          /* ignore */
        }
        setState({ kind: "scanned", found: [...found].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999)) });
      }, 8000);
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [ble]);

  const connect = useCallback(
    async (dev: Found) => {
      try {
        const client = await ble();
        await client.connect(dev.deviceId, () => {
          connectedId.current = null;
          setState({ kind: "scanned", found: [] });
        });
        connectedId.current = dev.deviceId;
        const live: Live = {};
        setState({ kind: "connected", name: dev.name, live });

        let lastPush = 0;
        const pushHr = (hr: number) => {
          const now = Date.now();
          if (now - lastPush > 900) {
            lastPush = now;
            void ingestWellness([{ kind: "heart_rate", value: hr }]).catch(() => undefined);
          }
        };

        // Subscribe to whatever standard services the device offers.
        try {
          await client.startNotifications(dev.deviceId, HR_SERVICE, HR_MEASUREMENT, (v) => {
            live.hr = parseHr(v);
            setState({ kind: "connected", name: dev.name, live: { ...live } });
            pushHr(live.hr);
          });
        } catch {
          /* no HR service */
        }
        try {
          await client.startNotifications(dev.deviceId, CP_SERVICE, CP_MEASUREMENT, (v) => {
            live.power = parsePower(v);
            setState({ kind: "connected", name: dev.name, live: { ...live } });
          });
        } catch {
          /* no power */
        }
        try {
          await client.startNotifications(dev.deviceId, RSC_SERVICE, RSC_MEASUREMENT, (v) => {
            const { speed, cadence } = parseRsc(v);
            live.speed = speed;
            live.cadence = cadence;
            setState({ kind: "connected", name: dev.name, live: { ...live } });
          });
        } catch {
          /* no RSC */
        }
      } catch (e) {
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    },
    [ble],
  );

  const disconnect = useCallback(async () => {
    const client = apiRef.current;
    if (client && connectedId.current) {
      try {
        await client.disconnect(connectedId.current);
      } catch {
        /* ignore */
      }
    }
    connectedId.current = null;
    setState({ kind: "scanned", found: [] });
  }, []);

  return (
    <AppShell
      title="Devices & sources"
      crumb="Direct BLE · real-time · cloudless"
      actions={
        state.kind === "connected" ? (
          <button type="button" className="btn btn--ghost" onClick={() => void disconnect()}>
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={state.kind === "scanning"}
            onClick={() => void scan()}
          >
            {state.kind === "scanning" ? "Scanning…" : "Scan for BLE devices"}
          </button>
        )
      }
    >
      <div className="banner" style={{ marginBottom: 24 }}>
        <BleIcon />
        <div>
          <b>Direct BLE (Phase 2b).</b>{" "}
          <span className="muted">
            Streams live heart rate / power / cadence from devices that expose the standard
            GATT services — no Gadgetbridge in the loop. Put your watch in "Broadcast HR"
            mode and your strap/Stryd active. (Runs on the phone; Bluetooth required.)
          </span>
        </div>
      </div>

      {state.kind === "connected" ? (
        <ConnectedView name={state.name} live={state.live} />
      ) : state.kind === "error" ? (
        <EmptyState label="Bluetooth error" hint={state.message} />
      ) : "found" in state && state.found.length > 0 ? (
        <DeviceList found={state.found} onConnect={(d) => void connect(d)} />
      ) : state.kind === "scanning" ? (
        <EmptyState label="Scanning for nearby devices…" />
      ) : (
        <EmptyState
          label="No devices yet"
          hint="Tap “Scan for BLE devices”. We’ll list what’s nearby and which standard services (HR / power / cadence) each exposes."
        />
      )}
    </AppShell>
  );
}

function DeviceList({ found, onConnect }: { found: Found[]; onConnect: (d: Found) => void }) {
  return (
    <div className="card card--pad0">
      {found.map((d) => {
        const tags: string[] = [];
        if (shortHas(d.services, "180d")) tags.push("Heart Rate");
        if (shortHas(d.services, "1818")) tags.push("Power");
        if (shortHas(d.services, "1814")) tags.push("Speed/Cadence");
        return (
          <div key={d.deviceId} className="dev" style={{ padding: "12px 16px" }}>
            <div className="dev__b">
              <b>{d.name}</b>
              <span>
                {d.rssi != null ? `${d.rssi} dBm · ` : ""}
                {tags.length ? tags.join(" · ") : "no standard services advertised"}
              </span>
            </div>
            <button type="button" className="btn btn--ghost" onClick={() => onConnect(d)}>
              Connect
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ConnectedView({ name, live }: { name: string; live: Live }) {
  return (
    <>
      <div className="card" style={{ marginBottom: "var(--gap)", display: "flex", alignItems: "center", gap: 12 }}>
        <span className="dot-live" />
        <b>{name}</b>
        <span className="muted">streaming live → wellness</span>
      </div>
      <div className="grid grid--stats">
        <LiveTile tint="t-hr" label="Heart rate" value={live.hr} unit="bpm" />
        <LiveTile tint="t-pow" label="Power" value={live.power} unit="W" />
        <LiveTile tint="t-cad" label="Cadence" value={live.cadence} unit="spm" />
        <LiveTile tint="t-pace" label="Speed" value={live.speed} unit="m/s" digits={1} />
      </div>
    </>
  );
}

function LiveTile({
  tint,
  label,
  value,
  unit,
  digits = 0,
}: {
  tint: string;
  label: string;
  value?: number;
  unit: string;
  digits?: number;
}) {
  return (
    <div className="card stat">
      <div className={`stat__ico ${tint}`}>
        <BleIcon />
      </div>
      <div className="stat__label">{label}</div>
      <div className="stat__val num" style={{ fontSize: 26 }}>
        {value != null ? value.toFixed(digits) : "—"}
        <small> {unit}</small>
      </div>
    </div>
  );
}

function BleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path d="M7 7l10 10-5 4V3l5 4L7 17" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
