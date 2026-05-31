# Workout Recording — Design & Build

On-device workout recording for Open Fit: a native Android capture engine streams GPS, heart rate, bike BLE sensors, and phone IMU into a crash-safe local file; on Stop the phone encodes a spec-conformant `.fit` Activity file and uploads it through the existing `POST /api/import` path. Phone recordings merge with a later Garmin `.fit` import because both share the same `Sport` value and overlapping time, so the existing `cluster_recordings` single-linkage fuses them into one Activity.

---

## 1. Overview & Architecture

### 1.1 Goals (locked product decisions)

- **Multisport:** Running, Bike, Walking, Hiking, Calisthenics. Calisthenics is **indoor → no GPS**.
- **Sources captured per session:** GPS (LocationManager, no GMS) + Helio HR (already streaming live over BLE) + bike BLE sensors (CSC `0x1816` / CPS `0x1818`) + phone IMU @ 25 Hz as a **side-stream**.
- **Manual pause only.** No auto-pause.
- **Controls:** Start / Pause / Resume / Stop (Stop requires a 2-second hold).
- **Encode `.fit` ON THE PHONE at Stop**, then upload via the existing import path, offline-queued.
- **Live screen:** one big main metric + 2–3 selectable secondaries, with per-sport defaults.
- **Merge:** a phone recording must fuse with a later Garmin `.fit` import — identical `Sport` value + overlapping time → existing cluster.

### 1.2 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ React (Capacitor WebView)  — CONTROLLER + DISPLAY only            │
│  - Sport picker, live metric layout, Start/Pause/Resume/Stop(2s)  │
│  - Calls RecordingPlugin.@PluginMethod handlers                   │
│  - Subscribes to notifyListeners("tick") heartbeat (1 Hz)         │
└───────────────▲───────────────────────────────┬──────────────────┘
                │ JS bridge (low rate)           │ start/pause/stop
                │                                 ▼
┌───────────────┴───────────────────────────────────────────────────┐
│ RecordingPlugin (Capacitor 6 Java)  org.openfit.app                │
│  - Permission flow (FINE → BACKGROUND → POST_NOTIFICATIONS)        │
│  - Owns session state machine; wires Sink; starts/stops service    │
└───────────────▲───────────────────────────────┬───────────────────┘
                │ Sink callbacks (native thread)  │ Intent
                │                                 ▼
┌───────────────┴───────────────────────────────────────────────────┐
│ RecordingService (FGS type=location|connectedDevice)               │
│  - PARTIAL_WAKE_LOCK held for the whole session                    │
│  - GPS @1Hz (GPS_PROVIDER) + IMU @25Hz (HandlerThread)             │
│  - Bike BLE (CSC/CPS parser) + Helio HR hook (existing BLE stream) │
│  - Appends every sample to the crash-safe local recording file     │
└───────────────────────────────────────────────┬───────────────────┘
                                                 │ on Stop
                                                 ▼
┌───────────────────────────────────────────────────────────────────┐
│ FitEncoder (Java, from-scratch, AGPLv3-clean)                      │
│  - Reads the local recording file → writes spec-conformant .fit    │
│  - Multipart POST /api/import (field "file"), offline-queued       │
└────────────────────────────────────────────────┬──────────────────┘
                                                  ▼
        ofit-ingest → ofit-db (RawRecording + Streams) → cluster_recordings → Activity
```

### 1.3 Why native (not JS capture)

- **Background continuity:** accelerometer/gyroscope are non-wakeup sensors and GPS callbacks are CPU-bound. A foreground service keeps the *process* alive but does **not** keep the CPU awake; the device suspends on screen-off and sampling stops/drops. A **`PARTIAL_WAKE_LOCK`** held for the session duration is mandatory. JS in a backgrounded WebView is throttled/suspended and cannot meet "never stop sampling with the screen off."
- **Bridge saturation:** emitting a JS event per IMU sample at 25 Hz floods the Capacitor bridge. Capture and persist on a native `HandlerThread`; emit only a 1 Hz heartbeat to JS.
- **Clock alignment:** `SensorEvent.timestamp` and `Location.getElapsedRealtimeNanos()` share the `SystemClock.elapsedRealtimeNanos()` timebase. Native code aligns GPS and IMU on one monotonic clock; JS cannot.
- **Existing precedent:** the repo already ships a `connectedDevice`-typed `BleForegroundService` (`mobile/android/app/src/main/java/org/openfit/app/BleForegroundService.java:21`) and an `OpenFitBlePlugin` with `@PluginMethod`/`notifyListeners`/outbox patterns (`OpenFitBlePlugin.java:57`). We extend, not reinvent.

---

## 2. Data Model & Streams

### 2.1 StreamKind captured per sport

`StreamKind` has 16 variants (`crates/ofit-core/src/stream.rs:17–50`). On-device capture only produces the subset below; the IMU side-stream is **not** a first-class `StreamKind` (see §2.3).

| Sport         | GPS | HeartRate | Speed | Distance | Altitude | LatLng | Power | Cadence | IMU side-stream |
|---------------|:---:|:---------:|:-----:|:--------:|:--------:|:------:|:-----:|:-------:|:---------------:|
| Running       | ✅  | ✅ (Helio)| ✅ GPS| ✅ GPS   | ✅ GPS   | ✅     | —     | —       | ✅ 25 Hz        |
| Bike          | ✅  | ✅        | ✅ BLE/GPS | ✅  | ✅       | ✅     | ✅ CPS| ✅ CSC/CPS | ✅ 25 Hz     |
| Walking       | ✅  | ✅        | ✅ GPS| ✅ GPS   | ✅ GPS   | ✅     | —     | —       | ✅ 25 Hz        |
| Hiking        | ✅  | ✅        | ✅ GPS| ✅ GPS   | ✅ GPS   | ✅     | —     | —       | ✅ 25 Hz        |
| Calisthenics  | ❌ indoor | ✅  | —     | —        | —        | —      | —     | —       | ✅ 25 Hz        |

- **Speed/Distance** for Running/Walking/Hiking are derived from successive GPS fixes (Haversine on consecutive `LatLng`, cumulative distance). For Bike, prefer BLE CSC wheel speed when a speed sensor is paired; otherwise GPS.
- **Power/Cadence** for Bike come from the BLE CSC/CPS parser (§3.5).
- **HeartRate** comes from the existing Helio live BLE stream (already wired in `OpenFitBlePlugin`); the recording engine subscribes to the same sample feed.

`Sample` is one of (`crates/ofit-core/src/stream.rs:121–138`):
```rust
pub enum Sample {
    Scalar { t_offset_ms: i64, value: f64 },
    LatLng { t_offset_ms: i64, lat: f64, lng: f64 },
}
```
`t_offset_ms` is milliseconds since recording `started_at` and **must be non-decreasing** within a stream (`offset_ms(start, ts)` clamps to `>= 0`, `crates/ofit-ingest/src/lib.rs:257`).

### 2.2 Local on-device recording file (append-only, crash-safe)

We do **not** hold the session in RAM. The service writes an append-only **JSONL** file (one sample per line) under `getFilesDir()`, mirroring the existing outbox convention (`OpenFitBlePlugin.java:506`, JSONL format `crates/ofit-ingest/src/fit.rs:517`).

```
getFilesDir()/recordings/<sessionId>/session.meta.json   # written at Start, updated at Stop
getFilesDir()/recordings/<sessionId>/samples.jsonl       # append-only sample stream
```

`session.meta.json` (written once at Start, patched at Stop):
```json
{
  "sessionId": "uuid",
  "sport": "running",
  "startedAtUnixMs": 1748600000000,
  "deviceId": "openfit-phone-<androidId>",
  "wheelCircumferenceM": 2.105,
  "endedAtUnixMs": null,
  "segments": []
}
```

Each line in `samples.jsonl` (written from the native `HandlerThread`):
```json
{"t":1234,"k":"hr","v":142}
{"t":1234,"k":"latlng","lat":47.123456,"lng":-122.98765,"acc":8.0}
{"t":1240,"k":"speed","v":3.41}
{"t":1240,"k":"alt","v":61.2}
{"t":1240,"k":"dist","v":512.4}
{"t":1245,"k":"power","v":210}
{"t":1245,"k":"cadence","v":88}
{"t":1250,"k":"imu","ax":0.12,"ay":9.79,"az":0.31,"gx":0.001,"gy":-0.002,"gz":0.0}
{"t":1260,"k":"event","ev":"pause"}
{"t":1900,"k":"event","ev":"resume"}
```

- `t` = `t_offset_ms` since `startedAtUnixMs` (derived from `elapsedRealtimeNanos` deltas → ms; the wall start is captured once so absolute timestamps can be reconstructed at encode time).
- **Crash-safety:** open the file in append mode; after each batch (every ~1 s of samples) call `FileOutputStream.getFD().sync()` (or `flush()` then `fsync`) so a process kill loses at most ~1 s. On restart with `START_STICKY` (intent may be `null`), re-read `session.meta.json`, seek to EOF, and continue appending. The JSONL parser tolerates a truncated final line (skip a line that fails JSON parse).
- **Pause/Resume** are recorded as `event` lines; the encoder uses them to compute `total_timer_time` (moving) vs `total_elapsed_time` (wall) and to emit FIT `event` timer start/stop messages.

### 2.3 The IMU side-stream

The 25 Hz accel+gyro stream is captured for future on-device form analytics but is **not** mapped to a first-class `StreamKind` (there is no IMU variant in the 16). It is:
- persisted to `samples.jsonl` for crash-safety and later use, and
- **omitted from the encoded `.fit`** (FIT has no native raw-IMU record we round-trip through `ofit-ingest`).

It is downsampled in `samples.jsonl` only; it never crosses the JS bridge. If we later want it server-side, it ships as a sidecar upload, out of scope here.

---

## 3. Native Capture Engine

### 3.1 `RecordingService` (new), `org.openfit.app`

A single foreground service typed `location|connectedDevice` so it can own GPS, IMU, and the bike BLE stream simultaneously, alongside the already-present Helio BLE connection. Built on the skeleton from the Android capture finding:

```java
package org.openfit.app;

