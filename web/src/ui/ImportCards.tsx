// Manual import cards — Gadgetbridge export DB + Zepp/Amazfit app export (.zip).
// Live on the Settings → Imports panel (the file picker opens the OS chooser on
// web and inside the Capacitor app). Both POST to the same idempotent endpoints
// the auto-import uses, then reload so the new data shows.

import { useRef, useState } from "react";
import { importGadgetbridge, importZepp } from "../api/endpoints";

/** Import wellness from a Gadgetbridge export DB (HR / stress / steps / resting HR). */
export function GadgetbridgeImportCard() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await importGadgetbridge(f);
      const perDevice = r.devices
        .map((d) => `${d.device}: ${d.ingested.toLocaleString()} (${d.by_kind.map((k) => k.kind).join(", ")})`)
        .join(" · ");
      setResult(`Imported ${r.ingested.toLocaleString()} readings — ${perDevice}.`);
      setTimeout(() => window.location.reload(), 1600);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card__head">
        <div className="card__title">
          Import from Gadgetbridge<span className="sub">export DB · cloudless</span>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 12px" }}>
        In Gadgetbridge → <b>Database management → Export DB</b>, then upload the file here to
        ingest heart rate, HRV, sleep, SpO₂, stress, steps and resting HR.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept=".db,application/octet-stream,application/x-sqlite3"
        style={{ display: "none" }}
        disabled={busy}
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <button type="button" className="btn" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? "Importing…" : "Choose Gadgetbridge DB"}
      </button>
      {result && (
        <div className="pill pill--good" style={{ marginTop: 12, justifyContent: "flex-start" }}>
          {result}
        </div>
      )}
      {error && (
        <div className="pill pill--bad" style={{ marginTop: 12, justifyContent: "flex-start" }}>
          {error}
        </div>
      )}
    </div>
  );
}

/** Import a zipped Zepp/Amazfit app export (all-day HR, sleep staging, steps,
 *  calories, weight, workouts). One account → one Zepp source; re-uploading replaces. */
export function ZeppImportCard() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await importZepp(f);
      const breakdown = r.by_kind.map((k) => `${k.count.toLocaleString()} ${k.kind}`).join(" · ");
      const acts = r.activities_imported ? ` + ${r.activities_imported} workouts → Activities` : "";
      const dups = r.activities_skipped_dup + r.duplicate_summaries_removed;
      const deduped = dups ? ` (skipped ${dups} that duplicate your .fit imports)` : "";
      setResult(`Imported ${r.ingested.toLocaleString()} readings into ${r.source} — ${breakdown}${acts}${deduped}.`);
      setTimeout(() => window.location.reload(), 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card__head">
        <div className="card__title">
          Import from Zepp / Amazfit<span className="sub">app export · cloudless</span>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 12px" }}>
        In the Zepp app → <b>Profile → Settings → About → Export data</b>, then zip the exported
        folder and upload it here to ingest all-day heart rate, sleep staging (→ sleep score),
        daily steps &amp; calories, weight, and workouts.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip"
        style={{ display: "none" }}
        disabled={busy}
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      <button type="button" className="btn" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? "Importing…" : "Choose Zepp export (.zip)"}
      </button>
      {result && (
        <div className="pill pill--good" style={{ marginTop: 12, justifyContent: "flex-start" }}>
          {result}
        </div>
      )}
      {error && (
        <div className="pill pill--bad" style={{ marginTop: 12, justifyContent: "flex-start" }}>
          {error}
        </div>
      )}
    </div>
  );
}
