// Read the Gadgetbridge auto-export from device storage and import it via the
// existing (idempotent) POST /api/import/gadgetbridge. Native-only: the
// @capacitor/filesystem plugin is dynamic-imported so the web build still bundles,
// and on desktop web the read throws → caught by the caller.

import { importGadgetbridge } from "../api/endpoints";
import { currentHourKey, saveLastRun, type GbLastRun } from "./autoImportConfig";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin);
}

/** Build the Filesystem.readFile options for a user-entered location, handling:
 *  - a `content://` / `file://` URI         → passed as-is
 *  - an absolute fs path (`/storage/...`)    → wrapped as a `file://` URI
 *  - a relative path (`Download/Foo.db`)     → resolved under external storage
 *  (The earlier bug treated an absolute `/storage/...` path as relative and
 *   prefixed it with the external-storage dir → a doubled, non-existent path.) */
async function readOptions(
  pathOrUri: string,
  Directory: typeof import("@capacitor/filesystem").Directory,
): Promise<{ path: string; directory?: import("@capacitor/filesystem").Directory }> {
  const p = pathOrUri.trim();
  if (p.startsWith("content://") || p.startsWith("file://")) return { path: p };
  if (p.startsWith("/")) return { path: `file://${p}` };
  return { path: p, directory: Directory.ExternalStorage };
}

/** Read the DB file and return it as a File for the multipart upload.
 *  NO encoding → binary-safe base64. */
async function readGadgetbridgeFile(pathOrUri: string): Promise<File> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  // Best-effort: ensure the legacy read permission (API ≤32). All-files access
  // (API 33+) must be granted in system settings — surfaced in the error if not.
  try {
    const perm = await Filesystem.checkPermissions();
    if (perm.publicStorage !== "granted") await Filesystem.requestPermissions();
  } catch {
    /* permission API may be unavailable; let the read attempt surface the real error */
  }
  const res = await Filesystem.readFile(await readOptions(pathOrUri, Directory));
  const b64 = typeof res.data === "string" ? res.data : await blobToBase64(res.data);
  const bytes = base64ToBytes(b64);
  return new File([bytes as BlobPart], "Gadgetbridge.db", { type: "application/x-sqlite3" });
}

/** Read + import the Gadgetbridge DB, persisting the run status. Returns the
 *  result string (also stored in lastRun). Throws on failure (caller may toast). */
export async function runGadgetbridgeImport(gbFilePath: string): Promise<GbLastRun> {
  let run: GbLastRun;
  try {
    const file = await readGadgetbridgeFile(gbFilePath);
    const r = await importGadgetbridge(file);
    run = {
      ts: Date.now(),
      ok: true,
      message: `Imported ${r.ingested.toLocaleString()} readings from ${r.devices.length} device(s)`,
      hourKey: currentHourKey(),
    };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // On Android 13+ a missing "All files access" grant surfaces as a generic
    // "does not exist"/"unable to" error — point the user at the real cause.
    const hint = /exist|unable|denied|permission|access/i.test(raw)
      ? " — check the path, and grant OpenFit “All files access” (Android Settings → Apps → OpenFit → Permissions → Files & media)."
      : "";
    run = { ts: Date.now(), ok: false, message: raw + hint, hourKey: currentHourKey() };
  }
  saveLastRun(run);
  return run;
}
