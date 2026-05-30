// Generic empty-state screen for nav items that have no module yet
// (Sleep, Trends, Algorithms, Devices & sources) plus the 404 fallback.
// Renders inside the AppShell with an on-brand <EmptyState>.

import { AppShell } from "../app/AppShell";
import { EmptyState } from "../ui/EmptyState";

export interface ComingSoonProps {
  title: string;
  crumb?: string;
  phase?: string;
  hint?: string;
}

export function ComingSoon({
  title,
  crumb,
  phase = "Phase 4",
  hint,
}: ComingSoonProps) {
  return (
    <AppShell title={title} crumb={crumb}>
      <EmptyState label="No data yet" phase={phase} hint={hint} />
    </AppShell>
  );
}
