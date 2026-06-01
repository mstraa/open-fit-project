package org.openfit.app.garmin;

/**
 * Garmin's nibble-table CRC-16 (the FIT/ANT CRC-16: reflected poly 0x8408, init 0,
 * no final xor), processed nibble-at-a-time. Used for the GFDI frame CRC, the
 * per-chunk file-transfer CRC, and the FIT file's internal CRC. The result u16 is
 * appended little-endian. See docs/GARMIN-GFDI-DESIGN.md §3.2.
 */
public final class GarminCrc {
    private GarminCrc() {}

    private static final int[] T = {
        0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
        0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
    };

    public static int crc16(byte[] data, int offset, int length) {
        return crc16(0, data, offset, length);
    }

    /** Continue a CRC from {@code seed} (for rolling file-transfer CRCs). */
    public static int crc16(int seed, byte[] data, int offset, int length) {
        int crc = seed & 0xFFFF;
        for (int i = offset; i < offset + length; i++) {
            int b = data[i] & 0xFF;
            crc = (((crc >> 4) & 0x0FFF) ^ T[crc & 0x0F]) ^ T[b & 0x0F];          // low nibble
            crc = (((crc >> 4) & 0x0FFF) ^ T[crc & 0x0F]) ^ T[(b >> 4) & 0x0F];   // high nibble
        }
        return crc & 0xFFFF;
    }
}
