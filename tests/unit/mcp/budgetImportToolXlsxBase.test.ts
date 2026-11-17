/**
 * import_budget_workbook (xlsx), review round 1: a workbook with `_meta` but no `_base` sheet is refused as tampered
 * (MEDIUM: the import preview diffs such a file against the version as it is, where `_meta`'s signature covers
 * nothing, so a forged or replayed file overwrote later saves with no conflict; round 2: one with NEITHER sheet is a
 * free-form sheet, budgetImportToolFreeform); and a conflict at a cc1 / cc2 / bu grain names its member
 * (breaker probe A: two members of one account and month were listed alike).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/budgets/budgetVersions', () => ({ getVersion: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridReadModel', () => ({ loadGridReadModel: vi.fn(), loadGridCells: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridSave', async (orig) => ({ ...(await orig<object>()), saveCells: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetWriteSnapshots', () => ({ recordSnapshot: vi.fn(async () => 'snap-1') }));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({ inRolledBackSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => { await fn(); }) }));

import { getVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { loadGridCells, loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { saveCells } from '@/modules/accounting/services/budgets/gridSave';
import { buildBudgetTemplate } from '@/modules/accounting/services/budgets/budgetTemplateXlsx';
import { bandTotals } from '@/modules/accounting/services/budgets/gridTotals';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { importBudgetWorkbookTool as tool } from '@/lib/mcp/tools/budgetImportTool';
import { CC1, MONTHS, RENT, TOKEN, VERSION, ctx, json, model, text, version } from './budgetToolsFixture';
import { applySave } from './budgetImportFixture';

vi.stubEnv('JWT_SECRET', 'k'.repeat(40)); // the template signature's key (any value)
const KEY = { idempotency_key: 'k-1', version_id: VERSION };
const CC1B = '30000000-0000-4000-8000-000000000002';
const T1 = '2026-11-16T11:00:00.000001Z';
let current: GridReadModel = model();
const use = (m: GridReadModel) => { current = m; applySave(m, vi.mocked(saveCells), vi.mocked(loadGridCells)); };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getVersion).mockResolvedValue(version() as never);
  vi.mocked(loadGridReadModel).mockImplementation(async () => current);
  use(model());
});

describe('a workbook with _meta but no _base sheet', () => {
  it('the breaker\'s from-scratch file (Budget header + one row, _meta without a signature) is refused as tampered; nothing is written', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Budget');
    ws.addRow(['Section', 'Account code', 'Account name', ...MONTHS]);
    ws.addRow(['Operating expenses', '6000', 'Rent', 9999]);
    const meta = wb.addWorksheet('_meta');
    for (const [k, v] of [['versionId', VERSION], ['fiscalYear', '2027'], ['grain', 'company'], ['updatedAt', TOKEN], ['templateVersion', '1']]) meta.addRow([k, v]);
    const file = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
    for (const dry of [true, false]) {
      const r = await tool.handler({ ...KEY, file_base64: file, dry_run: dry }, ctx());
      expect([r.isError, text(r)]).toEqual([true, expect.stringMatching(/^This template's hidden _base or _meta sheet was changed, .*it has _meta but no _base/)]);
    }
    expect(saveCells).not.toHaveBeenCalled();
  });
});

function cc1Model(a: number, b: number, token: string): GridReadModel {
  const base = model();
  const accounts = base.accounts.map((x) => (x.id === RENT ? { ...x, grain: 'cc1' } : x)) as GridReadModel['accounts'];
  return {
    ...base, version: version({ updatedAt: token }) as never, updatedAt: token, accounts, grains: { [RENT]: 'cc1' },
    cells: [CC1, CC1B].map((m, i) => ({ glAccountId: RENT, cc1Id: m, cc2Id: null, buId: null, month: '2026-03', amount: i === 0 ? a : b, source: 'manual' as const })),
    dimensions: { cc1: [{ id: CC1, code: 'C1', name: 'Centre', isActive: true }, { id: CC1B, code: 'C2', name: 'Other', isActive: true }], cc2: [], bu: [] },
    totals: bandTotals(accounts, new Map([[RENT, [(a + b) * 100, ...Array(11).fill(0)]]]), 12),
  };
}

describe('conflicts name their member (breaker probe A)', () => {
  it('two members of one account and month changed on both sides: two conflicts, each with its dimension', async () => {
    const prior = { fiscalYear: 2027, grain: 'cc1', months: MONTHS, priorMonths: MONTHS, cells: [] } as never;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildBudgetTemplate(cc1Model(100, 200, TOKEN), 'cc1', prior, [CC1, CC1B])) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Budget')!;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      if (String(row.getCell(2).value) === '6000') row.getCell(6).value = String(row.getCell(4).value) === 'C1' ? 111 : 222; // col 6 = 2026-03
    }
    use(cc1Model(150, 250, T1)); // a colleague changed both since
    const out = json(await tool.handler({ ...KEY, file_base64: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64'), dry_run: true }, ctx()));
    expect(out.conflicts).toEqual([
      { account: '6000', dimension: { kind: 'cc1', code: 'C1' }, month: '2026-03', downloaded: '100.00', current: '150.00', after: '111.00' },
      { account: '6000', dimension: { kind: 'cc1', code: 'C2' }, month: '2026-03', downloaded: '200.00', current: '250.00', after: '222.00' },
    ]);
  });
});
