package org.openfit.app.huami;

import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.util.Calendar;
import java.util.GregorianCalendar;
import java.util.TimeZone;
import java.util.function.Consumer;

/**
 * Pulls the Helio's STORED wellness over BLE (Zepp-OS / Huami activity-fetch
 * protocol), ported from Gadgetbridge's AbstractFetchOperation + the per-type
 * Fetch*Operation classes (AGPLv3).
 *
 * The transport is identical for every metric — START_DATE → FETCH_DATA → data
 * packets (raw char 0x0005) → FETCH_DATA response (CRC) → ACK — only the data
 * TYPE byte and the record format differ. So one fetch can sweep several types
 * sequentially (ACTIVITY, then STRESS, HRV, RESTING_HR, SPO2). Control commands
 * are written raw to char 0x0004; their responses arrive on the same char.
 */
public class HuamiFetch {
    private static final String TAG = "HuamiFetch";

    // Control commands / responses.
    private static final byte CMD_START_DATE = 0x01;
    private static final byte CMD_FETCH_DATA = 0x02;
    private static final byte CMD_ACK = 0x03;
    private static final byte RESPONSE = 0x10;
    private static final byte SUCCESS = 0x01;

    // Fetch data types (HuamiFetchDataType — values verified against Gadgetbridge).
    public static final byte TYPE_ACTIVITY = 0x01;     // per-minute steps + HR (+sleep bytes)
    public static final byte TYPE_STRESS = 0x13;       // STRESS_AUTOMATIC, per-minute byte
    public static final byte TYPE_SPO2 = 0x25;         // SPO2_NORMAL, 65-byte records
    public static final byte TYPE_RESTING_HR = 0x3a;   // RESTING_HEART_RATE, 6-byte records
    public static final byte TYPE_HRV = 0x49;          // HRV, 6-byte records

    public interface Sink {
        /** A parsed sample: kind ("steps"/"heart_rate"/"stress"/"hrv"/…), value, epoch millis. */
        void sample(String kind, double value, long tsMillis);
        /** The whole multi-type fetch finished. */
        void done(boolean ok);
        void log(String msg);
    }

    private final Consumer<byte[]> writeControl; // → raw GATT char 0x0004
    private final Sink sink;

    private boolean active = false;
    private byte type;
    private byte[] typeQueue = new byte[0];
    private int typeIndex = 0;
    private long sinceMillis;
    private int lastPacketCounter;
    private long startMillis;
    private int expectedRecords;
    private final ByteArrayOutputStream buffer = new ByteArrayOutputStream(4096);

    public HuamiFetch(Consumer<byte[]> writeControl, Sink sink) {
        this.writeControl = writeControl;
        this.sink = sink;
    }

    public boolean isActive() {
        return active;
    }

    /** Sweep the given data types in order since {@code sinceMillis}. */
    public void startSync(long sinceMillis, byte[] types) {
        this.sinceMillis = sinceMillis;
        this.typeQueue = types;
        this.typeIndex = 0;
        Log.i(TAG, "startSync since=" + sinceMillis + " types=" + types.length);
        startNextType();
    }

    private void startNextType() {
        if (typeIndex >= typeQueue.length) {
            sink.done(true);
            return;
        }
        active = true;
        type = typeQueue[typeIndex];
        lastPacketCounter = -1;
        buffer.reset();
        byte[] cmd = concat(new byte[]{CMD_START_DATE, type}, timeBytes(sinceMillis));
        sink.log("fetch: type 0x" + String.format("%02x", type) + " since " + sinceMillis);
        writeControl.accept(cmd);
    }

    /** Inbound control response (raw char 0x0004 payload). */
    public void onControl(byte[] v) {
        if (!active || v.length < 3 || v[0] != RESPONSE) {
            return;
        }
        switch (v[1]) {
            case CMD_START_DATE:
                onStartDate(v);
                return;
            case CMD_FETCH_DATA:
                onFetchDataResponse(v);
                return;
            case CMD_ACK:
                finishType(true);
                return;
            default:
                Log.w(TAG, "unexpected control " + String.format("0x%02x", v[1]));
                finishType(false);
        }
    }

