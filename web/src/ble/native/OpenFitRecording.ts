import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/** 1 Hz live summary from the native recording service. */
export interface RecordingTick {
  elapsedMs: number;
  distanceM: number;
  speedMps: number;
  hr: number;
  cadence: number;
  power: number;
  altitudeM: number;
  ascentM: number;
  paused: boolean;
}

export interface RecordingStopped {
  sessionDir: string;
  elapsedMs: number;
}

/** Controls the native workout RecordingService (GPS + IMU + HR → local .fit). */
export interface OpenFitRecordingPlugin {
  start(options: { sport: string }): Promise<{ sessionId: string; sport: string }>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  isActive(): Promise<{ active: boolean }>;
  /** Re-attempt any queued/failed .fit uploads now (after refreshing creds). */
  retryUploads(): Promise<void>;
  addListener(event: "tick", cb: (t: RecordingTick) => void): Promise<PluginListenerHandle>;
  addListener(event: "recordingStopped", cb: (s: RecordingStopped) => void): Promise<PluginListenerHandle>;
  addListener(event: "recordingUploaded", cb: (e: { count: number }) => void): Promise<PluginListenerHandle>;
  /** A finished recording could not be uploaded; `reason` is human-readable. */
  addListener(event: "recordingUploadFailed", cb: (e: { reason: string }) => void): Promise<PluginListenerHandle>;
}

export const OpenFitRecording = registerPlugin<OpenFitRecordingPlugin>("OpenFitRecording");
