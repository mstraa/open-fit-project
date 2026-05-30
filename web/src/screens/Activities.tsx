// Activities screen — the full, dense, sortable activity list.
//
// Ported from docs/designs/dashboard.html (the "Recent activities" .act list +
// the .tbl table styling). REAL DATA only, via useActivities() → listActivities().
// Every fused effort renders as a sortable .tbl row (Sport · Started · Duration ·
// Recordings); a .seg filters by sport; clicking a row navigates to the workout
// detail. The on-brand <ImportControl> lives inline. Empty/error states are
// styled per design — never fake numbers.

import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AppShell } from "../app/AppShell";
import { ImportIcon, NoDataIcon } from "../app/icons";
import { useActivities, sortActivities } from "../hooks/useActivities";
import type { SortDir, SortKey } from "../hooks/useActivities";
import { ImportControl } from "../views/ImportControl";
import { Seg } from "../ui/Seg";
import { EmptyState } from "../ui/EmptyState";
import { formatDuration, formatDateTime, sportLabel } from "../ui/format";
import type { ActivitySummary, Sport } from "../api/types";

// Per-sport tint class + glyph, matching the design's .act__ico treatment
// (t-pace running, t-hr cycling/HR-led, t-elev trail, t-cad strength …).
const SPORT_TINT: Record<Sport, string> = {
  running: "t-pace",
  cycling: "t-acc",
  swimming: "t-pace",
  walking: "t-elev",
  strength: "t-cad",
  other: "t-pow",
};

