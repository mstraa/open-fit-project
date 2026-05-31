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

/** Read the DB file (path under external storage OR a file://content:// URI) and
 *  return it as a File for the multipart upload. NO encoding → binary-safe base64. */
async function readGadgetbridgeFile(pathOrUri: string): Promise<File> {
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const absolute = pathOrUri.startsWith("content://") || pathOrUri.startsWith("file://");
  const res = await Filesystem.readFile(
    absolute ? { path: pathOrUri } : { path: pathOrUri, directory: Directory.ExternalStorage },
  );
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
    run = {
      ts: Date.now(),
      ok: false,
      message: e instanceof Error ? e.message : String(e),
      hourKey: currentHourKey(),
    };
  }
  saveLastRun(run);
  return run;
}
