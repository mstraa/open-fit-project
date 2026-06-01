package org.openfit.app.garmin;

import java.io.ByteArrayOutputStream;

/**
 * Garmin's COBS (Consistent Overhead Byte Stuffing) variant used on the GFDI
 * multi-link transport, ported from Gadgetbridge's CobsCoDec (AGPLv3). It is NOT
 * standard COBS: every frame is wrapped with a LEADING 0x00 pad and a TRAILING
 * 0x00 terminator, so the watch's stream is a run of `00 <cobs-bytes> 00` frames.
 *
 * The encoder produces one whole frame; the decoder is streaming — feed inbound
 * notification payloads and call {@link #retrieve()} to pull complete GFDI
 * messages as their trailing 0x00 arrives. See docs/GARMIN-GFDI-DESIGN.md §2.5.
 */
public final class GarminCobs {

    /** Encode a GFDI message into a single `00 …cobs… 00` frame: a leading 0x00
     *  pad, the COBS-stuffed bytes (blocks of ≤254 non-zero bytes), and a trailing
     *  0x00 terminator. */
    public static byte[] encode(byte[] data) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(data.length + 4);
        out.write(0x00); // leading pad
        int i = 0;
        int n = data.length;
        while (i <= n) {
            // collect a run of non-zero bytes (a COBS block is up to 254 bytes)
            int start = i;
            int run = 0;
            while (i < n && data[i] != 0 && run < 0xFE) {
                i++;
                run++;
            }
            out.write(run + 1);
            out.write(data, start, run);
            if (run == 0xFE) {
                // block was truncated at 254 non-zero bytes; continue same run, no zero consumed
                continue;
            }
            if (i < n && data[i] == 0) {
                i++; // consume the delimiting zero (implied by the next code byte)
                if (i == n) {
                    // trailing zero in the data → emit an extra 0x01 (empty block)
                    out.write(0x01);
                    break;
                }
            } else {
                break; // reached end with no trailing zero
            }
        }
        out.write(0x00); // trailing terminator
        return out.toByteArray();
    }

    // ---- streaming decoder ----

    private final ByteArrayOutputStream buffer = new ByteArrayOutputStream(512);
    private long lastFeedMs = 0;

    /** Append inbound bytes (after the 1-byte ML handle has been stripped). A long
     *  inter-packet gap resets the buffer (matches CobsCoDec's 1500ms timeout). */
    public void feed(byte[] data, long nowMs) {
        if (lastFeedMs != 0 && nowMs - lastFeedMs > 1500) {
            buffer.reset();
        }
        lastFeedMs = nowMs;
        buffer.write(data, 0, data.length);
    }

    /** Return the next complete decoded GFDI message, or null if none is ready. */
    public byte[] retrieve() {
        byte[] b = buffer.toByteArray();
        if (b.length < 4) return null;
        // a frame starts at a leading 0x00 and ends at a trailing 0x00
        int start = 0;
        while (start < b.length && (b[start] & 0xFF) != 0x00) start++;
        // need a terminating 0x00 with at least one content byte after start
        int term = -1;
        for (int j = start + 1; j < b.length; j++) {
            if ((b[j] & 0xFF) == 0x00) {
                // a 0x00 right after the leading pad is not a terminator (empty); skip
                if (j == start + 1) {
                    start = j;
                    continue;
                }
                term = j;
                break;
            }
        }
        if (term < 0) return null; // frame incomplete
        byte[] decoded = decodeCobs(b, start + 1, term);
        // drop the consumed frame (keep the terminator as the next leading pad)
        byte[] rest = new byte[b.length - term];
        System.arraycopy(b, term, rest, 0, rest.length);
        buffer.reset();
        buffer.write(rest, 0, rest.length);
        return decoded;
    }

    /** Standard COBS decode over bytes [from, to) (exclusive of the terminator). */
    private static byte[] decodeCobs(byte[] b, int from, int to) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(to - from);
        int i = from;
        while (i < to) {
            int code = b[i++] & 0xFF;
            if (code == 0x00) break;
            int payload = code - 1;
            for (int k = 0; k < payload && i < to; k++) {
                out.write(b[i++]);
            }
            if (code != 0xFF && i < to) {
                out.write(0x00); // implied zero between blocks
            }
        }
        return out.toByteArray();
    }
}
