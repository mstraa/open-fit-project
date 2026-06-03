package org.openfit.app.protocol;

import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattService;

import java.util.UUID;

/**
 * Standard GATT Heart Rate (0x180D / 0x2A37): live HR only, no session handshake,
 * no MTU negotiation. Mirrors the previous {@code setupStandardHr} + the standard
 * branch of {@code onCharacteristicChanged}.
 */
public final class StandardHrProtocol implements DeviceProtocol {
    private final LinkContext ctx;

    public StandardHrProtocol(LinkContext ctx) {
        this.ctx = ctx;
    }

    @Override
    public void onServicesDiscovered(BluetoothGatt g) {
        BluetoothGattService svc = g.getService(BleGatt.HR_SERVICE);
        if (svc == null) {
            // A missing required service/char is an error, not a "ready" state.
            ctx.emitStatus("error", "no standard Heart Rate service");
            return;
        }
        BluetoothGattCharacteristic hr = svc.getCharacteristic(BleGatt.HR_MEASUREMENT);
        if (hr == null) {
            ctx.emitStatus("error", "no HR measurement characteristic");
            return;
        }
        ctx.enqueueNotify(hr);
        ctx.emitStatus("ready", "streaming heart rate");
    }

    @Override
    public void onMtuNegotiated(BluetoothGatt g, int mtu) {
        // Standard HR does not negotiate MTU.
    }

    @Override
    public void onCharacteristicChanged(UUID uuid, byte[] value) {
        if (BleGatt.HR_MEASUREMENT.equals(uuid)) {
            Integer hr = BleGatt.parseHeartRate(value);
            if (hr != null) ctx.emitSample("heart_rate", hr);
        }
    }

    @Override
    public void requestSync(Long sinceMillis) {
        // Live-only.
    }

    @Override
    public void teardown() {
        // Nothing to tear down.
    }
}
