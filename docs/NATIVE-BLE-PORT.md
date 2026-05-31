# Native BLE port — direct Helio + Garmin (no Gadgetbridge app, no DB export)

Feasibility + port plan for talking to the **Amazfit Helio Strap** (daily driver) and
**Garmin Forerunner 945** (running) directly from the Open Fit app, by porting
Gadgetbridge's protocol code into a native Capacitor plugin. Produced by a 4-agent
research workflow that read the actual Gadgetbridge source (2026-05).

## Verdict
**Feasible.** The Helio is a *cleaner* port than expected: the strap adds **zero**
device-specific protocol — `AmazfitHelioStrapCoordinator` is a ~70-line cosmetic subclass,
so 100% of the BLE/auth/sync logic is shared Zepp-OS code. Garmin is moderate but lower
per-byte risk (no crypto — plain OS bond) and its activity files are **real `.fit`**, which
our `ofit-ingest` already parses.

Honest framing: this is a **multi-week project** (≈5–8 weeks to a Helio daily-driver MVP,
+1–2 weeks for Garmin running). BLE has **no CI** — development is tight loops of native
code → install APK → read on-device logs. The single hardest piece is the Helio encrypted
handshake (must be byte-exact, validated against a real capture).

## ⚠️ Resolve first (30 min): which protocol family is the Helio?
The two source-reading agents disagreed:
- **Most authoritative** (read the coordinator file): Helio is **Huami / Zepp-OS** —
  `devices/huami/zeppos/straps/AmazfitHelioStrapCoordinator` → `ZeppOsCoordinator`. Auth =
  **ECDH-B163 + AES** (`ZeppOsAuthenticationService`), service **FEE0/FEE1**, chunked chars
  **0x0016/0x0017** (`Huami2021ChunkedEncoder/Decoder`).
- **The other agent** claimed **Xiaomi** stack — service `fe95`, **HMAC-SHA256 `miwear-auth`
  + AES-CCM** (`XiaomiAuthService`).

These are different families with different auth/transport. **Before writing M1, open
`AmazfitHelioStrapCoordinator.getDeviceSupportClass()` and confirm whether it returns a
ZeppOs/Huami support class or a Xiaomi one.** The auth key the user extracted works for
whichever it is; this only changes which classes we vendor. (Pin a specific Gadgetbridge
commit — the repo is **archived/read-only as of Feb 2026**, so we own maintenance.)

