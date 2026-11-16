/**
 * import_budget_workbook with the JSON grid (get_budget_template's rows, edited): the rows become the import's
 * own lines and go through the SAME resolve and diff as an .xlsx (`budgetImportDiff`), against the version as it
 * is, which is only sound while the version is what the grid was read from: so version_token is required and a
 * moved token is refused (read a fresh template). Accounts and members by id or code; every month of the year
 * listed (null = not budgeted); amounts decimal strings, else refused per row; the grid save's 20 000 changed
 * cells per call refused, never chunked; the request's own bounds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { getVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { loadGridCells, loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { MAX_SAVE_CELLS, saveCells } from '@/modules/accounting/services/budgets/gridSave';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { importBudgetWorkbookTool as tool, MAX_GRID_ROWS } from '@/lib/mcp/tools/budgetImportTool';
import { CC1, MONTHS, RENT, SALES, TOKEN, VERSION, ctx, json, model, text, version } from './budgetToolsFixture';
import { applySave } from './budgetImportFixture';

const KEY = { idempotency_key: 'k-1', version_id: VERSION };
let current: GridReadModel = model();
beforeEach(() => {
  vi.clearAllMocks();
  current = model();
  vi.mocked(getVersion).mockResolvedValue(version() as never);
  vi.mocked(loadGridReadModel).mockImplementation(async () => current);
  applySave(current, vi.mocked(saveCells), vi.mocked(loadGridCells));
});

const year = (set: Record<string, unknown> = {}) => Object.fromEntries(MONTHS.map((m) => [m, m in set ? set[m] : null]));
const grid = (rows: unknown[], extra: Record<string, unknown> = {}) => ({ ...KEY, version_token: TOKEN, rows, ...extra });
/** Rent as downloaded (March 100) with April set; Sales (by id) March set. */
const EDIT = [
  { account: '6000', months: year({ '2026-03': '100.00', '2026-04': '250.00' }) },
  { account: SALES, months: year({ '2026-03': '1000.00' }) },
];

describe('import_budget_workbook (json): the import\'s resolve and diff, then PR 1\'s write', () => {
  it('dry run then live: only the cells that differ from the version; an account by id or code; rows listed by position', async () => {
    const dry = json(await tool.handler({ ...grid(EDIT), dry_run: true }, ctx()));
    expect(dry).toMatchObject({ ready: true, format: 'json', import_counts: { added: 2, changed: 0, cleared: 0, unchanged: 22 } });
    expect((dry.cells as Array<{ i: number; account: string; month: string }>).map((c) => `${c.i}:${c.account}:${c.month}`)).toEqual(['1:6000:2026-04', '2:4000:2026-03']);
    const out = json(await tool.handler({ ...grid(EDIT), plan_hash: dry.plan_hash }, ctx()));
    expect(out).toMatchObject({ saved: 2, snapshot_id: 'snap-1' });
    expect(vi.mocked(saveCells).mock.calls.at(-1)![2].cells).toEqual([
      { glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month: '2026-04', amount: 250 },
      { glAccountId: SALES, cc1Id: null, cc2Id: null, buId: null, month: '2026-03', amount: 1000 },
    ]);
  });

  it('null clears a month that holds an amount; a row absent from the grid is untouched; one changed cell needs no plan_hash', async () => {
    const out = json(await tool.handler(grid([{ account: '6000', months: year() }]), ctx()));
    expect(out).toMatchObject({ saved: 2 });
    expect(vi.mocked(saveCells).mock.calls[0]![2].cells).toEqual([{ glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month: '2026-03', amount: null, clear: true }]);
  });

  it('version_token is required, and a version saved since the grid was read is refused (no silent revert)', async () => {
    expect(text(await tool.handler({ ...KEY, rows: EDIT, dry_run: true }, ctx()))).toMatch(/version_token is required with rows/);
    current = model({ updatedAt: '2026-11-16T11:00:00.000001Z' });
    const r = await tool.handler({ ...grid(EDIT), dry_run: true }, ctx());
    expect(text(r)).toMatch(/saved after the grid you are importing was read.*fresh template/);
    expect(saveCells).not.toHaveBeenCalled();
  });

  it('a dimension grid: rows by member code or id', async () => {
    const rows = [{ account: '7100', dimension: 'C1', months: year({ '2026-05': '7.00' }) }, { account: '4000', dimension: CC1, months: year({ '2026-05': '8.00' }) }];
    const dry = json(await tool.handler({ ...grid(rows, { grain: 'cc1' }), dry_run: true }, ctx()));
    expect((dry.counts as Record<string, number>).added).toBe(2);
    expect(vi.mocked(saveCells).mock.calls[0]![2].cells.map((c) => [c.cc1Id, c.month, c.amount])).toEqual([[CC1, '2026-05', 7], [CC1, '2026-05', 8]]);
  });
});