public class RecordingService extends Service
        implements SensorEventListener, LocationListener {
    public static final String CHANNEL_ID = "openfit_recording";
    public static final int NOTIF_ID = 1001;
    private static final long IMU_PERIOD_NS = 40_000_000L; // 25 Hz
    private static final int  IMU_PERIOD_US = 40_000;

    public interface Sink {
        void onLocation(double lat, double lon, double alt, float speed,
                        float bearing, float acc, long elapsedNanos, long wallMs);
        void onImu(int sensorType, float x, float y, float z, long elapsedNanos);
    }
    private static volatile Sink sink;
    public static void setSink(Sink s) { sink = s; }

    private HandlerThread thread; private Handler handler;
    private SensorManager sm; private LocationManager lm; private PowerManager.WakeLock wl;
    private final long[] lastEmit = new long[64]; // per sensor.type throttle

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        createChannel();
        Notification n = new Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Recording workout")
            .setContentText("GPS + motion sensors active")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setOngoing(true).build();

        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, n,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                | ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTIF_ID, n);
        }

        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "openfit:recording");
        wl.setReferenceCounted(false); wl.acquire();

        thread = new HandlerThread("recording-sensors"); thread.start();
        handler = new Handler(thread.getLooper());

        startImu(); startGps();   // GPS only if sport != Calisthenics (see §3.4)
        return START_STICKY;
    }

    private void startImu() {
        sm = (SensorManager) getSystemService(SENSOR_SERVICE);
        Sensor a = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
        Sensor g = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE);
        if (a != null) sm.registerListener(this, a, IMU_PERIOD_US, handler);
        if (g != null) sm.registerListener(this, g, IMU_PERIOD_US, handler);
    }

    @SuppressWarnings("MissingPermission")
    private void startGps() {
        lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        try {
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER,
                1000L, 0f, this, thread.getLooper());
        } catch (SecurityException ignored) {}
    }

    @Override public void onSensorChanged(SensorEvent e) {
        int t = e.sensor.getType();
        if (e.timestamp - lastEmit[t] < IMU_PERIOD_NS) return; // throttle to 25 Hz
        lastEmit[t] = e.timestamp;
        Sink s = sink;
        if (s != null) s.onImu(t, e.values[0], e.values[1], e.values[2], e.timestamp);
    }
    @Override public void onAccuracyChanged(Sensor s, int acc) {}

    @Override public void onLocationChanged(Location loc) {
        if (!loc.hasAccuracy() || loc.getAccuracy() > 50f) return; // accuracy filter
        Sink s = sink;
        if (s != null) s.onLocation(loc.getLatitude(), loc.getLongitude(),
            loc.hasAltitude()? loc.getAltitude():0, loc.hasSpeed()? loc.getSpeed():0,
            loc.hasBearing()? loc.getBearing():0, loc.getAccuracy(),
            loc.getElapsedRealtimeNanos(), loc.getTime());
    }
    @Override public void onProviderEnabled(String p) {}
    @Override public void onProviderDisabled(String p) {}
    @Override public void onStatusChanged(String p, int st, Bundle b) {}

    @Override public void onDestroy() {
        try { if (sm != null) sm.unregisterListener(this); } catch (Exception ignored) {}
        try { if (lm != null) lm.removeUpdates(this); } catch (Exception ignored) {}
        if (wl != null && wl.isHeld()) wl.release();
        if (thread != null) thread.quitSafely();
        if (Build.VERSION.SDK_INT >= 24) stopForeground(Service.STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent i) { return null; }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel c = new NotificationChannel(CHANNEL_ID,
                "Workout recording", NotificationManager.IMPORTANCE_LOW);
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(c);
        }
    }
}
```

### 3.2 Session state machine (in `RecordingPlugin`)

States: `IDLE → RECORDING ⇄ PAUSED → STOPPED`. The service runs continuously while `RECORDING` or `PAUSED`; **pause does not stop sampling** — it flips a `paused` flag so the Sink writes an `event:pause` line and stops advancing the "moving" accumulators. Manual pause only.

| Action  | From            | To         | Effect |
|---------|-----------------|------------|--------|
| `start` | IDLE            | RECORDING  | Create `session.meta.json`; `setSink`; `startForegroundService`; acquire wakelock; register GPS (unless Calisthenics) + IMU + bike BLE; subscribe Helio HR. |
| `pause` | RECORDING       | PAUSED     | Append `{"k":"event","ev":"pause"}`; stop accumulating moving-time/distance; keep service + wakelock + listeners alive (so resume is instant and GPS stays warm). |
| `resume`| PAUSED          | RECORDING  | Append `{"k":"event","ev":"resume"}`; resume accumulators. |
| `stop`  | RECORDING/PAUSED| STOPPED    | Append `endedAtUnixMs`; flush+fsync; unregister/`stopService`; release wakelock; invoke FitEncoder → multipart upload (§4–5). Triggered only after the 2-second UI hold. |

### 3.3 Sampling rates

| Stream      | Rate                | Mechanism |
|-------------|---------------------|-----------|
| GPS         | 1 Hz (`1000L, 0f`)  | `LocationManager.GPS_PROVIDER`, callbacks on HandlerThread Looper. |
| IMU         | 25 Hz (40 ms)       | `registerListener(..., 40_000, handler)`; **software throttle** in `onSensorChanged` (`event.timestamp - lastEmit >= 40_000_000L` ns). `samplingPeriodUs` is only a hint; `maxReportLatencyUs = 0` (no batching) so the FIFO never overflows during suspend. |
| Bike BLE    | sensor-driven       | CSC/CPS notifications (§3.5); typically ~1–4 Hz. |
| Helio HR    | sensor-driven (~1 Hz)| existing live BLE stream, reused. |

### 3.4 GPS gating by sport

`Calisthenics` is indoor: **do not** register `GPS_PROVIDER` and **do not** require background-location for it (still need POST_NOTIFICATIONS + FGS). The plugin passes the sport into the start Intent; `startGps()` is skipped when `sport == "calisthenics"`. This also means the FGS could start as `connectedDevice`-only for Calisthenics, but for code simplicity we keep the combined type and simply never call `requestLocationUpdates` (no location runtime perm is *used*, though the perm may still be held). For Calisthenics specifically, if FINE location is not granted, start with `FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE` only to avoid the location-type runtime prerequisite.

### 3.5 Bike BLE parsing (CSC + CPS)

Stateful per-sensor parsers, little-endian, `& 0xFF` masking, one instance per connected sensor, reset on reconnect.

**CSC — service `0x1816`, char `0x2A5B` (notify), CCCD `0x2902` ← `0x0001`.**
Flags (uint8): bit0 `0x01` wheel present, bit1 `0x02` crank present. Layouts: wheel-only len 7, crank-only len 5, both len 11; wheel fields always precede crank. Event time unit 1/1024 s, wraps mod 65536.

**CPS — service `0x1818`, char `0x2A63` (notify).**
Flags are **16-bit** (offset 0..1). Instantaneous Power is **sint16** at offset 2..3, always present. Crank offset math:
```
offset = 4
if (flags & 0x0001) offset += 1   // pedal power balance (u8)
if (flags & 0x0004) offset += 2   // accumulated torque (u16)
if (flags & 0x0010) offset += 6   // wheel rev data (u32 + u16, time 1/2048 s)
// crank present (flags & 0x0020): cumCrankRevs=u16@offset, lastCrankTime=u16@offset+2 (1/1024 s)
```

Reading helpers and the two parser classes:
```java
static int  u8 (byte[] d, int i){ return d[i] & 0xFF; }
static int  u16(byte[] d, int i){ return (d[i] & 0xFF) | ((d[i+1] & 0xFF) << 8); }
static int  s16(byte[] d, int i){ return (short)((d[i] & 0xFF) | ((d[i+1] & 0xFF) << 8)); }
static long u32(byte[] d, int i){ return (d[i]&0xFFL)|((d[i+1]&0xFFL)<<8)|((d[i+2]&0xFFL)<<16)|((d[i+3]&0xFFL)<<24); }

