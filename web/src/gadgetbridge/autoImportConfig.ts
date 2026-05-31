// Persisted config + last-run status for the Gadgetbridge hourly auto-import.
// Plain localStorage (same pattern as api/client.ts), shared by the scheduler
// hook and the Settings panel.

export interface GbAutoImportConfig {
  /** When true the foreground scheduler runs (mobile app only). */
  autoImportEnabled: boolean;
  /** Minute of the hour (0–59) to import at, e.g. 7 → imports at :07. */
  minute: number;
  /** Path to the Gadgetbridge auto-export, relative to external storage
   *  (e.g. "Download/Gadgetbridge.db") or an absolute file://content:// URI. */
  gbFilePath: string;
}

export interface GbLastRun {
  ts: number;
  ok: boolean;
  message: string;
  /** Per-calendar-hour key, used to dedupe one import per hour. */
  hourKey: string;
}

const CFG_KEY = "ofit_gb_autoimport";
const RUN_KEY = "ofit_gb_lastrun";

const DEFAULT_CFG: GbAutoImportConfig = {
  autoImportEnabled: false,
  minute: 7,
  gbFilePath: "Download/Gadgetbridge.db",
};

export function loadGbConfig(): GbAutoImportConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (!raw) return DEFAULT_CFG;
    const o = JSON.parse(raw);
    return {
      autoImportEnabled: !!o.autoImportEnabled,
      minute: Math.min(59, Math.max(0, Number(o.minute) || 0)),
      gbFilePath: typeof o.gbFilePath === "string" && o.gbFilePath ? o.gbFilePath : DEFAULT_CFG.gbFilePath,
    };
  } catch {
    return DEFAULT_CFG;
  }
}

export function saveGbConfig(c: GbAutoImportConfig): void {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

export function loadLastRun(): GbLastRun | null {
  try {
    const raw = localStorage.getItem(RUN_KEY);
    return raw ? (JSON.parse(raw) as GbLastRun) : null;
  } catch {
    return null;
  }
}

export function saveLastRun(r: GbLastRun): void {
  try {
    localStorage.setItem(RUN_KEY, JSON.stringify(r));
  } catch {
    /* ignore */
  }
}

/** A stable per-calendar-hour key for dedupe (local time). */
export function currentHourKey(d = new Date()): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
}

/** Whether we're running inside the native Capacitor app (vs desktop web). */
export function isNativeApp(): boolean {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return !!cap?.isNativePlatform?.();
}
