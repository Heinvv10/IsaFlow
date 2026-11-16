/**
 * set_budget_amounts / set_budget_annual: the tools' own half. Argument and per-row refusals (money as decimal
 * text, months of the year, decision 14, unknown / header accounts) happen before the save; a live bulk write
 * needs the dry run's token, writes nothing when any row is refused, and answers a stale token cleanly; the
 * dry run runs the real save inside a rolled-back savepoint and frees the idempotency key; a live write records
 * its snapshot after the save; amounts are hidden without read:reports. The database half is
 * tests/integration/mcp-budget-tools*.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/budgets/budgetVersions', () => ({ getVersion: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridReadModel', () => ({ loadGridReadModel: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/gridSave', async (orig) => ({ ...(await orig<object>()), saveCells: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetWriteSnapshots', () => ({ recordSnapshot: vi.fn(async () => 'snap-1') }));
vi.mock('@/modules/accounting/services/budgets/priorActuals', () => ({ loadPriorActuals: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetRefResolve', async (orig) => ({
  ...(await orig<object>()), explainMissingAccounts: vi.fn(async (_c: string, refs: string[]) => new Map(refs.map((r) => [r, `${r} is not an account of this company`]))),
}));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({ inRolledBackSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => { await fn(); }) }));

import { getVersion } from '@/modules/accounting/services/budgets/budgetVersions';
import { loadGridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { BudgetVersionStaleError, saveCells } from '@/modules/accounting/services/budgets/gridSave';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { recordSnapshot } from '@/modules/accounting/services/budgets/budgetWriteSnapshots';
import { loadPriorActuals } from '@/modules/accounting/services/budgets/priorActuals';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import { setBudgetAmountsTool as amounts, setBudgetAnnualTool as annual } from '@/lib/mcp/tools/budgetAmountTools';
import { CC1, CHILD, HEADER, MONTHS, RENT, SALES, TOKEN, VERSION, ctx, json, model, text, version } from './budgetToolsFixture';

const KEY = { idempotency_key: 'k-1', version_id: VERSION };
const saved = { updatedAt: '2026-11-16T10:00:01.000001Z', saved: 2, deleted: 0, recomputed: 0, driverWarnings: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getVersion).mockResolvedValue(version() as never);
  vi.mocked(loadGridReadModel).mockResolvedValue(model());
  vi.mocked(saveCells).mockResolvedValue(saved);
});

const cell = (account: string, month: string, amount: unknown, dims: Record<string, string> = {}) => ({ account, month, amount, ...dims });

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
    expect(out.ready).toBe(false);
    expect((out.counts as Record<string, number>).refused).toBe(1);
    const refused = (out.cells as Array<{ status: string; reason?: string; i: number }>).find((c) => c.status === 'refused')!;
    expect([refused.i, refused.reason]).toEqual([1, expect.stringMatching(why)]);
    expect(saveCells).not.toHaveBeenCalled();
    expect(r.wroteNothing).toBe(true);
  });

  it('the live call with any refused row writes nothing (all or nothing)', async () => {
    const r = await amounts.handler({ ...KEY, version_token: TOKEN, cells: [cell('6000', '2026-04', '5.00'), cell('7000', '2026-04', '1')] }, ctx());
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/1 cell is refused, so nothing was written.*cell 1: .*header/);
    expect(saveCells).not.toHaveBeenCalled();
  });
});

describe('set_budget_amounts: token, size and version', () => {
  it('a bulk live write without version_token is refused before anything is read or written', async () => {
    const r = await amounts.handler({ ...KEY, cells: [cell('6000', '2026-04', '1'), cell('6000', '2026-05', '1')] }, ctx());
    expect(text(r)).toMatch(/version_token is required/);
    expect(saveCells).not.toHaveBeenCalled();
  });

  it('a version_token that is not the current one is the stale refusal, before the save', async () => {
    const r = await amounts.handler({ ...KEY, version_token: '2026-11-16T09:00:00.000001Z', cells: [cell('6000', '2026-04', '1'), cell('6000', '2026-05', '1')] }, ctx());
    expect(text(r)).toMatch(/changed since your dry run.*Dry-run again/);
    expect(saveCells).not.toHaveBeenCalled();
  });

  it('the save\'s own stale refusal (a save landed between the read and the compare-and-set) is the same clean refusal; no snapshot', async () => {
    vi.mocked(saveCells).mockRejectedValue(new BudgetVersionStaleError('2026-11-16T10:00:05.000001Z', 'draft'));
    const r = await amounts.handler({ ...KEY, version_token: TOKEN, cells: [cell('6000', '2026-04', '1'), cell('6000', '2026-05', '1')] }, ctx());
    expect(text(r)).toMatch(/changed since your dry run/);
    expect(recordSnapshot).not.toHaveBeenCalled();
  });

  it('a single-cell merge needs no token (the current one is used)', async () => {
    vi.mocked(saveCells).mockResolvedValue({ ...saved, saved: 1 });
    const r = await amounts.handler({ ...KEY, cells: [cell('6000', '2026-04', '1.10')] }, ctx());
    expect(r.isError).toBeUndefined();
    expect(vi.mocked(saveCells).mock.calls[0]![2].expectedUpdatedAt).toBe(TOKEN);
  });

  it(`more than 20000 cells is refused stating the limit`, async () => {
    const r = await amounts.handler({ ...KEY, cells: Array.from({ length: 20_001 }, () => cell('6000', '2026-04', '1')) }, ctx());
    expect(text(r)).toMatch(/at most 20000/);
    expect(loadGridReadModel).not.toHaveBeenCalled();
  });

  it("another company's version is the shared Not found", async () => {
    vi.mocked(getVersion).mockRejectedValue(new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found'));
    const r = await amounts.handler({ ...KEY, cells: [cell('6000', '2026-04', '1')] }, ctx());
    expect(text(r)).toBe('Not found');
  });

  it("the save's refusal (e.g. a grain clash, decision 4) is answered with its message, nothing recorded", async () => {
    vi.mocked(saveCells).mockRejectedValue(new BudgetVersionError('BUDGET_GRAIN_CONFLICT', 'Account 6000 Rent is budgeted at one level per version'));
    const r = await amounts.handler({ ...KEY, version_token: TOKEN, cells: [cell('6000', '2026-04', '1', { cc1: 'C1' }), cell('6000', '2026-05', '1')] }, ctx());
    expect(text(r)).toMatch(/one level per version/);
    expect(recordSnapshot).not.toHaveBeenCalled();
  });
});

describe('set_budget_amounts: dry run and live', () => {
  it('the dry run runs the real save in a rolled-back savepoint, answers the token and the diff, and frees the key', async () => {
    const r = await amounts.handler({ ...KEY, dry_run: true, cells: [cell('6000', '2026-03', '150.25'), cell('4000', '2026-04', '-30.50')] }, ctx());
    const out = json(r);
    expect(r.wroteNothing).toBe(true);
    expect(inRolledBackSavepoint).toHaveBeenCalledTimes(1);
    expect(saveCells).toHaveBeenCalledWith(expect.anything(), 'u-1', expect.objectContaining({ versionId: VERSION, expectedUpdatedAt: TOKEN }));
    expect(out).toMatchObject({ dry_run: true, ready: true, version_token: TOKEN, counts: { added: 1, changed: 1, refused: 0 } });
    expect(out.cells).toEqual([
      { i: 0, account: '6000', dimension: null, month: '2026-03', status: 'changed', before: '100.00', after: '150.25' },
      { i: 1, account: '4000', dimension: null, month: '2026-04', status: 'added', before: null, after: '-30.50' },
    ]);
    const totals = out.totals as { before: Record<string, { year: string }>; after: Record<string, { year: string }> };
    // Rent 100 → 150.25 (expense), sales 0 → -30.50 (revenue): net profit -100.00 → -180.75.
    expect([totals.before.netProfit!.year, totals.after.netProfit!.year]).toEqual(['-100.00', '-180.75']);
  });

  it('a dry run whose save would be refused says so (same guard as the live call)', async () => {
    vi.mocked(saveCells).mockRejectedValue(new BudgetVersionError('BUDGET_SLICE_FORBIDDEN', 'You can change only your own budget slices'));
    const r = await amounts.handler({ ...KEY, dry_run: true, cells: [cell('6000', '2026-04', '1')] }, ctx());
    expect(text(r)).toMatch(/would be refused: You can change only your own budget slices/);
  });

  it('live: saves the changed cells as the token user with exact amounts, then records the snapshot with before/after', async () => {
    const r = await amounts.handler({ ...KEY, version_token: TOKEN, mode: 'replace', cells: [cell('6000', '2026-04', '0.10'), cell('6000', '2026-05', '1', {})] }, ctx());
    expect(json(r)).toMatchObject({ saved: 2, version_token: saved.updatedAt, snapshot_id: 'snap-1' });
    expect(vi.mocked(saveCells).mock.calls[0]![2].cells).toEqual([
      { glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month: '2026-04', amount: 0.1 },
      { glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month: '2026-05', amount: 1 },
      { glAccountId: RENT, cc1Id: null, cc2Id: null, buId: null, month: '2026-03', amount: null, clear: true },
    ]);
    expect(vi.mocked(recordSnapshot).mock.calls[0]![1]).toMatchObject({
      versionId: VERSION, tool: 'set_budget_amounts', tokenJti: 'jti-1', tokenBefore: TOKEN, tokenAfter: saved.updatedAt,
      cells: expect.arrayContaining([{ a: RENT, c1: null, c2: null, b: null, m: '2026-03', before: '100.00', after: null }]),
    });
  });

  it('without read:reports no amount is shown: no before/after, no totals', async () => {
    const r = await amounts.handler({ ...KEY, dry_run: true, cells: [cell('6000', '2026-03', '150.25')] }, ctx('owner', ['write:budgets']));
    const out = json(r);
    expect(out.totals).toBeUndefined();
    expect(out.figures_hidden).toMatch(/read:reports/);
    expect(JSON.stringify(out.cells)).not.toMatch(/150|100\.00/);
  });

  it('accounts and members resolve by id or code; a member by code', async () => {
    await amounts.handler({ ...KEY, dry_run: true, cells: [cell(SALES, '2026-04', '1', { cc1: 'C1' })] }, ctx());
    expect(vi.mocked(saveCells).mock.calls[0]![2].cells[0]).toMatchObject({ glAccountId: SALES, cc1Id: CC1 });
  });
});

describe('set_budget_annual', () => {
  it('flat: R1 rounding, the last month takes the residue, every month set', async () => {
    const r = await annual.handler({ ...KEY, dry_run: true, rows: [{ account: '7100', amount: '1000.00', spread: 'flat' }] }, ctx());
    const after = (json(r).cells as Array<{ after: string; month: string }>).map((c) => c.after);
    expect(after).toEqual([...Array(11).fill('83.00'), '87.00']);
    expect(vi.mocked(saveCells).mock.calls[0]![2].cells.every((c) => c.glAccountId === CHILD)).toBe(true);
  });

  it('prior_year with no prior-year activity is refused for that row, never guessed', async () => {
    vi.mocked(loadPriorActuals).mockResolvedValue({ fiscalYear: 2027, grain: 'company', months: MONTHS, priorMonths: [], cells: [] });
    const r = await annual.handler({ ...KEY, dry_run: true, rows: [{ account: '6000', amount: '1200', spread: 'prior_year' }] }, ctx());
    expect(json(r)).toMatchObject({ ready: false, counts: { refused: 1 } });
    expect(JSON.stringify(json(r).cells)).toMatch(/no prior-year activity/);
  });

  it('weights must be one per month', async () => {
    const r = await annual.handler({ ...KEY, dry_run: true, rows: [{ account: '6000', amount: '1200', spread: 'weights', weights: [1, 2] }] }, ctx());
    expect(JSON.stringify(json(r).cells)).toMatch(/one weight per month/);
  });

  it('a live annual write always needs the version_token', async () => {
    const r = await annual.handler({ ...KEY, rows: [{ account: '6000', amount: '1200', spread: 'flat' }] }, ctx());
    expect(text(r)).toMatch(/version_token is required/);
  });

  it('a header row is refused', async () => {
    const r = await annual.handler({ ...KEY, dry_run: true, rows: [{ account: HEADER, amount: '1', spread: 'flat' }] }, ctx());
    expect(JSON.stringify(json(r).cells)).toMatch(/header account/);
  });
});
