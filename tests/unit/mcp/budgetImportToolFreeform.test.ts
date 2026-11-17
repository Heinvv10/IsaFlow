/**
 * import_budget_workbook with a free-form .xlsx (review round 2): a workbook with neither _meta nor _base is read
 * as a free-form sheet (`budgetImportFreeform`) and written as an explicit OVERWRITE of the version as it is:
 * version_token required and equal to the version's token now (dry run and live), the dry run's plan_hash required
 * live, the reply saying it has no base. A workbook with _meta but no _base stays refused as tampered.
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
vi.mock('@/modules/accounting/services/budgets/budgetRefResolve', async (orig) => ({
  ...(await orig<object>()), explainMissingAccounts: vi.fn(async (_c: string, refs: string[]) => new Map(refs.map((r) => [r, `${r} is not an account of this company`]))),
}));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({ inRolledBackSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => { await fn(); }) }));

import { BUDGET_SPREADSHEET_SLOT } from '@/lib/withCpuSlot';
import { getVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { loadGridCells, loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { saveCells } from '@/modules/accounting/services/budgets/gridSave';
import { importBudgetWorkbookTool as tool } from '@/lib/mcp/tools/budgetImportTool';
import { MONTHS, RENT, SALES, TOKEN, VERSION, ctx, json, model, text, version } from './budgetToolsFixture';
import { applySave } from './budgetImportFixture';

const KEY = { idempotency_key: 'k-1', version_id: VERSION };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getVersion).mockResolvedValue(version() as never);
  vi.mocked(loadGridReadModel).mockResolvedValue(model());
  applySave(model(), vi.mocked(saveCells), vi.mocked(loadGridCells));
});

async function freeform(rows: unknown[][], extraSheet?: string): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('My plan');
  for (const r of rows) ws.addRow(r);
  if (extraSheet) wb.addWorksheet(extraSheet).addRow(['versionId', VERSION]);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}
const FILE = () => freeform([['Code', 'Description', ...MONTHS], ['6000', 'Rent', null, 250], ['4000', 'Sales', 'clear', null, 1000]]);

describe('a free-form sheet is an explicit overwrite of the version as it is', () => {
  it('version_token is required, dry run and live', async () => {
    for (const dry of [true, false]) {
      expect(text(await tool.handler({ ...KEY, file_base64: await FILE(), dry_run: dry }, ctx())))
        .toMatch(/^This workbook is a free-form sheet \(it has no IsaFlow _meta or _base sheet\), so it overwrites: send version_token/);
    }
    expect(saveCells).not.toHaveBeenCalled();
  });

  it('a version_token that is not the version\'s now is refused, dry run and live', async () => {
    for (const dry of [true, false]) {
      expect(text(await tool.handler({ ...KEY, file_base64: await FILE(), version_token: '2026-11-16T09:00:00.000001Z', dry_run: dry, plan_hash: 'a'.repeat(64) }, ctx())))
        .toMatch(/^This budget was saved after the version_token this sheet was sent with/);
    }
    expect(saveCells).not.toHaveBeenCalled();
  });

  it('dry run: the cells it sets (blank keeps, "clear" clears), the overwrite said plainly; live needs its plan_hash, then saves', async () => {
    const args = { ...KEY, file_base64: await FILE(), version_token: TOKEN };
    const dry = json(await tool.handler({ ...args, dry_run: true }, ctx()));
    expect(dry).toMatchObject({ ready: true, format: 'xlsx', sheet: 'free-form', sheet_name: 'My plan', conflict_count: 0 });
    expect(String(dry.overwrite)).toMatch(/^This sheet has no base: every cell it names is set to the sheet's value, even if someone changed it after you read version_token/);
    expect((dry.cells as Array<{ i: number; account: string; month: string; status: string }>).map((c) => `${c.i}:${c.account}:${c.month}:${c.status}`))
      .toEqual(['2:6000:2026-04:added', '3:4000:2026-05:added']); // Rent March (100) kept: blank; Sales March cleared: it held nothing
    vi.mocked(saveCells).mockClear();
    expect(text(await tool.handler(args, ctx()))).toMatch(/plan_hash is required/);
    expect(saveCells).not.toHaveBeenCalled();
    expect(json(await tool.handler({ ...args, plan_hash: dry.plan_hash }, ctx()))).toMatchObject({ saved: 2, sheet: 'free-form' });
    expect(vi.mocked(saveCells).mock.calls[0]![2].cells).toEqual([
      { glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month: '2026-04', amount: 250 },
      { glAccountId: SALES, cc1Id: null, cc2Id: null, buId: null, month: '2026-05', amount: 1000 },
    ]);
  });

  it('a layout fault is refused whole with its sheet, row and column; an unknown code is refused per row at its sheet row', async () => {
    expect(text(await tool.handler({ ...KEY, file_base64: await freeform([['Code', ...MONTHS, 'Budget owner']]), version_token: TOKEN, dry_run: true }, ctx())))
      .toMatch(/^Sheet "My plan", row 1, column N: "Budget owner" is not an account code, dimension or month column/);
    const dry = json(await tool.handler({ ...KEY, file_base64: await freeform([['Code', ...MONTHS], ['9999', 1]]), version_token: TOKEN, dry_run: true }, ctx()));
    expect((dry.cells as Array<{ i: number; status: string; reason: string }>).filter((c) => c.status === 'refused').map((c) => [c.i, c.reason]))
      .toEqual([[2, '9999 is not an account of this company']]);
  });

  it('is read inside the spreadsheet CPU slot', async () => {
    const run = vi.spyOn(BUDGET_SPREADSHEET_SLOT, 'run');
    await tool.handler({ ...KEY, file_base64: await FILE(), version_token: TOKEN, dry_run: true }, ctx());
    expect(run).toHaveBeenCalledTimes(1);
    run.mockRestore();
  });
});

describe('review round 3: the sheet read, and what it must not read silently', () => {
  type Sheet = { name: string; rows: unknown[][]; state?: 'visible' | 'hidden' | 'veryHidden'; edit?: (ws: ExcelJS.Worksheet) => void };
  async function book(...sheets: Sheet[]): Promise<string> {
    const wb = new ExcelJS.Workbook();
    for (const sh of sheets) {
      const ws = wb.addWorksheet(sh.name, { state: sh.state ?? 'visible' });
      for (const r of sh.rows) ws.addRow(r);
      sh.edit?.(ws);
    }
    return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  }
  const dry = async (file: string) => tool.handler({ ...KEY, file_base64: file, version_token: TOKEN, dry_run: true }, ctx());
  const listed = (out: Record<string, unknown>) => (out.cells as Array<{ i: number; account: string; month: string; status: string; reason?: string }>);

  it.each(['hidden', 'veryHidden'] as const)('F1: a %s sheet first is not read: the first VISIBLE sheet is, and the reply names it', async (state) => {
    const file = await book({ name: 'Old draft', state, rows: [['Code', ...MONTHS], ['6000', null, 999]] }, { name: 'Budget', rows: [['Code', ...MONTHS], ['6000', null, 250]] });
    const out = json(await dry(file));
    expect(out).toMatchObject({ sheet: 'free-form', sheet_name: 'Budget' });
    expect(listed(out).map((c) => `${c.account}:${c.month}:${c.status}`)).toEqual(['6000:2026-04:added']);
    expect(vi.mocked(saveCells).mock.calls[0]![2].cells).toEqual([{ glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month: '2026-04', amount: 250 }]);
  });

  it.each(['_Meta', '_BASE', '_meta ', ' _base'])('F2: a sheet named %j (IsaFlow\'s hidden sheet, renamed) refuses the workbook', async (name) => {
    const r = await dry(await book({ name: 'Budget', rows: [['Code', ...MONTHS], ['6000', 1]] }, { name, rows: [['versionId', VERSION]] }));
    expect([r.isError, text(r)]).toEqual([true, expect.stringMatching(/^This workbook has a sheet named ".*" that is not IsaFlow\'s _(meta|base) sheet exactly/)]);
    expect(saveCells).not.toHaveBeenCalled();
  });

  it('F2: a template\'s Budget sheet copied into a new workbook is refused (its blanks would keep, not clear)', async () => {
    const r = await dry(await book({ name: 'Budget', rows: [['Section', 'Account code', 'Account name', ...MONTHS, 'FY total', 'PY actual'], ['Operating expenses', '6000', 'Rent', null, 5]] }));
    expect(text(r)).toMatch(/^Sheet "Budget", row 1: this is an IsaFlow budget template without its hidden _meta and _base sheets; download a fresh one/);
  });

  it('F3: a TRUE formula and a date-formatted formula in a month are refused per cell, with the sheet row and month', async () => {
    const file = await book({ name: 'Budget', rows: [['Code', ...MONTHS], ['6000', 1, 2]], edit: (ws) => {
      ws.getCell('B2').value = { formula: '1=1', result: true } as ExcelJS.CellFormulaValue;
      ws.getCell('C2').value = { formula: '2+2', result: 4 } as ExcelJS.CellFormulaValue;
      ws.getCell('C2').numFmt = 'dd/mm/yyyy';
    } });
    const refused = listed(json(await dry(file))).filter((c) => c.status === 'refused');
    expect(refused.map((c) => [c.i, c.month, c.reason])).toEqual([
      [2, '2026-03', 'This cell is a TRUE / FALSE result, not an amount.'],
      [2, '2026-04', 'This formula\'s result is formatted as a date, not an amount.'],
    ]);
  });

  it('a numeric code that lost its leading zero is a refused row in the reply (never guessed), so the live call writes nothing', async () => {
    vi.mocked(loadGridReadModel).mockResolvedValue(model({ accounts: [...model().accounts, { ...model().accounts[0]!, id: '20000000-0000-4000-8000-0000000000a1', code: '0400', name: 'Fees' }] }));
    const file = await book({ name: 'Budget', rows: [['Code', ...MONTHS], [400, 5], ['6000', null, 250]] });
    const out = json(await dry(file));
    expect([out.ready, listed(out).filter((c) => c.status === 'refused').map((c) => [c.i, c.account, c.reason])]).toEqual([false, [[2, '400', expect.stringMatching(/lost its leading zero \(0400\?\)/)]]]);
    expect(text(await tool.handler({ ...KEY, file_base64: file, version_token: TOKEN, plan_hash: 'a'.repeat(64) }, ctx()))).toMatch(/^1 cell is refused, so nothing was written/);
  });

  it('F5: cells merged across month columns refuse the workbook', async () => {
    const file = await book({ name: 'Budget', rows: [['Code', ...MONTHS], ['6000', 120]], edit: (ws) => ws.mergeCells('B2:D2') });
    expect(text(await dry(file))).toMatch(/^Sheet "Budget", cells B2:D2: merged across month columns/);
  });

  it('rows skipped (no code, totals, headings with no amounts) are listed by the dry run, and do not refuse the import', async () => {
    const out = json(await dry(await book({ name: 'Budget', rows: [['Code', ...MONTHS], ['Expenses'], ['6000', null, 250], ['Total', null, 250]] })));
    expect(out).toMatchObject({ ready: true, skipped_rows: [{ row: 2, reason: 'not an account, and no amounts (a heading?)' }, { row: 4, reason: 'a total row' }], skipped_count: 2 });
  });
});