    /** Inbound data packet (raw char 0x0005): [counter, ...records]. */
    public void onData(byte[] v) {
        if (!active || v.length == 0) return;
        if ((byte) (lastPacketCounter + 1) == v[0]) {
            lastPacketCounter++;
            buffer.write(v, 1, v.length - 1); // skip the counter byte
        } else {
            sink.log("fetch: bad packet counter " + v[0] + " (last " + lastPacketCounter + ")");
            active = false; // out of sync; let the device's FETCH_DATA response close it
        }
    }

    private void onStartDate(byte[] v) {
        if (v[2] != SUCCESS) {
            sink.log("fetch: 0x" + String.format("%02x", type) + " start not ok (0x" + String.format("%02x", v[2]) + ")");
            finishType(false);
            return;
        }
        expectedRecords = le32(v, 3);
        startMillis = parseTs(v, 7);
        if (expectedRecords == 0) {
            sink.log("fetch: 0x" + String.format("%02x", type) + " nothing new");
            sendAck();
            return;
        }
        sink.log("fetch: 0x" + String.format("%02x", type) + " " + expectedRecords + " records");
        writeControl.accept(new byte[]{CMD_FETCH_DATA});
    }

    private void onFetchDataResponse(byte[] v) {
        if (v[2] != SUCCESS) {
            finishType(false);
            return;
        }
        boolean ok = true;
        if (v.length == 7) {
            int crc = le32(v, 3);
            ok = crc == HuamiCrypto.crc32(buffer.toByteArray(), 0, buffer.size());
            if (!ok) sink.log("fetch: CRC mismatch");
        }
        if (ok) {
            byte[] buf = buffer.toByteArray();
            switch (type) {
                case TYPE_ACTIVITY: parseActivity(buf, startMillis); break;
                case TYPE_STRESS: parseStress(buf, startMillis); break;
                case TYPE_HRV: parseTimestamped6(buf, "hrv", 1, 255); break;
                case TYPE_RESTING_HR: parseTimestamped6(buf, "resting_heart_rate", 25, 220); break;
                case TYPE_SPO2: parseSpo2(buf); break;
                default: break;
            }
        }
        sendAck();
    }

    /** ACTIVITY: per-minute records. 4-byte = [rawKind,rawIntensity,steps,hr];
     *  8-byte (extended) keeps steps@2/hr@3. The extra bytes 4-7 are NOT sleep —
     *  on this device they are flat/sentinel during the day (verified by a byte
     *  dump), so we emit ONLY steps + HR. Record size is derived from the data
     *  length / the device-reported record count (the Helio uses 8). */
    private void parseActivity(byte[] bytes, long firstMinuteMillis) {
        int size = 4;
        if (expectedRecords > 0) {
            int s = bytes.length / expectedRecords;
            size = s >= 8 ? 8 : 4;
        } else if (bytes.length % 8 == 0) {
            size = 8;
        }
        int emitted = 0;
        for (int i = 0; i + size <= bytes.length; i += size) {
            long ts = firstMinuteMillis + (long) (i / size) * 60_000L;
            int steps = bytes[i + 2] & 0xff;
            int hr = bytes[i + 3] & 0xff;
            if (hr > 0 && hr < 255) {
                sink.sample("heart_rate", hr, ts);
                emitted++;
            }
            if (steps > 0) {
                sink.sample("steps", steps, ts);
                emitted++;
            }
        }
        sink.log("fetch: activity " + (bytes.length / size) + " min, emitted " + emitted);
    }

    /** STRESS_AUTOMATIC: one byte per minute from startMillis; 0xff = not measured. */
    private void parseStress(byte[] bytes, long firstMinuteMillis) {
        int n = 0;
        for (int i = 0; i < bytes.length; i++) {
            int s = bytes[i] & 0xff;
            if (s >= 1 && s <= 100) {
                sink.sample("stress", s, firstMinuteMillis + (long) i * 60_000L);
                n++;
            }
        }
    }

