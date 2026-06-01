# Garmin (GFDI) — Design & Build

Native Garmin Forerunner 945 support for Open Fit, running **simultaneously** alongside the
existing Helio (Huami / Zepp-OS) connection. The 945 is moved **off Garmin Connect** entirely:
the app pairs/bonds with it, holds the exclusive BLE link, and is the sole sync target for both
**activities** (`.fit`, merged with phone recordings via `cluster_recordings`) and **all
wellness** (Garmin daily monitoring FITs → steps/HR/stress/sleep/body-battery/respiration/SpO2/HRV
→ `/api/wellness`), plus **live HR and realtime metrics over GFDI**.

This document is implementation-ready: it preserves the reverse-engineered UUIDs, byte layouts,
message IDs, CRC algorithm, message flows, field/scale tables, and `file:line` references that the
implementation must mirror exactly.

---

## 1. Overview & Architecture

### 1.1 Goals (locked product decisions)

- **Exclusive ownership.** The FR945 bonds with Open Fit and stops talking to Garmin Connect. We
  drive the entire connect/auth/sync handshake ourselves (there is no Garmin cloud in the loop).
- **Two payloads synced.**
  - **Activities**: `.fit` activity files downloaded over GFDI → uploaded to `POST /api/import` →
    parsed by `ofit-ingest` → `RawRecording` → `cluster_recordings` merges them with phone
    recordings (and Helio activities) by sport + time-overlap.
  - **Wellness**: Garmin daily *monitoring* FIT files downloaded over GFDI → parsed into
    `WellnessSample`/`WellnessKind` (steps, HR, resting HR, stress, body battery, sleep,
    respiration, SpO2, HRV) → `POST /api/wellness` under a dedicated Garmin source.
- **Live data.** Live HR + realtime step metrics streamed over the proprietary GFDI/Multi-Link
  (ML) transport while connected.
- **Simultaneous connections.** The app holds **Helio AND Garmin connected at the same time**.
  This requires refactoring `OpenFitBlePlugin.java` from one-connection globals to a
  per-device `DeviceConnection` keyed by MAC.
- **Sequential Sync.** "Sync now" syncs **Helio first, then Garmin**, sequentially, skipping
  whichever is not present (avoids BLE/device contention on Android).

### 1.2 High-level architecture

```
 ┌────────────────────────── Android (mobile/android) ──────────────────────────┐
 │  OpenFitBlePlugin                                                              │
 │    Map<String,DeviceConnection> connections    (keyed by MAC)                 │
 │    ┌── DeviceConnection(Helio)  mode="huami" ──┐  ┌── DeviceConnection(Garmin)│
 │    │   BluetoothGatt + opQueue                  │  │  BluetoothGatt + opQueue   │
 │    │   HuamiSession (ECDH/auth/HR)              │  │  GarminSession             │
 │    │                                            │  │   ├ CommunicatorV2 (ML/COBS)
 │    │                                            │  │   ├ Gfdi framing + CRC     │
 │    │                                            │  │   ├ FileTransferHandler    │
 │    │                                            │  │   └ Realtime ML services   │
 │    └────────────────────────────────────────────┘  └────────────────────────── │
 │      live HR/steps → emitSample(...,conn) → nativeIngest(source_id)            │
 │      downloaded .fit → POST /api/import   |  monitoring .fit → parse → /wellness│
 └───────────────────────────────────────────────────────────────────────────────┘
                                   │ HTTP
 ┌──────────────────────────────── server (crates) ─────────────────────────────┐
 │  POST /api/import  → ofit-ingest fit.rs → RawRecording → cluster_recordings    │
 │  POST /api/wellness → ensure_source(Gadgetbridge,"Live stream (Garmin)") → DB  │
 └───────────────────────────────────────────────────────────────────────────────┘
 ┌──────────────────────────────── web (React) ─────────────────────────────────┐
 │  NativeBleProvider: Map<deviceId, {device,hr,syncing,message}>                 │
 │  sync(): for dev in [Helio, Garmin] if connected → OpenFitBle.syncNow({deviceId})│
 └───────────────────────────────────────────────────────────────────────────────┘
```

### 1.3 Per-device connection objects

Today `OpenFitBlePlugin.java` holds a **single** connection: `gatt`, `connectedId`, `mode`,
`authKey`, `huami`, `opQueue`, `fetchBatch`, `maxFetchedTs` (lines 82–118), with one
`BluetoothGattCallback` (769–836). We introduce a `DeviceConnection` class (one per physical
device) that owns all per-connection state, and replace the globals with
`Map<String,DeviceConnection> connections`. Each `DeviceConnection` runs **its own GATT state
machine and its own serialized op queue** — Android allows only one in-flight GATT op *per* `gatt`
object, so two devices means two independent queues running in parallel. Helio connections carry a
`HuamiSession`; Garmin connections carry a `GarminSession` (the new GFDI stack). See §7.

### 1.4 How Sync orchestrates Helio → Garmin

`sync()` in the web `NativeBleProvider` iterates the saved devices **in deterministic order
(Helio first, then Garmin)** and calls `OpenFitBle.syncNow({ deviceId, sinceMillis? })`
**sequentially** (awaiting each), skipping any device that is not currently connected. The Android
plugin routes `syncNow(deviceId)` to the matching `DeviceConnection`. Only after the last device
finishes do we emit `ofit:data-updated` to refresh the UI. Sequential ordering avoids the
SharedPreferences watermark race and BLE contention described in §9.

---

## 2. BLE Transport + Pairing / Auth

The FR945 is a **"V2" / multi-link (ML)** Garmin device. It does **not** use the single-link V1
GFDI characteristic. Picking the wrong UUID family is the single most common mistake.

### 2.1 GATT service + characteristic UUIDs

Base UUID template (`CommunicatorV2.java:50`):

```
BASE_UUID = "6A4E%04X-667B-11E3-949A-0800200C9A66"
```

GFDI multi-link service (`CommunicatorV2.java:51`):

```
UUID_SERVICE_GARMIN_ML_GFDI = 6A4E2800-667B-11E3-949A-0800200C9A66
```

Inside that service, characteristics come in **receive (NOTIFY, watch→phone) / send (WRITE,
phone→watch)** pairs where **send = receive + 0x10** (`CommunicatorV2.initializeDevice`,
`CommunicatorV2.java:84-105`):

```
Receive/NOTIFY candidates: 6A4E2810, 6A4E2811, 6A4E2812, 6A4E2813, 6A4E2814 (-667B-11E3-949A-0800200C9A66)
Send/WRITE    candidates:  6A4E2820, 6A4E2821, 6A4E2822, 6A4E2823, 6A4E2824 (-667B-11E3-949A-0800200C9A66)
```

Iterate `i = 0x2810..0x2814`; the **first** `i` for which **both** `char(i)` (receive) and
`char(i+0x10)` (send) exist is used. On a FR945 this is almost always **6A4E2810 (NOTIFY) /
6A4E2820 (WRITE)**. (There is an undocumented `6A4E2803` in the service; not used.)

Write type: standard GATT write-with-response to the send characteristic, queued through the
op queue. Enable notifications (CCCD `0x2902` = `0x0001`) on the receive characteristic.

**Do NOT** use the legacy V1/V0 services (FR945 never uses them): V1 service `6A4E2401-...`
(send `6A4E4C80`, recv `6A4ECD28`), V0 service `9B012401-BC30-CE9A-E111-0F67E491ABDE`
(`CommunicatorV1.java:23-30`).

### 2.2 Bonding / pairing requirement

The device **must be Android-BONDED**. Garmin uses the framework default bonding style
(`BONDING_STYLE_ASK`, `AbstractDeviceCoordinator.java:612-613`; `GarminCoordinator.java:107-111`
adds only `suggestUnbindBeforePair()=false`). There is **no in-protocol passkey** — the
passkey/numeric-comparison is the standard Android BLE pairing UI handled by the OS.

Implementation for our plugin:

1. Put the watch into "Pair smartphone" mode.
2. Before opening notifications/writes, ensure `device.createBond()` succeeds (or the device is
   already `BOND_BONDED`); wait for `ACTION_BOND_STATE_CHANGED → BOND_BONDED`.
3. On some Android stacks bonding is lazy: if the **first** encrypted characteristic write returns
   a GATT auth error (status **133/137**), call `createBond()` then retry.
4. Only after bonding completes proceed to the ML handshake (§2.4).

FR945 uses BLE Secure Connections / Just Works pairing, triggered on the first
encryption-requiring characteristic access.

### 2.3 Connection sequence (post-connect, before any GFDI)

Mirrors `GarminSupport.initializeDevice` (`GarminSupport.java:260-285`):

1. `setDeviceState(INITIALIZING)`.
2. `requestMtu(515)` early (pref `PREF_ALLOW_HIGH_MTU` default true). On `onMtuChanged`,
   `maxWriteSize = mtu - 3` (3 ATT header bytes; ignore `mtu < 23`). Default `maxWriteSize`
   before negotiation = **20** (`CommunicatorV2.java:64,76-82`). If you write before MTU
   negotiation it works but fragments to 19-byte chunks (slow).
3. Locate the receive/send pair (§2.1), then:
   - `builder.notify(characteristicReceive, true)` — enable CCCD.
   - `builder.write(characteristicSend, closeAllServices())` — first ML command (§2.4).
4. The **watch drives the rest**: it sends ML handle-management responses, then GFDI
   `DeviceInformation`, `AuthNegotiation`, Capabilities/protobuf. The phone replies/ACKs.

### 2.4 Multi-link (ML) handle-management handshake ("register GFDI")

