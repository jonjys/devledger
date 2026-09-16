// Pure helpers behind the Connections screen.

import type { ConnectionSummary, MatchStatus, ReconcileItem, ReconcileReport } from "./types";

/** Which rows start ticked. Conflicts and possible matches never do. */
export function initialSelection(report: ReconcileReport): Set<string> {
  return new Set(
    report.items.filter((i) => i.selected_by_default).map((i) => i.provider_id),
  );
}

/** Whether a row can be ticked at all. A conflict needs a human, not a click. */
export function isSelectable(item: ReconcileItem): boolean {
  return item.status !== "matched" && item.status !== "conflict";
}

/** One line summarising a report, e.g. "3 new, 1 needs attention, 1 conflict". */
export function summarise(report: ReconcileReport): string {
  const parts: string[] = [];
  if (report.unmatched > 0) parts.push(`${report.unmatched} new`);
  if (report.needs_attention > 0) parts.push(`${report.needs_attention} to complete`);
  if (report.possible > 0) parts.push(`${report.possible} possible`);
  if (report.matched > 0) parts.push(`${report.matched} already known`);
  if (report.conflicts > 0) parts.push(`${report.conflicts} in conflict`);
  if (report.paused > 0) parts.push(`${report.paused} paused`);
  return parts.length > 0 ? parts.join(", ") : "nothing found";
}

/** Group a report into organizations with their projects, for display. */
export interface ReportGroup {
  organization: ReconcileItem | null;
  projects: ReconcileItem[];
}

export function groupReport(report: ReconcileReport): ReportGroup[] {
  const groups: ReportGroup[] = [];
  const orphans: ReconcileItem[] = [];

  for (const item of report.items) {
    if (item.scope === "organization") {
      groups.push({ organization: item, projects: [] });
      continue;
    }
    const parent = item.parent_provider_org_id;
    const group = parent
      ? groups.find((g) => g.organization?.provider_id === parent)
      : undefined;
    if (group) group.projects.push(item);
    else orphans.push(item);
  }

  if (orphans.length > 0) groups.push({ organization: null, projects: orphans });
  return groups;
}

/** How many ticked rows would actually be written. */
export function countToImport(report: ReconcileReport, selected: Set<string>): number {
  return report.items.filter(
    (i) => selected.has(i.provider_id) && isSelectable(i) && i.status !== "matched",
  ).length;
}

/** Visual tone for a status chip. */
export function statusTone(status: MatchStatus): string {
  switch (status) {
    case "matched":
      return "explicit";
    case "unmatched":
      return "strong";
    case "needs_attention":
      return "heuristic";
    case "possible_match":
      return "heuristic";
    case "conflict":
      return "unsafe";
  }
}

/** Connections grouped by connector, so each provider renders as one block. */
export function byConnector(
  connections: ConnectionSummary[],
): Map<string, ConnectionSummary[]> {
  const out = new Map<string, ConnectionSummary[]>();
  for (const summary of connections) {
    const key = summary.connection.connector_id;
    const existing = out.get(key);
    if (existing) existing.push(summary);
    else out.set(key, [summary]);
  }
  return out;
}