function SportGlyph({ sport }: { sport: Sport }) {
  const s = { fill: "none", stroke: "currentColor", strokeWidth: 2 } as const;
  switch (sport) {
    case "running":
      return (
        <svg viewBox="0 0 24 24" {...s} aria-hidden>
          <path d="M13 4l-2 6h4l-3 10" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="16" cy="5" r="1.6" fill="currentColor" />
        </svg>
      );
    case "cycling":
      return (
        <svg viewBox="0 0 24 24" {...s} aria-hidden>
          <circle cx="6" cy="17" r="3" />
          <circle cx="18" cy="17" r="3" />
          <path d="M6 17l4-7h5l3 7M10 10l2-3h3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "swimming":
      return (
        <svg viewBox="0 0 24 24" {...s} aria-hidden>
          <path d="M3 17c1.5 1 3 1 4.5 0S10.5 16 12 17s3 1 4.5 0S19.5 16 21 17" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M7 12l5-3 4 3" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="16" cy="6" r="1.6" fill="currentColor" />
        </svg>
      );
    case "walking":
      return (
        <svg viewBox="0 0 24 24" {...s} aria-hidden>
          <circle cx="13" cy="4" r="1.6" fill="currentColor" />
          <path d="M11 8l2 4 3 2M11 8l-2 5 1 6m4-9l1 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "strength":
      return (
        <svg viewBox="0 0 24 24" {...s} aria-hidden>
          <path d="M6 19V7a6 6 0 0112 0v12" strokeLinecap="round" />
          <path d="M4 19h16" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" {...s} aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" strokeLinecap="round" />
        </svg>
      );
  }
}

// Sort-aware column header. Clicking toggles dir / switches the active key.
function SortTh({
  label,
  col,
  sort,
  onSort,
  num = false,
}: {
  label: string;
  col: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  num?: boolean;
}) {
  const active = sort.key === col;
  const arrow = active ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
  return (
    <th className={num ? "num" : undefined} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={() => onSort(col)}
        style={{
          all: "unset",
          cursor: "pointer",
          color: active ? "var(--fg)" : "inherit",
          font: "inherit",
          letterSpacing: "inherit",
          textTransform: "inherit",
        }}
      >
        {label}
        <span className="mono" style={{ color: "var(--accent)" }}>{arrow}</span>
      </button>
    </th>
  );
}

export function Activities() {
  const navigate = useNavigate();
  const { state, activities, counts, reload } = useActivities();

  const [sport, setSport] = useState<Sport | "all">("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "started_at",
    dir: "desc",
  });
  const [showImport, setShowImport] = useState(false);

  const onSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" },
    );

  // Sport filter options: only sports that actually exist in the data, with counts.
  const sportOptions = useMemo(() => {
    const opts: { value: Sport | "all"; label: string }[] = [
      { value: "all", label: `All · ${activities.length}` },
    ];
    const present = (["running", "cycling", "swimming", "walking", "strength", "other"] as Sport[]).filter(
      (sp) => (counts.get(sp) ?? 0) > 0,
    );
    for (const sp of present) {
      opts.push({ value: sp, label: `${sportLabel(sp)} · ${counts.get(sp) ?? 0}` });
    }
    return opts;
  }, [activities.length, counts]);

  const rows = useMemo(
    () => sortActivities(activities, sport, sort),
    [activities, sport, sort],
  );

  const crumb =
    state.kind === "ok"
      ? `${activities.length} ${activities.length === 1 ? "activity" : "activities"} · resolved locally`
      : "every fused effort · resolved locally";

  return (
    <AppShell
      title="Activities"
      crumb={crumb}
      actions={
        <button type="button" className="btn" onClick={() => setShowImport((v) => !v)} aria-expanded={showImport}>
          <ImportIcon />
          Import .FIT
        </button>
      }
    >
      {showImport && (
        <div className="card" style={{ marginBottom: "var(--gap)" }}>
          <div className="card__head">
            <div className="card__title">
              Import recordings<span className="sub">.fit · .gpx · .tcx</span>
            </div>
            <div className="card__tools">
              <button type="button" className="btn btn--ghost" onClick={() => setShowImport(false)}>
                Done
              </button>
            </div>
          </div>
          <ImportControl
            onImported={() => {
              reload();
            }}
          />
        </div>
      )}

      {/* Sport filter */}
      {activities.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--gap)", marginBottom: "var(--gap)", flexWrap: "wrap" }}>
          <Seg
            options={sportOptions}
            value={sport}
            onChange={setSport}
            aria-label="Filter activities by sport"
          />
          <span className="tag" style={{ marginLeft: "auto" }}>
            {rows.length} shown
          </span>
        </div>
      )}

      <div className="card card--pad0">
        {state.kind === "loading" && (
          <div style={{ padding: 24 }}>
            <EmptyState
              label="Loading activities…"
              icon={<NoDataIcon style={{ width: 18, height: 18 }} />}
              hint="Reading the local activity index from ofit-api."
            />
          </div>
        )}

        {state.kind === "error" && (
          <div style={{ padding: 24 }}>
            <div className="banner" role="alert" style={{ marginBottom: 16 }}>
              <NoDataIcon style={{ width: 20, height: 20 }} />
              <div>
                <b>Could not load activities.</b>
                <span className="muted"> {state.message}</span>
              </div>
              <button type="button" className="btn btn--ghost" style={{ marginLeft: "auto" }} onClick={reload}>
                Retry
              </button>
            </div>
          </div>
        )}

        {state.kind === "ok" && activities.length === 0 && (
          <div style={{ padding: 24 }}>
            <EmptyState
              label="No activities yet"
              phase="Phase 2"
              hint="Import a .fit / .gpx / .tcx file (or wire BLE ingestion) to populate this list."
            />
          </div>
        )}

        {state.kind === "ok" && activities.length > 0 && rows.length === 0 && (
          <div style={{ padding: 24 }}>
            <EmptyState
              label={`No ${sport === "all" ? "" : sportLabel(sport as Sport).toLowerCase() + " "}activities match`}
              hint="Try a different sport filter."
            />
          </div>
        )}

        {state.kind === "ok" && rows.length > 0 && (
          <table className="tbl">
            <thead>
              <tr>
                <SortTh label="Sport" col="sport" sort={sort} onSort={onSort} />
                <SortTh label="Started" col="started_at" sort={sort} onSort={onSort} />
                <SortTh label="Duration" col="duration_secs" sort={sort} onSort={onSort} num />
                <SortTh label="Recordings" col="recording_count" sort={sort} onSort={onSort} num />
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <ActivityRow key={a.id} a={a} onOpen={() => navigate(`/activities/${a.id}`)} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}

function ActivityRow({ a, onOpen }: { a: ActivitySummary; onOpen: () => void }) {
  return (
    <tr
      onClick={onOpen}
      style={{ cursor: "pointer" }}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <td>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <span
            className={`act__ico ${SPORT_TINT[a.sport]}`}
            style={{ width: 30, height: 30 }}
            aria-hidden
          >
            <SportGlyph sport={a.sport} />
          </span>
          <Link
            to={`/activities/${a.id}`}
            onClick={(e) => e.stopPropagation()}
            style={{ color: "var(--fg)", fontWeight: 600, textDecoration: "none" }}
          >
            {sportLabel(a.sport)}
          </Link>
        </span>
      </td>
      <td className="muted">{formatDateTime(a.started_at)}</td>
      <td className="num mono">{formatDuration(a.duration_secs)}</td>
      <td className="num mono">
        {a.recording_count}
        {a.recording_count > 1 ? (
          <span className="pill" style={{ marginLeft: 8, padding: "1px 7px" }}>
            {a.recording_count} sources merged
          </span>
        ) : null}
      </td>
    </tr>
  );
}
