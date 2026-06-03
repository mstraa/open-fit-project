package org.openfit.app.protocol;

import java.util.List;
import java.util.UUID;

/**
 * Maps a BLE device to the protocol that drives it. Stage 0 of the DeviceProtocol
 * refactor (see DEVICE_REFACTOR_PLAN.md): for now this only does best-effort
 * protocol DETECTION from a device's advertised service UUIDs, so the add-device
 * UI can pre-select the right type instead of the user guessing. The protocol
 * implementations + a {@code create()} factory land with Stages 1-2.
 */
public final class ProtocolRegistry {
    private ProtocolRegistry() {}

    /** Standard Heart Rate service (0x180D). */
    public static final UUID HR_SERVICE =
        UUID.fromString("0000180d-0000-1000-8000-00805f9b34fb");
    /** Garmin GFDI multi-link service — distinctive; Garmin wearables advertise it. */
    public static final UUID GARMIN_GFDI_SERVICE =
        UUID.fromString("6a4e2800-667b-11e3-949a-0800200c9a66");

    /**
     * Best-effort protocol hint from a device's ADVERTISED service UUIDs (from the
     * scan record). Proprietary services are checked BEFORE the standard HR service,
     * since proprietary wearables often also advertise 0x180D.
     *
     * <p>Returns {@code "garmin"}, {@code "standard"}, or {@code null} when nothing
     * recognizable is advertised. Note: Huami/Zepp devices typically do NOT advertise
     * their chunked-transfer service, so they intentionally fall through to {@code null}
     * — the user picks "Zepp/Huami" manually (it also needs an auth key). Many devices
     * advertise no service UUIDs at all (only post-connect), so a {@code null} result
     * is normal and just means "no hint".
     */
    public static String detectFromServices(List<UUID> advertised) {
        if (advertised == null) return null;
        for (UUID u : advertised) {
            if (GARMIN_GFDI_SERVICE.equals(u)) return "garmin";
        }
        for (UUID u : advertised) {
            if (HR_SERVICE.equals(u)) return "standard";
        }
        return null;
    }
}
