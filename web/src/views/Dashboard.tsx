// Dashboard — qBittorrent-WebUI-style layout: a left filter sidebar (by sport,
// with counts) + a dense, sortable activities table. Fetches once and shares the
// data between the sidebar (counts) and the table (rows).

import { useCallback, useEffect, useMemo, useState } from "react";
import { listActivities } from "../api/endpoints";
import type { ActivitySummary, Sport } from "../api/types";
import { formatDateTime, formatDuration, sportIcon, sportLabel } from "../ui/format";
import { Banner, Spinner } from "../ui/primitives";
import { ImportControl } from "./ImportControl";

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; activities: ActivitySummary[] }
  | { kind: "error"; message: string };

type SortKey = "sport" | "started_at" | "duration_secs" | "recording_count";
type SortDir = "asc" | "desc";

export function Dashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [sport, setSport] = useState<Sport | "all">("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "started_at",
    dir: "desc",
  });

  const load = useCallback(() => {
    setState({ kind: "loading" });
    listActivities()
      .then((activities) => setState({ kind: "ok", activities }))
      .catch((e: unknown) =>
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
      );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const activities = state.kind === "ok" ? state.activities : [];

  const counts = useMemo(() => {
    const m = new Map<Sport, number>();
    for (const a of activities) m.set(a.sport, (m.get(a.sport) ?? 0) + 1);
    return m;
  }, [activities]);

  const rows = useMemo(() => {
    const filtered = sport === "all" ? activities : activities.filter((a) => a.sport === sport);
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const k = sort.key;
      const av = k === "sport" ? a.sport : k === "started_at" ? a.started_at : a[k];
      const bv = k === "sport" ? b.sport : k === "started_at" ? b.started_at : b[k];
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [activities, sport, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "started_at" || key === "duration_secs" ? "desc" : "asc" },
    );

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      <Sidebar
        total={activities.length}
        counts={counts}
        active={sport}
        onSelect={setSport}
      />

      <section
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "auto",
        }}
      >
        {/* Import strip (qbit "add" action lives in the toolbar; here it's a slim bar) */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            padding: "var(--space-3) var(--space-4)",
            borderBottom: "1px solid var(--color-border)",
            background: "var(--color-surface)",
          }}
        >
          <ImportControl onImported={load} />
        </div>

        <div style={{ padding: "var(--space-2) 0", flex: 1, minHeight: 0 }}>
          {state.kind === "loading" && (
            <div style={{ padding: "var(--space-4)" }}>
              <Spinner label="Loading activities…" />
            </div>
          )}

          {state.kind === "error" && (
            <div style={{ padding: "var(--space-4)" }}>
              <Banner kind="error">
                Couldn’t reach the API — {state.message}. Import to add data once the
                backend is up.
              </Banner>
            </div>
          )}

          {state.kind === "ok" && rows.length === 0 && (
            <div style={{ padding: "var(--space-4)" }}>
              <Banner kind="info">
                {activities.length === 0
                  ? "No activities yet. Import a .fit / .gpx / .tcx file to get started."
                  : "No activities match this filter."}
              </Banner>
            </div>
          )}

          {state.kind === "ok" && rows.length > 0 && (
            <ActivitiesTable rows={rows} sort={sort} onSort={toggleSort} onOpen={onOpen} />
          )}
        </div>
      </section>
    </div>
  );
}

/* --------------------------------------------------------------- sidebar */

