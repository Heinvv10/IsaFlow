/**
 * set_budget_amounts / set_budget_annual: the tools' own half. Argument and per-row refusals (money as decimal
 * text, months of the year, decision 14, unknown / header accounts) happen before the save; a live bulk write
 * needs the dry run's plan_hash and is refused when the recomputed plan differs (another mode, moved cells);
 * it writes nothing when any row is refused and answers a stale token cleanly; the dry run runs the real save
 * inside a rolled-back savepoint and reports what the save ACTUALLY left (a driver reset, a recomputed
 * dependent), freeing the idempotency key; a live write records its snapshot (values and sources) after the
 * save. The database half is tests/integration/mcp-budget-*.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/budgets/budgetVersions', () => ({ getVersion: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridReadModel', () => ({ loadGridReadModel: vi.fn(), loadGridCells: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridSave', async (orig) => ({ ...(await orig<object>()), saveCells: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetWriteSnapshots', () => ({ recordSnapshot: vi.fn(async () => 'snap-1') }));
vi.mock('@/modules/accounting/services/budgets/priorActuals', () => ({ loadPriorActuals: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetRefResolve', async (orig) => ({
  ...(await orig<object>()), explainMissingAccounts: vi.fn(async (_c: string, refs: string[]) => new Map(refs.map((r) => [r, `${r} is not an account of this company`]))),
}));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({ inRolledBackSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => { await fn(); }) }));

import { getVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { loadGridCells, loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { BudgetVersionStaleError, saveCells, type SaveCell } from '@/modules/accounting/services/budgets/gridSave';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import type { GridCell } from '@/modules/accounting/services/budgets/gridReadTypes';
import { recordSnapshot } from '@/modules/accounting/services/budgets/budgetWriteSnapshots';
import { loadPriorActuals } from '@/modules/accounting/services/budgets/priorActuals';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import { setBudgetAmountsTool as amounts, setBudgetAnnualTool as annual } from '@/lib/mcp/tools/budgetAmountTools';
import { CC1, CHILD, HEADER, MONTHS, RENT, SALES, TOKEN, VERSION, ctx, json, model, text, version } from './budgetToolsFixture';

const KEY = { idempotency_key: 'k-1', version_id: VERSION };
const saved = { updatedAt: '2026-11-16T10:00:01.000001Z', saved: 2, deleted: 0, recomputed: 0, driverWarnings: [] };
/** The cells the (mocked) save leaves: the model's, with the save's cells applied, plus `extra` (a driver's doing). */
let post: GridCell[] = [];
let extra: (cells: GridCell[]) => GridCell[] = (c) => c;
const keyOf = (c: { glAccountId: string; cc1Id: string | null; cc2Id: string | null; buId: string | null; month: string }) => `${c.glAccountId}|${c.cc1Id}|${c.cc2Id}|${c.buId}|${c.month}`;
function apply(cells: GridCell[], save: SaveCell[]): GridCell[] {
  const out = new Map(cells.map((c) => [keyOf(c), c]));
  for (const s of save) {
    if (s.amount === null) out.delete(keyOf(s));
    else out.set(keyOf(s), { glAccountId: s.glAccountId, cc1Id: s.cc1Id, cc2Id: s.cc2Id, buId: s.buId, month: s.month, amount: s.amount, source: 'manual' });
  }
  return extra([...out.values()]);
}

beforeEach(() => {
  vi.clearAllMocks();
  extra = (c) => c;
  vi.mocked(getVersion).mockResolvedValue(version() as never);
  vi.mocked(loadGridReadModel).mockResolvedValue(model());
  vi.mocked(saveCells).mockImplementation(async (_c, _u, input) => { post = apply(model().cells, input.cells); return saved; });
  vi.mocked(loadGridCells).mockImplementation(async () => ({ versionId: VERSION, updatedAt: TOKEN, cells: post }));
});

const cell = (account: string, month: string, amount: unknown, dims: Record<string, string> = {}) => ({ account, month, amount, ...dims });
const TWO = [cell('6000', '2026-04', '1'), cell('6000', '2026-05', '1')];
const dryHash = async (args: Record<string, unknown>) => String(json(await amounts.handler({ ...KEY, ...args, dry_run: true }, ctx())).plan_hash);

