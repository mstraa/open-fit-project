package org.openfit.app.protocol;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/**
 * Canonical Heart Rate Measurement (0x2A37) parse vectors.
 *
 * <p>These VALUE vectors are the shared contract with the web parser
 * ({@code parseHr} in {@code web/src/ble/BleProvider.tsx}) — keep them in sync so
 * the two HR parsers can't drift. Layout: byte 0 = flags; bit 0 set ⇒ HR is a
 * little-endian uint16 at bytes 1–2, else a uint8 at byte 1. See docs/ADDING-A-DEVICE.md.
 */
public class BleGattTest {
    @Test
    public void uint8_hr() {
        // flags=0x00 → uint8 HR at byte 1
        assertEquals(Integer.valueOf(72), BleGatt.parseHeartRate(new byte[]{0x00, 72}));
    }

    @Test
    public void uint8_hr_is_unsigned() {
        // 0xC8 = 200 — must not sign-extend to a negative
        assertEquals(Integer.valueOf(200), BleGatt.parseHeartRate(new byte[]{0x00, (byte) 0xC8}));
    }

    @Test
    public void uint16_hr_little_endian() {
        // flags bit0 set → uint16 LE: 0x012C = 300
        assertEquals(Integer.valueOf(300), BleGatt.parseHeartRate(new byte[]{0x01, 0x2C, 0x01}));
    }

    @Test
    public void malformed_returns_null() {
        assertNull(BleGatt.parseHeartRate(null));
        assertNull(BleGatt.parseHeartRate(new byte[]{0x00}));        // too short for any HR
        assertNull(BleGatt.parseHeartRate(new byte[]{0x01, 0x2C}));  // flags say uint16 but only 2 bytes
    }
}