All ML control traffic is on **handle byte `0x00`**. The 13-byte control frame (little-endian)
(`CommunicatorV2.closeAllServices/registerService/closeService`, lines 497-524):

```
byte[0]    = 0x00                       // ML handle (0 = handle management)
byte[1]    = RequestType ordinal        // see enum below
byte[2..9] = clientId (int64 LE) = 2    // GADGETBRIDGE_CLIENT_ID = 2L
byte[10,11]= service code (int16 LE)    // see Service enum
byte[12]   = extra (reliable flag, or handle)
```

`RequestType` ordinals (wire value = ordinal, `CommunicatorV2.java:556-565`):

```
0 REGISTER_ML_REQ   1 REGISTER_ML_RESP   2 CLOSE_HANDLE_REQ   3 CLOSE_HANDLE_RESP
4 UNK_HANDLE        5 CLOSE_ALL_REQ      6 CLOSE_ALL_RESP     7 UNK_REQ   8 UNK_RESP
```

`Service` codes (int16, `CommunicatorV2.java:579-598`):

```
GFDI=1, REGISTRATION=4, REALTIME_HR=6, REALTIME_STEPS=7, REALTIME_CALORIES=8,
REALTIME_INTENSITY=10, REALTIME_HRV=12, REALTIME_STRESS=13, REALTIME_ACCELEROMETER=16,
REALTIME_SPO2=19, REALTIME_BODY_BATTERY=20, REALTIME_RESPIRATION=21,
FILE_TRANSFER_2=0x2018, _4=0x4018, _6=0x6018, _A=0xa018, _C=0xc018, _E=0xe018.
```

Handshake exchange:

1. **Phone → watch: CLOSE_ALL_REQ** (`closeAllServices()`):
   `00 05 02 00 00 00 00 00 00 00 00 00 00`
2. **Watch → phone: CLOSE_ALL_RESP** (type 6). On receipt the phone clears handle maps and sends
   **REGISTER_ML_REQ for GFDI**:
   `00 00 02 00 00 00 00 00 00 00 01 00 RR`
   where `RR = reliable` (use **0** for first bring-up — plain ML; MLR is optional, §2.5).
3. **Watch → phone: REGISTER_ML_RESP** (handle `0x00`, type 1; parsed at lines 294-358):
   `byte type=1; int64 clientId(==2); int16 serviceCode; byte status(0=ok); byte handle; byte reliable`.
   Record `serviceByHandle[handle]=GFDI` and `handleByService[GFDI]=handle`. This small int handle
   (e.g. `0x01`) prefixes every subsequent GFDI write.

Incoming routing (`CommunicatorV2.onCharacteristicChanged`, lines 154-205):

- `value[0]` is the handle byte. If `(value[0] & 0x80) != 0` it *may* be an MLR packet
  (handle = `((value[0] & 0x70) >> 4) | 0x80`); forward to that MLR communicator **if registered**,
  else **fall through** to normal handling (per GB bug #5476).
- If handle `== 0x00` → `processHandleManagement` (ML control above).
- Else look up `serviceByHandle[handle]`, strip the handle byte, hand `value[1..]` to that
  service's callback. For **GFDI**, the callback feeds bytes into a per-link `CobsCoDec` and, on a
  full decoded COBS frame, calls `onMessage(message)`.

### 2.5 BLE-layer framing: COBS + handle prefix + MTU fragmentation

**Outbound GFDI send** (`CommunicatorV2.sendMessage`, lines 123-152):

1. Build GFDI message bytes (§3).
2. `payload = CobsCoDec.encode(gfdiMessageBytes)`.
3. Prepend the 1-byte GFDI handle.
4. Fragment so each BLE write `<= maxWriteSize`: `chunkDataMax = maxWriteSize - 1` (1 byte reserved
   for the handle on **every** chunk). The handle byte is repeated on **every fragment**.

**Inbound reassembly** (`GfdiCallback`, lines 406-419): append each notification's payload (after
stripping the handle) via `CobsCoDec.receivedBytes()`; `retrieveMessage()` returns a full frame
when a trailing `0x00` terminator completes a packet. There is **no length-based reassembly** at
the BLE layer — COBS framing delimits messages. A **1500ms** inter-byte gap resets the buffer
(`CobsCoDec.BUFFER_TIMEOUT`); keep notification processing prompt and never block the BLE callback
thread.

**Garmin COBS variant** (non-standard; standard COBS libs will NOT interoperate):

```
encode(data):
  out.put(0x00)                       // LEADING pad (Garmin-specific)
  for each run of non-zero bytes up to a 0x00 (or end):
     while runLen >= 0xFE: out.put(0xFF); out.put(254 bytes); runLen -= 0xFE
     out.put(runLen+1); out.put(runLen bytes)
  if last data byte was 0x00: out.put(0x01)
  out.put(0x00)                       // TRAILING terminator

decode():  needs >=4 bytes; requires byte[pos-1]==0x00 (terminator) and byte[0]==0x00 (leading).
           Then standard COBS: read code; payloadSize=code-1; copy payloadSize bytes;
           if code!=0xFF and bytes remain, emit a 0x00; stop at code==0x00.
```

**Optional MLR (Multi-Link Reliable)** — only if you register GFDI with `reliable=2`. 2-byte header
(`MlrCommunicator.java`):

```
packet[0] = 0x80 | ((handle&0x07)<<4) | ((reqNum>>2)&0x0F)
packet[1] = ((reqNum&0x03)<<6) | (seqNum&0x3F)
packet[2..] = data fragment        (fragment size = maxWriteSize-2)
```

`reqNum` = cumulative ACK; `seqNum` 0..0x3F wraps mod 64; window `INITIAL_MAX_UNACKED_SEND=0x20`;
`ACK_TIMEOUT=250ms`, `ACK_TRIGGER_THRESHOLD=5`, retransmit `1000ms`→`20000ms` doubling.
**For FR945 bring-up: use plain ML (`reliable=0`) and skip MLR entirely** — connect/auth/sync works
fine without it.

### 2.6 Minimal connect+auth flow (plugin pseudocode)

```
connectAndAuthenticate(device):
  ensureBonded(device)                       // createBond / wait BOND_BONDED (§2.2)
  gatt = connectGatt(device)
  discoverServices()
  requestMtu(515); maxWriteSize = negotiatedMtu - 3   // fallback 20
  svc = gatt.getService(6A4E2800-667B-11E3-949A-0800200C9A66)
  for i in 0x2810..0x2814:
     recv = svc.getCharacteristic(6A4E{i}); send = svc.getCharacteristic(6A4E{i+0x10})
     if recv && send: break
  enableNotifications(recv)                  // CCCD 0x2902 = 0x0001
  write(send, closeAllServices())            // 13 bytes, CLOSE_ALL_REQ
  onNotify(value):
     h = value[0]
     if (h & 0x80) and mlr_registered: mlr.onPacket(value); return
     if h == 0x00: handleMgmt(value[1..])    // CLOSE_ALL_RESP -> REGISTER_ML_REQ(GFDI,0)
                                             // REGISTER_ML_RESP -> store gfdiHandle, ready
     else if h == gfdiHandle:
        cobs.feed(value[1..]); msg = cobs.retrieve()
        if msg: handleGfdi(parseGfdi(msg))
  handleGfdi(m):
     if m.type==DEVICE_INFORMATION: sendAck(m); sendDeviceInfoResponse()   // §3.5(A)
     if m.type==AUTH_NEGOTIATION:   sendAck(m); sendAuthNegotiationZeroFlags()  // §3.5(B)
     if m indicates capabilities ready: completeInitialization()
     else: sendAck(m)                        // ACK everything by default
```

The phone is mostly **reactive**; the watch initiates `DeviceInformation` and `AuthNegotiation`.
For each inbound GFDI message you must send, **in order**: a status ACK, then the reply (if any),
then any followup. Forgetting the ACK stalls the handshake.

### 2.7 Key classes to mirror (file:line)

- `communicator.v2.CommunicatorV2` (`CommunicatorV2.java:47-685`): UUIDs (50-51), init (84-105),
  `sendMessage` COBS+fragment (123-152), routing (154-205), handle management (272-404), control
  frame builders (497-524), `RequestType` (556-565), `Service` (579-598).
- `communicator.CobsCoDec` (whole file).
- `communicator.v2.MlrCommunicator` (optional, 16-315).
- `GarminSupport` (260-285 init, 306-368 onMessage/ACK/reply/followup, 662-680 send/ack,
  789-816 completeInitialization).
- `messages.GFDIMessage` (21-213), `ChecksumCalculator` (21-50),
  `messages.DeviceInformationMessage` (15-125), `messages.AuthNegotiationMessage` (9-61),
  `messages.MessageWriter` (8-88), `messages.SystemEventMessage` (30-48).
- `GarminCoordinator` (107-111), `AbstractDeviceCoordinator` (612-613).

---

## 3. GFDI Framing + Message Catalog

All GFDI integers are **little-endian** — length, type, CRC, and payload fields alike.

### 3.1 Packet (frame) layout

```
[0,1]      uint16 length        = total length INCLUDING this field and the 2-byte CRC
[2,3]      uint16 messageType
[4..N-3]   payload
[N-2,N-1]  uint16 CRC-16        over bytes [0 .. N-2) (everything except the CRC itself)
```

Construction (`GFDIMessage.generateOutgoing` + `addLengthAndChecksum`, ~line 87-92):

```
writeShort(0)                                 // length placeholder at offset 0
writeShort(garminMessage.getId())             // message id
<payload...>
response.putShort(0, (short)(position() + 2)) // length = bytes so far + 2 CRC bytes
response.putShort(computeCrc(response, 0, position()))   // CRC appended LE
```

