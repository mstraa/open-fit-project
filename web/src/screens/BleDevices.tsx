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

import { useEffect, useState } from "react";
import { AppShell } from "../app/AppShell";
import { EmptyState } from "../ui/EmptyState";
import { useBle, serviceLabel, type Found, type Live } from "../ble/BleProvider";
import { useNativeBle, type NativeConnStatus } from "../ble/native/NativeBleProvider";
import { OpenFitBle } from "../ble/native/OpenFitBle";
import { isNativeApp } from "../gadgetbridge/autoImportConfig";

export function BleDevices() {
  const { status, found, live, device, message, steps, scan, connect, disconnect } = useBle();
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
          <b>Direct BLE.</b>{" "}
          <span className="muted">
            Streams live heart rate / power / cadence from devices that expose the standard
            GATT services — no Gadgetbridge in the loop. Put your watch in "Broadcast HR"
            mode and your strap/Stryd active. The connection stays alive as you move between
            screens. (Runs on the phone; Bluetooth required.)
          </span>
        </div>
      </div>

      {live_ && device ? (
        <ConnectedView name={device.name} live={live} reconnecting={status === "reconnecting"} note={message} />
      ) : status === "connecting" ? (
        <>
          <EmptyState label={`Connecting to ${device?.name ?? "device"}…`} />
          <BleLog steps={steps} />
        </>
      ) : status === "error" ? (
        <>
          <EmptyState label="Bluetooth error" hint={message} />
          <BleLog steps={steps} />
          <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
            {device && (
              <button type="button" className="btn" onClick={() => void connect(device)}>
                Retry connection
              </button>
            )}
          </div>
        </>
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

      <NativeBleCard />
      <OutboxCard />
    </AppShell>
  );
}

const HELIO_KEY_STORE = "ofit_helio_authkey";
const isZeppOs = (name: string) => /helio|amazfit|zepp|band|mi/i.test(name);
const isGarmin = (name: string) => /garmin|forerunner|fenix|epix|venu|instinct|945|945|fr\d/i.test(name);

/** Direct-device port (docs/NATIVE-BLE-PORT.md). M0: standard-GATT HR. M1:
 *  Zepp-OS / Huami (Helio) — auth handshake + encrypted transport → live HR.
 *  Added devices live in the app-global NativeBleProvider: they keep streaming
 *  across screens and auto-reconnect on drop. Android app only. */
/** Format remaining-capacity hours as a friendly duration. */
function fmtHeadroom(hours: number): string {
  if (hours >= 48) return `~${Math.round(hours / 24)} days`;
  if (hours >= 1) return `~${Math.round(hours)} h`;
  return `~${Math.round(hours * 60)} min`;
}

function BufStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="stat__label">{label}</div>
      <div className="num" style={{ fontSize: 16, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

/** Offline-buffer status: how much off-network data is queued on the phone, its
 *  size, and how much streaming headroom is left before the (300k) cap. Polls the
 *  native plugin. Android app only. */
function OutboxCard() {
  const [s, setS] = useState<{ count: number; maxLines: number; bytes: number } | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (!isNativeApp()) return;
    let alive = true;
    const poll = () =>
      OpenFitBle.getOutboxStatus()
        .then((r) => {
          if (!alive) return;
          setS(r);
          setErr(false);
        })
        .catch(() => alive && setErr(true));
    poll();
    const id = window.setInterval(poll, 8000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  if (!isNativeApp()) return null;

  // Always render the section on the app, even before the first status arrives,
  // so the offline buffer is discoverable (works without the server).
  if (!s) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card__head">
          <div className="card__title">
            Offline buffer<span className="sub">on-device safety net</span>
          </div>
        </div>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          {err ? "Update the app to see buffer status." : "Checking buffer…"}
        </p>
      </div>
    );
  }

  const pct = s.maxLines > 0 ? Math.min(100, (s.count / s.maxLines) * 100) : 0;
  const mb = s.bytes / 1_000_000;
  const empty = s.count === 0;
  const warn = pct >= 75;
  const headroomH = Math.max(0, s.maxLines - s.count) / 3600; // at ~1 Hz HR
  const barColor = empty ? "var(--good)" : warn ? "var(--cal)" : "var(--accent)";

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card__head">
        <div className="card__title">
          Offline buffer<span className="sub">on-device safety net</span>
        </div>
        <div className="card__tools">
          <span className={`pill ${empty ? "pill--good" : ""}`}>
            {empty ? "all backed up" : `${Math.round(pct)}% full`}
          </span>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "0 0 12px" }}>
        Readings captured while off your network are saved here and uploaded automatically when you reconnect.
      </p>
      <div style={{ height: 10, borderRadius: 999, background: "var(--surface-2, #1a1d28)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: barColor, transition: "width .3s" }} />
      </div>
      <div style={{ display: "flex", gap: 24, marginTop: 12, flexWrap: "wrap" }}>
        <BufStat label="Buffered" value={`${s.count.toLocaleString()} / ${s.maxLines.toLocaleString()}`} />
        <BufStat label="Size" value={`${mb < 0.1 ? mb.toFixed(2) : mb.toFixed(1)} MB`} />
        <BufStat label={empty ? "Status" : "Headroom"} value={empty ? "Empty" : `${fmtHeadroom(headroomH)} of HR`} />
      </div>
      {warn && (
        <p style={{ fontSize: 12, color: "var(--cal)", marginTop: 12, fontWeight: 600 }}>
          Buffer is {Math.round(pct)}% full — connect to your network to back up the data.
        </p>
      )}
    </div>
  );
}

function NativeBleCard() {
  const { status, found, devices, syncing, available, scan, addAndConnect, forget, sync, statusOf, messageOf, hrOf } =
    useNativeBle();
  const [authKey, setAuthKey] = useState<string>(() => {
    try {
      return localStorage.getItem(HELIO_KEY_STORE) ?? "";
    } catch {
      return "";
    }
  });
  if (!available) return null;
  const keyOk = /^(0x)?[0-9a-fA-F]{32}$/.test(authKey.trim());
  // Only offer to add devices that aren't already saved.
  const addable = found.filter((d) => !devices.some((x) => x.deviceId === d.deviceId));

  const saveKey = (v: string) => {
    setAuthKey(v);
    try {
      localStorage.setItem(HELIO_KEY_STORE, v);
    } catch {
      /* ignore */
    }
  };

  const statusLabel = (s: NativeConnStatus) =>
    s === "connected"
      ? "streaming → wellness"
      : s === "reconnecting"
        ? "reconnecting…"
        : s === "connecting"
          ? "connecting…"
          : s === "error"
            ? "error"
            : "added";

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div className="card__head">
        <div className="card__title">
          Native BLE<span className="sub">direct GATT · auto-reconnect</span>
        </div>
        <div className="card__tools">
          <button type="button" className="btn" disabled={status === "scanning"} onClick={() => void scan()}>
            {status === "scanning" ? "Scanning…" : "Native scan"}
          </button>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 12px" }}>
        Direct device sync, no Gadgetbridge. The <b>Helio (Zepp-OS)</b> and a <b>Garmin</b> can stay connected
        and stream live HR at the same time. For the Helio, paste its 32-hex auth key, then add it with{" "}
        <b>Zepp-OS</b>. Added devices keep streaming across the app and reconnect automatically.{" "}
        <b>First unpair the Helio in Android → Bluetooth settings</b> so it doesn&apos;t fight the Zepp app.
      </p>

      <label style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 12 }}>
        <span className="stat__label">Helio auth key (32 hex)</span>
        <input
          className="inp"
          value={authKey}
          onChange={(e) => saveKey(e.target.value)}
          placeholder="0123456789abcdef0123456789abcdef"
          spellCheck={false}
          autoCapitalize="none"
        />
      </label>

      {/* Saved devices — each its own live card. */}
      {devices.length > 0 && (
        <div className="grid grid--stats" style={{ marginBottom: addable.length > 0 ? 16 : 0 }}>
          {devices.map((device) => {
            const s = statusOf(device.deviceId);
            const hr = hrOf(device.deviceId);
            const message = messageOf(device.deviceId);
            const showSync = device.type === "huami" && s === "connected";
            return (
              <div key={device.deviceId} className="card stat">
                <div className="stat__ico t-hr">
                  <BleIcon />
                </div>
                <div className="stat__label">
                  {device.name} · {statusLabel(s)}
                </div>
                <div className="stat__val num" style={{ fontSize: 26 }}>
                  {s === "connected" && hr != null ? hr : "—"} <small>bpm</small>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  {showSync && (
                    <button type="button" className="btn" disabled={syncing} onClick={() => void sync()}>
                      {syncing ? "Syncing…" : "Sync now"}
                    </button>
                  )}
                  <button type="button" className="btn btn--ghost" onClick={() => void forget(device.deviceId)}>
                    Forget
                  </button>
                </div>
                {message && (s === "error" || message.startsWith("sync") || message.startsWith("auto")) && (
                  <span className={s === "error" ? "pill pill--bad" : "faint"} style={{ fontSize: 10.5, marginTop: 6 }}>
                    {message}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Scan results — add new devices without dropping the connected ones. */}
      {addable.length > 0 ? (
        <div className="card card--pad0">
          {addable.map((d) => (
            <div key={d.deviceId} className="dev" style={{ padding: "12px 16px" }}>
              <div className="dev__b">
                <b>{d.name}</b>
                <span>{d.rssi} dBm</span>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {isZeppOs(d.name) && (
                  <button
                    type="button"
                    className="btn"
                    disabled={!keyOk}
                    title={keyOk ? "" : "Enter the 32-hex auth key first"}
                    onClick={() => void addAndConnect(d, { type: "huami", authKey: authKey.trim() })}
                  >
                    Add · Zepp-OS
                  </button>
                )}
                {isGarmin(d.name) && (
                  <button type="button" className="btn" onClick={() => void addAndConnect(d, { type: "garmin" })}>
                    Add · Garmin
                  </button>
                )}
                <button type="button" className="btn btn--ghost" onClick={() => void addAndConnect(d)}>
                  Add · Standard HR
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : devices.length === 0 ? (
        <span className="faint" style={{ fontSize: 11 }}>
          {status === "scanning" ? "Scanning…" : "Tap Native scan to list devices."}
        </span>
      ) : null}
    </div>
  );
}

/** Diagnostic step log — shows exactly where a scan/connect got to and which
 *  step failed (with the real Bluetooth error), so failures aren't a mystery. */
function BleLog({ steps }: { steps: string[] }) {
  if (!steps || steps.length === 0) return null;
  return (
    <div className="card" style={{ marginTop: 16, padding: 14 }}>
      <div className="stat__label" style={{ marginBottom: 8 }}>
        Connection log
      </div>
      <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
        {steps.map((s, i) => (
          <li
            key={i}
            className={s.startsWith("ERROR") || s.startsWith("No Heart") || s.includes("dropped") ? "" : "muted"}
            style={{
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: s.startsWith("ERROR") ? "var(--hr, #e5677d)" : undefined,
            }}
          >
            {s}
          </li>
        ))}
      </ol>
    </div>
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

function ConnectedView({
  name,
  live,
  reconnecting,
  note,
}: {
  name: string;
  live: Live;
  reconnecting: boolean;
  note?: string;
}) {
  return (
    <>
      <div className="card" style={{ marginBottom: "var(--gap)", display: "flex", alignItems: "center", gap: 12 }}>
        <span className="dot-live" style={reconnecting ? { background: "var(--warn, #e0a83e)" } : undefined} />
        <b>{name}</b>
        <span className="muted">{reconnecting ? "reconnecting…" : "streaming live → wellness"}</span>
      </div>
      {note && (
        <div className="banner" style={{ marginBottom: "var(--gap)" }}>
          <span className="muted">{note}</span>
        </div>
      )}
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
