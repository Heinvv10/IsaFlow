/**
 * Shared primitives for the /bureau cockpit work aggregator and its signals.
 * Pure — no runtime dependencies — so signal modules can import these without
 * creating a cycle back through the aggregator.
 */

export type Severity = 'overdue' | 'due_soon' | 'info';

export interface WorkItem {
  bureauId: string;
  bureauName: string;
  companyId: string;
  companyName: string;
  task: string;
  detail: string;
  dueAt: string | null;
  href: string;
  severity: Severity;
  /** ZAR value when the signal carries one (bills, unreconciled); null/omitted otherwise. */
  amount?: number | null;
}

export interface CompanyMeta {
  bureau_id: string;
  bureau_name: string;
  company_id: string;
  company_name: string;
}

export interface MonthEndStat {
  closed: number;
  total: number;
}

export const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function formatPeriod(month: number, year: number): string {
  return `${MONTHS[month - 1]} ${year}`;
}

export function endOfNextMonth(periodMonth: number, periodYear: number): Date {
  const nextMonth = periodMonth === 12 ? 1 : periodMonth + 1;
  const nextYear = periodMonth === 12 ? periodYear + 1 : periodYear;
  return new Date(nextYear, nextMonth, 0, 23, 59, 59);
}

export function severityForDate(due: Date, today: Date): Severity {
  const days = (due.getTime() - today.getTime()) / (24 * 3600 * 1000);
  if (days < 0) return 'overdue';
  if (days <= 7) return 'due_soon';
  return 'info';
}

/**
 * Collapse fully identical work items (same company + task + due date + href),
 * keeping the first occurrence. Defence-in-depth against signal overlap —
 * the compliance engine and vatDueSignal emit disjoint VAT periods by design
 * (future-ending vs just-ended), so a collision indicates drift. The href is
 * part of the key so distinct targets (e.g. two pay runs sharing a period)
 * are never merged.
 */
export function dedupeWorkItems(items: WorkItem[]): WorkItem[] {
  const seen = new Set<string>();
  const out: WorkItem[] = [];
  for (const it of items) {
    const key = `${it.companyId}|${it.task}|${it.dueAt ?? ''}|${it.href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}
