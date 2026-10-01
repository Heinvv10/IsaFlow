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

/** The ledger's subtype totals for the period, as the one reader queries them. */
let subtypeTotals: Record<string, string>;

function serveLedger(): void {
  sqlMock.mockImplementation(async (strings: unknown) => {
    const text = (strings as readonly string[]).join('?');
    if (text.includes('payroll_employees')) return [{ count: 12 }];
    if (text.includes('interest_expense')) return [subtypeTotals];
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
  subtypeTotals = {
    interest_expense: '30000.00', interest_income: '5000.00', employee_costs: '400000.00',
    tax_expense: '27000.00', direct_materials: '350000.00',
  };
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
    subtypeTotals = { ...subtypeTotals, interest_expense: '0', interest_income: '0' };
    const { scorecard, ratios } = await both();
    const reason = 'No interest expense recorded in the period, so this ratio cannot be stated.';
    expect(ratios.interestCoverage).toBeNull();
    expect(ratios.notMeaningful.interestCoverage).toBe(reason);
    expect(scorecard.find((r) => r.ratioKey === 'interestCoverage')).toMatchObject({ value: null, reason });
  });

  it('state the effective tax rate from the ledger\'s tax expense rather than "not captured"', async () => {
    const { ratios } = await both();
    // Profit before tax 150 000 − 30 000 + 5 000 = 125 000; tax 27 000.
    expect(ratios.effectiveTaxRate).toBe(21.6);
    expect(ratios.notMeaningful.effectiveTaxRate).toBeUndefined();
  });

  it('say "not captured" only of what this screen really does not read', async () => {
    const { ratios } = await both();
    expect(ratios.notMeaningful.dividendCover).toBe('Dividends paid is not captured in this report, so this ratio cannot be stated.');
    expect(Object.values(ratios.notMeaningful).filter((r) => /Interest|Tax|employee/i.test(r))).toEqual([]);
  });
});

describe('Financial Analysis: the ratio trends', () => {
  it('are built from the same read, so a tracked cover is a figure there too', async () => {
    const trends = (await call(trendsRoute, { months: '3' })).trends as Array<{ ratioName: string; values: Array<{ value: number | null }> }>;
    const cover = trends.find((t) => t.ratioName === 'interestCoverage')!;
    expect(cover.values.map((v) => v.value)).toEqual([5, 5, 5]);
  });
});
