/** The POs a skipped budget check would have blocked, read from the PO batches' own answers (`would_have_failed`). PURE. */
import type { BatchReport, MigrationReport } from './sageMigrationTypes';

interface Skipped { po_number?: unknown; reasons?: unknown }

export function budgetWouldHaveFailed(phase: BatchReport[]): MigrationReport['budgetWouldHaveFailed'] {
  return phase.flatMap((b) => {
    const list = (b.toolReported?.would_have_failed ?? []) as Skipped[];
    return list.map((x) => ({ poNumber: String(x.po_number), reasons: Array.isArray(x.reasons) ? x.reasons.map(String) : [] }));
  });
}
