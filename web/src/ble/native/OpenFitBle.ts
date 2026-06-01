// TS interface for the native OpenFitBle Capacitor plugin (Android, Java). M0 of
// the direct-device port — see docs/NATIVE-BLE-PORT.md. The plugin owns a native
// BluetoothGatt connection + a serialized GATT op queue and streams events back.

import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface NativeScanResult {
  deviceId: string;
  name: string;
  rssi: number;
}

export interface NativeSample {
  deviceId: string;
  kind: string; // e.g. "heart_rate"
  value: number;
  ts: number; // epoch ms
}

export interface NativeStatus {
  deviceId: string | null;
  status: "connected" | "disconnected" | "ready" | "error";
  message?: string;
}

export interface OpenFitBlePlugin {
  echo(options: { value: string }): Promise<{ value: string; available: boolean }>;
  /** Hand the native side the server base + session token so it can POST samples
   *  itself (survives screen-lock, when the WebView JS is suspended). */
  configure(options: { apiBase: string; token: string }): Promise<void>;
  startScan(): Promise<void>;
  stopScan(): Promise<void>;
  connect(options: {
    deviceId: string;
    /** "standard" (default) reads standard GATT HR; "huami" runs the Zepp-OS
     *  auth handshake (requires authKey). */
    deviceType?: "standard" | "huami" | "garmin";
    authKey?: string;
  }): Promise<void>;
  /** Disconnect one device (by id) or, with no id, all connected devices. */
  disconnect(options?: { deviceId?: string }): Promise<void>;
  /** Pull stored wellness since `sinceMillis` from every connected Zepp-OS device. */
  syncNow(options: { sinceMillis?: number }): Promise<void>;
  /** Offline-buffer status: queued sample count, the cap, and file size in bytes. */
  getOutboxStatus(): Promise<{ count: number; maxLines: number; bytes: number }>;
  addListener(event: "scanResult", cb: (e: NativeScanResult) => void): Promise<PluginListenerHandle>;
  addListener(event: "sample", cb: (e: NativeSample) => void): Promise<PluginListenerHandle>;
  addListener(event: "status", cb: (e: NativeStatus) => void): Promise<PluginListenerHandle>;
}

export const OpenFitBle = registerPlugin<OpenFitBlePlugin>("OpenFitBle");
