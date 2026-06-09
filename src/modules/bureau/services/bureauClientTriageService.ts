/**
 * Per-client triage roll-up for the /bureau cockpit board.
 *
 * Pure: no DB, no clock. Groups the already-aggregated cross-client work items
 * by company into a single R/A/G+Blue light + severity counts. Iterates the
 * roster so clear clients (zero work) still produce a green row. Work items
 * whose company is not in the roster are ignored (defence-in-depth, mirrors the
 * aggregator's meta.get guards).
 */
import type { WorkItem, CompanyMeta } from './bureauWorkTypes';

export type TriageLight = 'red' | 'amber' | 'blue' | 'green';

export interface ClientTriage {
  companyId: string;
  companyName: string;
  bureauId: string;
  bureauName: string;
  light: TriageLight;
  overdue: number;
  dueSoon: number;
  info: number;
  total: number;
}

const LIGHT_RANK: Record<TriageLight, number> = { red: 0, amber: 1, blue: 2, green: 3 };

function lightFor(overdue: number, dueSoon: number, info: number): TriageLight {
  if (overdue > 0) return 'red';
  if (dueSoon > 0) return 'amber';
  if (info > 0) return 'blue';
  return 'green';
}

export function rollupClientTriage(workItems: WorkItem[], roster: CompanyMeta[]): ClientTriage[] {
  const rosterIds = new Set(roster.map((r) => r.company_id));
  const counts = new Map<string, { overdue: number; dueSoon: number; info: number }>();
  for (const it of workItems) {
    if (!rosterIds.has(it.companyId)) continue;
    const c = counts.get(it.companyId) ?? { overdue: 0, dueSoon: 0, info: 0 };
    if (it.severity === 'overdue') c.overdue += 1;
    else if (it.severity === 'due_soon') c.dueSoon += 1;
    else c.info += 1;
    counts.set(it.companyId, c);
  }

  const rows: ClientTriage[] = roster.map((r) => {
    const c = counts.get(r.company_id) ?? { overdue: 0, dueSoon: 0, info: 0 };
    return {
      companyId: r.company_id,
      companyName: r.company_name,
      bureauId: r.bureau_id,
      bureauName: r.bureau_name,
      light: lightFor(c.overdue, c.dueSoon, c.info),
      overdue: c.overdue,
      dueSoon: c.dueSoon,
      info: c.info,
      total: c.overdue + c.dueSoon + c.info,
    };
  });

  rows.sort((a, b) => {
    if (LIGHT_RANK[a.light] !== LIGHT_RANK[b.light]) return LIGHT_RANK[a.light] - LIGHT_RANK[b.light];
    if (a.overdue !== b.overdue) return b.overdue - a.overdue;
    return a.companyName.localeCompare(b.companyName);
  });

  return rows;
}
