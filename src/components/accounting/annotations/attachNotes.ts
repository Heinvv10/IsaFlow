/**
 * Merges annotation counts onto rows. Pure, and returns new objects: the grid
 * renders what it is given, and an adapter's output must not be mutated behind
 * its back. It touches no figure — only `note`.
 */
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import type { Annotation } from '@/modules/accounting/services/annotations/annotationService';

export function attachNotes(rows: StatementRow[], annotations: Annotation[]): StatementRow[] {
  if (annotations.length === 0) return rows.map(r => ({ ...r }));
  const byRow = new Map<string, Annotation[]>();
  for (const a of annotations) {
    const list = byRow.get(a.rowId);
    if (list) list.push(a); else byRow.set(a.rowId, [a]);
  }
  return rows.map(r => {
    const list = byRow.get(r.id);
    if (!list || list.length === 0) return { ...r };
    return { ...r, note: { count: list.length, hasOpen: list.some(a => a.resolvedAt === null) } };
  });
}