class Reading { Double speedMps; Double cadenceRpm; Integer powerW; }

class CscParser {
    double wheelCircumferenceM = 2.105;   // configurable, default 700x25c
    Long prevWheelRevs=null; Integer prevWheelTime=null;
    Integer prevCrankRevs=null; Integer prevCrankTime=null;
    Reading parse(byte[] d) {
        Reading r = new Reading();
        int flags = u8(d,0); int off = 1;
        boolean wheel=(flags&0x01)!=0, crank=(flags&0x02)!=0;
        if (wheel) {
            long curRevs=u32(d,off); off+=4; int curTime=u16(d,off); off+=2;
            if (prevWheelRevs!=null) {
                long dRevs=(curRevs-prevWheelRevs)&0xFFFFFFFFL;
                int dTicks=(curTime-prevWheelTime)&0xFFFF;
                if (dTicks!=0) r.speedMps=(dRevs*wheelCircumferenceM)/(dTicks/1024.0);
            }
            prevWheelRevs=curRevs; prevWheelTime=curTime;
        }
        if (crank) {
            int curRevs=u16(d,off); off+=2; int curTime=u16(d,off); off+=2;
            if (prevCrankRevs!=null) {
                int dRevs=(curRevs-prevCrankRevs)&0xFFFF;
                int dTicks=(curTime-prevCrankTime)&0xFFFF;
                if (dTicks!=0) r.cadenceRpm=(dRevs/(dTicks/1024.0))*60.0;
                else if (dRevs==0) r.cadenceRpm=0.0;
            }
            prevCrankRevs=curRevs; prevCrankTime=curTime;
        }
        return r;
    }
}

class CpsParser {
    Integer prevCrankRevs=null; Integer prevCrankTime=null;
    Reading parse(byte[] d) {
        Reading r = new Reading();
        int flags=u16(d,0);
        r.powerW=s16(d,2);                    // signed, always present
        int off=4;
        if ((flags&0x0001)!=0) off+=1;        // pedal power balance
        if ((flags&0x0004)!=0) off+=2;        // accumulated torque
        if ((flags&0x0010)!=0) off+=6;        // wheel rev data
        if ((flags&0x0020)!=0) {              // crank rev data
            int curRevs=u16(d,off), curTime=u16(d,off+2); // 1/1024 s
            if (prevCrankRevs!=null) {
                int dRevs=(curRevs-prevCrankRevs)&0xFFFF;
                int dTicks=(curTime-prevCrankTime)&0xFFFF;
                if (dTicks!=0) r.cadenceRpm=(dRevs/(dTicks/1024.0))*60.0;
                else if (dRevs==0) r.cadenceRpm=0.0;
            }
            prevCrankRevs=curRevs; prevCrankTime=curTime;
        }
        return r;
    }
}
```

Integration: one parser instance per sensor; reset `prev*` to `null` on disconnect/reconnect; guard `dTicks==0` (divide-by-zero / stationary); a wall-clock 2–3 s stationary timeout forces speed/cadence to 0 in the consumer. `wheelCircumferenceM` is user-configurable (stored in `session.meta.json`); default 2.105 m (700x25c).

### 3.6 Sink → file writer

The plugin sets a `Sink` that, on the native thread, converts each callback into a `samples.jsonl` line and the per-stream accumulators (cumulative distance, last speed). It also fans out a **1 Hz** summary to JS via `notifyListeners("tick", ...)` — never per-sample (25 Hz would saturate the bridge, per `OpenFitBlePlugin` precedent). HR samples arrive from the existing Helio feed and are written the same way.

---

## 4. On-Device FIT Encoder

A from-scratch, license-clean (AGPLv3) Java encoder. Output round-trips through the project's Rust `fitparser` reader (`crates/ofit-ingest/src/fit.rs`, via `fitparser::from_bytes`).

### 4.1 File layout

```
[ 14-byte File Header ]
[ Data Records  (exactly data_size bytes) ]
[ 2-byte trailing CRC-16, little-endian ]