Incoming parse (`MessageReader`, ~line 175): `payloadSize = readShort()` must equal the buffer
capacity; CRC at offset `payloadSize-2` must equal `computeCrc(buffer, 0, payloadSize-2)`; then
`limit(payloadSize-2)` strips the CRC.

**Message-type decode** (`parseIncoming`, ~line 27): read uint16; if `(type & 0x8000) != 0` it is a
**status/response channel**: real id = `(type & 0xFF) + 5000`, and bits 8..14 are a sequence
number. Otherwise `type` is the raw id. **Handle this mask or you will mis-parse ACKs** — registry
ids are ≥5000, so the high-bit branch is the only way a raw `0x80xx` value resolves.

Primitive encodings (`GarminByteBufferReader` / `MessageWriter`):
`readByte` u8, `readShort` u16 LE, `readInt` u32 LE, `readLong` u64 LE, `readBytes(n)` raw;
`readString()` = **1-byte u8 length prefix + that many UTF-8 bytes, NOT null-terminated**, max 255;
`readNullTerminatedString()` exists separately — check which a given message uses.

### 3.2 CRC algorithm (exact)

**NOT** a standard CRC-16. It is Garmin's nibble-table CRC-16 (the FIT/ANT CRC-16: reflected poly
`0x8408`, init 0, no final xor), processed nibble-at-a-time. **Reuse this one implementation** for
(a) the GFDI frame CRC, (b) the rolling per-chunk file-transfer CRC, and (c) the FIT file's
internal header/trailer CRC.

```
CONSTANTS = {0x0000,0xCC01,0xD801,0x1400,0xF001,0x3C00,0x2800,0xE401,
             0xA001,0x6C00,0x7800,0xB401,0x5000,0x9C01,0x8801,0x4400}

computeCrc(crc /*init 0 or seed*/, data, offset, length):
  for each byte b in data[offset .. offset+length):
    crc = (((crc >> 4) & 0x0FFF) ^ CONSTANTS[crc & 0x0F]) ^ CONSTANTS[b & 0x0F]        // low nibble
    crc = (((crc >> 4) & 0x0FFF) ^ CONSTANTS[crc & 0x0F]) ^ CONSTANTS[(b >> 4) & 0x0F] // high nibble
  return crc & 0xFFFF
```

The result u16 is appended **little-endian** as the last 2 bytes; the length field counts those
bytes; the CRC covers the length field and type bytes too. The `& 0x0FFF` (12-bit) mask before xor
is canonical. When porting, compute over a stable `byte[]` slice, not a live position-dependent
buffer.

### 3.3 Message-ID registry (`GFDIMessage.GarminMessage`)

```
5000 RESPONSE/STATUS               -> GFDIStatusMessage (generic ACK/status)
5002 DOWNLOAD_REQUEST              5003 UPLOAD_REQUEST           5004 FILE_TRANSFER_DATA
5005 CREATE_FILE                   5007 FILTER                   5008 SET_FILE_FLAG
5011 FIT_DEFINITION                5012 FIT_DATA                 5014 WEATHER_REQUEST
5024 DEVICE_INFORMATION            5026 DEVICE_SETTINGS          5030 SYSTEM_EVENT
5031 SUPPORTED_FILE_TYPES_REQUEST  5033 NOTIFICATION_UPDATE      5034 NOTIFICATION_CONTROL
5035 NOTIFICATION_DATA             5036 NOTIFICATION_SUBSCRIPTION 5037 SYNCHRONIZATION
5039 FIND_MY_PHONE_REQUEST         5040 FIND_MY_PHONE_CANCEL     5041 MUSIC_CONTROL
5042 MUSIC_CONTROL_CAPABILITIES    5043 PROTOBUF_REQUEST         5044 PROTOBUF_RESPONSE
5049 MUSIC_CONTROL_ENTITY_UPDATE   5050 CONFIGURATION            5052 CURRENT_TIME_REQUEST
5101 AUTH_NEGOTIATION
```

`Status` enum (ordinal = wire value): `ACK=0, NAK=1, UNSUPPORTED=2, DECODE_ERROR=3, CRC_ERROR=4,
LENGTH_ERROR=5`.

**Generic ACK frame** (id 5000): payload = `[u16 original_message_id][u8 status]`. Incoming
`GFDIStatusMessage.parseIncoming` dispatches by original type to type-specific status parsers,
defaulting to a generic `[u8 status]`. After parsing any inbound message, its `getAckBytestream()`
(usually `GenericStatusMessage(ACK)`) is sent back. This is the ACK mechanism.

**Binary vs protobuf rule:** **only ids 5043/5044 carry protobuf**; every other id is hand-rolled
binary. Do not assume protobuf for `DEVICE_SETTINGS(5026)` or `CONFIGURATION(5050)`.

The **ML service codes** (`GFDI=1`, `FILE_TRANSFER_2=0x2018`, …) are a **different namespace** from
GFDI message ids (5000+). Do not conflate them.

### 3.4 Protobuf envelope (ids 5043 / 5044)

After the standard header, the payload is:

```
u16  requestId
u32  dataOffset           (byte offset of this chunk within the full protobuf message)
u32  totalProtobufLength  (length of the complete protobuf message)
u32  protobufDataLength   (length of THIS chunk)
byte[protobufDataLength]  messageBytes
```

`isChunked() = (totalProtobufLength != protobufDataLength)`;
`isComplete() = (dataOffset==0 && !isChunked())`. Reassembled bytes are a `GdiSmartProto.Smart`
envelope. Outbound chunks are re-chunked at `maxChunkSize = 375`. Protobuf status/ack
(`ProtobufStatusMessage`): `[u16 5000][u16 5043/5044][u8 status][u16 requestId][u32 dataOffset]
[u8 chunkStatus][u8 statusCode]` (`ProtobufChunkStatus`: 0 KEPT, 1 DISCARDED). For an incomplete
inbound protobuf reply `KEPT, NO_ERROR` (request next chunk); for a complete one reply
`GenericStatusMessage(ACK)`.

For FR945 bring-up the only protobuf we must *handle* is the **Capabilities** message that triggers
`completeInitialization()`; battery-level requests are also protobuf and can be added later.

### 3.5 Handshake messages the watch sends (and our replies)

**(A) DeviceInformation (5024)** — watch→phone. Incoming payload (LE):
`u16 protocolVersion, u16 productNumber, u32 unitNumber, u16 softwareVersion, u16 maxPacketSize,
string bluetoothFriendlyName, string deviceName, string deviceModel`. `maxPacketSize` caps
subsequent GFDI packet sizes. Reply is a RESPONSE(5000):

```
writeShort(0)               // length placeholder
writeShort(5000)            // RESPONSE
writeShort(5024)            // DEVICE_INFORMATION being answered
writeByte(0)                // Status.ACK
writeShort(150)             // ourProtocolVersion = 150
writeShort(-1)              // ourProductNumber  = 0xFFFF
writeInt(-1)                // ourUnitNumber     = 0xFFFFFFFF
writeShort(7791)            // ourSoftwareVersion = 7791
writeShort(-1)              // ourMaxPacketSize  = 0xFFFF (watch may cap)
writeString(<android BT adapter name>)
writeString(Build.MANUFACTURER)
writeString(Build.DEVICE)
writeByte(protocolFlags)    // = 1 if incomingProtocolVersion/100 == 1 else 0
```

