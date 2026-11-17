/**
 * import_budget_workbook unit tests: a mocked grid save that applies its cells to the version's cells (typed
 * cells are 'manual', as the save writes them), a mocked cell read answering what that save left, and JSON
 * template rows with their signed base.
 */
import type { Mock } from 'vitest';
import type { GridCell, GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { SaveCell } from '@/modules/accounting/services/budgets/gridSave';
import { encodeRowBase } from '@/modules/accounting/services/budgets/budgetTemplateSignature';
import type { TemplateGrain } from '@/modules/accounting/services/budgets/budgetTemplateXlsx';
import { toCents } from '@/modules/accounting/services/budgets/grid/cents';
import { centsText } from '@/lib/mcp/tools/budgetToolArgs';
import { MONTHS, VERSION } from './budgetToolsFixture';

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

/** Every month of the fixture year, null unless set. */
export const monthsOf = (set: Record<string, unknown>) => Object.fromEntries(MONTHS.map((m) => [m, m in set ? set[m] : null]));

/**
 * A JSON template row of `accountId` (at `grain`, for `memberId`) as get_budget_template answers it when the version
 * holds `model`'s cells: `base` signed over the months as read; `months` those values with `set` laid over them.
 */
export function basedRow(model: GridReadModel, accountId: string, set: Record<string, unknown>, opts: { grain?: TemplateGrain; memberId?: string } = {}) {
  const grain = opts.grain ?? 'company';
  const memberId = opts.memberId ?? null;
  const at = (m: string) => model.cells.find((c) => c.glAccountId === accountId && c.month === m
    && (grain === 'cc1' ? c.cc1Id === memberId : c.cc1Id === null) && c.cc2Id === null && c.buId === null);
  const cents = MONTHS.map((m) => { const c = at(m); return c ? toCents(c.amount) : null; });
  const base = encodeRowBase({ versionId: VERSION, fiscalYear: 2027, grain, months: MONTHS }, { accountId, memberId, cents });
  const code = model.accounts.find((a) => a.id === accountId)?.code ?? accountId;
  const member = memberId === null ? null : model.dimensions.cc1.find((m) => m.id === memberId)?.code ?? memberId;
  return {
    account: code, ...(member === null ? {} : { dimension: member }), base,
    months: { ...Object.fromEntries(MONTHS.map((m, i) => [m, cents[i] === null ? null : centsText(cents[i]!)])), ...set } as Record<string, unknown>,
  };
}