file_total_bytes = 14 + data_size + 2
```
All integers little-endian (architecture = 0 in every definition). Verified: `test-data/RUN001-Stryd-export.fit` → `data_size=245739`, `+14+2 = 245755` = actual size.

### 4.2 File header (14 bytes), `ByteBuffer` LITTLE_ENDIAN

| Off | Sz | Field | Value |
|-----|----|-------|-------|
| 0 | u8 | header_size | `14` (0x0E) |
| 1 | u8 | protocol_version | `0x20` (FIT 2.0 packed nibble; **not** plain int 2) |
| 2..3 | u16 | profile_version | `21100` LE |
| 4..7 | u32 | data_size | bytes of DATA RECORDS only (excludes 14-byte header **and** 2-byte trailing CRC). Patch at finalize. |
| 8..11 | 4×u8 | ".FIT" | `0x2E 0x46 0x49 0x54` |
| 12..13 | u16 | header_crc | CRC-16 over header bytes `[0..11]`, LE. (0x0000 also legal.) |

### 4.3 Record (message) header byte — normal headers only

```
bit7 0x80 = 0   normal header (MUST be 0; 0x80 set = compressed-timestamp → misparse)
bit6 0x40 = D   1 = Definition, 0 = Data
bit5 0x20 = 0   developer-data flag (keep 0)
bit4 0x10 = 0   reserved (MUST be 0)
bits3..0        local message type (0..15)

Definition header = 0x40 | localType
Data       header = 0x00 | localType
```
Assign distinct local types: file_id=0, record=1, lap=2, session=3, activity=4, event=5.

### 4.4 Definition message body (after a 0x40-set header)

```
byte0 reserved      = 0x00
byte1 architecture  = 0x00 (LE)
byte2..3 global_msg_num u16 LE
byte4 num_fields    u8
then num_fields × { field_def_num u8, size_in_bytes u8, base_type u8 }  // in data-write order
```

### 4.5 Base type bytes

| name | byte | width | sentinel |
|------|------|-------|----------|
| enum | 0x00 | 1 | 0xFF |
| sint8 | 0x01 | 1 | 0x7F |
| uint8 | 0x02 | 1 | 0xFF |
| sint16 | 0x83 | 2 | 0x7FFF |
| uint16 | 0x84 | 2 | 0xFFFF |
| sint32 | 0x85 | 4 | 0x7FFFFFFF |
| uint32 | 0x86 | 4 | 0xFFFFFFFF |
| string | 0x07 | var | 0x00 |
| float32 | 0x88 | 4 | NaN |
| float64 | 0x89 | 8 | NaN |
| uint8z | 0x0A | 1 | 0x00 |
| uint16z | 0x8B | 2 | 0x0000 |
| uint32z | 0x8C | 4 | 0x00000000 |
| byte | 0x0D | var | 0xFF |
| sint64 | 0x8E | 8 | 0x7FFF…FF |
| uint64 | 0x8F | 8 | 0xFFFF…FF |
| uint64z | 0x90 | 8 | 0x0000…00 |

High bit (0x80) is set for **all** multi-byte types. Common bug: writing uint16 as `0x04` instead of `0x84`.

### 4.6 Message profiles (field_def_num, base_type, scale/offset, units)

`stored = round(real * scale - offset)`; `real = stored/scale + offset`.

**file_id (global #0) — MUST be first.**
- 0 type enum → `4` (Activity)
- 1 manufacturer uint16 → `255` (development; `fitparser` maps to "development", `fit.rs` placeholder)
- 2 product uint16 → `0`
- 3 serial_number uint32z → nonzero (e.g. `0x0FA1CE01`)
- 4 time_created uint32 (FIT timestamp)

**event (global #21) — recommended.**
- 253 timestamp uint32, 0 event enum (`0`=timer), 1 event_type enum (`0`=start, `4`=stop_all), 4 event_group uint8 (`0`)

**record (global #20) — one definition, N data messages.**
- 253 timestamp uint32 (s)
- 0 position_lat sint32 (semicircles)
- 1 position_long sint32 (semicircles)
- 2 altitude uint16 scale 5 offset 500 (m) → `stored = m*5 + 2500`
- 3 heart_rate uint8 (bpm)
- 4 cadence uint8 (rpm)
- 5 distance uint32 scale 100 (m)
- 6 speed uint16 scale 1000 (m/s)
- 7 power uint16 (W)
- 13 temperature sint8 (°C)

Every record DATA message contains values for **exactly** the fields in the single record definition, in order; write the base-type sentinel for any missing value, never skip.

**lap (global #19) — ≥1 required.**
- 253 timestamp uint32 (lap end), 254 message_index uint16 (`0`), 2 start_time uint32, 7 total_elapsed_time uint32 scale 1000 (s), 8 total_timer_time uint32 scale 1000 (s), 9 total_distance uint32 scale 100 (m). Optional 0 event enum (`9`=lap), 1 event_type enum (`1`=stop).

**session (global #18) — exactly one.**
- 253 timestamp, 254 message_index (`0`), 2 start_time, 5 sport enum, 6 sub_sport enum, 7 total_elapsed_time scale 1000, 8 total_timer_time scale 1000, 9 total_distance scale 100. Optional: 11 total_calories u16, 14 avg_speed (scale 1000), 15 max_speed, 16 avg_heart_rate u8, 17 max_heart_rate u8, 18 avg_cadence u8, 28 first_lap_index (`0`), 26 num_laps (`1`).

**activity (global #34) — MUST be last.**
- 253 timestamp, 0 total_timer_time uint32 scale 1000, 1 num_sessions uint16 (`1`), 2 type enum (`0`=manual), 3 event enum (`26`=activity), 4 event_type enum (`1`=stop), 5 local_timestamp uint32 (= timestamp if no offset tracked).

### 4.7 Sport enum (session field 5) — Open Fit sports → FIT

| Open Fit sport | FIT sport (field 5) | FIT sub_sport (field 6) |
|----------------|--------------------:|------------------------:|
| Running        | running = `1`       | generic = `0`           |
| Bike           | cycling = `2`       | generic = `0`           |
| Walking        | walking = `11`      | generic = `0`           |
| Hiking         | hiking = `17`       | generic = `0` (`hiking` is a sport value 17) |
| Calisthenics   | training = `10`     | strength_training = `20`|

> Note: `hiking` is sport enum 17 directly. Either `sport=17` or `sport=walking(11)` round-trips to `Sport::Walking` server-side (see §5.3) — we emit `17` to preserve intent, both cluster as `Walking`.

### 4.8 Timestamps & semicircles

FIT epoch = 1989-12-31T00:00:00Z = Unix `631065600` (NOT 1990-01-01).
```
fitTs(u32)   = unixSeconds - 631065600
unixSeconds  = fitTs + 631065600
local_timestamp = fitTs + localUtcOffsetSeconds
semicircles  = (int) Math.round(degrees * (2147483648.0 / 180.0));   // 2^31/180
degrees      = semicircles * (180.0 / 2147483648.0);
```
Invalid lat/long sentinel = `0x7FFFFFFF`. The reader uses `180 / 2^31` — matches.

### 4.9 CRC-16 (Garmin SDK; identical for header and trailing CRC)

```java
static final int[] CRC_TABLE = {
  0x0000,0xCC01,0xD801,0x1400,0xF001,0x3C00,0x2800,0xE401,
  0xA001,0x6C00,0x7800,0xB401,0x5000,0x9C01,0x8801,0x4400 };

