/**
 * import_budget_workbook with an .xlsx (MCP budget tools PR 2): the file goes through the import preview's own
 * parse, signature check, resolve and 3-way diff (`budgetImportDiff`), and its cells through PR 1's one write path
 * (dry run = the real grid save rolled back, plan_hash, all or nothing, snapshot). A tampered _base, a forged
 * signature, a damaged or old-style file and another version's file are refused whole; unknown, ambiguous,
 * non-P&L and header rows are refused per row with the reason; the size bound is refused before decoding.
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
  ...(await orig<object>()), explainMissingAccounts: vi.fn(async (_c: string, refs: string[]) => new Map(refs.map((r) => [r, r === '1000'
    ? '1000 Bank is not a revenue or expense account; budgets are set on income statement accounts only' : `${r} is not an account of this company`]))),
}));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({ inRolledBackSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => { await fn(); }) }));

import { checkRateLimit } from '@/lib/rateLimit';
import { getVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { loadGridCells, loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { saveCells } from '@/modules/accounting/services/budgets/gridSave';
import { recordSnapshot } from '@/modules/accounting/services/budgets/budgetWriteSnapshots';
import { buildBudgetTemplate } from '@/modules/accounting/services/budgets/budgetTemplateXlsx';
import { previewImport } from '@/modules/accounting/services/budgets/budgetImportDiff';
import { readBudgetWorkbook } from '@/modules/accounting/services/budgets/budgetImportParse';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { importBudgetWorkbookTool as tool, MAX_WORKBOOK_BASE64 } from '@/lib/mcp/tools/budgetImportTool';
import { CC1, MONTHS, RENT, SALES, TOKEN, VERSION, ctx, json, model, text, version } from './budgetToolsFixture';
import { applySave, savedAfter } from './budgetImportFixture';

vi.stubEnv('JWT_SECRET', 'k'.repeat(40)); // the template signature's key (any value)
const KEY = { idempotency_key: 'k-1', version_id: VERSION };
const prior = { fiscalYear: 2027, grain: 'company', months: MONTHS, priorMonths: MONTHS, cells: [] } as never;

let current: GridReadModel = model();
beforeEach(() => {
  vi.clearAllMocks();
  current = model();
  vi.mocked(checkRateLimit).mockResolvedValue(true);
  vi.mocked(getVersion).mockResolvedValue(version() as never);
  vi.mocked(loadGridReadModel).mockImplementation(async () => current);
  applySave(current, vi.mocked(saveCells), vi.mocked(loadGridCells));
});

const col = (ws: ExcelJS.Worksheet, header: string) => { let at = 0; ws.getRow(1).eachCell((c, n) => { if (String(c.value) === header) at = n; }); return at; };
const rowOf = (ws: ExcelJS.Worksheet, code: string) => { for (let r = 2; r <= ws.rowCount; r++) if (String(ws.getRow(r).getCell(2).value) === code) return r; return 0; };

async function edited(edit: (wb: ExcelJS.Workbook) => void, from: GridReadModel = model()): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildBudgetTemplate(from, 'company', prior)) as unknown as ArrayBuffer);
  edit(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
/** Rent April 250, Sales March 1000, Rent March (100) cleared: three changed cells. */
const threeEdits = (wb: ExcelJS.Workbook) => {
  const ws = wb.getWorksheet('Budget')!;
  ws.getRow(rowOf(ws, '6000')).getCell(col(ws, '2026-04')).value = 250;
  ws.getRow(rowOf(ws, '4000')).getCell(col(ws, '2026-03')).value = 1000;
  ws.getRow(rowOf(ws, '6000')).getCell(col(ws, '2026-03')).value = null;
};
const b64 = (file: Buffer) => file.toString('base64');

