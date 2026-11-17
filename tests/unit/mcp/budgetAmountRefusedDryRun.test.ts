/**
 * set_budget_amounts dry runs with refused rows: the rolled-back save still runs on the cells that are not
 * refused, so counts, sources and section totals are what the save would leave (never `unchanged` for a cell
 * that would change); no plan_hash while anything is refused. In replace, accounts whose unlisted cells would
 * be cleared are held back whole while a row is refused. Shares the mocks of budgetAmountTools.test.ts.
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
vi.mock('@/lib/als', async (orig) => ({ ...(await orig<object>()), assertTxUsable: vi.fn() }));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({ inRolledBackSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => { await fn(); }) }));

import { getVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { loadGridCells, loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { BudgetVersionStaleError, saveCells, type SaveCell } from '@/modules/accounting/services/budgets/gridSave';
import { assertTxUsable } from '@/lib/als';
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

describe('set_budget_amounts: a dry run with refused rows', () => {
  const refusedDry = async (args: Record<string, unknown>) => json(await amounts.handler({ ...KEY, dry_run: true, ...args }, ctx()));
  const year = (out: Record<string, unknown>, when: 'before' | 'after') => (out.totals as Record<string, Record<string, { year: string }>>)[when].operatingExpenses.year;

  it('with a refused row the other cells are counted, listed and totalled by what the save would leave, never as unchanged', async () => {
    const out = await refusedDry({ cells: [cell('6000', '2026-04', '5.00'), cell('7000', '2026-04', '1')] });
    expect(out).toMatchObject({ ready: false, plan_hash: null, counts: { added: 1, changed: 0, removed: 0, unchanged: 0, refused: 1 } });
    expect((out.cells as unknown[])[0]).toEqual({ i: 0, account: '6000', dimension: null, month: '2026-04', status: 'added', before: null, after: '5.00' });
    expect([year(out, 'before'), year(out, 'after')]).toEqual(['100.00', '105.00']);
  });

  it('with a refused row the listed source is the one the save leaves (a driver override)', async () => {
    extra = (cells) => cells.map((c) => (c.month === '2026-04' ? { ...c, source: 'override' } : c));
    const out = await refusedDry({ cells: [cell('6000', '2026-04', '5.00'), cell('7000', '2026-04', '1')] });
    expect((out.cells as Array<Record<string, unknown>>)[0]).toMatchObject({ status: 'added', after: '5.00', source: 'override' });
  });

  it.each([
    ['another account', cell('7000', '2026-04', '1')],
    ['the same account', cell('6000', '2026-05', '1', { cc1: 'NOPE' })],
  ])('replace with a refused row (%s) holds back a whole account that would clear cells, and says so', async (_n, bad) => {
    const out = await refusedDry({ mode: 'replace', cells: [cell('6000', '2026-04', '5.00'), cell('7100', '2026-04', '2.00'), bad] });
    // 6000 holds 2026-03, which replace would clear: held back whole. 7100 holds nothing else: shown by the save.
    expect(out.counts).toMatchObject({ added: 1, removed: 0, unchanged: 0, refused: 1 });
    const listed = out.cells as Array<Record<string, unknown>>;
    expect(listed.filter((c) => c.status !== 'refused').map((c) => [c.account, c.status, c.after])).toEqual([['7100', 'added', '2.00']]);
    expect(vi.mocked(saveCells).mock.calls.map((c) => c[2].cells.map((x) => [x.glAccountId, x.month]))).toEqual([[[CHILD, '2026-04']]]);
    expect([year(out, 'before'), year(out, 'after')]).toEqual(['100.00', '102.00']);
    expect(out.next_step).toMatch(/Accounts whose other cells replace would clear \(pending.held_accounts\) are listed once nothing is refused/);
    expect(out.pending).toEqual({ other_cells_unchecked: false, held_accounts: ['6000'] });
  });

  it('replace moving an account to another level with a refused row never trial-saves the new level alone', async () => {
    const out = await refusedDry({ mode: 'replace', cells: [cell('6000', '2026-04', '5.00', { cc1: 'C1' }), cell('7000', '2026-04', '1')] });
    expect(saveCells).not.toHaveBeenCalled();
    expect(out).toMatchObject({ plan_hash: null, counts: { added: 0, removed: 0, refused: 1 } });
    expect([year(out, 'before'), year(out, 'after')]).toEqual(['100.00', '100.00']);
  });

  it('replace with nothing refused still lists and saves its clears', async () => {
    const out = await refusedDry({ mode: 'replace', cells: [cell('6000', '2026-04', '5.00')] });
    expect(out.counts).toMatchObject({ added: 1, removed: 1, refused: 0 });
    expect([year(out, 'before'), year(out, 'after')]).toEqual(['100.00', '5.00']);
  });

  it('a plan-level refusal (the same cell twice) still shows the first one by its outcome', async () => {
    const out = await refusedDry({ cells: [cell('6000', '2026-04', '5.00'), cell('6000', '2026-04', '6.00')] });
    expect(out).toMatchObject({ plan_hash: null, counts: { added: 1, unchanged: 0, refused: 1 } });
    expect([year(out, 'before'), year(out, 'after')]).toEqual(['100.00', '105.00']);
  });

  it('a save refusal of the subset is never answered while rows are refused: only the refusals are listed', async () => {
    // e.g. a refused clear in merge leaves an old-level cell standing, so the subset trips the one-level rule.
    vi.mocked(saveCells).mockRejectedValue(new BudgetVersionError('BUDGET_GRAIN_CONFLICT', 'Account 6000 is budgeted at one level per version'));
    const r = await amounts.handler({ ...KEY, dry_run: true, cells: [cell('6000', '2026-04', '5.00', { cc1: 'C1' }), cell('6000', '2026-03', null), cell('6000', '2026-4', null)] }, ctx());
    const out = json(r);
    expect(out).toMatchObject({ ready: false, plan_hash: null, totals: null, counts: { added: 0, changed: 0, removed: 0, unchanged: 0, refused: 1 } });
    expect((out.cells as Array<Record<string, unknown>>).map((c) => c.status)).toEqual(['refused']);
    expect(out.next_step).toMatch(/other cells are checked once nothing is refused/);
    expect(out.pending).toEqual({ other_cells_unchecked: true, held_accounts: [] });
    expect(JSON.stringify(out)).not.toMatch(/one level per version/);
    expect(r.wroteNothing).toBe(true);
  });

  it('a plain refused dry run carries no pending marker', async () => {
    const out = await refusedDry({ cells: [cell('6000', '2026-04', '5.00'), cell('7000', '2026-04', '1')] });
    expect(out).not.toHaveProperty('pending');
  });

  it('the trial save failing on a finished transaction is thrown, never answered', async () => {
    vi.mocked(saveCells).mockRejectedValue(new BudgetVersionError('BUDGET_GRAIN_CONFLICT', 'one level'));
    vi.mocked(assertTxUsable).mockImplementationOnce(() => { throw new Error('Request transaction has already finished'); });
    await expect(amounts.handler({ ...KEY, dry_run: true, cells: [cell('6000', '2026-04', '5.00'), cell('7000', '2026-04', '1')] }, ctx())).rejects.toThrow(/already finished/);
  });

  it('with nothing refused a save refusal is still answered', async () => {
    vi.mocked(saveCells).mockRejectedValue(new BudgetVersionError('BUDGET_SLICE_FORBIDDEN', 'You can change only your own budget slices'));
    expect(text(await amounts.handler({ ...KEY, dry_run: true, cells: [cell('6000', '2026-04', '5.00')] }, ctx()))).toMatch(/would be refused: You can change only your own budget slices/);
  });

  it('any other failure of the trial save is thrown, never answered as a refusal', async () => {
    vi.mocked(saveCells).mockRejectedValue(new Error('connection lost'));
    await expect(amounts.handler({ ...KEY, dry_run: true, cells: [cell('6000', '2026-04', '5.00'), cell('7000', '2026-04', '1')] }, ctx())).rejects.toThrow('connection lost');
  });
});
