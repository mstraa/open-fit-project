package org.openfit.app;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.TreeMap;

/**
 * From-scratch (license-clean) FIT Activity encoder. Reads a recorded session
 * (session.meta.json + samples.jsonl) and produces a spec-conformant `.fit` byte
 * array that the project's Rust fitparser reads back. See
 * docs/WORKOUT-RECORDING-DESIGN.md §4 for the exact layout this implements.
 *
 * Records are bucketed to 1 Hz (GPS/HR/distance/speed). The 25 Hz IMU side-stream
 * is intentionally NOT written to FIT records (no standard message + it would
 * bloat the file); it stays in samples.jsonl for later use.
 */
public final class FitEncoder {
    private FitEncoder() {}

    // local message types
    private static final int LT_FILE_ID = 0, LT_EVENT = 1, LT_RECORD = 2,
        LT_LAP = 3, LT_SESSION = 4, LT_ACTIVITY = 5;

    // base type bytes
    private static final int ENUM = 0x00, U8 = 0x02, U16 = 0x84, U32 = 0x86, S32 = 0x85, U32Z = 0x8C;

    /** A 1-second record accumulator. */
    private static final class Rec {
        double lat = Double.NaN, lng = Double.NaN, alt = Double.NaN, spd = Double.NaN, dist = Double.NaN;
        int hr = -1, cad = -1, pwr = -1;
        boolean hasPos() { return !Double.isNaN(lat) && !Double.isNaN(lng); }
    }

