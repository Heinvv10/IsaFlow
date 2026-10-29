/**
 * getBudgetVariance(…, 'absent') under a cost-centre filter, PR-C review r2 (ledger LB2-1, LB2-2; rulings
 * R8, R9): the REAL facade, range, core and bands on an in-memory ledger with cost centres.
 *   - R8: a year whose budget is all at OTHER dimensions is not "no budget for FY2027": its lines are
 *     unbudgeted and the year is named as having a budget none of which is at this filter. The either-level
 *     meaning of `cost_centre_id` is unchanged.
 *   - LB2-1 / R9: sections, totals and profit totals have NO budget where a band under them is above the
 *     filter, never a zero or the other side's figure alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RENT, SALES, W, fakeFiscalYearForDate, fakeSql, resetLedger } from './helpers/budgetLedgerFake';

vi.mock('@/lib/neon', () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => fakeSql(s, ...v) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', async (orig) => ({
  ...(await orig<object>()),
  fiscalYearForDate: (c: string, d: string) => fakeFiscalYearForDate(c, d),
}));

import { getBudgetVariance } from '@/modules/accounting/services/reports/budgetVarianceService';

const CO = 'cccccccc-0000-4000-8000-00000000000c';
const FNO = 'bbbbbbbb-0000-4000-8000-0000000000f1';
const PROJ = 'bbbbbbbb-0000-4000-8000-0000000000c2';
const FY27 = { fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28' };
const APR = ['2026-04-01', '2026-04-30'] as const;
const run = (extra: Record<string, string>) => getBudgetVariance(CO, APR[0], APR[1], { partialWindow: 'absent', ...extra });
const band = (r: Awaited<ReturnType<typeof run>>, k: string) => r.bands.find((b) => b.key === k)?.budget;
const line = (r: Awaited<ReturnType<typeof run>>, id: string) => r.lines.find((l) => l.account_id === id);

beforeEach(() => {
  resetLedger();
  W.years = [FY27];
  W.versions = { 2027: 'v27' };
  W.centres = { [FNO]: { code: 'FNO1', type: 'cc1', parent: null }, [PROJ]: { code: 'P1', type: 'cc2', parent: FNO } };
});

describe('R8: a budget at other dimensions is a budget, not an absent year', () => {
  beforeEach(() => {
    // The FNO-level budget; the actual is posted on the project (and so on its FNO).
    W.cells = [{ version: 'v27', account: SALES, month: '2026-04', amount: 1000, cc1: FNO }];
    W.jl = [{ account: SALES, date: '2026-04-10', amount: 800, cc1: FNO, cc2: PROJ }];
  });

  it("a project passed as cost_centre_id: FY2027 is not absent; the line is unbudgeted; the year is named as having a budget elsewhere", async () => {
    const r = await run({ costCentreId: PROJ });
    expect(r.budgetAbsentYears).toEqual([]);
    expect(r.budgetOutsideFilterYears).toEqual([2027]);
    expect(line(r, SALES)).toMatchObject({ budgeted: false, budget_verdict: 'unbudgeted', actual_amount: 800 });
    expect(r.unbudgeted.map((l) => l.account_code)).toEqual(['4000']);
    expect(r.unallocatedBudget).toEqual({ income: 0, expense: 0 });
  });

  it("the explicit project filter (cc2_id) is unchanged: the FNO's own row is above it, the unallocated footer's", async () => {
    const r = await run({ cc2Id: PROJ });
    expect(r.budgetAbsentYears).toEqual([]);
    expect(r.budgetOutsideFilterYears).toEqual([]);
    expect(line(r, SALES)).toMatchObject({ budget_verdict: 'above-filter' });
    expect(r.unallocatedBudget).toEqual({ income: 1000, expense: 0 });
  });

  it('a year with no budget at all is still absent (the sentence is true there)', async () => {
    W.cells = [];
    const r = await run({ costCentreId: PROJ });
    expect(r.budgetAbsentYears).toEqual([2027]);
    expect(r.budgetOutsideFilterYears).toEqual([]);
    expect(line(r, SALES)).toMatchObject({ budget_verdict: 'absent' });
  });
});

describe('LB2-1 / R9: nothing is budgeted at the filter where the budget sits above it', () => {
  beforeEach(() => {
    // Sales budgeted at company level (above any cost centre); Rent budgeted at the FNO itself.
    W.cells = [
      { version: 'v27', account: SALES, month: '2026-04', amount: 1000 },
      { version: 'v27', account: RENT, month: '2026-04', amount: 150, cc1: FNO },
    ];
    W.jl = [
      { account: SALES, date: '2026-04-10', amount: 800, cc1: FNO },
      { account: RENT, date: '2026-04-12', amount: 200, cc1: FNO },
    ];
  });

  it('the income budget above the filter: revenue section, totals and every profit total have no budget; opex keeps its own', async () => {
    const r = await run({ costCentreId: FNO });
    expect(line(r, SALES)).toMatchObject({ budget_verdict: 'above-filter' });
    expect([band(r, 'turnover'), band(r, 'operating_expense')]).toEqual([null, 150]);
    expect([band(r, 'gross_profit'), band(r, 'operating_profit'), band(r, 'net_profit')]).toEqual([null, null, null]);
    expect([r.sections.revenue.budget, r.sections.expense.budget, r.sections.net_profit.budget]).toEqual([null, 150, null]);
    expect([r.totals.budget, r.totals.variance]).toEqual([null, null]);
    expect(r.sections.revenue.favourable).toBeNull();
  });

  it('only the expense budget at the filter: no zero revenue target', async () => {
    W.cells = [{ version: 'v27', account: RENT, month: '2026-04', amount: 150, cc1: FNO }];
    const r = await run({ costCentreId: FNO });
    // Sales has no budget anywhere (unbudgeted), so the sections are the engine's: revenue none, never 0.
    expect([r.sections.revenue.budget, r.sections.expense.budget]).toEqual([null, 150]);
    expect(band(r, 'turnover')).toBeNull();
  });
});
