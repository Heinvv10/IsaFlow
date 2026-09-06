/**
 * Merges annotation counts onto rows. Pure, and returns new objects: the grid
 * renders what it is given, and an adapter's output must not be mutated behind
 * its back. It touches no figure — only `note`.
 *
 * It lives here, beside the row model it transforms, rather than under
 * `src/components/`: nothing in it renders. It is the same kind of thing as
 * every other adapter in this directory — rows in, rows out — and a caller
 * that is not a React component (the PDF path, a test) should not have to
 * reach into the component tree to find it.
 */
import type { StatementRow } from './statementModel';
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