describe('set_budget_amounts: per-row refusals (dry run lists them, the save is never reached)', () => {
  it.each([
    ['a number, not a decimal string', cell('6000', '2026-04', 12.5), /decimal strings/],
    ['three decimals', cell('6000', '2026-04', '1.005'), /at most 2 decimals/],
    ['a month outside the year', cell('6000', '2027-03', '1'), /not a month of FY2027/],
    ['a bad month', cell('6000', 'April', '1'), /YYYY-MM/],
    ['two dimensions (decision 14)', cell('6000', '2026-04', '1', { cc1: 'C1', bu: 'B1' }), /at most one dimension/],
    ['a header without its own amounts (decision 18)', cell('7000', '2026-04', '1'), /header account/],
    ['an unknown account', cell('9999', '2026-04', '1'), /not an account of this company/],
    ['an unknown member', cell('6000', '2026-04', '1', { cc1: 'NOPE' }), /not one of this company's active CC1/],
  ])('%s', async (_n, bad, why) => {
    const r = await amounts.handler({ ...KEY, dry_run: true, cells: [cell('6000', '2026-04', '5.00'), bad] }, ctx());
    const out = json(r);
    expect([out.ready, out.plan_hash]).toEqual([false, null]);
    expect((out.counts as Record<string, number>).refused).toBe(1);
    const refused = (out.cells as Array<{ status: string; reason?: string; i: number }>).find((c) => c.status === 'refused')!;
    expect([refused.i, refused.reason]).toEqual([1, expect.stringMatching(why)]);
    expect(saveCells).not.toHaveBeenCalled();
    expect(r.wroteNothing).toBe(true);
  });

  it('a dry run with a refused row counts and lists the other cells by what they would do, not as unchanged', async () => {
    const r = await amounts.handler({ ...KEY, dry_run: true, cells: [cell('6000', '2026-04', '5.00'), cell('7000', '2026-04', '1')] }, ctx());
    const out = json(r);
    const counts = out.counts as Record<string, number>;
    expect([counts.unchanged, counts.added + counts.changed, counts.refused]).toEqual([0, 1, 1]);
    const good = (out.cells as Array<{ i: number; status: string; after?: string }>).find((c) => c.i === 0)!;
    expect([good.status === 'added' || good.status === 'changed', good.after]).toEqual([true, '5.00']);
    const totals = out.totals as { before: Record<string, { year: string }>; after: Record<string, { year: string }> };
    expect(totals.after.netProfit.year).not.toBe(totals.before.netProfit.year);
    expect(saveCells).not.toHaveBeenCalled();
    expect(r.wroteNothing).toBe(true);
  });

  it('the live call with any refused row writes nothing (all or nothing)', async () => {
    const r = await amounts.handler({ ...KEY, plan_hash: 'a'.repeat(64), cells: [cell('6000', '2026-04', '5.00'), cell('7000', '2026-04', '1')] }, ctx());
    expect(text(r)).toMatch(/1 cell is refused, so nothing was written.*cell 1: .*header/);
    expect(saveCells).not.toHaveBeenCalled();
  });
});

describe('set_budget_amounts: plan_hash, token and size', () => {
  it('a bulk live write without plan_hash is refused before anything is written', async () => {
    expect(text(await amounts.handler({ ...KEY, cells: TWO }, ctx()))).toMatch(/plan_hash is required/);
    expect(saveCells).not.toHaveBeenCalled();
  });

  it('the dry run\'s plan_hash applies the same request; another mode or other cells is "plan changed"', async () => {
    const hash = await dryHash({ cells: TWO });
    vi.clearAllMocks();
    vi.mocked(saveCells).mockImplementation(async (_c, _u, input) => { post = apply(model().cells, input.cells); return saved; });
    expect(text(await amounts.handler({ ...KEY, mode: 'add', plan_hash: hash, cells: TWO }, ctx()))).toMatch(/plan changed since your dry run/);
    expect(text(await amounts.handler({ ...KEY, plan_hash: hash, cells: [TWO[0], cell('6000', '2026-05', '2')] }, ctx()))).toMatch(/plan changed/);
    expect(saveCells).not.toHaveBeenCalled();
    expect(json(await amounts.handler({ ...KEY, plan_hash: hash, cells: TWO }, ctx()))).toMatchObject({ saved: 2, snapshot_id: 'snap-1' });
  });

  it('the plan_hash binds the before-values: a cell that moved since the dry run is "plan changed"', async () => {
    const hash = await dryHash({ cells: [cell('6000', '2026-03', '5'), cell('6000', '2026-04', '5')] });
    vi.mocked(loadGridReadModel).mockResolvedValue(model({ cells: [{ ...model().cells[0]!, amount: 101 }] }));
    expect(text(await amounts.handler({ ...KEY, plan_hash: hash, cells: [cell('6000', '2026-03', '5'), cell('6000', '2026-04', '5')] }, ctx()))).toMatch(/plan changed/);
  });

  it('a version_token that is not the current one is the stale refusal, before the save', async () => {
    const r = await amounts.handler({ ...KEY, version_token: '2026-11-16T09:00:00.000001Z', plan_hash: 'a'.repeat(64), cells: TWO }, ctx());
    expect(text(r)).toMatch(/changed since your dry run.*Dry-run again/);
    expect(saveCells).not.toHaveBeenCalled();
  });

  it('the save\'s own stale refusal (a save between the read and the compare-and-set) is the same clean refusal; no snapshot', async () => {
    const hash = await dryHash({ cells: TWO });
    vi.mocked(saveCells).mockRejectedValue(new BudgetVersionStaleError('2026-11-16T10:00:05.000001Z', 'draft'));
    expect(text(await amounts.handler({ ...KEY, plan_hash: hash, cells: TWO }, ctx()))).toMatch(/changed since your dry run/);
    expect(recordSnapshot).not.toHaveBeenCalled();
  });

  it('L1: a multi-cell live write that changes nothing answers "nothing changed", not "plan_hash is required"', async () => {
    const r = await amounts.handler({ ...KEY, cells: [cell('6000', '2026-03', '100.00'), cell('4000', '2026-04', null)] }, ctx());
    expect(text(r)).toMatch(/Nothing changed/);
    expect(r.wroteNothing).toBe(true);
    expect(saveCells).not.toHaveBeenCalled();
  });

  it('a single-cell merge needs no plan_hash (the current token is used)', async () => {
    expect(json(await amounts.handler({ ...KEY, cells: [cell('6000', '2026-04', '1.10')] }, ctx()))).toMatchObject({ saved: 2 });
    expect(vi.mocked(saveCells).mock.calls[0]![2].expectedUpdatedAt).toBe(TOKEN);
  });

  it('exactly 20000 cells pass the size check; 20001 are refused stating the limit', async () => {
    const many = (n: number) => Array.from({ length: n }, () => cell('6000', '2026-04', '1'));
    expect(text(await amounts.handler({ ...KEY, cells: many(20_001) }, ctx()))).toMatch(/at most 20000/);
    expect(loadGridReadModel).not.toHaveBeenCalled();
    const r = await amounts.handler({ ...KEY, dry_run: true, cells: many(20_000) }, ctx());
    expect(loadGridReadModel).toHaveBeenCalledTimes(1);
    expect(text(r)).not.toMatch(/at most 20000/);
  });

  it('a replace whose clears take the changed cells past 20000 is refused before the save', async () => {
    const held: GridCell[] = Array.from({ length: 20_001 }, (_, i) => ({ glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month: MONTHS[i % 12]!, amount: 1, source: 'manual' as const }))
      .map((c, i) => ({ ...c, cc1Id: i < 12 ? null : `30000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));
    vi.mocked(loadGridReadModel).mockResolvedValue(model({ cells: held }));
    const r = await amounts.handler({ ...KEY, mode: 'replace', dry_run: true, cells: [cell('6000', '2026-04', '7'), cell('6000', '2026-05', '7')] }, ctx());
    expect(text(r)).toMatch(/This write changes 20001 cells; one call writes at most 20000/);
    expect(saveCells).not.toHaveBeenCalled();
  });

  it("another company's version is the shared Not found", async () => {
    vi.mocked(getVersion).mockRejectedValue(new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found'));
    expect(text(await amounts.handler({ ...KEY, cells: [cell('6000', '2026-04', '1')] }, ctx()))).toBe('Not found');
  });

  it("the save's refusal (a grain clash, decision 4) is answered with its message, nothing recorded", async () => {
    vi.mocked(saveCells).mockRejectedValue(new BudgetVersionError('BUDGET_GRAIN_CONFLICT', 'Account 6000 Rent is budgeted at one level per version'));
    expect(text(await amounts.handler({ ...KEY, cells: [cell('6000', '2026-04', '1', { cc1: 'C1' })] }, ctx()))).toMatch(/one level per version/);
    expect(recordSnapshot).not.toHaveBeenCalled();
  });
});

describe('set_budget_amounts: what the save actually leaves', () => {
  it('the dry run runs the save rolled back and answers the ACTUAL diff, totals and plan_hash; the key stays free', async () => {
    const r = await amounts.handler({ ...KEY, dry_run: true, cells: [cell('6000', '2026-03', '150.25'), cell('4000', '2026-04', '-30.50')] }, ctx());
    const out = json(r);
    expect(r.wroteNothing).toBe(true);
    expect(inRolledBackSavepoint).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ dry_run: true, ready: true, version_token: TOKEN, plan_hash: expect.stringMatching(/^[0-9a-f]{64}$/), counts: { added: 1, changed: 1, refused: 0 } });
    expect(out.cells).toEqual([
      { i: 0, account: '6000', dimension: null, month: '2026-03', status: 'changed', before: '100.00', after: '150.25' },
      { i: 1, account: '4000', dimension: null, month: '2026-04', status: 'added', before: null, after: '-30.50' },
    ]);
    const totals = out.totals as { before: Record<string, { year: string }>; after: Record<string, { year: string }> };
    expect([totals.before.netProfit!.year, totals.after.netProfit!.year]).toEqual(['-100.00', '-180.75']);
  });

  it('a cleared override that the driver resets, and a dependent the driver recomputes, are shown as they are', async () => {
    vi.mocked(loadGridReadModel).mockResolvedValue(model({ cells: [{ ...model().cells[0]!, source: 'override' }] }));
    extra = (cells) => [
      ...cells, { glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month: '2026-03', amount: 80, source: 'driver' },
      { glAccountId: SALES, cc1Id: null, cc2Id: null, buId: null, month: '2026-03', amount: 8, source: 'driver' },
    ];
    const out = json(await amounts.handler({ ...KEY, dry_run: true, cells: [cell('6000', '2026-03', null)] }, ctx()));
    expect(out.cells).toEqual([
      { i: 0, account: '6000', dimension: null, month: '2026-03', status: 'changed', before: '100.00', after: '80.00', source: 'driver' },
      { i: null, account: '4000', dimension: null, month: '2026-03', status: 'recomputed', before: null, after: '8.00', source: 'driver' },
    ]);
    expect((out.counts as Record<string, number>).recomputed).toBe(1);
  });

  it('a dry run whose save would be refused says so (same guard as the live call)', async () => {
    vi.mocked(saveCells).mockRejectedValue(new BudgetVersionError('BUDGET_SLICE_FORBIDDEN', 'You can change only your own budget slices'));
    expect(text(await amounts.handler({ ...KEY, dry_run: true, cells: [cell('6000', '2026-04', '1')] }, ctx()))).toMatch(/would be refused: You can change only your own budget slices/);
  });

  it('live: saves as the token user with exact amounts, then records the snapshot with values and sources', async () => {
    const cells = [cell('6000', '2026-04', '0.10'), cell('6000', '2026-05', '1')];
    const hash = await dryHash({ mode: 'replace', cells });
    vi.mocked(saveCells).mockClear();
    expect(json(await amounts.handler({ ...KEY, mode: 'replace', plan_hash: hash, cells }, ctx()))).toMatchObject({ saved: 2, version_token: saved.updatedAt, snapshot_id: 'snap-1' });
    expect(vi.mocked(saveCells).mock.calls[0]![2].cells).toEqual([
      { glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month: '2026-04', amount: 0.1 },
      { glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month: '2026-05', amount: 1 },
      { glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month: '2026-03', amount: null, clear: true },
    ]);
    expect(vi.mocked(recordSnapshot).mock.calls[0]![1]).toMatchObject({
      versionId: VERSION, tool: 'set_budget_amounts', tokenJti: 'jti-1', tokenBefore: TOKEN, tokenAfter: saved.updatedAt,
      cells: expect.arrayContaining([{ a: RENT, c1: null, c2: null, b: null, m: '2026-03', before: '100.00', after: null, bs: 'manual', as: null }]),
    });
  });

  it('accounts and members resolve by id or code; a member by code', async () => {
    await amounts.handler({ ...KEY, dry_run: true, cells: [cell(SALES, '2026-04', '1', { cc1: 'C1' })] }, ctx());
    expect(vi.mocked(saveCells).mock.calls[0]![2].cells[0]).toMatchObject({ glAccountId: SALES, cc1Id: CC1 });
  });
});

describe('set_budget_annual', () => {
  it('flat: R1 rounding, the last month takes the residue, every month set', async () => {
    const r = await annual.handler({ ...KEY, dry_run: true, rows: [{ account: '7100', amount: '1000.00', spread: 'flat' }] }, ctx());
    expect((json(r).cells as Array<{ after: string }>).map((c) => c.after)).toEqual([...Array(11).fill('83.00'), '87.00']);
    expect(vi.mocked(saveCells).mock.calls[0]![2].cells.every((c) => c.glAccountId === CHILD)).toBe(true);
  });

  it('a rounding that puts the last month past zero is written and named in notices, as the grid does', async () => {
    const out = json(await annual.handler({ ...KEY, dry_run: true, rounding_unit: 1000, rows: [{ account: '7100', amount: '6000.00', spread: 'flat' }] }, ctx()));
    expect(out.notices).toEqual([{ i: 0, account: '7100', reason: expect.stringMatching(/last month on the other side of zero/) }]);
    expect((out.cells as Array<{ after: string }>).at(-1)!.after).toBe('-5000.00');
  });

  it('prior_year with no prior-year activity is refused for that row, never guessed', async () => {
    vi.mocked(loadPriorActuals).mockResolvedValue({ fiscalYear: 2027, grain: 'company', months: MONTHS, priorMonths: [], cells: [] });
    const out = json(await annual.handler({ ...KEY, dry_run: true, rows: [{ account: '6000', amount: '1200', spread: 'prior_year' }] }, ctx()));
    expect(out).toMatchObject({ ready: false, counts: { refused: 1 } });
    expect(JSON.stringify(out.cells)).toMatch(/no prior-year activity/);
  });

  it('weights must be one per month', async () => {
    const r = await annual.handler({ ...KEY, dry_run: true, rows: [{ account: '6000', amount: '1200', spread: 'weights', weights: [1, 2] }] }, ctx());
    expect(JSON.stringify(json(r).cells)).toMatch(/one weight per month/);
  });

  it('a live annual write always needs the plan_hash', async () => {
    expect(text(await annual.handler({ ...KEY, rows: [{ account: '6000', amount: '1200', spread: 'flat' }] }, ctx()))).toMatch(/plan_hash is required/);
  });

  it('a header row is refused', async () => {
    const r = await annual.handler({ ...KEY, dry_run: true, rows: [{ account: HEADER, amount: '1', spread: 'flat' }] }, ctx());
    expect(JSON.stringify(json(r).cells)).toMatch(/header account/);
  });
});

describe('plan_hash refusal wording, one rule per tool', () => {
  const tail = (tool: string) => `: call ${tool} with dry_run true, read the diff, then apply with the plan_hash it returns.`;
  it('set_budget_amounts: more than one cell, or replace mode', async () => {
    const want = `plan_hash is required for a write of more than one cell or in replace mode${tail('set_budget_amounts')}`;
    expect(text(await amounts.handler({ ...KEY, cells: TWO }, ctx()))).toBe(want);
    expect(text(await amounts.handler({ ...KEY, mode: 'replace', cells: [cell('6000', '2026-04', '1')] }, ctx()))).toBe(want);
  });
  it('set_budget_annual: always, even for one row', async () => {
    expect(text(await annual.handler({ ...KEY, rows: [{ account: '6000', amount: '1200', spread: 'flat' }] }, ctx())))
      .toBe(`plan_hash is required for every annual write (its dry run is the preview)${tail('set_budget_annual')}`);
  });
});

describe('set_budget_amounts: one cell in merge mode needs no plan_hash', () => {
  it('a live single-cell merge write without plan_hash proceeds to the save', async () => {
    const r = await amounts.handler({ ...KEY, cells: [cell('6000', '2026-04', '1')] }, ctx());
    expect(text(r)).not.toMatch(/plan_hash is required/);
    expect(saveCells).toHaveBeenCalledTimes(1);
  });
});
