package org.openfit.app.garmin;

import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.function.Consumer;

/**
 * Drives a Garmin GFDI session over the multi-link (ML) transport:
 *   1. ML handshake — CLOSE_ALL_REQ → REGISTER_ML_REQ(GFDI) → REGISTER_ML_RESP
 *      (yields the 1-byte GFDI handle that prefixes every GFDI write).
 *   2. GFDI handshake — the watch sends DeviceInformation (5024) + AuthNegotiation
 *      (5101); we ACK + reply, then on its capabilities we completeInitialization
 *      (SupportedFileTypes + SYNC_READY) → link ready for file sync.
 *
 * Transport-agnostic: the plugin supplies a write callback (→ the send char,
 * already chunked by the op queue) and feeds inbound notifications via onNotify.
 * Ported from Gadgetbridge's Garmin support (AGPLv3). See
 * docs/GARMIN-GFDI-DESIGN.md §2–3. Stage A/B; file sync (Stage C) hooks via the
 * listener's onGfdiMessage.
 */
public class GarminSession {
    private static final String TAG = "GarminSession";

    // ML request types (ordinals)
    private static final int REGISTER_ML_REQ = 0, REGISTER_ML_RESP = 1, CLOSE_ALL_REQ = 5, CLOSE_ALL_RESP = 6;
    private static final int SERVICE_GFDI = 1;
    private static final long CLIENT_ID = 2L;

    // GFDI message ids
    private static final int RESPONSE = 5000, DEVICE_SETTINGS = 5026, SYSTEM_EVENT = 5030,
        SUPPORTED_FILE_TYPES_REQUEST = 5031, DEVICE_INFORMATION = 5024, PROTOBUF_REQUEST = 5043,
        CONFIGURATION = 5050, AUTH_NEGOTIATION = 5101;
    private static final int STATUS_ACK = 0;
    private static final int SYS_EVENT_SYNC_READY = 8;

    public interface Listener {
        void onLog(String msg);
        void onReady();
        void onGfdiMessage(int msgId, byte[] payload);
    }

    private final Consumer<byte[]> write; // → send characteristic (op queue chunks further if needed)
    private final Listener listener;
    private final String btName;
    private final GarminCobs cobs = new GarminCobs();
    private int maxWriteSize = 20;
    private int gfdiHandle = -1;
    private boolean ready = false;
    private boolean initialized = false;

    public GarminSession(String btName, Consumer<byte[]> write, Listener listener) {
        this.btName = btName == null ? "OpenFit" : btName;
        this.write = write;
        this.listener = listener;
    }

    public void setMaxWriteSize(int mtu) {
        this.maxWriteSize = Math.max(20, mtu - 3);
    }

    /** Begin the ML handshake (call once notifications are enabled). */
    public void start() {
        Log.i(TAG, "ML start: CLOSE_ALL_REQ");
        listener.onLog("garmin: handshake start");
        write.accept(mlFrame(CLOSE_ALL_REQ, 0, 0));
    }

    /** Feed an inbound notification from the receive characteristic. */
    public void onNotify(byte[] value) {
        if (value == null || value.length == 0) return;
        int handle = value[0] & 0xFF;
        if ((handle & 0x80) != 0) {
            // MLR (reliable) packet — we registered plain ML, so ignore.
            return;
        }
        if (handle == 0x00) {
            handleMl(value);
            return;
        }
        if (handle == gfdiHandle) {
            cobs.feed(Arrays.copyOfRange(value, 1, value.length), System.currentTimeMillis());
            byte[] msg;
            while ((msg = cobs.retrieve()) != null) {
                handleGfdiFrame(msg);
            }
        }
    }

    // ---- ML handle management (handle 0x00) ----

    private void handleMl(byte[] v) {
        if (v.length < 2) return;
        int type = v[1] & 0xFF;
        if (type == CLOSE_ALL_RESP) {
            Log.i(TAG, "ML CLOSE_ALL_RESP → REGISTER_ML_REQ(GFDI)");
            write.accept(mlFrame(REGISTER_ML_REQ, SERVICE_GFDI, 0));
        } else if (type == REGISTER_ML_RESP) {
            // [0]=ml handle, [1]=type, [2..9]=clientId, [10,11]=service, [12]=status, [13]=handle, [14]=reliable
            int status = v.length > 12 ? v[12] & 0xFF : 0xFF;
            gfdiHandle = v.length > 13 ? v[13] & 0xFF : -1;
            Log.i(TAG, "ML REGISTER_ML_RESP status=" + status + " gfdiHandle=" + gfdiHandle);
            listener.onLog("garmin: ML registered (handle " + gfdiHandle + ")");
            ready = (status == 0 && gfdiHandle >= 0);
            // The watch now drives the GFDI handshake (DeviceInformation, etc.).
        } else {
            Log.i(TAG, "ML other type=" + type);
        }
    }

    // ---- GFDI ----