static int crc16Update(int crc, int b) {
  int tmp;
  tmp = CRC_TABLE[crc & 0xF]; crc = (crc >>> 4) & 0x0FFF; crc = crc ^ tmp ^ CRC_TABLE[b & 0xF];
  tmp = CRC_TABLE[crc & 0xF]; crc = (crc >>> 4) & 0x0FFF; crc = crc ^ tmp ^ CRC_TABLE[(b >>> 4) & 0xF];
  return crc & 0xFFFF;
}
static int crc16(byte[] buf, int start, int end) {
  int crc = 0; for (int i=start;i<end;i++) crc = crc16Update(crc, buf[i]&0xFF); return crc & 0xFFFF;
}
```
- `header_crc = crc16(arr, 0, 12)` → bytes 12..13 LE.
- `trailing_crc = crc16(arr, 0, 14 + data_size)` — covers the **header (after data_size + header CRC are patched in) PLUS all records**, appended LE as the final 2 bytes. **Compute the trailing CRC last.**

### 4.10 Encoder pseudocode (finalize)

```java
ByteBuffer out = ByteBuffer.allocate(CAP).order(ByteOrder.LITTLE_ENDIAN);
int headerStart = out.position();              // 0
out.put((byte)14); out.put((byte)0x20); out.putShort((short)21100);
int dataSizePos = out.position(); out.putInt(0);                // patch later
out.put(new byte[]{0x2E,0x46,0x49,0x54});
int headerCrcPos = out.position(); out.putShort((short)0);
int dataStart = out.position();                // == 14
// ... writeDefinition + data messages in the §4.11 order ...
int dataEnd = out.position();
out.putInt(dataSizePos, dataEnd - dataStart);  // back-patch data_size (LE)
byte[] arr = out.array();
out.putShort(headerCrcPos, (short) crc16(arr, headerStart, headerStart + 12));
int fileCrc = crc16(arr, 0, dataEnd);
out.putShort((short) fileCrc);                 // append at position == dataEnd
byte[] fitFile = Arrays.copyOf(arr, dataEnd + 2);
```
```java
class Field { int num,size,baseType; Field(int n,int s,int b){num=n;size=s;baseType=b;} }
long fitTs(long unixSec){ return unixSec - 631065600L; }
int toSemicircles(double deg){ return (int)Math.round(deg * (2147483648.0/180.0)); }
```
Record definition example:
```java
Field[] recDef = {
  new Field(253,4,0x86), new Field(0,4,0x85), new Field(1,4,0x85),
  new Field(2,2,0x84),  new Field(3,1,0x02), new Field(5,4,0x86),
  new Field(6,2,0x84),  new Field(7,2,0x84),
};
```

### 4.11 Message order (minimal valid activity)

```
1. file_id            (REQUIRED, first; type=4, manufacturer=255, time_created)
2. event timer-start  (event=0, event_type=0)         — recommended
3. record …           (REQUIRED; 1 definition + N data; emit pause/resume as event timer stop/start)
4. event timer-stop   (event=0, event_type=4 stop_all) — recommended
5. lap                (REQUIRED ≥1; message_index 0)
6. session            (REQUIRED exactly 1; carries sport+sub_sport)
7. activity           (REQUIRED, last; num_sessions=1, type=0, event=26, event_type=1)
```
Load-bearing for round-trip (per `fit.rs`): file_id, record(s), session/sport. lap+activity make it well-formed.

### 4.12 Round-trip TEST PLAN (against the existing parser)

The encoder ships with a Rust integration test that feeds encoder output back through `fitparser` exactly as `ofit-ingest` does.

1. **Golden header bytes** — unit test asserts the 14-byte header for a known input decodes as `size=0x0E, proto=0x20, data_size LE`, and that `file_total = 14 + data_size + 2` equals the byte array length (mirrors the `RUN001-Stryd-export.fit` invariant).
2. **CRC vectors** — assert `crc16` over a fixed byte buffer matches a precomputed value; assert header CRC and trailing CRC are recomputed after `data_size`/header-CRC patching.
3. **Round-trip via fitparser** — a Rust test (in `crates/ofit-ingest/tests/`) loads an encoder-produced `.fit` byte vector and calls the same path as `fit::parse(name, bytes)` (`crates/ofit-ingest/src/fit.rs:16`). Assert:
   - `file_id` detected; sport read from "Sport"/"Session" (`fit.rs:32–36`) → `sport_from_str()` (`crates/ofit-ingest/src/lib.rs:225`) yields the expected `Sport` variant.
   - `record` messages extracted (`extract_record()`, `fit.rs:238`); `streams_found` equals the count of distinct StreamKinds written.
   - LatLng decodes via `pos * (180 / 2^31)` (`fit.rs:13, 245–246`) back to input degrees within tolerance (≤ 1e-5°).
   - `heart_rate`, `power`, `cadence`, `speed`, `altitude`, `distance` decode to within scale-rounding tolerance.
4. **Full pipeline** — call `ofit_ingest::import_bytes_path(db, "phone.fit", bytes)` (`crates/ofit-ingest/src/pipeline.rs:82`) against an in-memory test DB; assert `ImportOutcome::Imported { recording_id, activity_id, stream_count }`.
5. **Dedup** — import the same bytes twice; second returns `ImportOutcome::Duplicate` (content hash, `crates/ofit-ingest/src/lib.rs:214–222`).
6. **Sample data file** — encode a 10-sample running activity, write to `test-data/`, and `git`-ignore it (already see `test-data/` untracked); keep one checked-in golden if small.

---

## 5. Upload, Offline Queue & Merge-with-Garmin

### 5.1 Upload endpoint contract

- **`POST /api/import`** (`crates/ofit-api/src/handlers.rs:59`).
- `multipart/form-data`, field name **`"file"`** (`web/src/api/endpoints.ts:292`), arbitrary binary bytes (FIT auto-detected by ".FIT" at offset 8, `crates/ofit-ingest/src/lib.rs:149`). Multiple files allowed.
- Response `ImportResponse` (`crates/ofit-api/src/dto.rs:16–37`):
```json
{ "files": [ { "filename": "2026-05-30_run.fit", "ok": true,
  "recording_id": "uuid", "activity_id": "uuid", "deduped": false,
  "streams_found": 5, "error": null } ] }
