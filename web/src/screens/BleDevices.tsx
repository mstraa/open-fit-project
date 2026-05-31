// Phase 2b — direct BLE (no Gadgetbridge). Scans for nearby devices (the
// hardware-coverage "gate": see what your Helio / 945 / Stryd expose), connects
// to one, and streams live data over STANDARD GATT services — Heart Rate
// (0x180D), Cycling Power (0x1818, Stryd power), Running Speed & Cadence
// (0x1814) — straight into /api/wellness (so it shows on the live card + stores).
//
// The connection itself lives in the app-global BleProvider (mounted above the
// router) so it SURVIVES navigation — this screen is just the scan/connect UI.
// Walk over to Wellness while connected and the live HR keeps streaming.
//
// Proprietary, device-specific protocols (full Helio/Garmin) stay on the
// Gadgetbridge-DB path (2a) until/unless we vendor those modules.
//
// Works in the Android app (Capacitor BLE) and in Chrome (Web Bluetooth). All
// BLE is verified on-device — there is no BLE in CI.

import { AppShell } from "../app/AppShell";
import { EmptyState } from "../ui/EmptyState";
import { useBle, serviceLabel, type Found, type Live } from "../ble/BleProvider";

export function BleDevices() {
  const { status, found, live, device, message, scan, connect, disconnect } = useBle();
  const live_ = status === "connected" || status === "reconnecting";

  return (
    <AppShell
      title="Devices & sources"
      crumb="Direct BLE · real-time · cloudless"
      actions={
        live_ ? (
          <button type="button" className="btn btn--ghost" onClick={() => void disconnect()}>
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={status === "scanning" || status === "connecting"}
            onClick={() => void scan()}
          >
            {status === "scanning" ? "Scanning…" : "Scan for BLE devices"}
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
            mode and your strap/Stryd active. The connection stays alive as you move between
            screens. (Runs on the phone; Bluetooth required.)
          </span>
        </div>
      </div>

      {live_ && device ? (
        <ConnectedView name={device.name} live={live} reconnecting={status === "reconnecting"} />
      ) : status === "connecting" ? (
        <EmptyState label={`Connecting to ${device?.name ?? "device"}…`} />
      ) : status === "error" ? (
        <EmptyState label="Bluetooth error" hint={message} />
      ) : found.length > 0 ? (
        <DeviceList found={found} onConnect={(d) => void connect(d)} />
      ) : status === "scanning" ? (
        <EmptyState label="Scanning for nearby devices…" />
      ) : (
        <div
          className="card"
          style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: 32, textAlign: "center" }}
        >
          <div className="stat__ico t-acc" style={{ width: 44, height: 44 }}>
            <BleIcon />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>No devices yet</div>
            <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0", maxWidth: 360 }}>
              Scan to list nearby Bluetooth devices and which standard services (heart rate /
              power / cadence) each exposes, then connect to stream live.
            </p>
          </div>
          <button type="button" className="btn" onClick={() => void scan()} style={{ padding: "10px 18px" }}>
            <BleIcon /> Scan for BLE devices
          </button>
          <span className="faint" style={{ fontSize: 11 }}>
            Requires Bluetooth (the Android app, or Chrome with Web Bluetooth).
          </span>
        </div>
      )}
    </AppShell>
  );
}

function DeviceList({ found, onConnect }: { found: Found[]; onConnect: (d: Found) => void }) {
  return (
    <div className="card card--pad0">
      {found.map((d) => {
        const tags = serviceLabel(d.services);
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

function ConnectedView({ name, live, reconnecting }: { name: string; live: Live; reconnecting: boolean }) {
  return (
    <>
      <div className="card" style={{ marginBottom: "var(--gap)", display: "flex", alignItems: "center", gap: 12 }}>
        <span className="dot-live" style={reconnecting ? { background: "var(--warn, #e0a83e)" } : undefined} />
        <b>{name}</b>
        <span className="muted">{reconnecting ? "reconnecting…" : "streaming live → wellness"}</span>
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