**(B) AuthNegotiation (5101)** — watch→phone. Incoming: `byte unknown; uint32 authFlags`.
**There is no crypto.** Reply: ACK (`AuthNegotiationStatusMessage`, status ACK / sub-status
GUESS_OK) and a 5101 body of `writeByte(0); writeInt(0)` — **all auth flags zeroed** ("we accept,
no auth"). Succeeds as long as the BLE bond exists.

**(C) Capabilities / protobuf** (`PROTOBUF_REQUEST 5043` / `CONFIGURATION 5050`) — watch→phone.
On the resulting `CapabilitiesDeviceEvent` the phone calls `completeInitialization()`.

**`completeInitialization()`** (`GarminSupport.java:789-816`), phone→watch, after capabilities:

```
SupportedFileTypesMessage (5031)            // request supported file types
sendDeviceSettings() -> SetDeviceSettings (5026)
if syncTime: SystemEvent TIME_UPDATED
SystemEvent SYNC_READY
enableBatteryLevelUpdate()  (protobuf request)
setUpdateState(INITIALIZED)
// first-ever pairing also: SystemEvent PAIR_COMPLETE, SYNC_COMPLETE, SETUP_WIZARD_COMPLETE
```

`SystemEventMessage (5030)` wire format: `writeShort(0); writeShort(5030); writeByte(eventType);
[optional writeByte(intValue)]`. `GarminSystemEventType` ordinals: `SYNC_COMPLETE=0, SYNC_FAIL=1,
FACTORY_RESET=2, PAIR_START=3, PAIR_COMPLETE=4, PAIR_FAIL=5, HOST_DID_ENTER_FOREGROUND=6,
HOST_DID_ENTER_BACKGROUND=7, SYNC_READY=8, NEW_DOWNLOAD_AVAILABLE=9, DEVICE_SOFTWARE_UPDATE=10,
DEVICE_DISCONNECT=11, TUTORIAL_COMPLETE=12, SETUP_WIZARD_START=13, SETUP_WIZARD_COMPLETE=14,
SETUP_WIZARD_SKIPPED=15, TIME_UPDATED=16`.

### 3.6 End-to-end decode/encode pseudocode

```
RX:
  on notify(value):
    handle = value[0]
    if handle==0: handleManagement(value); return
    if (handle & 0x80) and MLR-registered: route to MLR; return
    cobs[handle].receivedBytes(value[1:])           // 1500ms reset
    frame = cobs[handle].retrieveMessage()          // non-null when trailing 0x00 seen
    if frame==null: return
    assert len(u16le frame[0:2]) == frame.length
    assert fitCrc16(frame[0:len-2]) == u16le(frame[len-2:])
    type = u16le(frame[2:4]); if type & 0x8000: type = (type & 0xff)+5000
    msg = REGISTRY[type].parse(frame[4:len-2])
    if type in {5043,5044}: feed ProtocolBufferHandler (reassemble -> Smart.parseFrom)
    send msg.ackFrame()                              // GenericStatus ACK / ProtobufStatus
TX:
  frame = [u16 0][u16 id][payload]; frame[0:2]=len(incl CRC); append fitCrc16(frame[0:len-2])
  cobsEncode(frame) -> 0x00 ... 0x00
  split into (maxWriteSize-1) chunks; each GATT write = [gfdiHandle] ++ chunk
```

---

## 4. File Sync (Activities + Wellness Monitoring FITs)

Gadgetbridge supports two variants. We implement the **LEGACY binary protocol** first (fully GFDI
binary; sufficient for FR945). The **NEW protobuf `FileSyncService`** protocol (zlib-compressed
transfers, paging) is documented here for completeness and as an optional later upgrade.

### 4.1 Sync trigger / handshake

`onFetchRecordedData()` (`GarminSupport.java:511-532`): requires a non-empty supported-file-type
list (legacy); sends `initiateDownload()` to flush device data. `initiateDownload()`
(`FileTransferHandler.java:134-137`):

```
currentlyDownloading = FileFragment(DirectoryEntry(index=0, DIRECTORY, ...))
return DownloadRequestMessage(fileIndex=0, dataSize=0, REQUEST_TYPE.NEW, crcSeed=0, dataOffset=0)
```

The device may also push **SYNCHRONIZATION (5037)** unsolicited:
`[u8 type][u8 size][bitmask: u64 if size==8 else u32]`; bits → `EnumSet<FileType>` (WORKOUTS=3,
ACTIVITIES=5, ACTIVITY_SUMMARY=21, SLEEP=26, …). `shouldProceed()` is true if
WORKOUTS|ACTIVITIES|ACTIVITY_SUMMARY|SLEEP present → reply with **FilterMessage (5007)**
(`[u16 0][u16 5007][u8 FilterType.UNK_3]`). When the device ACKs the filter, `handle()` returns
`initiateDownload()` → directory download begins.

The directory download is **always** used as a flush, even in the new protocol (skipping it can
yield incomplete MONITOR files).

### 4.2 Directory listing (legacy binary)

1. Request `DownloadRequestMessage(fileIndex=0)`. Outgoing
   (`DownloadRequestMessage.java:26-38`): `[u16 len=0][u16 5002][u16 fileIndex][u32 dataOffset]
   [u8 requestType.ordinal()][u16 crcSeed][u32 dataSize]`. `requestType`: `CONTINUE=0, NEW=1` —
   use **NEW(1)**, `dataOffset=0`, `crcSeed=0`, `dataSize=0`.
2. `DownloadRequestStatusMessage` reply: `[u8 status][u8 downloadStatus][u32 maxFileSize]`.
   `downloadStatus`: `OK=0, INDEX_UNKNOWN=1, INDEX_NOT_READABLE=2, NO_SPACE_LEFT=3, INVALID=4,
   NOT_READY=5, CRC_INCORRECT=6`. `canProceed() = status==ACK && downloadStatus==OK`. On OK,
   allocate a buffer of `maxFileSize`.
3. Device streams the directory file as `FileTransferDataMessage` chunks (§4.4).
4. When the buffer is full, `parseDirectoryEntries()` runs (filetype == DIRECTORY).

**Directory entries are EXACTLY 16 bytes** (`dataSize % 16 == 0`), little-endian
(`FileTransferHandler.java:233-265`):

```
bytes 0-1   u16 fileIndex
byte  2     u8  fileDataType
byte  3     u8  fileSubType       -> FILETYPE.fromDataTypeSubType(dataType, subType)
bytes 4-5   u16 fileNumber
byte  6     u8  specificFlags
byte  7     u8  fileFlags
bytes 8-11  u32 fileSize
bytes 12-15 u32 garminTimestamp   -> Date (Garmin epoch)
```

Skip entries with null filetype, entries not in `FILE_TYPES_TO_PROCESS` (unless
`fetchUnknownFiles`), and the **all-zero 16-byte entry** (anti-infinite-loop guard).

### 4.3 File types (FileType.java) — monitoring vs activity

`isFitFile() == (type == 128)` → `.fit` extension, else `.bin`. Key `(type, subType)` entries:

```
DIRECTORY      (0,   0)   virtual; root index 0x0000
DEVICE_XML     (8,   255) index 0xFFFD (debug)
SETTINGS       (128, 2)
ACTIVITY       (128, 4)   "FIT_TYPE_4"  -> garmin/activity   (workout .fit, merges w/ phone recordings)
MONITOR_A      (128, 15)
MONITOR_DAILY  (128, 28)
MONITOR        (128, 32)  "FIT_TYPE_32" -> garmin/monitor    (daily wellness; §6)
SCORE          (128, 38)  METRICS (128, 44)   CHANGELOG (128, 41)
SLEEP          (128, 49)  "FIT_TYPE_49"
DEVICE_58      (128, 58)  ECG (128, 61)  HRV_STATUS (128, 68)  HSA (128, 70)
COM_ACT        (128, 71)  SKIN_TEMP (128, 73)  SLP_DISR (128, 79)
AREA_COURSES   (128, 82)  SEGMENT_LIST (128, 35)
ERROR_SHUTDOWN_REPORTS (255, 245)
```

`FILE_TYPES_TO_PROCESS` (whitelist queued): DIRECTORY, ACTIVITY, MONITOR, METRICS, CHANGELOG,
HRV_STATUS, SLEEP, SKIN_TEMP, DEVICE_58, SLP_DISR, ERROR_SHUTDOWN_REPORTS, SCORE, HSA, COM_ACT,
AREA_COURSES, SEGMENT_LIST.

**For Open Fit we route by type:** `ACTIVITY (128/4)` files → `POST /api/import` (§4.6);
`MONITOR (128/32)`, `SLEEP (128/49)`, `HRV_STATUS (128/68)`, `METRICS (128/44)` and the other
wellness types → the monitoring-FIT wellness parser (§6) → `POST /api/wellness`.

### 4.4 Chunked download + ACK/flow-control + CRC (legacy)

Per file: `downloadDirectoryEntry(entry)` → `DownloadRequestMessage(entry.fileIndex, 0, NEW, 0, 0)`;
wait for `DownloadRequestStatusMessage` (gives `maxFileSize`, allocates buffer). Only **one
download is in flight at a time** (`currentlyDownloading`); `processDownloadQueue` is re-driven
after every received GFDI message.

Device→phone **FileTransferDataMessage (5004)** payload (`FileTransferDataMessage.java:31-39`):

```
u8  flags
u16 crc           (rolling CRC the device computed)
u32 dataOffset    (absolute offset of this chunk within the file)
byte[] message    (the file payload chunk)
```

Append/verify (`FileFragment.append`):

```
require dataOffset == dataHolder.position()                 // strictly in-order
dataCrc = computeCrc(runningCrc, chunkBytes, 0, len)        // CHAINED from previous chunk
require dataCrc == message.crc
runningCrc = dataCrc; append bytes
```

ACK / flow control: each chunk is ACKed with **FileTransferDataStatusMessage**:
`[u16 0][u16 5000][u16 5004][u8 status][u8 transferStatus][u32 dataOffset]` where `dataOffset =
prevOffset + chunk.length` = **next expected offset** (the windowing signal — the device sends the
next chunk only after this ACK). `TransferStatus`: `OK=0, RESEND=1, ABORT=2, CRC_MISMATCH=3,
OFFSET_MISMATCH=4, SYNC_PAUSED=5`. There is **no separate whole-file CRC** in the transfer — the
chained per-chunk CRC is the wire-integrity check; the FIT file's own internal CRC is validated
separately at parse time.

On buffer-full → `processCompleteDownload()`; else report progress.

### 4.5 Write to disk + watermark (re-download avoidance)

Completion writes the raw buffer **verbatim** (it *is* the `.fit`/`.bin`) to:

```
<FILETYPE.name>/<yyyy>/<FILETYPE>_<yyyy-MM-dd_HH-mm-ss>_<fileIndex>.<fit|bin>
```

(year folder + date omitted if the file date is the Garmin epoch.)

**Watermark = filesystem + on-watch flags. There is NO persisted timestamp/counter.**
`alreadyDownloaded(entry)` returns true iff the output file already exists **and length > 0**
(empty files are re-fetched). On already-downloaded or successful-download, if
`!keepActivityDataOnDevice`, send **SetFileFlagsMessage(fileIndex, ARCHIVE)**
(`[u16 0][u16 5008][u16 fileIndex][u8 bitvector]`, `ARCHIVE = bit4 = 0x10`) so the file is removed
from the watch and won't reappear in the next directory listing. Since we own the watch
exclusively, **leave `keepActivityDataOnDevice` false** so the watch is the authoritative "not yet
synced" queue.

### 4.6 Uploading downloaded FITs via `/api/import`

Downloaded **ACTIVITY** `.fit` files are POSTed to `{base}/api/import` as multipart, field name
**`file`** (the same path as `RecordingPlugin.postFit()`):

- `handlers.rs:59-128` reads each multipart field's `file_name()` + `bytes()` and calls
  `import_one(state, filename, bytes)` → `ofit_ingest::import_bytes_path(&db, filename, bytes)`.
- The FIT parser (`fit.rs:1-54`) is **device-agnostic**: extracts sport via
  `sport_from_str(...)` (`lib.rs:225-236` — Garmin "cycling"/"biking" → `Sport::Cycling`) and
  device identity (Garmin product mapping → source "Garmin Forerunner 945", `fit.rs:128`).
- `cluster_recordings` (`dedup.rs:44-100`) is **already multi-device aware**: it merges by
  `sport == other.sport && time_overlaps(other)` (`recording.rs:132`), so a Garmin run and a phone
  recording of the same run merge into one Activity. The existing test
  (`import_pipeline.rs:65-74`) already verifies Garmin-945 BIKE files cluster correctly. **No
  server change needed.**

Test data already in repo: `test-data/BIKE001-Garmin-Forerunner-945-*.fit/.gpx/.tcx`.

### 4.7 NEW protobuf file-sync protocol (optional later)

Enabled by pref `new_sync_protocol`. Replaces the binary directory with `FileSyncService`
messages: `FileListRequest/Response` (paging via `nextPageId/startPageId`; only the **first** File
per type carries `type.name`, so cache `code→name`; `nextPageId==0` → fall back to max pageId
seen); `FileRequest/Response` returns a transfer handle; `downloadFileFromServiceV2(handle)` opens a
`CommunicatorV2.startTransfer` channel, writes a 6-byte LE request
`[00][00][u16 fileHandle][00][00]`, streams into a `ByteArrayOutputStream`, then on close
**`CompressionUtils.inflate(baos)`** (V2 payload is **zlib-compressed**) → FIT bytes → import →
`FileSetFlags` markSynced. Match file types by string name (`FIT_TYPE_4`, `FIT_TYPE_32`,
`FIT_TYPE_49`, …). Not required for FR945 bring-up.

---

## 5. Realtime Data + Standard 0x180D Live HR

### 5.1 Which path FR945 uses

FR945 is a **watch** → `GarminSupport` + `CommunicatorV2`. The standard BLE Heart Rate Service
(`0x180D`/`0x2A37`) is used **only** by `GarminSupportHrm` (Garmin HRM chest straps), **never** by
the watch. A FR945 does **not** expose a usable standard HRS on its phone GFDI link. (It *can*
separately enter "Broadcast Heart Rate" mode to other devices, but that typically suspends the
phone GFDI link and we do not consume it.) **For live HR on FR945 you MUST register ML service 6;
you cannot rely on a free `0x180D` side-channel.**

### 5.2 Enabling realtime = a 13-byte ML REGISTER_ML_REQ (NOT protobuf)

Realtime is enabled by the same ML control packet as §2.4, on handle `0x00`, with the metric's
service code. Realtime services register **non-reliable** (`reliable=0`). The `GdiSettingsService
REALTIME_SETTINGS` capability and `GdiCore REALTIME_TRACKING` are **unrelated** (settings-menu
mirror UI / GPS push to watch, respectively).

```
Enable HR  (Service.REALTIME_HR = 6):   00 00 | 02 00 00 00 00 00 00 00 | 06 00 | 00
  -> REGISTER_ML_RESP: 00 01 <06 00> <status=00> <handle=H_hr> <reliable=00>
Enable steps (Service.REALTIME_STEPS=7): 00 00 | 02 00 00 00 00 00 00 00 | 07 00 | 00
Disable: CLOSE_HANDLE_REQ (type 2): 00 02 02 .. .. <service.code> <assigned handle>
```

Service codes (`CommunicatorV2.java:579-598`): `REALTIME_HR=6, REALTIME_STEPS=7,
REALTIME_CALORIES=8, REALTIME_INTENSITY=10, REALTIME_HRV=12, REALTIME_STRESS=13,
REALTIME_ACCELEROMETER=16, REALTIME_SPO2=19, REALTIME_BODY_BATTERY=20, REALTIME_RESPIRATION=21`.
**Only HR(6), STEPS(7), SPO2(19), RESPIRATION(21), HRV(12), ACCEL(16) have decode callbacks.**
CALORIES(8), INTENSITY(10), STRESS(13), BODY_BATTERY(20) have codes but **no callback** → not
streamed. **There is NO ML service for cadence, pace, or power** — those metrics only appear in
downloaded FIT activity files.

Public enable API to mirror: `onEnableRealtimeHeartRateMeasurement(enable)` →
`toggleService(REALTIME_HR, enable)`; `onEnableRealtimeSteps(enable)` →
`toggleService(REALTIME_STEPS, enable)` (resets `previousSteps=-1`); `onHeartRateTest()` registers
HR once and auto-closes after the first reading. Drive these from the app's live-activity screen.

### 5.3 Realtime payload decoders (device → us)

Realtime ML payloads are **raw little-endian bytes with only a 1-byte handle prefix — NOT
COBS-encoded and NO GFDI CRC**. Each callback receives `value[]` with the handle already stripped.

```
REALTIME_HR    : value[0]=type, value[1]=hr (bpm, &0xff), value[2]=resting hr, then 0xff 0xff
                 hr==0 means "no reading" (skip). broadcast(hr, steps=-1).
REALTIME_STEPS : steps = u32 LE [0..3] (cumulative day total); goal = u32 LE [4..7]
                 EMIT DELTA: broadcast(hr=-1, steps - previousSteps); first packet seeds previousSteps.
                 Counter resets at midnight; on (re)enable previousSteps=-1.
REALTIME_SPO2  : value[0]=spo2 (s8; -1 unknown), u32 LE [1..4]=Garmin timestamp.  (logged only)
REALTIME_RESPIRATION : value[0]=breaths/min (signed; negative=unknown).           (logged only)
REALTIME_HRV   : u16 LE [0..1]=rr (ms), u32 LE [2..5]=unknown.                     (logged only)
REALTIME_ACCEL : onConnect write {0x01} to start; hexdump only.
```

Live samples in our app flow `emitSample("heart_rate", hr, conn)` (and steps), enriched with the
Garmin `source_id`, into `nativeIngest` (§7). Only HR + step deltas are useful live; SpO2 /
respiration / HRV are decode-only and can be wired later if desired.

### 5.4 Standard 0x180D coexistence — answer

For FR945: **not used / not available** on the GFDI link. There is no standard HRS to consume
alongside GFDI; live HR is exclusively via ML service 6. Keep the GFDI/ML connection up and
register the realtime service when the live screen opens.

---

## 6. Garmin Monitoring-FIT Wellness Parsing → WellnessKind

Garmin daily wellness arrives as downloaded **monitoring** FIT files (type 128, subType 32/49/etc.,
§4.3). These are parsed into `WellnessSample`/`WellnessKind`
(`crates/ofit-core/src/wellness.rs:46`).

**Where this runs:** parse on the **server**. The Android plugin downloads the monitoring `.fit`
verbatim and POSTs the raw bytes; a new server-side parser (extending `ofit-ingest`) emits
`WellnessSample`s into the DB under the Garmin source. (Rationale: the FIT/Garmin profile,
16-bit-timestamp reconstruction, and cumulative-counter diffing are non-trivial and belong next to
the existing Rust FIT machinery and `WellnessSample::scalar/sleep_stage` constructors. The phone
stays a thin transport.) Activities and monitoring share the same FIT parser plumbing; route by
file type to either `RawRecording` (activity) or wellness extraction (monitoring).

### 6.1 File-level context

- `file_id (#0)` field 0 `type`: daily wellness uses `monitoring_a=15`, `monitoring_b=32`,
  `monitoring_daily=28`. **Don't hard-require it** — parse any file containing #55/#227/#297/etc.
- ALL timestamps are FIT `date_time` = u32 **seconds since 1989-12-31T00:00:00Z**. To Unix:
  `unix = fit_ts + 631065600` (`GARMIN_TIME_EPOCH`). `local_date_time` values `< 0x10000000` are
  device-uptime seconds (not wall clock) — discard. `local_timestamp` is local wall time; do not
  re-offset to UTC.
- Invalid sentinels: u8=`0xFF`, u16=`0xFFFF`, u32=`0xFFFFFFFF`, s16=`0x7FFF`, enum=`0xFF`. Skip
  fields equal to their invalid value. Physical value = `(raw / scale) - offset`.

### 6.2 Message layouts (global message # = the "UUID")

**monitoring (#55)** — multiple rows per logging interval, one per active activity_type; merge by
timestamp:

```
f0  device_index        u8
f1  calories            u16 kcal            accumulated per activity_type
f2  distance            u32 /100 m          accumulated per activity_type
f3  cycles              u32 /2 "cycles"     accumulated per activity_type
      subfield steps   (activity_type running(1)|walking(6)): u32 SCALE 1 (NOT 2)
      subfield strokes (cycling(2)|swimming(5)):              u32 /2
f4  active_time         u32 /1000 s
f5  activity_type       enum  (0 generic,1 running,2 cycling,3 transition,4 fitness_equipment,
                               5 swimming,6 walking,8 sedentary,254 all)
f8  distance_16         u16 "100*m"         compact accumulated distance
f9  cycles_16           u16 "2*cycles/steps" 16-bit accumulated step/cycle counter (ROLLS OVER)
f11 local_timestamp     local_date_time
f19 active_calories     u16 kcal            per-interval active calories
f24 current_activity_type_intensity  byte:  activity_type = cati & 0x1F ; intensity = (cati>>5)&0x7
f25 timestamp_min_8     u8  min             8-bit minute delta
f26 timestamp_16        u16 s               16-bit seconds delta (see §6.3 rollover)
f27 heart_rate          u8  bpm             per-interval HR
f33 moderate_activity_minutes  u16          intensity-minutes
f34 vigorous_activity_minutes  u16
f253 timestamp          date_time           full absolute timestamp (anchor records)
```

**monitoring_info (#103)** — emit once near start; use to convert cycles→distance/calories if
absent: `f3 cycles_to_distance u16 /5000 m/cycle` (indexed by activity_type),
`f4 cycles_to_calories u16 /5000 kcal/cycle`, `f5 resting_metabolic_rate u16 kcal/day`.

**stress_level (#227)** — often has **no f253**; use f1 as the sample time:

```
f0  stress_level_value  s16   0-100 valid; NEGATIVE = invalid (sentinels -1/-2) -> DROP <0
f1  stress_level_time   date_time           use THIS as timestamp
f3  body_energy         u8/u16  0-100       *** BODY BATTERY *** (UNDOCUMENTED; getFieldByNumber(3))
```

**hsa_body_battery_data (#314)** — newer dedicated Body-Battery message; **prefer if present**:

```
f0  processing_interval u16 s               seconds between array entries
f1  level[]   array u8  0-100               Body Battery; element i at ts253 + i*processing_interval
f2  charged[] array     f3 uncharged[] array
f253 timestamp          date_time           timestamp of FIRST array element
```

**respiration_rate (#297)**: `f0 respiration_rate s16 /100 breaths/min`; **raw sentinels** -300
invalid, -200 large motion, -100 off-wrist → **drop raw ≤ 0 before scaling**; `f253 timestamp`.

**spo2_data (#269)**: `f0 reading_spo2 u8 %` (drop ≤0), `f1 reading_confidence u8`,
`f2 mode enum {0 offWrist,1 spotCheck,2 continuousCheck,3 periodic}`, `f253 timestamp`.

**monitoring_hr_data (#211)**: `f0 resting_heart_rate u8` (7-day rolling avg),
`f1 current_day_resting_heart_rate u8` (today; **prefer f1**), `f253 timestamp`.

**hrv (#78)**: `f0 time u16 /1000 s` — one RR interval, ARRAY up to 5 per message. Compute
`rr_ms = time*1000`; `RMSSD = sqrt(mean(diff(rr_ms)^2))` → Hrv (ms).

**sleep_level (#275)**: `f0 sleep_level enum {0 unmeasurable,1 awake,2 light,3 deep,4 rem}`,
`f253 timestamp` (stage start; runs until next record).

**sleep_assessment (#346)**: per-night summary (`overall_sleep_score`, etc.) — store as a daily
sleep score if desired, **not** a per-sample `WellnessSample` stage.

### 6.3 16-bit timestamp reconstruction (`timestamp_16` / `cycles_16` rollover)

Compact #55 records carry only `f26 timestamp_16` (low 16 bits of Garmin-epoch seconds). Seed from
a full f253 anchor:

```
last_unix = <unix ts of previous monitoring record>     // seeded by a 253 anchor
if record has timestamp_16 and last_unix set:
    ref_garmin = last_unix - 631065600
    diff = (timestamp_16 & 0xFFFF) - (ref_garmin & 0xFFFF)
    if diff < -32768: diff += 65536                      // forward rollover
    elif diff > 32768: diff -= 65536                     // defensive backward
    current_unix = last_unix + diff
elif record has f253: current_unix = ts253 + 631065600
else: current_unix = last_unix
last_unix = current_unix                                 // carry forward
```

`f25 timestamp_min_8` is the analogous 8-bit minute delta (mask `0xFF`, ±128 wrap at 256).

### 6.4 Cumulative step/cycle counters → per-interval

`cycles` (f3) and `cycles_16` (f9) are **monotonic accumulators maintained per activity_type**,
reset at midnight. For running/walking they are **steps** (scale 1); for cycling/swimming they are
**strokes** (scale 2) — choose via the record's activity_type (f5 or `f24 & 0x1F`). 16-bit
`cycles_16` rolls at 65536:

```
// first record for an activity_type: accum = cycles_16; prev16 = cycles_16
delta16 = cycles_16.wrapping_sub(prev16)   // u16 wrapping handles rollover
accum += delta16 as u32
prev16 = cycles_16
```

Per-interval steps for timestamp t, activity_type A:
`interval_steps[A] = cumulative[A](t) - cumulative[A](t_prev)`; keep
`HashMap<activity_type, last_cumulative>`. **A decrease (midnight/counter reset) → treat previous as
0.** Because multiple #55 messages share one timestamp, **buffer all #55 with the same computed
timestamp, diff each activity_type, then SUM the diffs into one Steps sample**. Do likewise for
distance (f2/f8) and calories (f1/f19).

### 6.5 Field → WellnessKind mapping

```
monitoring(#55).heart_rate (f27)                          -> HeartRate        bpm (u8)
monitoring(#55) cycles/steps (f3 sub / f9), diffed+summed -> Steps            per-interval count
monitoring(#55).active_calories (f19)                     -> Calories         kcal (diff f1 if only cumulative)
monitoring_hr_data(#211).current_day_resting_heart_rate(f1)-> RestingHeartRate bpm (prefer f1)
stress_level(#227).stress_level_value (f0, drop <0)       -> Stress           0-100, ts = f1
stress_level(#227).body_energy (f3)  [undocumented]       -> BodyBattery      0-100
hsa_body_battery_data(#314).level[] (f1, arrayed)         -> BodyBattery      0-100, ts=253+i*interval
respiration_rate(#297).respiration_rate (f0/100, raw>0)   -> Respiration      breaths/min
spo2_data(#269).reading_spo2 (f0, >0)                     -> SpO2             percent
hrv(#78).time[] (f0*1000=rr_ms) -> RMSSD                  -> Hrv              ms
sleep_level(#275).sleep_level enum (f0)                   -> SleepStage       0/1->Awake(or skip),
                                                                              2->Light,3->Deep,4->Rem
sleep_assessment(#346).overall_sleep_score               -> (daily summary; store separately)
(intensity-minutes f33/f34, ascent f31, temperature f12) -> no current WellnessKind; ignore/extend
```

Each emitted sample: `ts = DateTime::from_timestamp(fit_ts + 631065600, 0)`; `source_id` = the
Garmin source; `value` = scaled f64; use `WellnessSample::scalar(...)` / `::sleep_stage(...)`
(`wellness.rs:92,103`).

### 6.6 Parse loop

```
maintain last_monitoring_unix: Option<i64>; per_activity_cumulative: HashMap<u8,u64>
for each data message, dispatch on global mesg_num:
  55  -> compute ts (§6.3); buffer by ts; on flush diff cumulative per activity_type (§6.4),
         sum -> Steps; emit HeartRate(f27), Calories.
  103 -> store cycles_to_distance/calories tables.
  227 -> if f0>=0 emit Stress @f1; if f3 present emit BodyBattery @f1.
  314 -> for i,lvl in level[]: emit BodyBattery @ (ts253 + i*processing_interval).
  297 -> if raw>0 emit Respiration = raw/100 @253.
  269 -> if f0>0 emit SpO2 @253.
  211 -> emit RestingHeartRate(f1) @253.
  78  -> push rr=time(f0)*1000; periodically RMSSD -> Hrv.
  275 -> emit SleepStage(map enum) @253.
```

FIT parsing itself uses standard header/record/CRC validation (`FitFile.parseIncoming`); magic
`0x5449462E` (".FIT"), header CRC if `headerSize==14`, trailing u16 file CRC = same nibble-table
CRC.

### 6.7 Wellness ingest

Parsed samples are persisted (server-side, since parsing is server-side) under the Garmin source
(§7.4). Sentinels and non-positive values are dropped per §6.2. The dashboard then shows per-source
wellness, enabling per-device preferences (e.g. prefer Garmin SpO2, Helio HRV).

---

## 7. Codebase Integration + Multi-Connection Refactor of `OpenFitBlePlugin`

### 7.1 Current single-connection state (target for refactor)

`OpenFitBlePlugin.java` lines 82–118: `gatt` (82), `connectedId` (83), `mode` (84), `authKey` (85),
`huami` (87), `fetchBatch` (95), `opQueue` (102), `maxFetchedTs` (118). `BluetoothGattCallback`
(769–836) processes notifications for the **one** gatt.

### 7.2 New `DeviceConnection` class

`mobile/android/app/src/main/java/org/openfit/app/DeviceConnection.java` — encapsulates **all**
per-connection state so two devices never share mutable BLE/auth state:

```java
class DeviceConnection {
  final String deviceId;            // MAC key
  String name, mode, authKey;       // mode: "huami" | "garmin" | "standard"
  String sourceId;                  // per-device wellness source (§7.4)
  boolean isPrimary;                // HR feed owner for recording (§7.5)

  BluetoothGatt gatt;
  BluetoothGattCallback gattCallback;        // instance callback (not plugin singleton)

  HuamiSession huami;               // Helio only
  GarminSession garmin;             // Garmin only: CommunicatorV2 + GFDI + FileTransferHandler

  // Garmin BLE chars
  BluetoothGattCharacteristic gfdiRecvChar, gfdiSendChar;
  // Helio BLE chars
  BluetoothGattCharacteristic chunkWriteChar, chunkReadChar, hrChar,
                              activityControlChar, activityDataChar;

  ArrayDeque<Runnable> opQueue; volatile boolean opInFlight;   // per-device serialized queue
  long maxFetchedTs; List<String> fetchBatch; volatile boolean fetchInProgress;

  DeviceConnection(String deviceId, String name, String mode, String authKey);
  void disconnect();
  void emitStatus(String status, String message);   // event carries deviceId
  void emitSample(String kind, double value);        // live data carries deviceId
}
```

`GarminSession` is the new Garmin protocol stack: the ML/COBS communicator (§2), GFDI framing+CRC
(§3), `FileTransferHandler` (§4), and realtime ML services (§5). It is **fully independent** of
`HuamiSession`.

### 7.3 `OpenFitBlePlugin` refactor

```java
// OLD: private BluetoothGatt gatt; private String connectedId; private HuamiSession huami;
private final Map<String, DeviceConnection> connections = new ConcurrentHashMap<>();
private volatile DeviceConnection activeConnection; // backward-compat (last connected)
```

- `doConnect(call)` (217–258): build `new DeviceConnection(id, name, mode, authKey)`,
  `connection.gatt = device.connectGatt(ctx, false, connection.gattCallback)`,
  `connections.put(id, connection)`, set `activeConnection`. For `mode=="garmin"`, run the bond →
  ML handshake (§2) inside the connection's callback/op queue.
- **Per-connection GATT callback + op queue.** Move callback logic (769) into the `DeviceConnection`
  instance; `enqueue/enqueueWrite/enqueueNotify/runNextOp/opComplete` (102, 660–682) become
  per-connection. Two `gatt` objects ⇒ two queues run in parallel; each `gatt` still does one op at
  a time (Android requirement). Dispatch via `Handler.post` (never `postAtFront`) to avoid
  starvation.
- **Huami wiring** (868–966; `HuamiSession.java:62-94`): `HuamiSession` is transport-agnostic; point
  its `writeChunk/writeAck` to `DeviceConnection.enqueueWrite(chunkWriteChar, …)`, and listener
  callbacks (`onHeartRate`, `onFetchSample`, `onFetchDone`) to the **connection-local** methods.
  Store in `DeviceConnection.huami`. **Never reuse a HuamiSession across deviceIds** (ECDH/session
  key are stateful).
- **Periodic sync** (419–431): iterate all connections; each with an active session and
  `!fetchInProgress` runs its own `beginSync(…)`. Prefer per-connection timers.
- **Foreground service** (`BleForegroundService.java:63-75`): keep a count/set of connected devices;
  start on first connect, update text on subsequent connects ("Connected (2 devices)"), stop on
  last disconnect. BLE foreground type `FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE` remains correct.

### 7.4 Source attribution (per-device wellness source)

`POST /api/wellness` (`handlers.rs:801-843`) defaults to `ensure_source(Gadgetbridge, "Live
stream")` when `source_id` is omitted; `WellnessIngest` (`dto.rs:268-280`) carries an optional
`source_id: Option<Uuid>`. **Adopt Option A:** each BLE device gets its own source:

- Helio first connect → `ensure_source(Gadgetbridge, "Live stream (Helio)")`.
- Garmin first connect → `ensure_source(Gadgetbridge, "Live stream (Garmin)")`.
- Store the returned UUID in `DeviceConnection.sourceId` (and SharedPreferences).
- `emitSample` enriches every sample with `sample.put("source_id", conn.sourceId)` before
  `nativeIngest`/`doPostBatch` (480–544).

For the **server-side monitoring-FIT wellness** (§6), the Garmin source is the same "Garmin" source;
parsed samples are persisted under it directly. The shared offline outbox `ofit_outbox.jsonl`
stays global (each record's `source_id` disambiguates); the watermark `prefs().getLong("wm_" +
deviceId, …)` is **already per-device** — no migration. Sync sequentially (§1.4) to avoid the
watermark write race.

### 7.5 Live HR & recording

For workout recording, **only one device feeds HR**. Set a primary (Helio if present, else Garmin):
`emitSample` calls `RecordingService.feedHeartRate(...)` (`RecordingService.java:66-72`) **only when
`conn.isPrimary && RecordingService.isRecording()`**. If the primary disconnects mid-workout,
optionally promote the secondary; otherwise lock HR to the first-connected device for the workout.

### 7.6 Web layer (`NativeBleProvider.tsx`) for two devices

Extend state to per-device (`NativeBleProvider.tsx:23-50`):

```typescript
interface NativeBleState {
  status: NativeConnStatus;        // "connected" if ANY device connected
  found: NativeScanResult[];
  devices: Map<string, { device: SavedDevice; hr: number|null; syncing: boolean; message?: string }>;
  hr: number|null;                 // backward-compat: latest/merged
  message?: string; device: SavedDevice|null;
}
```

- **Listeners** (107–175): `sample` listener routes `e.deviceId` →
  `devices[e.deviceId].hr = round(e.value)` (mirror latest to top-level `hr`); `status` listener
  routes per-device, sets global status = connected if any device is connected.
- **Storage** (54–69): `ofit_native_devices` holds a list of `SavedDevice`; load all on mount, save
  on add/forget; keep a "primary" for `RecordingPlugin` feed.

**Dual-sync UI** (`sync()`, 206–215) — Helio then Garmin, sequential, skip absent:

```typescript
const sync = useCallback(async (days?: number) => {
  if (!available) return;
  userSync.current = true;
  const opts = days ? { sinceMillis: Date.now() - days*86400000 } : {};
  const ordered = orderHelioThenGarmin(Array.from(devices.values()));   // deterministic
  let anyCompleted = false;
  for (const dev of ordered) {
    if (!dev.connected) continue;                                       // skip absent
    setSyncing(dev.deviceId, true);
    try { await OpenFitBle.syncNow({ deviceId: dev.deviceId, ...opts }); anyCompleted = true; }
    catch (e) { Log.w("sync error " + dev.deviceId + ": " + e); }
    finally { setSyncing(dev.deviceId, false); }
  }
  userSync.current = false;
  if (anyCompleted) window.dispatchEvent(new Event("ofit:data-updated"));
}, [available, devices]);
```

Capacitor plugin API change: `syncNow(opts?: { deviceId?: string; sinceMillis?: number })`; the
Android handler routes to the matching `DeviceConnection` by `deviceId`.

### 7.7 Ingest / clustering (no core changes)

`POST /api/import` and the FIT parser are device-agnostic; `cluster_recordings` already merges
Garmin + Helio by sport + time overlap; `sport_from_str` already maps Garmin "cycling"/"biking".
The only server addition is the **monitoring-FIT wellness extractor** (§6), which feeds existing
`WellnessSample` persistence.

---

## 8. Staged Implementation Plan

Each stage is independently testable on-device. Stages A–B bring up the protocol; C–D deliver the
two locked payloads; E adds live metrics; F delivers simultaneous dual-connection + the sequential
Sync UI.

### Stage A — Pair + bond + prove the link (live HR target)

**Goal:** bond the FR945 to the app, complete the connect/handshake far enough to confirm the link;
get a first live HR reading.

Ordered tasks:
1. Add `mode="garmin"` to the connect path; scaffold `GarminSession` + the V2 UUIDs (§2.1).
   Files: `OpenFitBlePlugin.java` (`doConnect` 217–258), new `GarminSession.java`.
2. Implement Android bonding: `createBond()` / wait `BOND_BONDED`; retry-on-133/137 (§2.2).
3. `requestMtu(515)`, discover services, find the recv/send pair `6A4E281x/282x` (§2.1, §2.3).
4. Enable notify on recv; send `CLOSE_ALL_REQ`; implement ML handle management → store `gfdiHandle`
   (§2.4).
5. Implement Garmin COBS (§2.5) + fragmentation; verify a round-trip by ACKing the watch's first
   GFDI messages (needs Stage B framing, so stub-ACK initially).
**Test:** watch shows "paired/connected" to our app; ML `REGISTER_ML_RESP` received and `gfdiHandle`
logged. (Live HR proven at end of Stage E once realtime is wired; Stage A target is a stable bonded
link + handle.)

### Stage B — GFDI handshake + framing

**Goal:** full GFDI framing with correct CRC; complete `DeviceInformation` + `AuthNegotiation` +
`completeInitialization`, reaching `INITIALIZED`.

1. Implement the nibble-table CRC-16 (§3.2) as a shared util (reused by file transfer + FIT parse).
2. Implement GFDI frame encode/decode incl. the `0x8000` status-channel mask (§3.1).
3. Implement the message registry + generic ACK (`GenericStatusMessage`) (§3.3).
4. Implement `DeviceInformationMessage` reply, `AuthNegotiationMessage` zero-flags reply (§3.5
   A/B), the protobuf envelope just enough to detect Capabilities (§3.4), and
   `completeInitialization()` (5031/5026/SYNC_READY; first-pair PAIR_COMPLETE etc.) (§3.5).
**Files:** `GarminSession.java` + message helpers, shared `GarminCrc.java`.
**Test:** handshake completes; device reaches INITIALIZED; logs show ACK→reply→followup order.

### Stage C — File sync (activities)

**Goal:** download ACTIVITY `.fit` files and upload them to `/api/import`; verify clustering with a
phone recording.

1. Implement SYNCHRONIZATION(5037) → FilterMessage(5007) → `initiateDownload()` (§4.1).
2. Implement directory download (DownloadRequest 5002 → DownloadRequestStatus → chunked transfer)
   and 16-byte directory entry parsing (§4.2).
3. Implement per-file chunked transfer with chained CRC + `FileTransferDataStatusMessage` ACK
   flow-control (§4.4); write `.fit` to disk verbatim (§4.5).
4. Implement watermark via filesystem `alreadyDownloaded` + `SetFileFlagsMessage(ARCHIVE)`
   (`keepActivityDataOnDevice=false`) (§4.5).
5. POST downloaded ACTIVITY files to `{base}/api/import` (multipart field `file`) (§4.6).
**Files:** `GarminSession.java`/`FileTransferHandler.java` (new), reuse `RecordingPlugin.postFit`
upload path. **Server:** none.
**Test:** record an activity on the watch, sync, confirm the `.fit` imports and (with an overlapping
phone recording) merges into one Activity (mirror `import_pipeline.rs`).

### Stage D — Monitoring-FIT wellness

**Goal:** download monitoring FITs and turn them into `WellnessSample`s under the Garmin source.

1. Route MONITOR/SLEEP/HRV_STATUS/METRICS file types through the same downloader (§4.3) but POST
   their raw bytes to a server wellness-import path.
2. Build the **server-side** monitoring-FIT parser (§6): #55/#103/#227/#314/#297/#269/#211/#78/#275,
   16-bit timestamp reconstruction (§6.3), cumulative-counter diffing (§6.4),
   WellnessKind mapping (§6.5), sentinel filtering.
3. Persist parsed samples under the Garmin source; ensure idempotency (re-import safe).
**Files (server):** new `ofit-ingest` monitoring module; wire into the import handler / a new
`POST /api/import/garmin-wellness` (pattern of `handlers.rs:470-631`). **Android:** route file types.
**Test:** sync a day of wear; confirm Steps/HR/RestingHR/Stress/BodyBattery/Sleep/Respiration/SpO2/
HRV appear on the wellness dashboard under "… (Garmin)" with correct timestamps and no sentinels.

### Stage E — Realtime data + live HR

**Goal:** live HR and step deltas over ML services while connected.

1. Implement ML `toggleService(REALTIME_HR/STEPS, enable)` (register/close on handle 0) (§5.2).
2. Implement realtime decoders (raw, no COBS/CRC): HR (byte[1]), steps cumulative→delta with
   `previousSteps=-1` reset (§5.3).
3. Wire `onEnableRealtimeHeartRateMeasurement/Steps` to the live-activity screen open/close;
   `emitSample(...,conn)` with Garmin `source_id`.
**Files:** `GarminSession.java`, `OpenFitBlePlugin.emitSample`.
**Test:** open the live screen; HR updates ~1/s; step count increments; closing the screen sends
`CLOSE_HANDLE_REQ`.

### Stage F — Dual connection + sequential Sync UI

**Goal:** Helio AND Garmin connected simultaneously; "Sync now" runs Helio then Garmin sequentially,
skipping absent devices.

1. Land the `DeviceConnection` refactor: `Map<String,DeviceConnection>`, per-device GATT callback +
   op queue, per-device `huami`/`garmin`, periodic sync iteration (§7.2–7.3).
2. Per-device source attribution + `emitSample` source_id; primary-device HR feed guard (§7.4–7.5).
3. Foreground service multi-device counter/notification (§7.3).
4. Capacitor `syncNow({ deviceId, sinceMillis? })`; route to the right connection.
5. Web `NativeBleProvider` per-device state + dual-sync (`sync()` iterates Helio→Garmin,
   sequential, skip absent) (§7.6); dashboard per-device status/HR.
**Files:** `OpenFitBlePlugin.java`, `DeviceConnection.java`, `BleForegroundService.java`,
`RecordingService.java`, `NativeBleProvider.tsx`, plugin TS definitions.
**Test:** connect both; confirm independent live HR; "Sync now" syncs Helio fully, then Garmin
(activities + wellness), refreshing the UI once at the end; unplug one device and confirm the other
still syncs.

---

## 9. Risks & Gotchas

**Transport / framing**
- **Wrong UUID family is the #1 mistake.** FR945 is V2/multi-link — use `6A4E2800` + the
  `6A4E281x/282x` pair, never the V1 `6A4E2401` characteristic.
- The **1-byte ML handle is prepended to EVERY fragment**, not just the first. Budget
  `maxWriteSize-1` per chunk (`-2` for MLR).
- **COBS is non-standard** — leading **and** trailing `0x00`. Standard COBS libs will not
  interoperate; implement the Garmin variant exactly. A trailing-zero source byte appends an extra
  `0x01`.
- **CRC is the FIT/ANT nibble-table CRC**, not CRC-CCITT/Modbus/XMODEM. Use the exact 16-entry
  table; it covers the length+type bytes and is reused for the rolling file CRC and the FIT
  internal CRC. Compute over a stable `byte[]` slice, not a live buffer position.
- **Everything is little-endian** (length, type, CRC, payload ints). FIT payloads inside have their
  own architecture byte — don't cross the wires.
- **`0x8000` message-type high bit**: real id = `(type & 0xFF) + 5000`, bits 8–14 are a sequence
  number. Handle the mask or mis-parse ACKs.
- The **1500ms COBS inter-byte timeout** drops partial multi-fragment frames — never block the BLE
  callback thread; keep notification handling prompt.
- **MLR fall-through**: inbound packets with the `0x80` high bit can still be plain (non-MLR)
  handles (GB #5476). If no MLR communicator is registered for that handle, fall through to normal
  handling. Use plain ML (`reliable=0`) for bring-up.

**Pairing / handshake**
- **Bonding is mandatory** and is plain Android `BONDING_STYLE_ASK` — no in-protocol passkey. On
  GATT auth error 133/137 on the first write, `createBond()` then retry.
- The phone is **reactive**: the watch initiates DeviceInformation/AuthNegotiation. Send **ACK →
  reply → followup** in order; forgetting the ACK stalls the handshake. "Auth" is just ACKing
  AuthNegotiation with all flags zeroed.
- `clientId` must stay **2** (`GADGETBRIDGE_CLIENT_ID`); ML packets with other client ids are
  ignored.
- `writeString` is a **u8 length prefix + UTF-8, not null-terminated**, max 255.

**File sync / wellness**
- **Two CRC layers**: the chained rolling per-chunk transfer CRC and the FIT file's own trailing
  CRC are validated independently. No extra whole-file CRC in the GFDI transfer.
- Directory entries are **exactly 16 bytes** (`dataSize % 16 == 0`); **skip the all-zero entry** or
  loop forever.
- **Re-download avoidance is filesystem-only** (file exists AND length > 0); an empty file is
  re-fetched. Files are removed from the watch via `SetFileFlags ARCHIVE` (legacy) /
  `FileSetFlags` markSynced (v2) unless `keepActivityDataOnDevice` — keep it false since we own the
  watch.
- New-protocol quirks (if adopted): only the **first** File per type carries `type.name` (cache
  `code→name`); `nextPageId` can be 0 (fall back to max pageId); V2 payload is **zlib-compressed**
  (inflate before treating as FIT).
- **Body Battery is undocumented/dual-source**: `stress_level(#227) f3 body_energy` on most
  firmware, dedicated `hsa_body_battery_data(#314) level[]` on newer — parse both; #314 element i
  is at `ts253 + i*processing_interval`.
- **#55 cumulative-per-activity-type counters**: diff per activity_type and sum; a decrease means a
  midnight reset → previous = 0. `cycles` f3 default scale is 2, but the **steps subfield is scale
  1** (applying scale 2 halves steps).
- **Compact #55 timestamps**: reconstruct from the previous record with ±32768 rollover math; seed
  from an f253 anchor. `local_date_time < 0x10000000` is uptime, not wall clock — discard.
- **Sentinels**: stress `< 0` invalid; respiration raw `-300/-200/-100` and `≤ 0`; SpO2 `≤ 0` —
  filter before scaling. `sleep_level 0=unmeasurable` has no ofit equivalent (map 0/1→Awake or
  skip).
- The public python-fitparse profile **lacks** #297/#269/#275/#346/#314 — use the current Garmin
  fit-javascript-sdk profile or Gadgetbridge codegen for these.

**Realtime / live HR**
- FR945 (watch) does **not** expose a usable standard `0x180D` HRS to the phone — live HR is
  exclusively via ML service 6. (Only Garmin HRM straps use `0x180D` in GB.)
- Realtime is enabled by the **13-byte ML REGISTER_ML_REQ**, not a protobuf settings message. The
  `REALTIME_SETTINGS` protobuf and `REALTIME_TRACKING` are unrelated (settings UI mirror / GPS push
  to watch).
- **No cadence / pace / power live services exist**; calories/intensity/stress/body-battery have
  service codes but no decode callback. Those metrics arrive only in downloaded FIT files.
- Realtime payloads are **raw bytes, no COBS, no CRC**; steps are **cumulative** (diff to deltas;
  reset `previousSteps=-1` on (re)enable; counter resets at midnight). `hr==0` = no reading.
- Enabling "Broadcast Heart Rate" on the watch can **suspend** the phone GFDI link.

**Multi-connection (Android/web)**
- **HuamiSession is stateful** (ECDH/session key/HR keepalive) — never reuse across deviceIds, or
  auth fails. Verify no cross-device leakage with concurrent Helio + Garmin.
- Each `BluetoothGatt` allows **one in-flight op**; two devices ⇒ two parallel queues. Use
  `Handler.post` (not `postAtFront`) to avoid starvation; test simultaneous MTU + handshake on both.
- **Watermark write race**: `prefs().putLong("wm_" + deviceId, …)` is per-device but not atomic
  across concurrent writers. **Mitigate by serializing sync (Helio then Garmin) in the web layer.**
- **Foreground service type** stays `FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE`; keep notification
  text short ("Connected (2 devices)").
- **source_id must be set per device** in every wellness sample (or the server defaults everything
  to the shared "Live stream"), otherwise Helio vs Garmin HR cannot be distinguished.
- **Primary-device HR for recording**: only one device feeds `RecordingService.feedHeartRate`;
  decide failover behavior if the primary disconnects mid-workout.