```
- The phone uploads the **raw encoder bytes verbatim** — any modification changes the SHA-256 content hash (the exact-dedup key) and creates a duplicate.

### 5.2 Offline queue

On Stop, the encoder writes the `.fit` to `getFilesDir()/recordings/<sessionId>/workout.fit` and enqueues a pending upload. Reuse the proven outbox/flush mechanics from `OpenFitBlePlugin` (`appendOutbox` ~line 513, `flushOutbox` ~line 541, watermark in `SharedPreferences`):
- Attempt `POST /api/import` with Bearer auth (same auth as `/api/wellness`).
- On 2xx → mark uploaded, delete local `workout.fit` (keep `samples.jsonl` until upload confirmed, then prune).
- On failure → leave file queued; retry on next connectivity / app foreground.
- A finished `.fit` is a single file (not 1 Hz JSONL), so the 300k-line `OUTBOX_MAX_LINES` cap is not a concern here; cap instead on a max number of queued `.fit` files (e.g. 50) and surface a warning.

### 5.3 Sport-mapping table (proves the merge)

The phone must emit a sport whose FIT string maps to the **same** `Sport` variant `sport_from_str()` would assign to the later Garmin file (`crates/ofit-ingest/src/lib.rs:225–235`).

| Open Fit sport | Phone FIT `sport` | Garmin FIT `sport` (typical) | `sport_from_str()` result | Clusters? |
|----------------|------------------:|------------------------------|---------------------------|:---------:|
| Running        | `running` (1)     | `running`/`trail_running`/`treadmill_running` | `Sport::Running` | ✅ |
| Bike           | `cycling` (2)     | `cycling`/`road_biking`/`mountain_biking`/`indoor_cycling` | `Sport::Cycling` | ✅ |
| Walking        | `walking` (11)    | `walking` | `Sport::Walking` | ✅ |
| Hiking         | `hiking` (17)     | `hiking` | `Sport::Walking` | ✅ |
| Calisthenics   | `training`+`strength_training` (10/20) | `strength_training`/`training`/`weight_training` | `Sport::Strength` | ✅ |

(`"running"|"run"|"trail_running"|"treadmill_running" → Running`; `"cycling"|"biking"|"bike"|"road_biking"|"mountain_biking"|"indoor_cycling" → Cycling`; `"walking"|"walk"|"hiking"|"hike" → Walking`; `"strength"|"strength_training"|"training"|"weight_training" → Strength`.)

### 5.4 How it clusters

On every import, `recluster_and_persist(db, target_recording)` (`crates/ofit-ingest/src/pipeline.rs:167`) runs `cluster_recordings_respecting(&recordings, &locked)` (`crates/ofit-core/src/dedup.rs:62`). Single-linkage: a recording joins the first activity where `activity.accepts(recording)` (`crates/ofit-core/src/activity.rs:48`), predicate = `sport == sport && overlaps(time_windows)` (`crates/ofit-core/src/recording.rs:132–134`). So the phone recording and the later Garmin import fuse iff same `Sport` variant **and** overlapping time. A free activity reuses its existing ID if a member matches; otherwise a new one is inserted (`pipeline.rs:200–215`).

**Merge gotchas to honor:**
- **Clustering lock:** if the user already confirmed the phone-only activity (`user_confirmed=true`), it is **never re-clustered** and the later Garmin import cannot join it (`crates/ofit-ingest/src/pipeline.rs:176–181, 187–194`). Don't auto-confirm phone activities if a Garmin merge is expected.
- **Source attribution:** embed a stable device id (`session.meta.json` `deviceId = "openfit-phone-<androidId>"`) so each device maps to one `Source` (`SourceKind::Device`) for multi-metric resolution priority.
- **Timestamps:** emit UTC; FIT timestamps are derived from UTC seconds; `offset_ms(start, ts)` clamps `>= 0`.

---

## 6. React Workout UI

React is **controller + display only**; all capture is native. It calls plugin methods and renders a 1 Hz heartbeat.

### 6.1 Flow

1. **Sport picker** — choose Running / Bike / Walking / Hiking / Calisthenics. Selection sets per-sport metric defaults and whether GPS is requested (Calisthenics → no GPS).
2. **Permission gate** — before first Start, run the incremental permission flow (§7.2). Bike additionally surfaces sensor pairing + `wheelCircumferenceM` input.
3. **Live screen** — big main metric + 2–3 selectable secondaries; controls.
4. **Stop (hold 2s)** → encode + queue upload → summary card from `ImportResponse`.

### 6.2 Per-sport metric layouts

| Sport         | Main metric        | Default secondaries (2–3)                 | Selectable pool |
|---------------|--------------------|-------------------------------------------|-----------------|
| Running       | Pace (min/km)      | Heart rate, Distance, Duration            | Pace, HR, Distance, Duration, Cadence, Altitude |
| Bike          | Speed (km/h)       | Power, Cadence, Heart rate                | Speed, Power, Cadence, HR, Distance, Duration, Altitude |
| Walking       | Duration           | Distance, Heart rate, Pace                | Duration, Distance, HR, Pace, Steps(IMU), Altitude |
| Hiking        | Distance           | Altitude (ascent), Duration, Heart rate   | Distance, Altitude, Duration, HR, Pace |
| Calisthenics  | Duration           | Heart rate, (avg HR)                      | Duration, HR, avg HR |

(Main + each secondary are derived from the 1 Hz `tick` payload: current HR, cumulative distance, derived pace/speed, elapsed moving time, current altitude/ascent, current power/cadence.)

### 6.3 Selectable-metric interaction

- Tap a secondary tile → opens a chooser listing the sport's selectable pool; pick replaces that tile. Selections persist per sport in local storage.
- Long-press the main metric → swap main with a chosen metric (the displaced one moves to a free secondary slot).
- The chooser only offers metrics actually being captured for the active sport (e.g. Power/Cadence appear for Bike only when a CPS/CSC sensor is connected).

### 6.4 Controls (incl. hold-2s Stop)

- **Start** (IDLE) → `RecordingPlugin.start({ sport, wheelCircumferenceM })`.
- **Pause** (RECORDING) → `pause()`; tile values freeze visually, moving-time stops.
- **Resume** (PAUSED) → `resume()`.
- **Stop** — a press-and-hold button: a 2000 ms radial/linear progress fills while held; release before 2 s cancels; completing the hold fires `stop()`. Implement with `onPointerDown`/`onPointerUp` + a `requestAnimationFrame` progress timer; on completion disable the button and show "Saving…". Prevents accidental end mid-workout.

The screen keeps the device awake natively (wakelock) regardless of WebView state; the React layer should also set `screen.keepAwake` while on the live screen for display, but must not rely on it for capture.

---

## 7. Manifest / Permissions Diff

### 7.1 `AndroidManifest.xml` (`mobile/android/app/src/main/AndroidManifest.xml`)

**Permissions (inside `<manifest>`):**
```xml
<!-- Foreground location -->
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<!-- Background location: FGS (re)start while backgrounded + screen-locked location -->
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />
<!-- FGS + location type -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
<!-- already present: FOREGROUND_SERVICE_CONNECTED_DEVICE, POST_NOTIFICATIONS -->
<!-- keep CPU awake with screen off -->
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-feature android:name="android.hardware.location.gps" android:required="false" />
```

**REMOVE the `android:maxSdkVersion="30"` cap** from the existing `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` lines (currently capped for legacy BLE scan, manifest lines ~56–57). With the cap, the app holds **no** location permission on Android 11–14 and the location FGS throws `SecurityException`.

**Service element (inside `<application>`):**
```xml
<service
    android:name=".RecordingService"
    android:exported="false"
    android:foregroundServiceType="location|connectedDevice" />
