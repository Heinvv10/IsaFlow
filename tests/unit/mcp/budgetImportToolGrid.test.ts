/**
 * import_budget_workbook with the JSON grid (get_budget_template's rows, edited): each row carries the signed
 * `base` it was read with (its months as read, bound to the version, year, grain, account and member), so the rows
 * go through the SAME resolve and 3-way diff as an .xlsx (`budgetImportDiff`): a cell changes only where the row
 * differs from its base, a colleague's later save is kept, a cell changed on both sides is a conflict (review round
 * 1, HIGH: rows read on pages at different tokens reverted a colleague's save). A missing or altered base refuses
 * the whole import; the row's identity is its base's account and member (a duplicate code resolves); every month of
 * the year listed (null = not budgeted); amounts decimal strings, else refused per row; the grid save's 20 000
 * changed cells per call refused, never chunked; the request's own bounds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/budgets/budgetVersions', () => ({ getVersion: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridReadModel', () => ({ loadGridReadModel: vi.fn(), loadGridCells: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/priorActuals', async (orig) => ({ ...(await orig<object>()), loadPriorActuals: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridSave', async (orig) => ({ ...(await orig<object>()), saveCells: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetWriteSnapshots', () => ({ recordSnapshot: vi.fn(async () => 'snap-1') }));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({ inRolledBackSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => { await fn(); }) }));

import { checkRateLimit } from '@/lib/rateLimit';
import { getVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { loadGridCells, loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { loadPriorActuals } from '@/modules/accounting/services/budgets/priorActuals';
import { MAX_SAVE_CELLS, saveCells } from '@/modules/accounting/services/budgets/gridSave';
import type { GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import { importBudgetWorkbookTool as tool, MAX_GRID_ROWS } from '@/lib/mcp/tools/budgetImportTool';
import { getBudgetTemplateTool } from '@/lib/mcp/tools/budgetTemplateTool';
import { CC1, MONTHS, RENT, SALES, TOKEN, VERSION, ctx, json, model, text, version } from './budgetToolsFixture';
import { applySave, basedRow, monthsOf } from './budgetImportFixture';

vi.stubEnv('JWT_SECRET', 'k'.repeat(40)); // the template signature's key (any value)
const KEY = { idempotency_key: 'k-1', version_id: VERSION };
const T1 = '2026-11-16T11:00:00.000001Z';
let current: GridReadModel = model();
const use = (m: GridReadModel) => { current = m; applySave(m, vi.mocked(saveCells), vi.mocked(loadGridCells)); };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue(true);
  vi.mocked(getVersion).mockResolvedValue(version() as never);
  vi.mocked(loadGridReadModel).mockImplementation(async () => current);
  vi.mocked(loadPriorActuals).mockResolvedValue({ fiscalYear: 2027, grain: 'company', months: MONTHS, priorMonths: MONTHS, cells: [] } as never);
  use(model());
});

const grid = (rows: unknown[], extra: Record<string, unknown> = {}) => ({ ...KEY, rows, ...extra });
/** Rent (read with March 100) with April set; Sales March set. */
const edit = () => [basedRow(model(), RENT, { '2026-04': '250.00' }), basedRow(model(), SALES, { '2026-03': '1000.00' })];
const listed = (out: Record<string, unknown>) => (out.cells as Array<{ i: number; account: string; month: string; status: string }>).map((c) => `${c.i}:${c.account}:${c.month}:${c.status}`);