    private void handleGfdiFrame(byte[] msg) {
        if (msg.length < 6) return;
        int len = u16(msg, 0);
        int type = u16(msg, 2);
        boolean statusChannel = (type & 0x8000) != 0;
        int id = statusChannel ? ((type & 0xFF) + 5000) : type;
        // CRC check (lenient: log mismatch but proceed)
        if (len <= msg.length && len >= 6) {
            int want = u16(msg, len - 2);
            int got = GarminCrc.crc16(msg, 0, len - 2);
            if (want != got) Log.w(TAG, "GFDI CRC mismatch id=" + id + " want=" + want + " got=" + got);
        }
        byte[] payload = (len >= 6 && len <= msg.length)
            ? Arrays.copyOfRange(msg, 4, len - 2)
            : new byte[0];
        Log.i(TAG, "GFDIDBG recv id=" + id + (statusChannel ? " (status)" : "") + " len=" + len + " plen=" + payload.length);

        if (statusChannel) {
            // an ACK/status for something we sent — nothing to do
            return;
        }
        switch (id) {
            case DEVICE_INFORMATION:
                listener.onLog("garmin: device info");
                sendGfdi(deviceInfoReply(payload));
                break;
            case AUTH_NEGOTIATION:
                listener.onLog("garmin: auth");
                sendGfdi(authReply());
                break;
            case PROTOBUF_REQUEST:
            case CONFIGURATION:
                sendGfdi(genericAck(id));
                completeInitialization();
                break;
            default:
                sendGfdi(genericAck(id));
                break;
        }
        listener.onGfdiMessage(id, payload);
    }

    private void completeInitialization() {
        if (initialized) return;
        initialized = true;
        Log.i(TAG, "completeInitialization → SUPPORTED_FILE_TYPES + SYNC_READY");
        listener.onLog("garmin: link ready");
        sendGfdi(gfdiFrame(SUPPORTED_FILE_TYPES_REQUEST, new byte[0]));
        sendGfdi(gfdiFrame(SYSTEM_EVENT, new byte[]{(byte) SYS_EVENT_SYNC_READY}));
        listener.onReady();
    }

    // ---- message builders ----

    private byte[] deviceInfoReply(byte[] incoming) {
        int inProto = incoming.length >= 2 ? u16(incoming, 0) : 0;
        Writer w = new Writer();
        w.u16(DEVICE_INFORMATION);   // answering 5024
        w.u8(STATUS_ACK);
        w.u16(150);                  // our protocol version
        w.u16(0xFFFF);               // our product number
        w.u32(0xFFFFFFFFL);          // our unit number
        w.u16(7791);                 // our software version
        w.u16(0xFFFF);               // our max packet size (watch may cap)
        w.str(btName);
        w.str(android.os.Build.MANUFACTURER);
        w.str(android.os.Build.DEVICE);
        w.u8(inProto / 100 == 1 ? 1 : 0); // protocol flags
        return gfdiFrame(RESPONSE, w.bytes());
    }

    private byte[] authReply() {
        Writer w = new Writer();
        w.u16(AUTH_NEGOTIATION); // answering 5101
        w.u8(STATUS_ACK);
        w.u8(0); // sub-status (GUESS_OK)
        w.u8(0); // auth byte
        w.u32(0); // auth flags all zeroed = "accept, no auth"
        return gfdiFrame(RESPONSE, w.bytes());
    }

    private byte[] genericAck(int origId) {
        Writer w = new Writer();
        w.u16(origId);
        w.u8(STATUS_ACK);
        return gfdiFrame(RESPONSE, w.bytes());
    }

    // ---- framing ----

    /** ML control frame (13 bytes, written raw to the send char). */
    private static byte[] mlFrame(int requestType, int service, int extra) {
        Writer w = new Writer();
        w.u8(0x00);             // ML handle = management
        w.u8(requestType);
        w.u64(CLIENT_ID);
        w.u16(service);
        w.u8(extra);
        return w.bytes();
    }

    /** GFDI frame: [u16 len][u16 type][payload][u16 crc]. */
    private static byte[] gfdiFrame(int msgId, byte[] payload) {
        int len = 2 + 2 + payload.length + 2;
        Writer w = new Writer();
        w.u16(len);
        w.u16(msgId);
        w.raw(payload);
        byte[] body = w.bytes();
        int crc = GarminCrc.crc16(body, 0, body.length);
        Writer full = new Writer();
        full.raw(body);
        full.u16(crc);
        return full.bytes();
    }

    /** COBS-encode a GFDI frame, prefix the handle on every fragment, and write. */
    private void sendGfdi(byte[] frame) {
        if (gfdiHandle < 0) {
            Log.w(TAG, "sendGfdi before handle ready");
            return;
        }
        byte[] enc = GarminCobs.encode(frame);
        int chunkMax = Math.max(1, maxWriteSize - 1);
        for (int off = 0; off < enc.length; off += chunkMax) {
            int n = Math.min(chunkMax, enc.length - off);
            byte[] chunk = new byte[1 + n];
            chunk[0] = (byte) gfdiHandle;
            System.arraycopy(enc, off, chunk, 1, n);
            write.accept(chunk);
        }
    }

    private static int u16(byte[] b, int o) {
        return (b[o] & 0xFF) | ((b[o + 1] & 0xFF) << 8);
    }

    /** Little-endian writer. */
    private static final class Writer {
        private final ByteArrayOutputStream o = new ByteArrayOutputStream();
        void u8(int v) { o.write(v & 0xFF); }
        void u16(int v) { o.write(v & 0xFF); o.write((v >> 8) & 0xFF); }
        void u32(long v) { for (int i = 0; i < 4; i++) o.write((int) ((v >> (8 * i)) & 0xFF)); }
        void u64(long v) { for (int i = 0; i < 8; i++) o.write((int) ((v >> (8 * i)) & 0xFF)); }
        void str(String s) {
            byte[] b = (s == null ? "" : s).getBytes(StandardCharsets.UTF_8);
            int len = Math.min(b.length, 255);
            o.write(len);
            o.write(b, 0, len);
        }
        void raw(byte[] b) { o.write(b, 0, b.length); }
        byte[] bytes() { return o.toByteArray(); }
    }
}