    /** HRV / RESTING_HEART_RATE: 6-byte records [ts(4, LE epoch secs), unk, value]. */
    private void parseTimestamped6(byte[] bytes, String kind, int lo, int hi) {
        int n = 0;
        for (int off = 0; off + 6 <= bytes.length; off += 6) {
            long ts = le32u(bytes, off) * 1000L;
            int val = bytes[off + 5] & 0xff;
            if (val >= lo && val <= hi && ts > 0) {
                sink.sample(kind, val, ts);
                n++;
            }
        }
    }

    /** SPO2_NORMAL: 1 version byte, then 65-byte records [ts(4 LE secs), spo2, …60].
     *  spo2 raw is signed: negative ⇒ automatic measurement, value = raw + 128. */
    private void parseSpo2(byte[] bytes) {
        if (bytes.length < 66 || (bytes.length - 1) % 65 != 0) {
            sink.log("fetch: spo2 unexpected len " + bytes.length);
            return;
        }
        int n = 0;
        for (int off = 1; off + 65 <= bytes.length; off += 65) {
            long ts = le32u(bytes, off) * 1000L;
            int raw = bytes[off + 4]; // signed
            int spo2 = raw < 0 ? raw + 128 : raw;
            if (spo2 >= 50 && spo2 <= 100 && ts > 0) {
                sink.sample("sp_o2", spo2, ts);
                n++;
            }
        }
    }

    private void sendAck() {
        // ZeppOS: 0x09 = keep data on device (we don't delete it).
        writeControl.accept(new byte[]{CMD_ACK, 0x09});
    }

    /** A type completed (ok or not) — advance to the next, or finish the sweep. */
    private void finishType(boolean ok) {
        active = false;
        buffer.reset();
        typeIndex++;
        startNextType();
    }

    // ---- helpers (ported from BLETypeConversions) ----

    /** 8-byte start-date: yearLo,yearHi,month,day,hour,minute,seconds(0),tzQuarterHrs. */
    static byte[] timeBytes(long millis) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(millis);
        int year = c.get(Calendar.YEAR);
        byte tz = (byte) (c.getTimeZone().getOffset(millis) / (1000 * 60 * 15));
        return new byte[]{
            (byte) (year & 0xff), (byte) ((year >> 8) & 0xff),
            (byte) (c.get(Calendar.MONTH) + 1), (byte) c.get(Calendar.DATE),
            (byte) c.get(Calendar.HOUR_OF_DAY), (byte) c.get(Calendar.MINUTE),
            0, tz,
        };
    }

    /** Parse the device's timestamp (local time + tz quarter-hours) → epoch millis. */
    static long parseTs(byte[] v, int off) {
        if (v.length < off + 7) return System.currentTimeMillis();
        int year = (v[off] & 0xff) | ((v[off + 1] & 0xff) << 8);
        GregorianCalendar c = new GregorianCalendar(
            year, (v[off + 2] & 0xff) - 1, v[off + 3] & 0xff,
            v[off + 4] & 0xff, v[off + 5] & 0xff, v[off + 6] & 0xff);
        if (v.length > off + 7) {
            TimeZone tz = TimeZone.getTimeZone("UTC");
            tz.setRawOffset(v[off + 7] * 15 * 60 * 1000);
            c.setTimeZone(tz);
        }
        return c.getTimeInMillis();
    }

    static int le32(byte[] v, int o) {
        return (v[o] & 0xff) | ((v[o + 1] & 0xff) << 8) | ((v[o + 2] & 0xff) << 16) | ((v[o + 3] & 0xff) << 24);
    }

    /** Unsigned little-endian 32-bit (epoch seconds fit in 31 bits until 2038, but
     *  mask to be safe). */
    static long le32u(byte[] v, int o) {
        return ((long) (v[o] & 0xff)) | ((long) (v[o + 1] & 0xff) << 8)
            | ((long) (v[o + 2] & 0xff) << 16) | ((long) (v[o + 3] & 0xff) << 24);
    }

    static byte[] concat(byte[] a, byte[] b) {
        byte[] out = new byte[a.length + b.length];
        System.arraycopy(a, 0, out, 0, a.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }
}
