/**
 * Grouping of WIP time entries into invoice lines (by work item or by job
 * category), for generateWipInvoice. Pure: no I/O.
 */
import type { DbRow } from '@/types/db';

export type GroupedLine = { name: string; hours: number; value: number };

export function buildGroupedLines(entries: DbRow[], groupBy: 'by_work_item' | 'by_category'): Map<string, GroupedLine> {
  const wi = groupBy === 'by_work_item';
  const groups = new Map<string, GroupedLine>();
  for (const e of entries) {
    const k = wi ? String(e.work_item_id) : String(e.job_category_id);
    const name = wi ? String(e.work_item_name ?? 'Work item') : String(e.job_category_name ?? 'Category');
    const prev = groups.get(k) ?? { name, hours: 0, value: 0 };
    prev.hours += Number(e.hours); prev.value += Number(e.line_total);
    groups.set(k, prev);
  }
  return groups;
}