describe('import_budget_workbook (json): refusals', () => {
  it.each([
    ['a month missing', [{ account: '6000', months: Object.fromEntries(MONTHS.slice(1).map((m) => [m, null])) }], /row 1: months must list every month of FY2027.*missing 2026-03/],
    ['a month outside the year', [{ account: '6000', months: { ...year(), '2027-03': null } }], /row 1: months must list every month of FY2027.*2027-03 is not one/],
    ['a dimension at company grain', [{ account: '6000', dimension: 'C1', months: year() }], /row 1: dimension is only for a cc1, cc2 or bu grid/],
    ['a row that is not an object', ['6000'], /row 1 must be an object/],
    ['too many rows', Array.from({ length: MAX_GRID_ROWS + 1 }, () => ({ account: '6000', months: year() })), new RegExp(`at most ${MAX_GRID_ROWS} rows`)],
  ])('refused whole: %s', async (_n, rows, why) => {
    const r = await tool.handler({ ...grid(rows), dry_run: true }, ctx());
    expect([r.isError, text(r)]).toEqual([true, expect.stringMatching(why)]);
    expect(saveCells).not.toHaveBeenCalled();
  });

  it.each([
    ['both a file and rows', { file_base64: 'AAAA', rows: EDIT }],
    ['neither', {}],
  ])('one source per call: %s', async (_n, args) => {
    expect(text(await tool.handler({ ...KEY, version_token: TOKEN, dry_run: true, ...args }, ctx()))).toMatch(/Send file_base64 \(an \.xlsx\) or rows \(the JSON grid\), not both/);
  });

  it('per row: a number amount, three decimals, an unknown account, a header with no budget; the live call writes nothing', async () => {
    const rows = [
      { account: '6000', months: year({ '2026-04': 12.5 }) },
      { account: '4000', months: year({ '2026-04': '1.005' }) },
      { account: 'NOPE', months: year({ '2026-04': '1.00' }) },
      { account: '7000', months: year({ '2026-04': '1.00' }) },
      { account: '7100', months: year({ '2026-04': '3.00' }) },
    ];
    const dry = json(await tool.handler({ ...grid(rows), dry_run: true }, ctx()));
    const refused = (dry.cells as Array<{ i: number; status: string; month: string; reason: string }>).filter((c) => c.status === 'refused');
    expect(refused.map((c) => [c.i, c.month, c.reason])).toEqual([
      [1, '2026-04', expect.stringMatching(/decimal strings/)],
      [2, '2026-04', expect.stringMatching(/at most 2 decimals/)],
      [3, '', 'NOPE is not an account of this company'],
      [4, '', expect.stringMatching(/7000 Admin is a header account with no budget/)],
    ]);
    expect([dry.ready, dry.plan_hash]).toEqual([false, null]);
    expect(text(await tool.handler({ ...grid(rows), plan_hash: 'a'.repeat(64) }, ctx()))).toMatch(/4 cells are refused, so nothing was written/);
    expect(saveCells).not.toHaveBeenCalled();
  });

  it(`more than ${MAX_SAVE_CELLS} changed cells is refused, dry run and live, never chunked`, async () => {
    const accounts = Array.from({ length: Math.ceil((MAX_SAVE_CELLS + 1) / 12) }, (_, i) => ({
      ...model().accounts[0]!, id: `a${String(i).padStart(7, '0')}-1111-4111-8111-111111111111`, code: `X${i}`,
    }));
    current = model({ accounts, cells: [] });
    const rows = accounts.map((a) => ({ account: a.code, months: year(Object.fromEntries(MONTHS.map((m) => [m, '1.00']))) }));
    for (const dry of [true, false]) {
      const r = await tool.handler({ ...grid(rows), dry_run: dry, plan_hash: 'a'.repeat(64) }, ctx());
      expect(text(r)).toMatch(new RegExp(`changes ${accounts.length * 12} cells; one call writes at most ${MAX_SAVE_CELLS}`));
    }
    expect(saveCells).not.toHaveBeenCalled();
  });
});
