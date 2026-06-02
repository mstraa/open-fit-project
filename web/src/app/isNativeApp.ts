/** Returns true when running inside the Capacitor native shell (iOS/Android). */
export function isNativeApp(): boolean {
  return typeof (window as unknown as { Capacitor?: unknown }).Capacitor !== "undefined";
}
