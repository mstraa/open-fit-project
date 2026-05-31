// Settings card to configure the hourly Gadgetbridge auto-import: enable, pick
// the minute of the hour, set the DB file path, run it now, and see the last run.
// The scheduler itself lives in useGadgetbridgeAutoImport (mounted in App).

import { useState } from "react";
import {
  loadGbConfig,
  saveGbConfig,
  loadLastRun,
  isNativeApp,
  type GbAutoImportConfig,
  type GbLastRun,
} from "./autoImportConfig";
import { runGadgetbridgeImport } from "./runImport";

export function GadgetbridgeAutoImportCard() {
  const [cfg, setCfg] = useState<GbAutoImportConfig>(() => loadGbConfig());
  const [lastRun, setLastRun] = useState<GbLastRun | null>(() => loadLastRun());
  const [busy, setBusy] = useState(false);
  const native = isNativeApp();

  const update = (patch: Partial<GbAutoImportConfig>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    saveGbConfig(next);
  };

  const importNow = async () => {
    setBusy(true);
    try {
      const run = await runGadgetbridgeImport(cfg.gbFilePath);
      setLastRun(run);
      if (run.ok) setTimeout(() => window.location.reload(), 1400);
    } finally {
      setBusy(false);
    }
  };

  const mm = (n: number) => `:${n.toString().padStart(2, "0")}`;

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card__head">
        <div className="card__title">
          Gadgetbridge auto-import<span className="sub">hourly · cloudless</span>
        </div>
      </div>

      <p className="muted" style={{ fontSize: 12.5, margin: "0 0 14px" }}>
        Point this at Gadgetbridge's hourly <b>Auto export</b> file and the app re-imports it every
        hour at the minute you choose, so your wellness stays current without tapping anything.
      </p>

      {!native && (
        <div className="pill pill--warn" style={{ marginBottom: 14, justifyContent: "flex-start" }}>
          Available in the Android app — this desktop browser can&apos;t read the device file.
        </div>
      )}

      <label className="switchrow" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <input
          type="checkbox"
          checked={cfg.autoImportEnabled}
          disabled={!native}
          onChange={(e) => update({ autoImportEnabled: e.target.checked })}
        />
        <span style={{ fontSize: 13, fontWeight: 600 }}>Auto-import every hour</span>
      </label>

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span className="stat__label">Import at minute</span>
          <select
            className="inp"
            value={cfg.minute}
            disabled={!native}
            onChange={(e) => update({ minute: Number(e.target.value) })}
          >
            {Array.from({ length: 60 }, (_, n) => (
              <option key={n} value={n}>
                {mm(n)}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span className="stat__label">Gadgetbridge DB path</span>
          <input
            className="inp"
            value={cfg.gbFilePath}
            onChange={(e) => update({ gbFilePath: e.target.value })}
            placeholder="Download/Gadgetbridge.db"
            spellCheck={false}
          />
        </label>
      </div>
      <p className="faint" style={{ fontSize: 11, margin: "6px 0 14px" }}>
        Relative to device storage (e.g. <code>Download/Gadgetbridge.db</code>), or a full
        <code> content://</code> / <code>file://</code> URI. Set Gadgetbridge → Settings → Auto export
        to the same file, hourly.
      </p>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="btn" disabled={busy || !native} onClick={() => void importNow()}>
          {busy ? "Importing…" : "Import now"}
        </button>
        {lastRun && (
          <span
            className={`pill ${lastRun.ok ? "pill--good" : "pill--bad"}`}
            style={{ justifyContent: "flex-start" }}
          >
            {lastRun.ok ? "✓ " : "✕ "}
            {lastRun.message} · {new Date(lastRun.ts).toLocaleString()}
          </span>
        )}
      </div>

      <p className="faint" style={{ fontSize: 11, margin: "12px 0 0" }}>
        Runs while the app is open (and catches up when you reopen it). Continuous background import
        needs a future native scheduler.
      </p>
    </div>
  );
}