describe('import_budget_workbook (xlsx): the import preview\'s path, then PR 1\'s write', () => {
  it('dry run: the 3-way diff\'s cells, each listed at its sheet row; plan_hash; the real save rolled back; nothing kept', async () => {
    const file = await edited(threeEdits);
    const r = await tool.handler({ ...KEY, file_base64: b64(file), dry_run: true }, ctx());
    const out = json(r);
    expect(r.wroteNothing).toBe(true);
    expect(out).toMatchObject({ dry_run: true, ready: true, format: 'xlsx', plan_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(out.counts).toMatchObject({ added: 2, removed: 1, refused: 0 });
    expect(out.import_counts).toEqual({ added: 2, changed: 0, cleared: 1, unchanged: 33 });
    const cells = out.cells as Array<{ i: number; account: string; month: string; status: string }>;
    expect(cells.map((c) => `${c.i}:${c.account}:${c.month}:${c.status}`).sort()).toEqual(['2:4000:2026-03:added', '3:6000:2026-03:removed', '3:6000:2026-04:added']);
    const expected = previewImport(model(), VERSION, await readBudgetWorkbook(file)).cells;
    expect(vi.mocked(saveCells).mock.calls[0]![2]).toEqual({ versionId: VERSION, expectedUpdatedAt: TOKEN, cells: expected });
  });

  it('live: refused without plan_hash (more than one cell); with it, saves exactly the preview\'s cells and records the undo snapshot', async () => {
    const file = await edited(threeEdits);
    const hash = json(await tool.handler({ ...KEY, file_base64: b64(file), dry_run: true }, ctx())).plan_hash;
    vi.mocked(saveCells).mockClear();
    expect(text(await tool.handler({ ...KEY, file_base64: b64(file) }, ctx()))).toMatch(/plan_hash is required/);
    expect(saveCells).not.toHaveBeenCalled();
    const out = json(await tool.handler({ ...KEY, file_base64: b64(file), plan_hash: hash }, ctx()));
    expect(out).toMatchObject({ saved: 2, snapshot_id: 'snap-1', version_token: savedAfter.updatedAt });
    expect(vi.mocked(saveCells).mock.calls[0]![2].cells).toEqual(previewImport(model(), VERSION, await readBudgetWorkbook(file)).cells);
    expect(vi.mocked(recordSnapshot).mock.calls[0]![1]).toMatchObject({ tool: 'import_budget_workbook', tokenBefore: TOKEN, cells: expect.arrayContaining([expect.objectContaining({ a: RENT, m: '2026-03', before: '100.00', after: null })]) });
  });

  it('a cell changed in the version since the dry run: the same file\'s plan_hash is "plan changed"', async () => {
    const file = await edited(threeEdits);
    const hash = json(await tool.handler({ ...KEY, file_base64: b64(file), dry_run: true }, ctx())).plan_hash;
    current = model({ updatedAt: '2026-11-16T11:00:00.000001Z', cells: [{ ...model().cells[0]!, amount: 101 }] });
    vi.mocked(saveCells).mockClear();
    expect(text(await tool.handler({ ...KEY, file_base64: b64(file), plan_hash: hash }, ctx()))).toMatch(/plan changed since your dry run/);
    expect(saveCells).not.toHaveBeenCalled();
  });
});

describe('import_budget_workbook (xlsx): a file refused whole writes nothing', () => {
  const editBase = (wb: ExcelJS.Workbook) => { wb.getWorksheet('_base')!.getRow(3).getCell(2).value = 5; };
  const forgeSignature = (wb: ExcelJS.Workbook) => {
    const meta = wb.getWorksheet('_meta')!;
    meta.eachRow((row) => { if (row.getCell(1).value === 'signature') row.getCell(2).value = 'f'.repeat(64); });
  };
  it.each([
    ['a tampered _base', async () => b64(await edited(editBase)), /_base or _meta sheet was changed/],
    ['a forged signature', async () => b64(await edited(forgeSignature)), /_base or _meta sheet was changed/],
    ['another version\'s file', async () => b64(await edited(() => undefined, model({ version: version({ id: '10000000-0000-4000-8000-0000000000ff' }) as never }))), /downloaded for another budget version/],
    ['not a workbook', async () => b64(Buffer.from('hello, this is not a spreadsheet')), /not an Excel workbook/],
    ['an old .xls file', async () => b64(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), /Old-style Excel .xls/],
    ['not base64', async () => 'not base64!', /file_base64 must be the .xlsx file as standard base64/],
    ['past the size bound (before decoding)', async () => 'A'.repeat(MAX_WORKBOOK_BASE64 + 4), /larger than one MCP request can carry/],
  ])('%s', async (_n, file, why) => {
    for (const dry of [true, false]) {
      const r = await tool.handler({ ...KEY, file_base64: await file(), dry_run: dry, plan_hash: 'a'.repeat(64) }, ctx());
      expect([r.isError, text(r)]).toEqual([true, expect.stringMatching(why)]);
    }
    expect(saveCells).not.toHaveBeenCalled();
  });

  it('shares the import preview\'s rate bucket', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce(false);
    expect(text(await tool.handler({ ...KEY, file_base64: b64(await edited(threeEdits)), dry_run: true }, ctx()))).toMatch(/Too many imports/);
    expect(checkRateLimit).toHaveBeenCalledWith('budget-import:u-1', { max: 60, windowSecs: 900 });
  });

  it('a budget holder\'s file changing a cell outside their slices is refused whole, as the import preview refuses it', async () => {
    current = model({ holder: { slices: [{ cc1Id: CC1, cc2Id: null, buId: null, glAccountIds: null }] } as never });
    const r = await tool.handler({ ...KEY, file_base64: b64(await edited(threeEdits)), dry_run: true }, ctx('manager'));
    expect(text(r)).toMatch(/changes cells outside your budget slices/);
    expect(saveCells).not.toHaveBeenCalled();
  });
});

describe('import_budget_workbook (xlsx): rows refused per row, with the reason', () => {
  const twins = model({ accounts: [...model().accounts, { ...model().accounts[0]!, id: '20000000-0000-4000-8000-0000000000aa', code: '4000 ', name: 'Sales twin' }] });
  it('unknown, non-P&L, ambiguous and header rows: listed refused at their sheet rows; the live call writes nothing', async () => {
    const file = await edited((wb) => {
      threeEdits(wb);
      const ws = wb.getWorksheet('Budget')!;
      ws.addRow(['Revenue', '9999', 'Unknown', 5]);
      ws.addRow(['Assets', '1000', 'Bank (balance sheet)', 5]);
      ws.addRow(['Revenue', ' 4000  ', 'Which one?', 5]);
      ws.addRow(['Operating expenses', '7000', 'Admin header', 5]);
    }, twins);
    current = twins;
    const out = json(await tool.handler({ ...KEY, file_base64: b64(file), dry_run: true }, ctx()));
    expect([out.ready, out.plan_hash, (out.counts as Record<string, number>).refused]).toEqual([false, null, 4]);
    const refused = (out.cells as Array<{ i: number; status: string; reason: string; account: string }>).filter((c) => c.status === 'refused');
    expect(refused.map((c) => [c.i, c.account, c.reason])).toEqual([
      [6, '9999', '9999 is not an account of this company'],
      [7, '1000', expect.stringMatching(/^1000 Bank is not a revenue or expense account; budgets are set on income statement accounts only/)],
      [8, ' 4000  ', expect.stringMatching(/matches more than one account/)],
      [9, '7000', expect.stringMatching(/7000 Admin is a header account with no budget in this version/)],
    ]);
    vi.mocked(saveCells).mockClear();
    expect(text(await tool.handler({ ...KEY, file_base64: b64(file), plan_hash: 'a'.repeat(64) }, ctx()))).toMatch(/^4 cells are refused, so nothing was written/);
    expect(saveCells).not.toHaveBeenCalled();
    expect(SALES).toBeTruthy();
  });
});
