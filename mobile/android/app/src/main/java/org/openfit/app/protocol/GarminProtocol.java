package org.openfit.app.protocol;

import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattService;

import java.util.UUID;

import org.openfit.app.garmin.GarminSession;

/**
 * Garmin GFDI multi-link live heart rate. Mirrors the previous {@code setupGarmin}
 * + {@code startGarminSession}. The GFDI session itself ({@link GarminSession}) is
 * unchanged — this only wires it to the link's op queue and event emission.
 */
public final class GarminProtocol implements DeviceProtocol {
    // GFDI multi-link service + first receive(notify)/send(write) pair.
    public static final UUID GARMIN_ML_SERVICE = UUID.fromString("6a4e2800-667b-11e3-949a-0800200c9a66");
    public static final UUID GARMIN_ML_RECV = UUID.fromString("6a4e2810-667b-11e3-949a-0800200c9a66");
    public static final UUID GARMIN_ML_SEND = UUID.fromString("6a4e2820-667b-11e3-949a-0800200c9a66");

    private final LinkContext ctx;
    private GarminSession garmin;
    private BluetoothGattCharacteristic garminSend;

    public GarminProtocol(LinkContext ctx) {
        this.ctx = ctx;
    }

    @Override
    public void onServicesDiscovered(BluetoothGatt g) {
        if (g.getService(GARMIN_ML_SERVICE) == null) {
            ctx.emitStatus("error", "no Garmin GFDI service (bond it + remove from Garmin Connect)");
            return;
        }
        ctx.emitStatus("connected", "Garmin found, negotiating MTU…");
        if (!ctx.requestMtu(515)) onMtuNegotiated(g, 23);
    }

    @Override
    public void onMtuNegotiated(BluetoothGatt g, int mtu) {
        if (garmin != null) return; // onMtuChanged can fire once; guard re-entry
        BluetoothGattService svc = g.getService(GARMIN_ML_SERVICE);
        if (svc == null) {
            ctx.emitStatus("error", "Garmin service missing");
            return;
        }
        BluetoothGattCharacteristic recv = svc.getCharacteristic(GARMIN_ML_RECV);
        garminSend = svc.getCharacteristic(GARMIN_ML_SEND);
        if (recv == null || garminSend == null) {
            ctx.emitStatus("error", "Garmin GFDI characteristics missing");
            return;
        }
        garmin = new GarminSession(
            ctx.btName(),
            (chunk) -> ctx.enqueueWrite(garminSend, chunk),
            new GarminSession.Listener() {
                @Override
                public void onLog(String msg) {
                    ctx.main().post(() -> ctx.emitStatus("connected", msg));
                }

                @Override
                public void onReady() {
                    ctx.main().post(() -> ctx.emitStatus("ready", "Garmin connected"));
                }

                @Override
                public void onHeartRate(int bpm) {
                    ctx.emitSample("heart_rate", bpm);
                }
            });
        garmin.setMaxWriteSize(mtu);
        ctx.emitStatus("connected", "negotiated MTU " + mtu + ", Garmin handshake…");
        ctx.enqueueNotify(recv);
        garmin.start();
    }

    @Override
    public void onCharacteristicChanged(UUID uuid, byte[] value) {
        if (GARMIN_ML_RECV.equals(uuid) && garmin != null) garmin.onNotify(value);
    }

    @Override
    public void requestSync(Long sinceMillis) {
        // Live-only here; Garmin history is imported from Garmin Connect exports.
    }

    @Override
    public void teardown() {
        garmin = null;
        garminSend = null;
    }
}