    public static byte[] encode(File dir) throws Exception {
        JSONObject meta = new JSONObject(readFile(new File(dir, "session.meta.json")));
        String sport = meta.optString("sport", "running");
        long startUnixSec = meta.optLong("startedAtUnixMs", System.currentTimeMillis()) / 1000L;
        long timerMs = meta.optLong("elapsedMs", 0);
        int steps = meta.optInt("steps", -1); // total step count (step detector), -1 = unknown

        TreeMap<Integer, Rec> bySec = new TreeMap<>();
        double maxSpeed = 0, finalDist = 0;
        long hrSum = 0;
        int hrCount = 0, hrMax = 0;

        try (BufferedReader r = new BufferedReader(new FileReader(new File(dir, "samples.jsonl")))) {
            String line;
            while ((line = r.readLine()) != null) {
                if (line.isEmpty()) continue;
                JSONObject o;
                try { o = new JSONObject(line); } catch (Exception e) { continue; }
                String k = o.optString("k", "");
                int sec = (int) (o.optLong("t", 0) / 1000L);
                Rec rec = bySec.get(sec);
                if (rec == null && (k.equals("gps") || k.equals("hr") || k.equals("dist")
                    || k.equals("cad") || k.equals("pwr"))) {
                    rec = new Rec();
                    bySec.put(sec, rec);
                }
                if (rec == null) continue; // acc/gyr/ev → not in FIT records
                switch (k) {
                    case "gps":
                        rec.lat = o.optDouble("lat", Double.NaN);
                        rec.lng = o.optDouble("lng", Double.NaN);
                        rec.alt = o.optDouble("alt", Double.NaN);
                        rec.spd = o.optDouble("spd", Double.NaN);
                        if (!Double.isNaN(rec.spd) && rec.spd > maxSpeed) maxSpeed = rec.spd;
                        break;
                    case "dist":
                        rec.dist = o.optDouble("v", Double.NaN);
                        if (!Double.isNaN(rec.dist)) finalDist = Math.max(finalDist, rec.dist);
                        break;
                    case "hr":
                        rec.hr = o.optInt("v", -1);
                        if (rec.hr > 0) { hrSum += rec.hr; hrCount++; if (rec.hr > hrMax) hrMax = rec.hr; }
                        break;
                    case "cad": rec.cad = o.optInt("v", -1); break;
                    case "pwr": rec.pwr = o.optInt("v", -1); break;
                    default: break;
                }
            }
        }

        int firstSec = bySec.isEmpty() ? 0 : bySec.firstKey();
        // With no 1 Hz records (no HR strap + no GPS fix) fall back to the timer
        // so the session still advertises the workout's real duration instead of
        // a zero-length window. The server now persists such record-less sessions.
        int lastSec = bySec.isEmpty() ? (int) (Math.max(0, timerMs) / 1000L) : bySec.lastKey();
        long startTs = fitTs(startUnixSec + firstSec);
        long endTs = fitTs(startUnixSec + lastSec);
        long elapsedSec = Math.max(0, lastSec - firstSec);
        long timerSec = timerMs > 0 ? timerMs / 1000 : elapsedSec;
        int avgHr = hrCount > 0 ? (int) (hrSum / hrCount) : 0;

        int cap = Math.max(64 * 1024, bySec.size() * 32 + 8192);
        ByteBuffer b = ByteBuffer.allocate(cap).order(ByteOrder.LITTLE_ENDIAN);

        // --- header (data_size + header CRC patched at finalize) ---
        b.put((byte) 14);
        b.put((byte) 0x20);            // protocol 2.0
        b.putShort((short) 21100);     // profile version
        int dataSizePos = b.position();
        b.putInt(0);
        b.put(new byte[]{ 0x2E, 0x46, 0x49, 0x54 }); // ".FIT"
        int headerCrcPos = b.position();
        b.putShort((short) 0);
        int dataStart = b.position();  // == 14

        // --- file_id (#0, first) ---
        defn(b, LT_FILE_ID, 0, new int[][]{ {0, 1, ENUM}, {1, 2, U16}, {2, 2, U16}, {3, 4, U32Z}, {4, 4, U32} });
        b.put((byte) LT_FILE_ID);
        b.put((byte) 4);                 // type = activity
        b.putShort((short) 255);         // manufacturer = development
        b.putShort((short) 0);           // product
        b.putInt(0x0FA1CE01);            // serial (nonzero)
        b.putInt((int) fitTs(startUnixSec));

        // --- event: timer start ---
        int[][] evDef = { {253, 4, U32}, {0, 1, ENUM}, {1, 1, ENUM}, {4, 1, U8} };
        defn(b, LT_EVENT, 21, evDef);
        eventMsg(b, startTs, 0);         // event_type 0 = start

        // --- record definition + data (1 Hz) ---
        defn(b, LT_RECORD, 20, new int[][]{
            {253, 4, U32}, {0, 4, S32}, {1, 4, S32}, {2, 2, U16}, {3, 1, U8},
            {4, 1, U8}, {5, 4, U32}, {6, 2, U16}, {7, 2, U16},
        });
        for (java.util.Map.Entry<Integer, Rec> e : bySec.entrySet()) {
            record(b, fitTs(startUnixSec + e.getKey()), e.getValue());
        }

        // --- event: timer stop_all ---
        eventMsg(b, endTs, 4);           // event_type 4 = stop_all

        // --- lap (one) ---
        defn(b, LT_LAP, 19, new int[][]{
            {253, 4, U32}, {254, 2, U16}, {2, 4, U32}, {7, 4, U32}, {8, 4, U32}, {9, 4, U32},
        });
        b.put((byte) LT_LAP);
        b.putInt((int) endTs);
        b.putShort((short) 0);                       // message_index
        b.putInt((int) startTs);                     // start_time
        b.putInt((int) (elapsedSec * 1000));         // total_elapsed_time (scale 1000)
        b.putInt((int) (timerSec * 1000));           // total_timer_time
        b.putInt((int) Math.round(finalDist * 100)); // total_distance (scale 100)

        // --- session (one) ---
        int[] sp = sportCodes(sport);
        defn(b, LT_SESSION, 18, new int[][]{
            {253, 4, U32}, {254, 2, U16}, {2, 4, U32}, {5, 1, ENUM}, {6, 1, ENUM},
            {7, 4, U32}, {8, 4, U32}, {9, 4, U32}, {16, 1, U8}, {17, 1, U8}, {10, 4, U32},
        });
        b.put((byte) LT_SESSION);
        b.putInt((int) endTs);
        b.putShort((short) 0);
        b.putInt((int) startTs);
        b.put((byte) sp[0]);                         // sport
        b.put((byte) sp[1]);                         // sub_sport
        b.putInt((int) (elapsedSec * 1000));
        b.putInt((int) (timerSec * 1000));
        b.putInt((int) Math.round(finalDist * 100));
        b.put((byte) (avgHr > 0 ? avgHr : 0xFF));
        b.put((byte) (hrMax > 0 ? hrMax : 0xFF));
        b.putInt(steps >= 0 ? steps : 0xFFFFFFFF);   // total_cycles = total steps (0xFFFFFFFF = unset)

        // --- activity (last) ---
        defn(b, LT_ACTIVITY, 34, new int[][]{
            {253, 4, U32}, {0, 4, U32}, {1, 2, U16}, {2, 1, ENUM}, {3, 1, ENUM}, {4, 1, ENUM}, {5, 4, U32},
        });
        b.put((byte) LT_ACTIVITY);
        b.putInt((int) endTs);
        b.putInt((int) (timerSec * 1000));           // total_timer_time
        b.putShort((short) 1);                        // num_sessions
        b.put((byte) 0);                              // type = manual
        b.put((byte) 26);                             // event = activity
        b.put((byte) 1);                              // event_type = stop
        b.putInt((int) endTs);                        // local_timestamp (no tz offset tracked)

        // --- finalize: patch data_size, header CRC, append file CRC ---
        int dataEnd = b.position();
        b.putInt(dataSizePos, dataEnd - dataStart);
        byte[] arr = b.array();
        int hcrc = crc16(arr, 0, 12);
        arr[headerCrcPos] = (byte) (hcrc & 0xFF);
        arr[headerCrcPos + 1] = (byte) ((hcrc >> 8) & 0xFF);
        int fcrc = crc16(arr, 0, dataEnd);
        byte[] out = Arrays.copyOf(arr, dataEnd + 2);
        out[dataEnd] = (byte) (fcrc & 0xFF);
        out[dataEnd + 1] = (byte) ((fcrc >> 8) & 0xFF);
        return out;
    }