```
Combined type means you must satisfy **both** prerequisites at every start: a granted FINE/COARSE runtime permission (for location) and a declared `BLUETOOTH_*` permission (already present, for connectedDevice), and pass `FOREGROUND_SERVICE_TYPE_LOCATION | FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE` to `startForeground`.

### 7.2 Runtime permission flow (Capacitor 6 Java plugin)

Strict, incremental order:
1. **POST_NOTIFICATIONS** (API 33+) — so the FGS notification is visible.
2. **ACCESS_FINE_LOCATION** (while-in-use): `requestPermissionForAlias("location", call, "cb")` — request FINE+COARSE together. **Never bundle background here.**
3. **ACCESS_BACKGROUND_LOCATION** — only after FINE granted, in a **separate** request. On API ≤ 29 the inline "Allow all the time" dialog appears; on API ≥ 30 show a rationale (use `PackageManager.getBackgroundPermissionOptionLabel()` for the exact OEM label) and route to Settings via `ACTION_APPLICATION_DETAILS_SETTINGS`, then verify `== PERMISSION_GRANTED` on resume. (Skip background-location for Calisthenics.)
4. **Location services enabled:** `lm.isProviderEnabled(GPS_PROVIDER)` — prompt if false. Use `PermissionChecker.checkSelfPermission` before `startForeground`.

Plugin annotation:
```java
@CapacitorPlugin(name="Recording", permissions = {
  @Permission(strings={Manifest.permission.ACCESS_FINE_LOCATION}, alias="location"),
  @Permission(strings={Manifest.permission.ACCESS_BACKGROUND_LOCATION}, alias="backgroundLocation"),
  @Permission(strings={Manifest.permission.POST_NOTIFICATIONS}, alias="notifications") })
