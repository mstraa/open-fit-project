// Import control: a file input that POSTs to /api/import (multipart) and
// reports per-file outcomes, then asks the parent to refresh the list.

import { useRef, useState } from "react";
import { importFiles } from "../api/endpoints";
import type { ImportFileOutcome } from "../api/types";
import { Banner, Button, Spinner } from "../ui/primitives";

export function ImportControl({ onImported }: { onImported: () => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<ImportFileOutcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    setOutcomes(null);
    try {
      const res = await importFiles(files);
      setOutcomes(res);
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          flexWrap: "wrap",
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".fit,.gpx,.tcx"
          disabled={busy}
          onChange={(e) => handleFiles(e.target.files)}
          style={{
            color: "var(--color-text-muted)",
            fontSize: "var(--font-size-sm)",
          }}
        />
        <Button
          kind="primary"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          Import .fit / .gpx / .tcx
        </Button>
        {busy && <Spinner label="Importing…" />}
      </div>

      {error && <Banner kind="error">Import failed — {error}</Banner>}

      {outcomes && (
        <ul
          style={{
            margin: 0,
            paddingLeft: "var(--space-4)",
            fontSize: "var(--font-size-sm)",
            color: "var(--color-text-muted)",
          }}
        >
          {outcomes.length === 0 && <li>No files reported.</li>}
          {outcomes.map((o, i) => {
            const status = o.status ?? o.outcome ?? "ok";
            const name = o.filename ?? `file ${i + 1}`;
            return (
              <li key={i}>
                <code style={{ fontFamily: "var(--font-mono)" }}>{name}</code>
                {" — "}
                {status}
                {o.message ? `: ${o.message}` : ""}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
