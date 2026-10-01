/**
 * THE SCORECARD AND THE RATIO LIST ON ONE SCREEN ARE BUILT FROM ONE READ.
 *
 * Financial Analysis shows a KPI scorecard (`reports-kpi-scorecard`) above a
 * ratio list (`reports-extended-ratios`). Each endpoint built its own engine
 * input: the list read interest, tax, employee cost and materials off the
 * ledger, the scorecard did not. So for one company and one period the list
 * printed Interest Cover as a figure and the scorecard, a few centimetres
 * above it, said there was none to state.
 *
 * Both now call `readExtendedRatioInputs`. Driven through both real handlers
 * over one stubbed ledger.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const getFinancialFiguresMock = vi.fn();
const sqlMock = vi.fn();

vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/gl/financialFiguresService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getFinancialFigures: (...a: unknown[]) => getFinancialFiguresMock(...a),
}));

import scorecardRoute from '../../../pages/api/accounting/reports-kpi-scorecard';
import ratiosRoute from '../../../pages/api/accounting/reports-extended-ratios';
import trendsRoute from '../../../pages/api/accounting/reports-ratio-trends';

const byType = {
  asset: { accounts: 0, amount: 0 }, liability: { accounts: 0, amount: 0 },
  equity: { accounts: 0, amount: 0 }, revenue: { accounts: 0, amount: 0 },
  expense: { accounts: 0, amount: 0 },
};
const none = { unclassifiedCount: 0, unclassifiedTotal: 0, unclassifiedByType: byType };
const FIGURES = {
  inventoryClassified: true, retainedEarningsBroughtForward: 0,
  period: {
    revenue: 1_000_000, otherIncome: 0, costOfSales: 600_000, grossProfit: 400_000,
    operatingExpenses: 250_000, otherExpenses: 57_000, depreciation: 40_000,
    operatingProfit: 150_000, netProfit: 93_000,
    totalAssets: 0, totalLiabilities: 0, totalEquity: 0, currentAssets: 0, nonCurrentAssets: 0,
    currentLiabilities: 0, nonCurrentLiabilities: 0, cash: 0, accountsReceivable: 0, accountsPayable: 0,
    inventory: 0, ...none,
  },
  cumulative: {
    revenue: 0, otherIncome: 0, costOfSales: 0, grossProfit: 0, operatingExpenses: 0, otherExpenses: 0,
    depreciation: 0, operatingProfit: 0, netProfit: 0,
    totalAssets: 2_000_000, totalLiabilities: 800_000, totalEquity: 1_107_000,
    currentAssets: 900_000, nonCurrentAssets: 1_100_000, currentLiabilities: 450_000, nonCurrentLiabilities: 350_000,
    cash: 300_000, accountsReceivable: 200_000, accountsPayable: 120_000, inventory: 150_000, ...none,
  },
};

type LedgerRow = { account_type: string; account_subtype: string; debit: string; credit: string };
const expense = (account_subtype: string, debit: string): LedgerRow => ({ account_type: 'expense', account_subtype, debit, credit: '0' });

/** The period's revenue and expense movement, as the one reader groups it. */
let ledger: LedgerRow[];
/** Head count by the date it is asked as at; 12 where a test does not say. */
let headCountAt: (asAt: string) => number;

function serveLedger(): void {
  sqlMock.mockImplementation(async (strings: unknown, ...values: unknown[]) => {
    const text = (strings as readonly string[]).join('?');
    if (text.includes('payroll_employees')) return (values[0] as string[]).map((as_at) => ({ as_at, count: headCountAt(as_at) }));
    if (text.includes('GROUP BY ga.account_type')) return ledger;
    return [];
  });
}

async function call(route: unknown, query: Record<string, string> = { from: '2026-03-01', to: '2026-08-31' }) {
  let body: unknown;
  const res = { status() { return res; }, json(b: unknown) { body = b; return res; }, setHeader() { return res; } };
  await (route as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
    { method: 'GET', query, companyId: 'c1' } as unknown as NextApiRequest, res as unknown as NextApiResponse,
  );
  return (body as { data: Record<string, unknown> }).data;
}

async function both() {
  const scorecard = (await call(scorecardRoute)).scorecard as Array<{ ratioKey: string; value: number | null; reason?: string }>;
  const ratios = (await call(ratiosRoute)).ratios as Record<string, number | null> & { notMeaningful: Record<string, string> };
  return { scorecard, ratios };
}

beforeEach(() => {
  vi.clearAllMocks();
  getFinancialFiguresMock.mockResolvedValue(FIGURES);
  ledger = [
    expense('interest_expense', '30000.00'), expense('salaries', '400000.00'), expense('income_tax', '27000.00'),
    { account_type: 'revenue', account_subtype: 'interest_income', debit: '0', credit: '5000.00' },
  ];
  headCountAt = () => 12;
  serveLedger();
});