public class RecordingPlugin extends Plugin { ... }
```
Start the service:
```java
Context ctx = getContext();
Intent svc = new Intent(ctx, RecordingService.class).putExtra("sport", sport);
if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(svc); else ctx.startService(svc);
// startForeground MUST be called within ~5 s or the OS kills the service (ANR).
```

---

## 8. Sport Enum + StreamKind Reference

### 8.1 `Sport` enum (`crates/ofit-core/src/recording.rs:15–28`)

```rust
pub enum Sport { Running, Cycling, Swimming, Walking, Strength, Other }
```

`sport_from_str()` mapping (`crates/ofit-ingest/src/lib.rs:225–235`):

| FIT strings | → Sport |
|-------------|---------|
| `running` `run` `trail_running` `treadmill_running` | `Running` |
| `cycling` `biking` `bike` `road_biking` `mountain_biking` `indoor_cycling` | `Cycling` |
| `swimming` `swim` `lap_swimming` `open_water` | `Swimming` |
| `walking` `walk` `hiking` `hike` | `Walking` |
| `strength` `strength_training` `training` `weight_training` | `Strength` |
| _ (anything else) | `Other` |

Open Fit product sports → server `Sport`: Running→Running, Bike→Cycling, Walking→Walking, Hiking→Walking, Calisthenics→Strength.

### 8.2 `StreamKind` (16 variants, `crates/ofit-core/src/stream.rs:17–50`) and FIT extraction (`fit.rs:238–319`)

| StreamKind | unit | FIT field(s) (extraction line) |
|------------|------|--------------------------------|
| HeartRate | bpm | `heart_rate` (251) |
| Power | W | `power` / `Power` (254) |
| Cadence | rpm | `cadence` (255) |
| Speed | m/s | `enhanced_speed` \| `speed` (260) |
| Altitude | m | `enhanced_altitude` \| `altitude` (267) |
| LatLng | "" | `position_lat` + `position_long` semicircles (245–248) |
| Wind | m/s | — |
| Temperature | °C | `temperature` (271) |
| Distance | m | `distance` (270) |
| VerticalOscillation | mm | `vertical_oscillation` \| `Vertical Oscillation` ×10 (281–284) |
| GroundContactTime | ms | `stance_time` \| `Ground Time` (289–295) |
| StrideLength | mm | `step_length` \| `cycle_length16` ×1000 (299–302) |
| VerticalRatio | % | `vertical_ratio` (307) |
| FormPower | W | `Form Power` Stryd (310) |
| AirPower | W | `Air Power` Stryd (311) |
| LegSpringStiffness | kN/m | `Leg Spring Stiffness` Stryd (317) |

On-device capture writes: **HeartRate, Speed, Distance, Altitude, LatLng** (GPS sports) and **Power, Cadence** (Bike). Stryd/running-dynamics fields and Wind are not produced on-device (they arrive via Garmin/Stryd imports and merge into the same activity).

---

## 9. Staged Implementation Plan

### Stage 1 — Native capture engine

Goal: continuous GPS + IMU + HR + bike BLE captured to a crash-safe local file, controllable from JS.

1. `AndroidManifest.xml`: add location/FGS-location/WAKE_LOCK permissions and the `gps` feature; **remove `maxSdkVersion=30`** cap on FINE/COARSE; add `.RecordingService` with `foregroundServiceType="location|connectedDevice"`. *(mobile/android/app/src/main/AndroidManifest.xml)*
2. Create `RecordingService.java` (§3.1): FGS start with combined type, `PARTIAL_WAKE_LOCK`, `HandlerThread`, GPS @1Hz, IMU @25Hz with software throttle, `START_STICKY` with null-intent guard. *(mobile/.../org/openfit/app/RecordingService.java)*
3. Add `CscParser.java` / `CpsParser.java` (§3.5) and wire bike BLE notifications into the Sink; store `wheelCircumferenceM`. *(new files, same package)*
4. Hook the existing Helio HR live stream into the same Sink (reuse `OpenFitBlePlugin` HR feed). *(OpenFitBlePlugin.java integration point)*
5. Implement the Sink → `samples.jsonl` writer with append + periodic `fsync`; write/patch `session.meta.json`. *(RecordingService / a small `RecordingFile.java`)*
6. Create `RecordingPlugin.java` (§7.2): `@PluginMethod start/pause/resume/stop/configure`, permission aliases + callbacks, state machine, `setSink`, `startForegroundService`/`stopService`, 1 Hz `notifyListeners("tick")`. *(new file)*
7. Register the plugin (Capacitor 6 auto-registers package-scanned plugins; verify it's picked up like `OpenFitBlePlugin`).

**Stage 1 exit:** start a session, lock the screen 10 min, confirm `samples.jsonl` keeps growing with GPS + 25 Hz IMU lines and `event` pause/resume lines.

### Stage 2 — FIT encoder + upload

Goal: encode a spec-conformant `.fit` at Stop and upload it through `/api/import`, offline-queued, proven by round-trip tests.

1. Create `FitEncoder.java`: header, definition/data writers, base-type table, semicircle/epoch helpers, CRC-16, finalize/back-patch (§4.1–4.11). *(mobile/.../org/openfit/app/FitEncoder.java)*
2. Create `RecordingToFit.java`: read `samples.jsonl` + `session.meta.json` → ordered messages (file_id → event start → records → event stop → lap → session → activity), map sport via §4.7, compute `total_elapsed_time` vs `total_timer_time` from pause/resume events. *(new file)*
3. Wire `stop()` → encode → write `workout.fit` → enqueue. *(RecordingPlugin)*
4. Implement offline upload queue: multipart `POST /api/import` field `"file"`, Bearer auth, retry-on-failure, prune on 2xx; reuse outbox/flush/watermark patterns. *(RecordingPlugin, mirroring OpenFitBlePlugin:506–541)*
5. **Tests:** add `crates/ofit-ingest/tests/phone_fit_roundtrip.rs` — feed encoder bytes (generated by a small fixture or committed golden) through `fit::parse` and `import_bytes_path`; assert sport, streams, LatLng tolerance, dedup, `ImportOutcome::Imported`. Add Java unit tests for header bytes + CRC vectors. *(crates/ofit-ingest/tests/, mobile test sources)*

**Stage 2 exit:** a recorded session uploads and appears as a RawRecording + Streams + Activity; re-upload dedups; round-trip test green.

### Stage 3 — React workout UI

Goal: sport picker, live metrics, controls.

1. Sport picker screen with per-sport defaults; persists last sport. *(web/src/…)*
2. TypeScript wrapper around the `Recording` plugin (`start/pause/resume/stop/configure`, `addListener("tick")`). *(web/src/…)*
3. Live screen: big main metric + 2–3 selectable secondary tiles fed by `tick`; per-sport layout table (§6.2); tile chooser + main-swap interaction (§6.3). *(web/src/…)*
4. Controls: Start/Pause/Resume + hold-2s Stop with progress + cancel (§6.4). *(web/src/…)*
5. Permission UX: pre-Start gate that drives the incremental flow; rationale + Settings deep-link for background location; bike pairing + wheel-circumference input.
6. Post-Stop summary from `ImportResponse` (streams_found, dedup, activity link); offline "queued, will upload" state.

**Stage 3 exit:** full record → live → stop → summary loop on-device, screen-locked safe.

### Stage 4 — Merge verification

Goal: prove phone + Garmin fuse into one Activity.

1. Record a phone Running session; export the same run from Garmin (use `test-data/RUN001-*` and `BIKE001-*` as reference fixtures).
2. Import phone `.fit` then Garmin `.fit` (overlapping time, same sport) via `/api/import`; assert both share one `activity_id` (clustering, `pipeline.rs:167`, `dedup.rs:62`).
3. Test the **lock** case: confirm an activity (`user_confirmed=true`), then import the other file — assert it does **not** re-cluster into the locked activity (`pipeline.rs:176–181`); decide product behavior (don't auto-confirm phone activities pre-merge).
4. Test each sport row of §5.3 maps to the expected `Sport` and clusters; Bike with BLE power/cadence present.
5. Verify Source attribution: stable `deviceId` yields one `SourceKind::Device` Source across sessions.

**Stage 4 exit:** documented, repeatable merge test (Rust integration test + manual device run) showing one fused Activity per Sport+overlap.

---

## 10. Risks & Gotchas

**FIT encoder**
- Trailing CRC covers the **header too** (offset 0 through end of data records) — compute it **after** patching `data_size` and the header CRC, or it's wrong.
- `data_size` counts **only** the data-records section (excludes 14-byte header and 2-byte trailing CRC). `file_size = 14 + data_size + 2`.
- Base type byte has 0x80 set for **all** multi-byte types (uint16=0x84, sint32=0x85, …). Writing uint16 as 0x04 is the classic bug.
- Record header bit 0x80 **must be 0** (normal header); set it and you get a compressed-timestamp header that misparses. Definition=0x40, data=0x00, dev bit 0x20 stays 0.
- Every DATA message must carry **exactly** the defined fields in order/width; write sentinels for missing values, never skip.
- `uint32z` (file_id.serial_number) treats 0 as "no value" — serial must be nonzero.
- FIT epoch is **1989-12-31** (Unix 631065600), not 1990-01-01. Semicircle factor is **2^31/180** (not 2^32). Off-by-one-day or wrong power = global shift / ~2× position error.
- Local message type is only 4 bits (0..15); we use ~6, well within range.

**Android capture**
- Android 14 (target 34): location-typed `startForeground` throws `SecurityException`/`ForegroundServiceTypeNotAllowedException` unless `FOREGROUND_SERVICE_LOCATION` is declared **and** FINE/COARSE is already granted; started while backgrounded also needs `ACCESS_BACKGROUND_LOCATION` (else `ForegroundServiceStartNotAllowedException`).
- The existing FINE/COARSE `maxSdkVersion=30` cap means **no** location permission on 11–14 — must remove it.
- A FGS does **not** keep the CPU awake; non-wakeup IMU + CPU-bound GPS stop on screen-off. `PARTIAL_WAKE_LOCK` for the session duration is mandatory.
- Never bundle background location with FINE on API 11+ (OS silently denies both); request separately, route to Settings on API ≥ 30.
- `samplingPeriodUs` (40000) is a hint; throttle in software via `event.timestamp` deltas. Keep `maxReportLatencyUs = 0` (no batching) so the FIFO never overflows during suspend.
- Use `elapsedRealtimeNanos` (shared IMU/GPS timebase), not `currentTimeMillis`, to align streams; `Location.getTime()` is wall-clock and can jump.
- Register on a dedicated `HandlerThread`, never the main thread (competes with the WebView).
- Use `GPS_PROVIDER`, not `FusedLocationProviderClient` (absent on AOSP/de-Googled). Guard with try/catch `SecurityException` for mid-run revocation.
- `startForegroundService` → `startForeground` within ~5 s or ANR; build the channel+notification first thing.
- `START_STICKY` re-runs `onStartCommand` with a **null intent** — guard and re-derive state from `session.meta.json`.
- Don't emit a JS event per IMU sample at 25 Hz — buffer natively, emit only the 1 Hz heartbeat.
- Combined `location|connectedDevice` requires satisfying **both** prerequisites every start and OR-ing both type constants.
- OEM battery optimizers (Xiaomi/Huawei/Samsung) can still kill a wakelock-holding FGS; on sideloaded installs guide users to `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.

**Bike BLE**
- CPS Flags is **16-bit** (offset 0..1); CSC Flags is 8-bit. CPS Instantaneous Power is **signed** sint16. CPS wheel time is 1/2048 s but **crank time is 1/1024 s** (use 1024 for cadence).
- Mandatory u16 rollover mask `(cur - prev) & 0xFFFF`; guard `dTicks == 0` (divide-by-zero / stationary). Wheel revs are u32, crank revs u16 in both services. One parser per sensor; reset `prev*` on reconnect. Always mask `& 0xFF`/`& 0xFFL`. Wheel circumference must be user-configurable (default 2.105 m).

**Merge / integration**
- Sport must map to the **same** `Sport` variant as `sport_from_str()` (§5.3) or recordings won't cluster despite overlap.
- Upload **raw bytes verbatim** — SHA-256 content hash is the dedup key; any modification duplicates.
- `t_offset_ms` must be non-decreasing; emit UTC; offsets clamp `>= 0`.
- **Clustering lock:** confirmed activities never re-cluster — don't auto-confirm phone activities if a Garmin merge is expected.
- Embed a stable `deviceId` so the phone is one `SourceKind::Device` Source for multi-metric resolution.
- LatLng is semicircles (÷2^31 × 180); `fitparser` does **not** auto-convert (`fit.rs:13, 245`).
