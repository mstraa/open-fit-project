package org.openfit.app.protocol;

import android.bluetooth.BluetoothGattCharacteristic;
import android.content.SharedPreferences;
import android.os.Handler;

import java.util.List;

/**
 * The capabilities a {@link DeviceProtocol} needs from its owning device link:
 * the serialized GATT op-queue, event emission, the offline ingest path, and
 * shared scheduling/prefs/recompute hooks. Implemented by OpenFitBlePlugin's
 * per-device {@code DeviceLink}, so protocol implementations stay free of any
 * reference to the plugin internals beyond this surface.
 */
public interface LinkContext {
    String deviceId();

    /** Enqueue a notify-enable on a characteristic (serialized through the op queue). */
    void enqueueNotify(BluetoothGattCharacteristic c);

    /** Enqueue a write to a characteristic (serialized through the op queue). */
    void enqueueWrite(BluetoothGattCharacteristic c, byte[] value);

    /** Request a larger ATT MTU. Returns true if the request was issued (the
     *  protocol's {@code onMtuNegotiated} will run); false → start at 23. */
    boolean requestMtu(int mtu);

    /** Emit a connection-status event for this device. */
    void emitStatus(String status, String message);

    /** Emit a live sample (also POSTed natively + fed to any active recording). */
    void emitSample(String kind, double value);

    /** Queue a batch of sample-JSON strings for POST (with offline buffering). */
    void sendOrQueue(List<String> samples);

    /** Kick a throttled server-side analytics recompute after a sync wrote data. */
    void scheduleRecompute();

    /** True while this link is still the registered one for its device id (its
     *  pending main-thread runnables must no-op once it's been replaced). */
    boolean isCurrentLink();

    /** The main/UI looper handler (protocols schedule keepalive/sync on it). */
    Handler main();

    /** Shared prefs (sync watermarks, throttle timestamps), keyed per device. */
    SharedPreferences prefs();

    /** This phone's Bluetooth adapter name (Garmin handshake identity). */
    String btName();

    /** Format an epoch-ms instant as the RFC3339 string the wellness API expects. */
    String formatTs(long epochMs);
}