function Sidebar({
  total,
  counts,
  active,
  onSelect,
}: {
  total: number;
  counts: Map<Sport, number>;
  active: Sport | "all";
  onSelect: (s: Sport | "all") => void;
}) {
  const sports = [...counts.keys()].sort();
  return (
    <nav
      style={{
        width: "13.5rem",
        flex: "0 0 auto",
        borderRight: "1px solid var(--color-border)",
        background: "var(--color-surface)",
        padding: "var(--space-3) var(--space-2)",
        overflow: "auto",
      }}
    >
      <div
        style={{
          padding: "0 var(--space-2) var(--space-2)",
          color: "var(--color-text-muted)",
          fontSize: "0.7rem",
          fontWeight: "var(--font-weight-bold)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        Sports
      </div>
      <FilterRow
        label="All activities"
        icon="📋"
        count={total}
        active={active === "all"}
        onClick={() => onSelect("all")}
      />
      {sports.map((s) => (
        <FilterRow
          key={s}
          label={sportLabel(s)}
          icon={sportIcon(s)}
          count={counts.get(s) ?? 0}
          active={active === s}
          onClick={() => onSelect(s)}
        />
      ))}
    </nav>
  );
}

function FilterRow({
  label,
  icon,
  count,
  active,
  onClick,
}: {
  label: string;
  icon: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="ofit-row"
      onClick={onClick}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        textAlign: "left",
        font: "inherit",
        fontSize: "var(--font-size-sm)",
        padding: "var(--space-2) var(--space-2)",
        borderRadius: "var(--radius-sm)",
        border: "1px solid transparent",
        cursor: "pointer",
        background: active ? "var(--color-accent-weak)" : "transparent",
        color: active ? "var(--color-accent-strong)" : "var(--color-text)",
        fontWeight: active ? "var(--font-weight-bold)" : "var(--font-weight-normal)",
        boxShadow: active ? "inset 2px 0 0 0 var(--color-accent)" : "none",
      }}
    >
      <span aria-hidden style={{ width: "1.25rem", textAlign: "center" }}>
        {icon}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      <span style={{ color: "var(--color-text-muted)", fontVariantNumeric: "tabular-nums" }}>
        {count}
      </span>
    </button>
  );
}

/* ----------------------------------------------------------------- table */

function ActivitiesTable({
  rows,
  sort,
  onSort,
  onOpen,
}: {
  rows: ActivitySummary[];
  sort: { key: SortKey; dir: SortDir };
  onSort: (k: SortKey) => void;
  onOpen: (id: string) => void;
}) {
  const arrow = (k: SortKey) => (sort.key === k ? (sort.dir === "asc" ? " ▲" : " ▼") : "");
  return (
    <table
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: "var(--font-size-sm)",
      }}
    >
      <thead>
        <tr>
          <Th onClick={() => onSort("sport")}>Sport{arrow("sport")}</Th>
          <Th onClick={() => onSort("started_at")}>Started{arrow("started_at")}</Th>
          <Th align="right" onClick={() => onSort("duration_secs")}>
            Duration{arrow("duration_secs")}
          </Th>
          <Th align="right" onClick={() => onSort("recording_count")}>
            Recordings{arrow("recording_count")}
          </Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((a) => (
          <tr
            key={a.id}
            className="ofit-row"
            onClick={() => onOpen(a.id)}
            style={{ cursor: "pointer", borderBottom: "1px solid var(--color-border)" }}
          >
            <Td>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)" }}>
                <span aria-hidden>{sportIcon(a.sport)}</span>
                <strong style={{ fontWeight: "var(--font-weight-bold)" }}>
                  {sportLabel(a.sport)}
                </strong>
              </span>
            </Td>
            <Td muted>{formatDateTime(a.started_at)}</Td>
            <Td align="right" tabular>
              {formatDuration(a.duration_secs)}
            </Td>
            <Td align="right" tabular muted>
              {a.recording_count}
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Th({
  children,
  align = "left",
  onClick,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  onClick?: () => void;
}) {
  return (
    <th
      onClick={onClick}
      style={{
        position: "sticky",
        top: 0,
        zIndex: 1,
        textAlign: align,
        padding: "var(--space-2) var(--space-4)",
        background: "var(--color-surface-alt)",
        borderBottom: "1px solid var(--color-border)",
        color: "var(--color-text-muted)",
        fontWeight: "var(--font-weight-bold)",
        whiteSpace: "nowrap",
        cursor: onClick ? "pointer" : "default",
        userSelect: "none",
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  muted,
  tabular,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  muted?: boolean;
  tabular?: boolean;
}) {
  return (
    <td
      style={{
        textAlign: align,
        padding: "var(--space-2) var(--space-4)",
        color: muted ? "var(--color-text-muted)" : "var(--color-text)",
        fontVariantNumeric: tabular ? "tabular-nums" : "normal",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </td>
  );
}
