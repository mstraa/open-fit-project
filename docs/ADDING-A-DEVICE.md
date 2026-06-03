# Adding a BLE device

How to teach Open Fit to talk to a new wearable / sensor over Bluetooth LE.

Open Fit speaks BLE from the **Android app** (the `OpenFitBle` Capacitor plugin,
`mobile/android/app/src/main/java/org/openfit/app/`). Desktop/web uses standard
Web-Bluetooth (`web/src/ble/BleProvider.tsx`) and is HR/power/cadence-only — this
guide is about the native plugin, which is where proprietary protocols (Zepp/Huami,
Garmin) live.

## Architecture

```
OpenFitBlePlugin            scan / connect / disconnect, offline ingest, foreground service
  └─ DeviceLink             ONE per connected device: owns the GATT connection,
     │                      the serialized op-queue, and the connection lifecycle
     └─ DeviceProtocol      the device-specific brain (you implement this)
            ⇅ LinkContext   the capabilities the link exposes back to the protocol
```

`DeviceLink` is now **protocol-agnostic**: it discovers services, negotiates MTU,
runs a serialized GATT op-queue, and forwards three callbacks to a `DeviceProtocol`.
Everything device-specific — which characteristics to enable, the handshake, parsing
notifications, optional stored-history sync — lives in a `DeviceProtocol`
implementation under `org/openfit/app/protocol/`.

The three shipped protocols are the templates:
- `StandardHrProtocol` — standard GATT Heart Rate (0x180D/0x2A37), no handshake. The simplest example.
- `GarminProtocol` — GFDI multi-link; wraps `garmin/GarminSession`.
- `HuamiProtocol` — Zepp-OS encrypted auth + realtime HR + stored-data sync; wraps `huami/HuamiSession`.

## The `DeviceProtocol` interface

```java
public interface DeviceProtocol {
    void onServicesDiscovered(BluetoothGatt gatt);   // find chars, enable notify, maybe requestMtu
    void onMtuNegotiated(BluetoothGatt gatt, int mtu);// only if you requested an MTU; else unused
    void onCharacteristicChanged(UUID uuid, byte[] value); // route inbound notifications
    void requestSync(Long sinceMillis);              // pull stored history (no-op for live-only)
    void teardown();                                 // stop sessions, cancel scheduled work; idempotent
}
```

**Connection lifecycle** the link drives for you:

1. Connect + service discovery → `onServicesDiscovered(gatt)`. Find your characteristics
   (`BleGatt.findChar(gatt, uuid)` or `gatt.getService(...).getCharacteristic(...)`),
   enable notifications (`ctx.enqueueNotify(c)`), and **either** complete setup here
   (no MTU step, like `StandardHrProtocol`) **or** call `ctx.requestMtu(n)` to bump the
   MTU first.
2. If you requested an MTU → `onMtuNegotiated(gatt, mtu)` (with the negotiated value, or
   23 on fallback). Start your session here. Guard against re-entry (`if (session != null) return;`).
3. Every inbound notification → `onCharacteristicChanged(uuid, value)`. Switch on `uuid`
   and feed your session; emit live samples with `ctx.emitSample("heart_rate", bpm)`.
4. `requestSync(since)` is called by the app's "Sync" button / auto-sync (no-op if your
   device has no stored history).
5. Disconnect → `teardown()`.

## What the protocol can call back into (`LinkContext`)

Never touch the `BluetoothGatt` directly for writes/notifies — go through the op-queue
so operations stay serialized (Android BLE requires one in-flight op at a time).

| `ctx.` method | use |
|---|---|
| `enqueueNotify(char)` / `enqueueWrite(char, bytes)` | serialized GATT notify-enable / write |
| `requestMtu(n)` | request a larger ATT MTU (returns false → start at 23) |
| `emitStatus(status, message)` | connection status to the UI (`"connecting"`/`"connected"`/`"ready"`/`"error"`) |
| `emitSample(kind, value)` | a live sample — POSTed to the server + fed to any active workout recording |
| `sendOrQueue(List<String> jsons)` | batch-POST sample JSONs (offline-buffered); for stored-history sync |
| `scheduleRecompute()` | kick a throttled server-side analytics recompute after a sync |
| `main()` | the main-thread `Handler` (schedule keepalives / periodic sync) |
| `prefs()` | per-device `SharedPreferences` (sync watermarks, throttles) |
| `isCurrentLink()` | guard pending runnables — false once this link was replaced/torn down |
| `btName()` | this phone's Bluetooth name (handshake identity) |
| `formatTs(epochMs)` | RFC3339 string for sample timestamps |
| `deviceId()` | the device address |

## Steps to add a device

### Native (the core — ~2–3 files)