describe('Financial Analysis: the scorecard and the ratio list', () => {
  it('agree on every ratio the scorecard shows', async () => {
    const { scorecard, ratios } = await both();
    expect(scorecard.length).toBeGreaterThan(5);
    for (const row of scorecard) {
      expect(row.value, row.ratioKey).toBe(ratios[row.ratioKey]);
      expect(row.reason, row.ratioKey).toBe(ratios.notMeaningful[row.ratioKey]);
    }
  });

  it('both state interest cover from the ledger\'s interest expense', async () => {
    const { scorecard, ratios } = await both();
    // Operating profit 150 000 over interest expense 30 000.
    expect(ratios.interestCoverage).toBe(5);
    expect(scorecard.find((r) => r.ratioKey === 'interestCoverage')!.value).toBe(5);
  });

  it('both say none was recorded — the same sentence — where the ledger has no interest', async () => {
    ledger = ledger.filter((r) => !r.account_subtype.startsWith('interest'));
    const { scorecard, ratios } = await both();
    const reason = 'No interest expense under a finance-cost classification recorded in the period, so this ratio cannot be stated.';
    expect(ratios.interestCoverage).toBeNull();
    expect(ratios.notMeaningful.interestCoverage).toBe(reason);
    expect(scorecard.find((r) => r.ratioKey === 'interestCoverage')).toMatchObject({ value: null, reason });
  });

  it('give a debt-free company with bank charges no interest cover, and do not score it against 3.0', async () => {
    ledger = [expense('bank_charges', '650.00'), expense('salaries', '400000.00')];
    const { scorecard, ratios } = await both();
    // On the whole finance-cost band this was 150 000 / 650 = 230.77, "on target".
    expect(ratios.interestCoverage).toBeNull();
    const row = scorecard.find((r) => r.ratioKey === 'interestCoverage')!;
    expect(row.value).toBeNull();
    expect(row.reason).toBe('No interest expense under a finance-cost classification recorded in the period, so this ratio cannot be stated.');
    expect(JSON.stringify(row)).not.toMatch(/on_target|"status":"green"/);
  });

  it('cover interest alone where the chart has interest and bank charges', async () => {
    ledger = [...ledger, expense('bank_charges', '650.00')];
    expect((await both()).ratios.interestCoverage).toBe(5);
  });

  it('state the effective tax rate from the ledger\'s tax expense rather than "not captured"', async () => {
    const { ratios } = await both();
    // Profit before tax is net profit 93 000 with the tax 27 000 put back.
    expect(ratios.effectiveTaxRate).toBe(22.5);
    expect(ratios.notMeaningful.effectiveTaxRate).toBeUndefined();
  });

  it('say "not captured" only of what this screen really does not read', async () => {
    const { ratios } = await both();
    expect(ratios.notMeaningful.dividendCover).toBe('Dividends paid is not captured in this report, so this ratio cannot be stated.');
    expect(Object.values(ratios.notMeaningful).filter((r) => /Interest|Tax|employee/i.test(r))).toEqual([]);
  });
});

describe('Financial Analysis: the ratio trends', () => {
  type Trend = { ratioName: string; values: Array<{ value: number | null }> };
  const trendsFor = async (months: string) => (await call(trendsRoute, { months })).trends as Trend[];
  const headCountReads = () => sqlMock.mock.calls
    .filter(([strings]) => (strings as readonly string[]).join('?').includes('payroll_employees'));

  it('are built from the same read, so a tracked cover is a figure there too', async () => {
    const cover = (await trendsFor('3')).find((t) => t.ratioName === 'interestCoverage')!;
    expect(cover.values.map((v) => v.value)).toEqual([5, 5, 5]);
  });

  it('read every month\'s head count in one query, as at each month end', async () => {
    await trendsFor('12');
    const reads = headCountReads();
    expect(reads).toHaveLength(1);
    const dates = reads[0]![1] as string[];
    expect(dates).toHaveLength(12);
    // Each is the last day of its month, in order.
    for (const date of dates) {
      const next = new Date(`${date}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      expect(next.getUTCDate(), date).toBe(1);
    }
    expect([...dates].sort()).toEqual(dates);
  });

  it('divide each month by that month\'s staff, not today\'s', async () => {
    // Staff grew by one a month: 10, 11, 12 at the three month ends.
    let seen: string[] = [];
    headCountAt = (asAt) => { if (!seen.includes(asAt)) seen = [...seen, asAt].sort(); return 10 + seen.indexOf(asAt); };
    const perHead = (await trendsFor('3')).find((t) => t.ratioName === 'revenuePerEmployee')!;
    expect(perHead.values.map((v) => v.value)).toEqual([100_000, 90_909.09, 83_333.33]);
  });
});