describe('import_budget_workbook (json): the import\'s resolve and 3-way diff, then PR 1\'s write', () => {
  it('get_budget_template\'s rows come back unchanged as no change; edited, only the cells that differ from their base', async () => {
    const t = json(await getBudgetTemplateTool.handler({ version_id: VERSION }, ctx()));
    const rows = t.rows as Array<{ base: string; months: Record<string, string | null> }>;
    expect(rows.every((r) => /^v1:/.test(r.base))).toBe(true);
    expect(json(await tool.handler({ ...grid(rows), dry_run: true }, ctx()))).toMatchObject({ counts: { added: 0, changed: 0, removed: 0 }, plan_hash: null });
    rows[1]!.months['2026-04'] = '250.00';
    const dry = json(await tool.handler({ ...grid(rows), dry_run: true }, ctx()));
    expect(listed(dry)).toEqual(['2:6000:2026-04:added']);
  });

  it('dry run then live: rows listed by position; one changed cell or more', async () => {
    const dry = json(await tool.handler({ ...grid(edit()), dry_run: true }, ctx()));
    expect(dry).toMatchObject({ ready: true, format: 'json', import_counts: { added: 2, changed: 0, cleared: 0, unchanged: 22 } });
    expect(listed(dry)).toEqual(['1:6000:2026-04:added', '2:4000:2026-03:added']);
    expect(text(await tool.handler(grid(edit()), ctx()))).toMatch(/plan_hash is required/);
    expect(json(await tool.handler({ ...grid(edit()), plan_hash: dry.plan_hash }, ctx()))).toMatchObject({ saved: 2, snapshot_id: 'snap-1' });
    expect(vi.mocked(saveCells).mock.calls.at(-1)![2].cells).toEqual([
      { glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month: '2026-04', amount: 250 },
      { glAccountId: SALES, cc1Id: null, cc2Id: null, buId: null, month: '2026-03', amount: 1000 },
    ]);
  });

  it('breaker B: rows read before a colleague\'s save, sent later (any token), keep that save; a cell edited on both sides is a conflict', async () => {
    const rows = edit(); // read when Rent March was 100
    use(model({ updatedAt: T1, version: version({ updatedAt: T1 }) as never, cells: [{ ...model().cells[0]!, amount: 500 }] }));
    const dry = json(await tool.handler({ ...grid(rows, { version_token: T1 }), dry_run: true }, ctx()));
    expect(listed(dry)).toEqual(['1:6000:2026-04:added', '2:4000:2026-03:added']); // March (500) untouched
    expect(JSON.stringify(dry.warnings)).toMatch(/1 cell in them changed since these rows were read/);
    const both = [basedRow(model(), RENT, { '2026-03': '120.00' })];
    const c = json(await tool.handler({ ...grid(both), dry_run: true }, ctx()));
    expect(c).toMatchObject({ conflict_count: 1, conflicts: [{ account: '6000', dimension: null, month: '2026-03', downloaded: '100.00', current: '500.00', after: '120.00' }] });
  });

  it('a row may be null-cleared; a row absent from the grid is untouched; ONE changed cell needs the dry run\'s plan_hash too (round 2)', async () => {
    const rows = [basedRow(model(), RENT, { '2026-03': null })];
    expect(text(await tool.handler(grid(rows), ctx()))).toMatch(/plan_hash is required/);
    expect(saveCells).not.toHaveBeenCalled();
    const dry = json(await tool.handler({ ...grid(rows), dry_run: true }, ctx()));
    vi.mocked(saveCells).mockClear();
    expect(json(await tool.handler({ ...grid(rows), plan_hash: dry.plan_hash }, ctx()))).toMatchObject({ saved: 2 });
    expect(vi.mocked(saveCells).mock.calls[0]![2].cells).toEqual([{ glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month: '2026-03', amount: null, clear: true }]);
  });

  it('breaker P1: a one-cell conflict is never written without its dry run (the conflict shows there first)', async () => {
    const rows = [basedRow(model(), RENT, { '2026-03': '120.00' })]; // read when Rent March was 100
    use(model({ updatedAt: T1, version: version({ updatedAt: T1 }) as never, cells: [{ ...model().cells[0]!, amount: 500 }] }));
    expect(text(await tool.handler(grid(rows), ctx()))).toMatch(/plan_hash is required/);
    expect(saveCells).not.toHaveBeenCalled();
    expect(json(await tool.handler({ ...grid(rows), dry_run: true }, ctx()))).toMatchObject({ conflict_count: 1, conflicts: [{ downloaded: '100.00', current: '500.00', after: '120.00' }] });
  });

  it('version_token is optional; a stale one is refused on the live call only', async () => {
    expect(json(await tool.handler({ ...grid(edit(), { version_token: T1 }), dry_run: true }, ctx())).ready).toBe(true);
    vi.mocked(saveCells).mockClear(); // the dry run ran the save in its rolled-back savepoint
    const r = await tool.handler({ ...grid(edit(), { version_token: T1 }), plan_hash: 'a'.repeat(64) }, ctx());
    expect(text(r)).toMatch(/changed since your dry run/);
    expect(saveCells).not.toHaveBeenCalled();
  });

  it('the row\'s identity is its base\'s account and member: a duplicate code carried with its id resolves', async () => {
    const twin = { ...model().accounts[0]!, id: '20000000-0000-4000-8000-0000000000aa', code: '4000', name: 'Sales twin' };
    use(model({ accounts: [...model().accounts, twin] }));
    const rows = [{ ...basedRow(current, twin.id, { '2026-05': '5.00' }), account: '4000', account_id: twin.id }];
    const dry = json(await tool.handler({ ...grid(rows), dry_run: true }, ctx()));
    expect(dry.ready).toBe(true);
    expect(vi.mocked(saveCells).mock.calls[0]![2].cells).toEqual([{ glAccountId: twin.id, cc1Id: null, cc2Id: null, buId: null, month: '2026-05', amount: 5 }]);
  });

  it('a cc1 grid: the member is the base\'s; a conflict names its member', async () => {
    const rows = [basedRow(model(), SALES, { '2026-05': '8.00' }, { grain: 'cc1', memberId: CC1 }), basedRow(model(), '20000000-0000-4000-8000-000000000004', { '2026-05': '7.00' }, { grain: 'cc1', memberId: CC1 })];
    const dry = json(await tool.handler({ ...grid(rows, { grain: 'cc1' }), dry_run: true }, ctx()));
    expect((dry.counts as Record<string, number>).added).toBe(2);
    expect(vi.mocked(saveCells).mock.calls[0]![2].cells.map((c) => [c.glAccountId, c.cc1Id, c.amount])).toEqual([[SALES, CC1, 8], ['20000000-0000-4000-8000-000000000004', CC1, 7]]);
    const cc1Cell = { glAccountId: SALES, cc1Id: CC1, cc2Id: null, buId: null, month: '2026-05', amount: 3, source: 'manual' as const };
    use(model({ updatedAt: T1, cells: [...model().cells, cc1Cell] }));
    const c = json(await tool.handler({ ...grid(rows.slice(0, 1), { grain: 'cc1' }), dry_run: true }, ctx()));
    expect(c.conflicts).toEqual([{ account: '4000', dimension: { kind: 'cc1', code: 'C1' }, month: '2026-05', downloaded: null, current: '3.00', after: '8.00' }]);
  });
});

