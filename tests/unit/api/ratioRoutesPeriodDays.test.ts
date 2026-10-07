/**
 * EVERY FINANCIAL ANALYSIS ROUTE HANDS THE ENGINE ITS WINDOW'S DAY COUNT.
 *
 * Debtor, creditor and inventory days multiply by the days the period's
 * revenue and cost of sales cover. The engine took 365 for every window, so a
 * six-month screen printed twice the book's debtor days and the monthly ratio
 * trends about twelve times. Driven through the real handlers and the real
 * `readExtendedRatioInputs`, over a stubbed ledger whose figures carry the
 * window's days as `getFinancialFigures` does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { inclusiveDays } from '@/modules/accounting/services/reports/priorPeriod';

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

import { calculateExtendedRatios } from '@/modules/accounting/services/reports/reportingEngineService';
import { readExtendedRatioInputs } from '@/modules/accounting/services/reports/extendedRatioInputs';
import scorecardRoute from '../../../pages/api/accounting/reports-kpi-scorecard';
import extendedRoute from '../../../pages/api/accounting/reports-extended-ratios';
import ratiosRoute from '../../../pages/api/accounting/reports-ratios';
import trendsRoute from '../../../pages/api/accounting/reports-ratio-trends';

const byType = {
  asset: { accounts: 0, amount: 0 }, liability: { accounts: 0, amount: 0 },
  equity: { accounts: 0, amount: 0 }, revenue: { accounts: 0, amount: 0 },
  expense: { accounts: 0, amount: 0 },
};
const zero = {
  revenue: 0, otherIncome: 0, costOfSales: 0, grossProfit: 0, operatingExpenses: 0, otherExpenses: 0,
  depreciation: 0, operatingProfit: 0, netProfit: 0, totalAssets: 0, totalLiabilities: 0, totalEquity: 0,
  currentAssets: 0, nonCurrentAssets: 0, currentLiabilities: 0, nonCurrentLiabilities: 0, cash: 0,
  accountsReceivable: 0, accountsPayable: 0, inventory: 0,
  unclassifiedCount: 0, unclassifiedTotal: 0, unclassifiedByType: byType,
};
/** Revenue 1 000 000 and cost of sales 600 000 against receivables 200 000,
 *  payables 120 000 and stock 150 000 — whatever the window. */
const figuresFor = (_companyId: string, from: string, to: string) => ({
  inventoryClassified: true, retainedEarningsBroughtForward: 0,
  period: { ...zero, revenue: 1_000_000, costOfSales: 600_000, grossProfit: 400_000, operatingExpenses: 250_000, operatingProfit: 150_000, netProfit: 150_000 },
  periodDays: inclusiveDays(from, to),
  cumulative: {
    ...zero, totalAssets: 2_000_000, totalLiabilities: 800_000, totalEquity: 1_050_000, currentAssets: 900_000,
    currentLiabilities: 450_000, cash: 300_000, accountsReceivable: 200_000, accountsPayable: 120_000, inventory: 150_000,
  },
});

const SIX_MONTHS = { from: '2026-03-01', to: '2026-08-31' };

async function call(route: unknown, query: Record<string, string>) {
  let body: unknown;
  let status = 200;
  const res = {
    status(code: number) { status = code; return res; },
    json(b: unknown) { body = b; return res; },
    setHeader() { return res; },
  };
  await (route as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
    { method: 'GET', query, companyId: 'c1' } as unknown as NextApiRequest, res as unknown as NextApiResponse,
  );
  return { status, data: (body as { data?: Record<string, unknown> }).data ?? {} };
}

type Ratios = Record<string, number | null>;

beforeEach(() => {
  vi.clearAllMocks();
  getFinancialFiguresMock.mockImplementation(async (...a: [string, string, string]) => figuresFor(...a));
  sqlMock.mockImplementation(async (strings: unknown, ...values: unknown[]) => {
    const text = (strings as readonly string[]).join('?');
    if (text.includes('payroll_employees')) return (values[0] as string[]).map((as_at) => ({ as_at, count: 5 }));
    return [];
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the window\'s day count reaches the engine', () => {
  it('from readExtendedRatioInputs, behind extended ratios, the KPI scorecard and the trends', async () => {
    const { data } = await readExtendedRatioInputs('c1', SIX_MONTHS.from, SIX_MONTHS.to);
    expect(data.periodDays).toBe(184);
    // 200 000 / 1 000 000 × 184 — 73 on 365.
    expect(calculateExtendedRatios(data).debtorDays).toBe(36.8);
  });

  it('on the extended ratio list', async () => {
    const { data } = await call(extendedRoute, SIX_MONTHS);
    const ratios = data.ratios as Ratios;
    expect((data.financialData as { periodDays: number }).periodDays).toBe(184);
    expect(ratios.debtorDays).toBe(36.8);
    expect(ratios.creditorDays).toBe(36.8);
    expect(ratios.inventoryDays).toBe(46);
  });

  it('on the KPI scorecard', async () => {
    const { data } = await call(scorecardRoute, SIX_MONTHS);
    const scorecard = data.scorecard as Array<{ ratioKey: string; value: number | null }>;
    expect(scorecard.find((r) => r.ratioKey === 'debtorDays')!.value).toBe(36.8);
  });

  it('on the basic ratio report', async () => {
    const { data } = await call(ratiosRoute, SIX_MONTHS);
    expect((data.financialData as { periodDays: number }).periodDays).toBe(184);
    expect((data.ratios as Ratios).debtorDays).toBe(36.8);
  });
});

describe('the ratio trends\' current month', () => {
  it('ends today, and its day counts are on the days so far', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 7, 12, 0, 0));
    const { data } = await call(trendsRoute, { months: '3' });
    const trends = data.trends as Array<{ ratioName: string; values: Array<{ value: number | null }> }>;
    // August's 31 days, September's 30, and 7 of October's: the same book
    // each month, so the count moves only with the window.
    expect(trends.find((t) => t.ratioName === 'debtorDays')!.values.map((v) => v.value)).toEqual([6.2, 6, 1.4]);
    expect(getFinancialFiguresMock).toHaveBeenCalledWith('c1', '2026-10-01', '2026-10-07');
    expect(getFinancialFiguresMock).not.toHaveBeenCalledWith('c1', '2026-10-01', '2026-10-31');
  });
});

describe('a window the day counts cannot be taken over is refused', () => {
  for (const [name, route] of [['extended ratios', extendedRoute], ['KPI scorecard', scorecardRoute]] as const) {
    it(`on the ${name}: a malformed date`, async () => {
      expect((await call(route, { from: '2026-3-1', to: '2026-08-31' })).status).toBe(400);
      expect((await call(route, { from: '2026-03-01', to: 'yesterday' })).status).toBe(400);
      expect(getFinancialFiguresMock).not.toHaveBeenCalled();
    });

    it(`on the ${name}: a window that runs backwards`, async () => {
      expect((await call(route, { from: '2026-09-01', to: '2026-08-31' })).status).toBe(400);
      expect(getFinancialFiguresMock).not.toHaveBeenCalled();
    });
  }
});
