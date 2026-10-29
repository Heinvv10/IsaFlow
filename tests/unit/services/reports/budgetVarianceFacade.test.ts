/**
 * getBudgetVariance's two modes in the unit tier (budgets P3 PR-C, review r1 TDD F1/F2/F5, ledger
 * LB-1..LB-3): the REAL facade, trackingRange, trackingCore, P1's primaryVersionScope and the line
 * builder against an in-memory ledger (helpers/budgetLedgerFake). Real PostgreSQL parity is
 * budget-variance-facade-parity.int.test.ts; this catches the same mistakes in the local gate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNTS, COS, RENT, SALES, WAGES, W, fakeFiscalYearForDate, fakeSql, registry, resetLedger } from './helpers/budgetLedgerFake';

vi.mock('@/lib/neon', () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => fakeSql(s, ...v) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', async (orig) => ({
  ...(await orig<object>()),
  fiscalYearForDate: (c: string, d: string) => fakeFiscalYearForDate(c, d),
}));

import { getBudgetVariance } from '@/modules/accounting/services/reports/budgetVarianceService';
import { buildRangeTracking, splitsBudgetMonth } from '@/modules/accounting/services/budgets/tracking/trackingRange';

const CO = 'cccccccc-0000-4000-8000-00000000000c';
const line = <T extends { account_id: string }>(r: { lines: T[] }, id: string) => r.lines.find((l) => l.account_id === id);
const FY27 = { fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28' };
const FY28 = { fiscalYear: 2028, startDate: '2027-03-01', endDate: '2028-02-29' };

beforeEach(() => { resetLedger(); });

describe("default mode: P0's rule", () => {
  it('sums EVERY budgeted month of the window, across years, a year with no budget or not', async () => {
    W.years = [FY27, FY28];
    W.versions = { 2027: 'v27' };
    W.cells = [
      { version: 'v27', account: SALES, month: '2027-01', amount: 100 },
      { version: 'v27', account: SALES, month: '2027-02', amount: 250.5 },
    ];
    W.jl = [{ account: SALES, date: '2027-03-10', amount: 40 }];
    const r = await getBudgetVariance(CO, '2027-01-01', '2027-03-31');
    expect(line(r, SALES)).toMatchObject({ budgeted: true, budget_amount: 350.5, actual_amount: 40 });
    expect(r.rows.map((l) => l.account_code)).toEqual(['4000']);
    expect(Object.keys(r).sort()).toEqual(['fiscalYear', 'lines', 'monthKeys', 'postedThrough', 'rows', 'sections', 'totals',
      'unbudgeted', 'unbudgetedMovement', 'universeTotal']);
    expect(line(r, SALES)).not.toHaveProperty('budget_partial');
  });

  it('reads actuals over the exact days: a 16th start leaves out the 15th, an end on the 15th the 16th', async () => {
    W.years = [FY27];
    W.versions = { 2027: 'v27' };
    W.jl = [
      { account: SALES, date: '2026-03-15', amount: 1 }, { account: SALES, date: '2026-03-16', amount: 10 },
      { account: SALES, date: '2026-04-15', amount: 100 }, { account: SALES, date: '2026-04-16', amount: 1000 },
    ];
    const r = await getBudgetVariance(CO, '2026-03-16', '2026-04-15');
    expect(line(r, SALES)?.actual_amount).toBe(110);
    expect(r.fiscalYear).toBe(2027);
  });

  it('walks the registry ONCE per year the window touches (review r2, verify L6): MCP\'s uncapped range doubled it', async () => {
    const FY29 = { fiscalYear: 2029, startDate: '2028-03-01', endDate: '2029-02-28' };
    W.years = [FY27, FY28, FY29];
    W.versions = { 2027: 'v27' };
    await getBudgetVariance(CO, '2026-03-01', '2029-02-28');
    expect(registry.lookups).toBe(3);
    registry.lookups = 0;
    await getBudgetVariance(CO, '2027-03-01', '2027-03-31', { partialWindow: 'absent' });
    expect(registry.lookups).toBe(1);
  });

  it('refuses a filter or a version: under P0\'s rule they would hide budget set above the filter', async () => {
    W.years = [FY27];
    const opts = { costCentreId: 'dddddddd-0000-4000-8000-000000000001' } as unknown as Parameters<typeof getBudgetVariance>[3];
    await expect(getBudgetVariance(CO, '2026-03-01', '2026-03-31', opts)).rejects.toThrow(/needs partialWindow 'absent'/);
  });
});

describe("partialWindow 'absent': the engine's rule, its verdicts copied", () => {
  it('LB-1: a window that splits a budget month has no window budget, and says so', async () => {
    W.years = [FY27];
    W.versions = { 2027: 'v27' };
    W.cells = [{ version: 'v27', account: SALES, month: '2026-03', amount: 1000 }, { version: 'v27', account: SALES, month: '2026-04', amount: 1000 }];
    W.jl = [{ account: SALES, date: '2026-03-16', amount: 500 }, { account: SALES, date: '2026-04-15', amount: 500 }];
    const r = await getBudgetVariance(CO, '2026-03-16', '2026-04-15', { partialWindow: 'absent' });
    expect(line(r, SALES)).toMatchObject({ budgeted: false, budget_amount: 0, actual_amount: 1000, budget_verdict: 'absent' });
    expect(r.splitsMonth).toBe(true);
    expect(r.rows).toEqual([]);
    expect(r.unbudgeted).toEqual([]);
    expect(r.sections.net_profit.budget).toBeNull();
    // The default mode keeps P0's whole months against the exact days (the ruling: P0 exactly).
    const p0 = await getBudgetVariance(CO, '2026-03-16', '2026-04-15');
    expect(line(p0, SALES)).toMatchObject({ budgeted: true, budget_amount: 2000 });
  });

  it('a window from the 1st to a month end does not split; an end on the 30th of a 31-day month does', () => {
    expect(splitsBudgetMonth('2026-03-01', '2026-04-30', [FY27])).toBe(false);
    expect(splitsBudgetMonth('2026-03-01', '2026-03-30', [FY27])).toBe(true);
    expect(splitsBudgetMonth('2026-03-02', '2026-03-31', [FY27])).toBe(true);
    expect(splitsBudgetMonth('2026-10-31', '2026-10-01', [FY27])).toBe(false);
  });

  it('LB-2: a registry year starting mid-month inside the window splits March, and is named as having no budget', async () => {
    W.years = [{ fiscalYear: 2026, startDate: '2025-03-15', endDate: '2026-03-14' }, { fiscalYear: 2027, startDate: '2026-03-15', endDate: '2027-03-14' }];
    W.versions = { 2026: 'v26' };
    W.cells = [{ version: 'v26', account: SALES, month: '2026-03', amount: 500 }];
    W.jl = [{ account: SALES, date: '2026-03-05', amount: 400 }, { account: SALES, date: '2026-03-20', amount: 600 }];
    const r = await getBudgetVariance(CO, '2026-03-01', '2026-03-31', { partialWindow: 'absent' });
    expect(r.splitsMonth).toBe(true);
    expect(r.budgetAbsentYears).toContain(2027);
    expect(line(r, SALES)).toMatchObject({ budgeted: false, budget_verdict: 'absent' });
  });

  it('LB-3: the partial count is the engine\'s, a partial account with no actual included', async () => {
    W.years = [FY27, FY28];
    W.versions = { 2027: 'v27', 2028: 'v28' };
    W.cells = [{ version: 'v27', account: RENT, month: '2027-02', amount: 900 }, { version: 'v28', account: WAGES, month: '2027-03', amount: 5000 }];
    W.jl = [{ account: SALES, date: '2027-02-10', amount: 100 }];
    const r = await getBudgetVariance(CO, '2027-02-01', '2027-03-31', { partialWindow: 'absent' });
    const engine = await buildRangeTracking(CO, '2027-02-01', '2027-03-31', { wholeMonthsOnly: true });
    expect(r.partialBudgetCount).toBe(2);
    expect(r.partialBudgetCount).toBe(engine.notices.partialBudget?.count);
    // Sales: no budget anywhere in the window, an actual: the one unbudgeted line.
    expect(r.unbudgeted.map((l) => l.account_code)).toEqual(['4000']);
  });

  it('copies each verdict: partial lines carry budget_partial, are in neither rows nor unbudgeted; bands and sections follow the engine', async () => {
    W.years = [FY27, FY28];
    W.versions = { 2027: 'v27', 2028: 'v28' };
    W.cells = [
      { version: 'v27', account: RENT, month: '2027-02', amount: 900 }, { version: 'v28', account: RENT, month: '2027-03', amount: 950 },
      { version: 'v27', account: COS, month: '2027-02', amount: 300 },
    ];
    W.jl = [{ account: RENT, date: '2027-02-10', amount: 1000 }, { account: COS, date: '2027-03-05', amount: 200 }];
    const r = await getBudgetVariance(CO, '2027-02-01', '2027-03-31', { partialWindow: 'absent' });
    expect(line(r, RENT)).toMatchObject({ budgeted: true, budget_amount: 1850, budget_verdict: 'budgeted' });
    expect(line(r, COS)).toMatchObject({ budgeted: false, budget_amount: 0, budget_verdict: 'partial', budget_partial: true });
    expect(line(r, RENT)).not.toHaveProperty('budget_partial');
    expect(r.rows.map((l) => l.account_code)).toEqual(['5000']);
    expect(r.unbudgeted).toEqual([]);
    const band = (k: string) => r.bands.find((b) => b.key === k)?.budget;
    expect([band('operating_expense'), band('cost_of_sales'), band('net_profit')]).toEqual([1850, null, null]);
    // Expenses holds a partial band: no expense or net-profit budget, never the sum of what is left.
    // Nothing is budgeted in revenue: its engine bands are absent, so no zero target (review r2, LB2-1).
    expect([r.sections.revenue.budget, r.sections.expense.budget, r.sections.net_profit.budget]).toEqual([null, null, null]);
    expect(r.totals.budget).toBeNull();
  });

  it('a budgeted zero is a budget in this mode too; an inverted range is empty, not an error', async () => {
    W.years = [FY27];
    W.versions = { 2027: 'v27' };
    W.cells = [{ version: 'v27', account: WAGES, month: '2026-06', amount: 0 }];
    const r = await getBudgetVariance(CO, '2026-06-01', '2026-06-30', { partialWindow: 'absent' });
    expect(line(r, WAGES)).toMatchObject({ budgeted: true, budget_amount: 0, budget_verdict: 'budgeted', variance_pct: null });
    const inv = await getBudgetVariance(CO, '2026-10-31', '2026-10-01', { partialWindow: 'absent' });
    // P0's month keys for an inverted range inside one month (budgetMonthKeysInWindow), and no actual.
    expect([inv.lines, inv.rows, inv.monthKeys, inv.splitsMonth, inv.fiscalYear]).toEqual([[], [], ['2026-10'], false, 2027]);
  });

  it('every account is classified: a year with a budget calls the others unbudgeted; a version with none in the window, absent', async () => {
    W.years = [FY27];
    W.versions = { 2027: 'v27' };
    W.cells = [{ version: 'v27', account: WAGES, month: '2026-05', amount: 70 }];
    W.jl = Object.keys(ACCOUNTS).map((a, i) => ({ account: a, date: '2026-05-10', amount: 10 * (i + 1) }));
    const r = await getBudgetVariance(CO, '2026-05-01', '2026-05-31', { partialWindow: 'absent' });
    expect(r.lines.map((l) => [l.account_code, l.budget_verdict])).toEqual([
      ['4000', 'unbudgeted'], ['5000', 'unbudgeted'], ['5100', 'budgeted'], ['5500', 'unbudgeted'],
    ]);
    W.cells = [];
    const empty = await getBudgetVariance(CO, '2026-05-01', '2026-05-31', { partialWindow: 'absent' });
    expect(new Set(empty.lines.map((l) => l.budget_verdict))).toEqual(new Set(['absent']));
    expect([empty.unbudgeted, empty.budgetAbsentYears]).toEqual([[], [2027]]);
  });
});
