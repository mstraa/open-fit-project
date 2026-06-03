package org.openfit.app.protocol;

import android.bluetooth.BluetoothGatt;

import java.util.UUID;

/**
 * Drives one BLE device's protocol over a {@link LinkContext}'s GATT connection.
 * The link owns the GATT + the serialized op queue + connection lifecycle; the
 * protocol owns everything device-specific: which characteristics to enable, the
 * session handshake, routing inbound notifications, optional stored-history sync,
 * and teardown.
 *
 * <p>Adding a new device = implement this interface + a session class, and register
 * it in {@link ProtocolRegistry#create}. No edits to the plugin's connection plumbing.
 */
public interface DeviceProtocol {
    /** Called once after services are discovered. Find + validate characteristics
     *  on {@code gatt}, enable what's needed (via the link's op queue), and either
     *  request a larger MTU (→ {@link #onMtuNegotiated} runs next) or complete setup
     *  here. Report progress/errors via the link's {@code emitStatus}. */
    void onServicesDiscovered(BluetoothGatt gatt);

    /** Called when MTU negotiation completes (only if {@link #onServicesDiscovered}
     *  requested one). {@code mtu} is the negotiated value (or 23 on fallback). */
    void onMtuNegotiated(BluetoothGatt gatt, int mtu);

    /** Route an inbound characteristic-change notification to the session. */
    void onCharacteristicChanged(UUID uuid, byte[] value);

    /** Pull stored history since {@code sinceMillis} (null → the protocol's default
     *  window). No-op for live-only protocols. */
    void requestSync(Long sinceMillis);

    /** Clean teardown on disconnect — stop sessions, cancel scheduled work. Idempotent. */
    void teardown();
}
