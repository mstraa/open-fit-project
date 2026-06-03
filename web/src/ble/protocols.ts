// Device-protocol model shared by the native BLE flow. Stage 0 of the
// DeviceProtocol refactor (see DEVICE_REFACTOR_PLAN.md).
//
// Protocol DETECTION from advertised services happens natively — the plugin emits
// `suggestedType` on each scan result via ProtocolRegistry.detectFromServices().
// This module holds the protocol type + the capability table the add-device UI
// uses to drive its flow (e.g. whether a protocol needs an auth key). The full
// per-protocol wiring + UI consumption lands with Stages 1-3.

export type DeviceProtocolType = "standard" | "huami" | "garmin";

export interface DeviceCapabilities {
  /** Live realtime heart rate over BLE. */
  liveHr: boolean;
  /** Pulls stored history over BLE (Huami/Zepp only). */
  storedSync: boolean;
  /** Requires a per-device auth key the user supplies. */
  requiresAuthKey: boolean;
}

export const PROTOCOL_CAPS: Record<DeviceProtocolType, DeviceCapabilities> = {
  standard: { liveHr: true, storedSync: false, requiresAuthKey: false },
  huami: { liveHr: true, storedSync: true, requiresAuthKey: true },
  garmin: { liveHr: true, storedSync: false, requiresAuthKey: false },
};