## Architecture (shared)
A native **Kotlin Capacitor plugin** (`org.openfit.app`, registered in `MainActivity`) that:
- owns a raw **`BluetoothGatt`** + a **serialized GATT op queue** (Android allows one op
  in-flight; we re-implement Gadgetbridge's `BtLEQueue` pattern — do NOT vendor it),
- ports only the **device byte-protocol** (auth + message builders/parsers) from
  Gadgetbridge — **not** `AbstractDeviceSupport`/`GBDevice`/the greenDAO DB/event bus
  (~1500-line spine, tightly coupled — verified),
- streams parsed samples to JS via `notifyListeners`, which relays to our **existing API**.

Packaging decision: **option (c)** — re-implement the transaction queue, vendor only
self-contained helpers + protocol classes. (Option (b) AAR doesn't exist; option (a)
full-vendor drags in the DB/app framework.) License: Gadgetbridge is **AGPLv3** (compatible
with our AGPLv3 server / GPL mobile); keep upstream headers + a `NOTICE` mapping each ported
file to its upstream path@commit.

## Integration with our stack (no/low backend change)
- **Live + daily wellness → `POST /api/wellness`** unchanged. `WellnessIngest {kind, value,
  ts?, source_id?}` is exactly our shape; it persists in 5k chunks + broadcasts to
  `/api/wellness/live`.
- **Garmin `.fit` → `POST /api/import`** unchanged (reuses `ofit-ingest`).
- **Idempotent per-device sync**: attribute to the **same Source** as the existing GB-DB
  import (`ensure_source(Gadgetbridge, "<device name>")`), and `delete_wellness_for_source`
  before a full re-sync (already how the DB importer works) → the live path and the DB
  import **converge** instead of duplicating.
- **Auth key storage**: secure storage in the plugin; config UX extends the existing
  Settings → **Imports & sync** panel.
- The current Gadgetbridge **DB auto-import stays as the fallback** and dedup baseline.

## Helio data → WellnessKind (Huami fetch ops)
| Gadgetbridge fetch op (type code) | → Open Fit |
|---|---|
| `ACTIVITY` (0x01) per-minute | `Steps`, `HeartRate`, `SleepStage` |
| `RESTING_HEART_RATE` (0x3a) | `RestingHeartRate` |
| `SPO2_NORMAL` (0x25) | `SpO2` |
| `HRV` (0x49) | `Hrv` |
| `STRESS_AUTOMATIC` (0x13) | `Stress` |
| `SLEEP_RESPIRATORY_RATE` (0x38) | `Respiration` |
| realtime HR (endpoint 0x001d) | live `HeartRate` |

**Not available from the Helio:** `BodyBattery` (no Huami fetch op exists), `Weight` (it's a
strap), `Calories` (derive if needed). **Workouts** are proprietary binary (→ GPX-ish, *not*
FIT) — they bypass `/api/import` and need a separate ingest path; **deferred**.

## Garmin 945 flow (MVP = pull activity FIT on connect)
ML service `6A4E2800-…`; register the GFDI logical channel (client id 2) → reach
`SYNC_READY` → `DOWNLOAD_REQUEST(0)` = directory → filter `ACTIVITY` files →
`DOWNLOAD_REQUEST(fileIndex)` → reassemble `FILE_TRANSFER_DATA` chunks (per-chunk CRC) →
raw `.fit` bytes → `POST /api/import`. **No crypto** (all-zero AuthFlags + OS bond). Realtime
(HR/steps proven; SpO2/HRV/etc. are stubs in GB) is a later bonus.

Classes to port (Garmin): `communicator/v2/CommunicatorV2`, `communicator/CobsCoDec`,
`messages/GFDIMessage` + `DownloadRequestMessage` + `FileTransferDataMessage` + `status/*`,
`FileTransferHandler`, `ChecksumCalculator`, `GarminByteBufferReader`.

## Roadmap (Helio-first)
- **M0 — DONE ✅** native Java plugin (`org.openfit.app.OpenFitBlePlugin`): scan/connect, a
  serialized GATT op queue, CCCD notify, standard `0x180D/0x2A37` HR → `/api/wellness`.
- **M1 — DONE ✅ (Helio live HR, direct, no Gadgetbridge).** Ported `ECDH_B163` +
  `Huami2021ChunkedEncoder/Decoder` + the ECDH-B163/AES auth handshake (`HuamiSession`) into
  `org.openfit.app.huami`. Confirmed Zepp-OS (`AmazfitHelioStrapCoordinator extends
  ZeppOsCoordinator`). Verified on-device: handshake completes → realtime HR streams over the
  encrypted link → `/api/wellness`.
  - **Gotchas found the hard way (all fixed):** (1) Android 13+ needs the *new*
    `writeDescriptor(d,value)`/`writeCharacteristic(c,value,type)` — the deprecated `setValue`
    forms silently no-op. (2) The chunked write char is **WRITE_NO_RESPONSE** (props `0x14`);
    pick write type from properties. (3) **Auth + HR endpoints are transport-PLAINTEXT**
    (`super(support,false)`) — only the auth random is app-level AES; sending them
    transport-encrypted makes the device drop you. (4) **The Helio allows ONE connection** —
    you must **unpair it from Android Bluetooth settings** (and the Amazfit Watch Manager
    auto-connects to bonded devices), or it starves our handshake.
- **M2 — Helio daily wellness backfill (~2–3 wks).** Port `HuamiFetcher` + fetch ops; on
  connect, incrementally sync HR/Steps/Sleep/RestingHR/SpO2/HRV/Stress/Respiration since a
  per-type watermark → batched `/api/wellness`. **Demotes DB auto-import to fallback.**
- **M3 — Garmin FIT download (~1–2 wks).** Vendor the GFDI/file-transfer path; download new
  `.fit` → `POST /api/import`. Content-hash dedup makes re-syncs free.
- **M4 — Helio workouts (optional, ~2 wks).** Port the Huami activity-details parser; needs a
  new streams ingest path. Only if recording workouts on the strap.

**Total to daily-driver MVP (M0–M2): ~5–8 weeks; +M3 for running.** M1 dominates risk.

## Key risks
- **Byte-exact crypto/transport** (M1): per-message AES keyed by `sessionKey XOR writeHandle`,
  running sequence number seeded from the ECDH shared secret, CRC32, MTU fragmentation +
  reassembly/ACK. Off-by-one fails silently → port line-for-line + capture-validate.
- **Custom curve** (`ECDH_B163`) — port verbatim, do not substitute a stdlib curve.
- **Android BLE realities** — serialized writes, interleaved notifications, MTU, Doze drops,
  API 31+ runtime `BLUETOOTH_SCAN/CONNECT`, foreground service for background sync.
- **Maintenance** — we fork a moving (now archived) target; ported parsers need periodic
  manual re-sync. Pin the commit; keep ported files in a delimited subdir with a NOTICE.
- **No BLE in CI** — every step validated on the user's real device.