    private static void defn(ByteBuffer b, int localType, int globalNum, int[][] fields) {
        b.put((byte) (0x40 | localType));
        b.put((byte) 0);   // reserved
        b.put((byte) 0);   // architecture = little-endian
        b.putShort((short) globalNum);
        b.put((byte) fields.length);
        for (int[] f : fields) {
            b.put((byte) f[0]); // field_def_num
            b.put((byte) f[1]); // size
            b.put((byte) f[2]); // base type
        }
    }

    private static void eventMsg(ByteBuffer b, long ts, int eventType) {
        b.put((byte) LT_EVENT);
        b.putInt((int) ts);
        b.put((byte) 0);          // event = timer
        b.put((byte) eventType);  // event_type
        b.put((byte) 0);          // event_group
    }

    private static void record(ByteBuffer b, long ts, Rec r) {
        b.put((byte) LT_RECORD);
        b.putInt((int) ts);
        b.putInt(r.hasPos() ? toSemicircles(r.lat) : 0x7FFFFFFF);
        b.putInt(r.hasPos() ? toSemicircles(r.lng) : 0x7FFFFFFF);
        b.putShort(!Double.isNaN(r.alt) ? (short) Math.round(r.alt * 5 + 2500) : (short) 0xFFFF);
        b.put(r.hr > 0 ? (byte) r.hr : (byte) 0xFF);
        b.put(r.cad >= 0 ? (byte) r.cad : (byte) 0xFF);
        b.putInt(!Double.isNaN(r.dist) ? (int) Math.round(r.dist * 100) : 0xFFFFFFFF);
        b.putShort(!Double.isNaN(r.spd) ? (short) Math.round(r.spd * 1000) : (short) 0xFFFF);
        b.putShort(r.pwr >= 0 ? (short) r.pwr : (short) 0xFFFF);
    }

    /** {sport, sub_sport} FIT enums for an Open Fit sport label. */
    private static int[] sportCodes(String sport) {
        switch (sport) {
            case "running": return new int[]{ 1, 0 };
            case "cycling": return new int[]{ 2, 0 };
            case "walking": return new int[]{ 11, 0 };
            case "hiking": return new int[]{ 17, 0 };
            case "calisthenics": return new int[]{ 10, 20 }; // training / strength_training
            default: return new int[]{ 0, 0 };
        }
    }

    private static long fitTs(long unixSec) { return unixSec - FitSpec.FIT_EPOCH_OFFSET; }
    private static int toSemicircles(double deg) { return (int) Math.round(deg * FitSpec.DEGREES_TO_SEMICIRCLES); }

    private static final int[] CRC_TABLE = {
        0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
        0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
    };

    private static int crc16(byte[] buf, int start, int end) {
        int crc = 0;
        for (int i = start; i < end; i++) {
            int b = buf[i] & 0xFF;
            int tmp = CRC_TABLE[crc & 0xF];
            crc = (crc >>> 4) & 0x0FFF;
            crc = crc ^ tmp ^ CRC_TABLE[b & 0xF];
            tmp = CRC_TABLE[crc & 0xF];
            crc = (crc >>> 4) & 0x0FFF;
            crc = crc ^ tmp ^ CRC_TABLE[(b >>> 4) & 0xF];
        }
        return crc & 0xFFFF;
    }

    private static String readFile(File f) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new FileReader(f))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
        }
        return sb.toString();
    }
}