1. **Implement the protocol** — `org/openfit/app/protocol/MyDeviceProtocol.java`.
   For a simple standard-ish sensor, copy `StandardHrProtocol`. For a proprietary
   transport, put the wire/crypto/state in its own session class (a new package like
   `org/openfit/app/mydevice/MyDeviceSession.java`, mirroring `huami/` and `garmin/`)
   and keep `MyDeviceProtocol` a thin adapter that wires the session to the op-queue +
   `ctx.emit*`. **Do not** put protocol state back in `DeviceLink`.

   Minimal sketch:
   ```java
   public final class MyDeviceProtocol implements DeviceProtocol {
       private static final UUID SVC  = UUID.fromString("....");
       private static final UUID RECV = UUID.fromString("....");
       private final LinkContext ctx;
       public MyDeviceProtocol(LinkContext ctx) { this.ctx = ctx; }

       @Override public void onServicesDiscovered(BluetoothGatt g) {
           BluetoothGattService svc = g.getService(SVC);
           if (svc == null) { ctx.emitStatus("error", "service not found"); return; }
           ctx.enqueueNotify(svc.getCharacteristic(RECV));
           ctx.emitStatus("ready", "streaming");
           // or: if you need a bigger MTU, ctx.requestMtu(247) and start in onMtuNegotiated
       }
       @Override public void onMtuNegotiated(BluetoothGatt g, int mtu) { /* start session */ }
       @Override public void onCharacteristicChanged(UUID uuid, byte[] v) {
           if (RECV.equals(uuid)) { /* parse → */ ctx.emitSample("heart_rate", hr); }
       }
       @Override public void requestSync(Long since) { /* live-only: no-op */ }
       @Override public void teardown() { /* stop session, removeCallbacks */ }
   }
   ```

2. **Register it** — one line in `protocol/ProtocolRegistry.create()`:
   ```java
   if ("mydevice".equals(mode)) return new MyDeviceProtocol(ctx);
   ```
   Optionally add a detection hint in `ProtocolRegistry.detectFromServices()` if the
   device advertises a distinctive service UUID (so the add-device UI can pre-select it).

### TypeScript / UI (wire the type through — ~4 small spots)

The native side maps a `deviceType` string to your protocol; the JS side currently
carries that string in a few hard-coded unions (a planned follow-up makes this fully
data-driven). Add `"mydevice"` to:

3. `web/src/ble/protocols.ts` — the `DeviceProtocolType` union + a `PROTOCOL_CAPS` entry
   (`liveHr` / `storedSync` / `requiresAuthKey`).
4. `web/src/ble/native/OpenFitBle.ts` — the `connect({ deviceType })` union.
5. `web/src/ble/native/NativeBleProvider.tsx` — `SavedDevice.type`, the `addAndConnect`
   `opts.type` union, and the `open()` dispatch (the `d.type === ... ?` ternary that
   builds the `connect()` args — add your branch, including `authKey` if your device needs one).
6. `web/src/design/pages/System.tsx` — an "Add as <device>" button in the scan-results
   list (near the existing Zepp/Garmin/standard buttons). Use `dev.suggestedType` to show
   the right button by default.

## Gotchas

- **Serialized GATT**: only `ctx.enqueueWrite/enqueueNotify` — never call `gatt.writeX`
  yourself. The op-queue completes each op on its `onCharacteristicWrite`/`onDescriptorWrite`.
- **Threading**: BLE callbacks arrive on binder threads. Use `ctx.main().post(...)` for
  anything that schedules follow-up work or touches keepalive/sync state.
- **Re-entry**: `onMtuNegotiated` can fire once per connect — guard your session creation.
- **Teardown must be idempotent** and must cancel every `Handler` callback you posted
  (use `ctx.isCurrentLink()` inside delayed runnables so a replaced link no-ops).
- **Stored history**: implement `requestSync` + batch via `ctx.sendOrQueue(...)`, persist a
  watermark in `ctx.prefs()`, and call `ctx.scheduleRecompute()` when you wrote new data.
  See `HuamiProtocol` for the full pattern (auto-sync on connect, 15-min periodic, watchdog).
- **Auth keys**: if the device needs a secret (like Huami), collect it in the `System.tsx`
  add flow and thread it through `addAndConnect(dev, { type, authKey })` → `connect`.

## Standard Heart Rate (0x2A37) — byte layout + shared test vectors

The native parser (`BleGatt.parseHeartRate`) and the web parser (`parseHr` in
`web/src/ble/BleProvider.tsx`) decode the **same** standard HR Measurement layout — keep them
in sync. Byte 0 is flags; **bit 0 = 0** → HR is a `uint8` at byte 1; **bit 0 = 1** → HR is a
little-endian `uint16` at bytes 1–2.

| bytes (hex) | meaning | HR |
|---|---|---|
| `00 48` | flags=0, uint8 | 72 |
| `00 C8` | flags=0, uint8 (unsigned) | 200 |
| `01 2C 01` | flags bit0=1, uint16 LE `0x012C` | 300 |
| `00` / `01 2C` | malformed / too short | (ignored) |

These vectors are enforced natively by `BleGattTest`
(`mobile/android/app/src/test/java/org/openfit/app/protocol/BleGattTest.java`, run via
`./gradlew :app:testDebugUnitTest`). Mirror them on the web side once a JS test runner exists
(the web project has none today).

## Testing

There is **no BLE in CI** — everything is verified on-device.

```bash
cd mobile/android && ./gradlew :app:assembleDebug
# sideload mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Checklist: scan finds the device → connect → `ready` → live samples appear (and record into
a workout) → stored-sync runs if supported → disconnect is clean (no stale sync/keepalive
firing afterward) → it coexists with other connected devices (each `DeviceLink` is independent).

See also: `docs/NATIVE-BLE-PORT.md`, `docs/GARMIN-GFDI-DESIGN.md`, and `DEVICE_REFACTOR_PLAN.md`.