describe('import_budget_workbook (json): refusals', () => {
  const tampered = () => { const r = basedRow(model(), RENT, {}); return { ...r, base: r.base.replace(/:10000,/, ':10001,') }; };
  it.each([
    ['a row without its base', () => [{ account: '6000', months: monthsOf({}) }], /row 1: base is required/],
    ['an altered base', () => [tampered()], /row 1: its base was changed or was read for another version, grain or row/],
    ['another row\'s base', () => [{ ...basedRow(model(), RENT, {}), account: '4000' }], /row 1: account 4000 is not the account its base was read for \(6000\)/],
    ['account_id not the base\'s', () => [{ ...basedRow(model(), RENT, {}), account_id: SALES }], /row 1: account_id .* is not the account its base was read for/],
    ['a company base on a cc1 grid', () => [basedRow(model(), RENT, {})], /row 1: its base was changed or was read for another version, grain or row/, { grain: 'cc1' }],
    ['a month missing', () => [{ ...basedRow(model(), RENT, {}), months: Object.fromEntries(MONTHS.slice(1).map((m) => [m, null])) }], /row 1: months must list every month of FY2027.*missing 2026-03/],
    ['a month outside the year', () => [{ ...basedRow(model(), RENT, {}), months: { ...monthsOf({}), '2027-03': null } }], /row 1: months must list every month of FY2027.*2027-03 is not one/],
    ['a dimension at company grain', () => [{ ...basedRow(model(), RENT, {}), dimension: 'C1' }], /row 1: dimension is only for a cc1, cc2 or bu grid/],
    ['a field no template row has (decision 14: one dimension)', () => [{ ...basedRow(model(), RENT, {}), cc2: 'X' }], /row 1: "cc2" is not a field of a template row/],
    ['a row that is not an object', () => ['6000'], /row 1 must be an object/],
    ['too many rows', () => Array.from({ length: MAX_GRID_ROWS + 1 }, () => basedRow(model(), RENT, {})), new RegExp(`at most ${MAX_GRID_ROWS} rows`)],
  ])('refused whole: %s', async (_n, rows, why, extra: Record<string, unknown> = {}) => {
    const r = await tool.handler({ ...grid(rows(), extra), dry_run: true }, ctx());
    expect([r.isError, text(r)]).toEqual([true, expect.stringMatching(why)]);
    expect(saveCells).not.toHaveBeenCalled();
  });

  it.each([['both a file and rows', { file_base64: 'AAAA', rows: [] }], ['neither', {}]])('one source per call: %s', async (_n, args) => {
    expect(text(await tool.handler({ ...KEY, dry_run: true, ...args }, ctx()))).toMatch(/Send file_base64 \(an \.xlsx\) or rows \(the JSON grid\), not both/);
  });

  it('per row: a number amount, three decimals; the live call writes nothing', async () => {
    const rows = [basedRow(model(), RENT, { '2026-04': 12.5 }), basedRow(model(), SALES, { '2026-04': '1.005' }), basedRow(model(), '20000000-0000-4000-8000-000000000004', { '2026-04': '3.00' })];
    const dry = json(await tool.handler({ ...grid(rows), dry_run: true }, ctx()));
    const refused = (dry.cells as Array<{ i: number; status: string; month: string; reason: string }>).filter((c) => c.status === 'refused');
    expect(refused.map((c) => [c.i, c.month, c.reason])).toEqual([[1, '2026-04', expect.stringMatching(/decimal strings/)], [2, '2026-04', expect.stringMatching(/at most 2 decimals/)]]);
    expect([dry.ready, dry.plan_hash]).toEqual([false, null]);
    expect(text(await tool.handler({ ...grid(rows), plan_hash: 'a'.repeat(64) }, ctx()))).toMatch(/2 cells are refused, so nothing was written/);
    expect(saveCells).not.toHaveBeenCalled();
  });

  it('the JSON path has its own rate bucket, charged before the model is read', async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce(false);
    expect(text(await tool.handler({ ...grid(edit()), dry_run: true }, ctx()))).toMatch(/Too many imports/);
    expect(checkRateLimit).toHaveBeenCalledWith('mcp-budget-import-json:u:u-1', { max: 240, windowSecs: 900 });
    expect(loadGridReadModel).not.toHaveBeenCalled();
  });

  it(`more than ${MAX_SAVE_CELLS} changed cells is refused, dry run and live, never chunked`, async () => {
    const accounts = Array.from({ length: Math.ceil((MAX_SAVE_CELLS + 1) / 12) }, (_, i) => ({
      ...model().accounts[0]!, id: `a${String(i).padStart(7, '0')}-1111-4111-8111-111111111111`, code: `X${i}`,
    }));
    use(model({ accounts, cells: [] }));
    const rows = accounts.map((a) => basedRow(current, a.id, Object.fromEntries(MONTHS.map((m) => [m, '1.00']))));
    for (const dry of [true, false]) {
      const r = await tool.handler({ ...grid(rows), dry_run: dry, plan_hash: 'a'.repeat(64) }, ctx());
      expect(text(r)).toMatch(new RegExp(`changes ${accounts.length * 12} cells; one call writes at most ${MAX_SAVE_CELLS}`));
    }
    expect(saveCells).not.toHaveBeenCalled();
  });
});

