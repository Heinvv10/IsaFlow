/**
 * import_budget_workbook unit tests: a mocked grid save that applies its cells to the version's cells (typed
 * cells are 'manual', as the save writes them), and a mocked cell read answering what that save left.
 */
import type { Mock } from 'vitest';
import type { GridCell, GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { SaveCell } from '@/modules/accounting/services/budgets/gridSave';
import { VERSION } from './budgetToolsFixture';

export const savedAfter = { updatedAt: '2026-11-16T10:00:01.000001Z', saved: 2, deleted: 1, recomputed: 0, driverWarnings: [] };

const keyOf = (c: { glAccountId: string; cc1Id: string | null; cc2Id: string | null; buId: string | null; month: string }) =>
  `${c.glAccountId}|${c.cc1Id}|${c.cc2Id}|${c.buId}|${c.month}`;

export function applied(cells: readonly GridCell[], save: readonly SaveCell[]): GridCell[] {
  const out = new Map(cells.map((c) => [keyOf(c), c]));
  for (const s of save) {
    if (s.amount === null) out.delete(keyOf(s));
    else out.set(keyOf(s), { glAccountId: s.glAccountId, cc1Id: s.cc1Id, cc2Id: s.cc2Id, buId: s.buId, month: s.month, amount: s.amount, source: 'manual' });
  }
  return [...out.values()];
}

/** saveCells applies to `model`'s cells; loadGridCells answers the result. */
export function applySave(model: GridReadModel, save: Mock, read: Mock): void {
  let post: GridCell[] = model.cells;
  save.mockImplementation(async (_c: string, _u: string, input: { cells: SaveCell[] }) => { post = applied(model.cells, input.cells); return savedAfter; });
  read.mockImplementation(async () => ({ versionId: VERSION, updatedAt: savedAfter.updatedAt, cells: post }));
}
