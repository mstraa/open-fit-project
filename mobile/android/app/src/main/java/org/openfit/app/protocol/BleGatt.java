package org.openfit.app.protocol;

import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattService;

import java.util.UUID;

/** Shared GATT helpers + standard Heart Rate UUIDs used across protocol impls. */
public final class BleGatt {
    private BleGatt() {}

    public static UUID uuid16(String s) {
        return UUID.fromString("0000" + s + "-0000-1000-8000-00805f9b34fb");
    }

    /** Standard Heart Rate service / measurement characteristic (0x180D / 0x2A37). */
    public static final UUID HR_SERVICE = uuid16("180d");
    public static final UUID HR_MEASUREMENT = uuid16("2a37");

    /** Find a characteristic by UUID across all of the connection's services. */
    public static BluetoothGattCharacteristic findChar(BluetoothGatt g, UUID uuid) {
        for (BluetoothGattService s : g.getServices()) {
            BluetoothGattCharacteristic c = s.getCharacteristic(uuid);
            if (c != null) return c;
        }
        return null;
    }

    /** Heart Rate Measurement (0x2A37): flags byte, then uint8 or uint16 LE HR. */
    public static Integer parseHeartRate(byte[] v) {
        if (v == null || v.length < 2) return null;
        int flags = v[0] & 0xff;
        if ((flags & 0x01) != 0) {
            if (v.length < 3) return null;
            return (v[1] & 0xff) | ((v[2] & 0xff) << 8);
        }
        return v[1] & 0xff;
    }
}