describe('PR 3\'s reference conventions (refText, ID_OR_CODE, DIM_REF) on a JSON row', () => {
  const props = () => ((tool.inputSchema as { properties: Record<string, { items: { properties: Record<string, { type: unknown }> } }> }).properties.rows!.items.properties);
  it('account is a string or a whole number, dimension also null', () => {
    expect([props().account!.type, props().dimension!.type]).toEqual([['string', 'integer'], ['string', 'integer', 'null']]);
  });
  it('a numeric account code (6000) names the base\'s account; 6000.5 is refused as not an account code', async () => {
    const ok = json(await tool.handler({ ...grid([{ ...basedRow(model(), RENT, { '2026-04': '250.00' }), account: 6000 }]), dry_run: true }, ctx()));
    expect(listed(ok)).toEqual(['1:6000:2026-04:added']);
    const bad = text(await tool.handler({ ...grid([{ ...basedRow(model(), RENT, { '2026-04': '250.00' }), account: 6000.5 }]), dry_run: true }, ctx()));
    expect(bad).toBe('row 1: 6000.5 is not an account code');
  });
  it('a numeric dimension code names the base\'s member', async () => {
    const m = model({ dimensions: { cc1: [{ id: CC1, code: '101', name: 'Centre', isActive: true }], cc2: [], bu: [] } as never });
    use(m);
    vi.mocked(loadGridReadModel).mockResolvedValue(m);
    const row = { ...basedRow(m, SALES, { '2026-04': '250.00' }, { grain: 'cc1', memberId: CC1 }), dimension: 101 };
    const out = json(await tool.handler({ ...grid([row], { grain: 'cc1' }), dry_run: true }, ctx()));
    expect([listed(out), (out.cells as Array<{ reason?: string }>)[0]?.reason]).toEqual([['1:4000:2026-04:added'], undefined]);
  });
});
