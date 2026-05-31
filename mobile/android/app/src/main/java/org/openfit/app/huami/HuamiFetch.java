package org.openfit.app.huami;

import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.GregorianCalendar;
import java.util.List;
import java.util.TimeZone;
import java.util.function.Consumer;

/**
 * Pulls the Helio's STORED wellness over BLE (Zepp-OS activity-fetch protocol),
 * ported from Gadgetbridge's AbstractFetchOperation / FetchActivityOperation
 * (AGPLv3). M2: the ACTIVITY type = per-minute steps + heart rate.
 *
 * Transport (driven by HuamiSession): control commands are written to the
 * encrypted chunked endpoint 0x004b and their responses arrive there too
 * ({@link #onControl}); the bulk data records stream on the raw char 0x0005
 * ({@link #onData}). The state machine: START_DATE → (FETCH_DATA) → data packets
 * → FETCH_DATA response (CRC) → parse → ACK.
 */
public class HuamiFetch {
    private static final String TAG = "HuamiFetch";

    // Control commands / responses (HuamiService).
    private static final byte CMD_START_DATE = 0x01;
    private static final byte CMD_FETCH_DATA = 0x02;
    private static final byte CMD_ACK = 0x03;
    private static final byte RESPONSE = 0x10;
    private static final byte SUCCESS = 0x01;

    // Fetch data types (HuamiFetchDataType).
    static final byte TYPE_ACTIVITY = 0x01;

    public interface Sink {
        /** A parsed sample: kind ("steps"/"heart_rate"), value, epoch millis. */
        void sample(String kind, double value, long tsMillis);
        /** Fetch finished (success or not). */
        void done(boolean ok);
        void log(String msg);
    }

    private final Consumer<byte[]> writeControl; // → chunked endpoint 0x004b (encrypted)
    private final Sink sink;

    private boolean active = false;
    private byte type;
    private int lastPacketCounter;
    private long startMillis;
    private final ByteArrayOutputStream buffer = new ByteArrayOutputStream(4096);

    public HuamiFetch(Consumer<byte[]> writeControl, Sink sink) {
        this.writeControl = writeControl;
        this.sink = sink;
    }

    public boolean isActive() {
        return active;
    }

    /** Begin fetching ACTIVITY (steps + HR per minute) since {@code sinceMillis}. */
    public void startActivity(long sinceMillis) {
        if (active) return;
        active = true;
        type = TYPE_ACTIVITY;
        lastPacketCounter = -1;
        buffer.reset();
        byte[] cmd = concat(new byte[]{CMD_START_DATE, type}, timeBytes(sinceMillis));
        sink.log("fetch: start activity since " + sinceMillis);
        writeControl.accept(cmd);
    }

    /** Inbound control response (chunked endpoint 0x004b payload). */
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
                finish(true);
                return;
            default:
                Log.w(TAG, "unexpected control " + String.format("0x%02x", v[1]));
                finish(false);
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
            sink.log("fetch: start-date not successful");
            finish(false);
            return;
        }
        int expectedPackets = le32(v, 3);
        startMillis = parseTs(v, 7);
        if (expectedPackets == 0) {
            sink.log("fetch: nothing new");
            sendAck();
            return;
        }
        sink.log("fetch: " + expectedPackets + " packets since " + startMillis);
        // Ask the device to start streaming the data packets (on char 0x0005).
        writeControl.accept(new byte[]{CMD_FETCH_DATA});
    }

    private void onFetchDataResponse(byte[] v) {
        if (v[2] != SUCCESS) {
            finish(false);
            return;
        }
        // Optional 4-byte CRC32 over the buffered records at [3..7].
        boolean ok = true;
        if (v.length == 7) {
            int crc = le32(v, 3);
            ok = crc == HuamiCrypto.crc32(buffer.toByteArray(), 0, buffer.size());
            if (!ok) sink.log("fetch: CRC mismatch");
        }
        if (ok) {
            parseActivity(buffer.toByteArray(), startMillis);
        }
        sendAck();
    }

    /** ACTIVITY: 4-byte records [rawKind, rawIntensity, steps, heartRate]/minute. */
    private void parseActivity(byte[] bytes, long firstMinuteMillis) {
        final int size = 4;
        if (bytes.length % size != 0) {
            sink.log("fetch: activity size % 4 != 0 (" + bytes.length + ")");
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
        sink.log("fetch: parsed " + (bytes.length / size) + " minutes, emitted " + emitted + " samples");
    }

    private void sendAck() {
        // ZeppOS: 0x09 = keep data on device (we don't delete it).
        writeControl.accept(new byte[]{CMD_ACK, 0x09});
    }

    private void finish(boolean ok) {
        active = false;
        buffer.reset();
        sink.done(ok);
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

    static byte[] concat(byte[] a, byte[] b) {
        byte[] out = new byte[a.length + b.length];
        System.arraycopy(a, 0, out, 0, a.length);
        System.arraycopy(b, 0, out, a.length, b.length);
        return out;
    }

    // (unused placeholder to keep List import meaningful for future multi-day batching)
    @SuppressWarnings("unused")
    private List<Long> reserved = new ArrayList<>();
}
