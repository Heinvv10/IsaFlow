/**
 * THE MANAGEMENT PACK STATES THE RATIOS THE LEDGER CAN STATE, AND STATES THEM
 * AS FINANCIAL ANALYSIS DOES.
 *
 * The pack's input carried no interest, tax, employee cost or head count, so
 * ten of its ratio rows printed "not captured in this report" for a company
 * whose Financial Analysis screen, over the same ledger and period, printed
 * each of them as a figure. `readReportPackInput` now takes them from the same
 * read the screen's endpoints use (`extendedRatioInputs`).
 *
 * Through the real builders: `readReportPackInput` + `buildReportPack` on one
 * side, the real `reports-extended-ratios` handler on the other, over one
 * stubbed ledger.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const getFinancialFiguresMock = vi.fn();
const getCashFlowDirectMock = vi.fn();
const sqlMock = vi.fn();

vi.mock('@/lib/neon', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sql: (...a: unknown[]) => sqlMock(...a),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/gl/financialFiguresService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getFinancialFigures: (...a: unknown[]) => getFinancialFiguresMock(...a),
}));
vi.mock('@/modules/accounting/services/afs/cashFlowDirectService', () => ({
  getCashFlowDirect: (...a: unknown[]) => getCashFlowDirectMock(...a),
}));

import ratiosRoute from '../../../../pages/api/accounting/reports-extended-ratios';
import { readReportPackInput } from '@/modules/accounting/services/reports/reportPackDataService';
import { buildReportPack } from '@/modules/accounting/services/reports/reportPackService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const FROM = '2026-03-01';
const TO = '2026-08-31';

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

/** The period's revenue and expense movement, as the read groups it. */
const LEDGER = [
  { account_type: 'expense', account_subtype: 'interest_expense', debit: '30000.00', credit: '0' },
  { account_type: 'revenue', account_subtype: 'interest_income', debit: '0', credit: '5000.00' },
  { account_type: 'expense', account_subtype: 'salaries', debit: '400000.00', credit: '0' },
  { account_type: 'expense', account_subtype: 'income_tax', debit: '27000.00', credit: '0' },
  { account_type: 'expense', account_subtype: 'bank_charges', debit: '8000.00', credit: '0' },
];

function serve(headCount: number, ledger: unknown[]): void {
  sqlMock.mockImplementation(async (strings: unknown, ...values: unknown[]) => {
    const text = (strings as readonly string[]).join('?');
    if (text.includes('payroll_employees')) return (values[0] as string[]).map((as_at) => ({ as_at, count: headCount }));
    if (text.includes('GROUP BY ga.account_type')) return ledger;
    return [];
  });
}

type Ratios = Record<string, number | null> & { notMeaningful: Record<string, string> };

/** Every ratio that needs an input only the ledger's subtype read supplies. */
const LEDGER_RATIOS = [
  'interestCoverage', 'ebitdaToNetInterest', 'pbtToNetInterest', 'netProfitToNetInterest',
  'revenuePerEmployee', 'pbitPerEmployee', 'ebitdaPerEmployee',
  'employeeCostToRevenue', 'employeeCostPerHead', 'effectiveTaxRate',
];

/** [statement with `?` for each bound value, the bound values]. */
const statements = (): Array<[string, unknown[]]> =>
  sqlMock.mock.calls.map(([strings, ...values]) => [(strings as readonly string[]).join('?'), values]);

async function packRatios(): Promise<Ratios> {
  const { input } = await readReportPackInput(COMPANY, 'Acme Fibre (Pty) Ltd', FROM, TO);
  const pack = buildReportPack('management', input, FROM, TO);
  return pack.sections.find((s) => s.type === 'ratios')!.data as Ratios;
}

async function financialAnalysisRatios(): Promise<Ratios> {
  let body: unknown;
  const res = { status() { return res; }, json(b: unknown) { body = b; return res; }, setHeader() { return res; } };
  await (ratiosRoute as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
    { method: 'GET', query: { from: FROM, to: TO }, companyId: COMPANY } as unknown as NextApiRequest,
    res as unknown as NextApiResponse,
  );
  return (body as { data: { ratios: Ratios } }).data.ratios;
}

beforeEach(() => {
  vi.clearAllMocks();
  getFinancialFiguresMock.mockResolvedValue(FIGURES);
  getCashFlowDirectMock.mockResolvedValue({ operatingTotal: 120_000, investingTotal: -30_000, financingTotal: 10_000, netChange: 100_000 });
  serve(12, LEDGER);
});

describe('the management pack\'s ratios', () => {
  it('state interest cover, the tax rate and the per-employee figures off the ledger', async () => {
    const ratios = await packRatios();
    expect(ratios.interestCoverage).toBe(5);            // 150 000 / 30 000
    expect(ratios.pbtToNetInterest).toBe(4.8);          // (93 000 + 27 000) / 25 000
    expect(ratios.effectiveTaxRate).toBe(22.5);         // 27 000 / (93 000 + 27 000)
    expect(ratios.revenuePerEmployee).toBe(83_333.33);  // 1 000 000 / 12
    expect(ratios.employeeCostToRevenue).toBe(40);      // 400 000 / 1 000 000
  });

  it.each(LEDGER_RATIOS)('state %s as the figure Financial Analysis states', async (key) => {
    const pack = await packRatios();
    const screen = await financialAnalysisRatios();
    expect(pack[key]).not.toBeNull();
    expect(pack[key]).toBe(screen[key]);
    expect(pack.notMeaningful[key]).toBeUndefined();
  });

  it('leave the bank charges out of the interest they cover', async () => {
    serve(12, [{ account_type: 'expense', account_subtype: 'bank_charges', debit: '8000.00', credit: '0' }]);
    const ratios = await packRatios();
    expect(ratios.interestCoverage).toBeNull();
    expect(ratios.notMeaningful.interestCoverage).toBe('No interest expense under a finance-cost classification recorded in the period, so this ratio cannot be stated.');
  });

  it('say the direct material margin is not captured: the classification has no such line', async () => {
    const ratios = await packRatios();
    expect(ratios.directMaterialMargin).toBeNull();
    expect(ratios.notMeaningful.directMaterialMargin).toBe('Direct material cost is not captured in this report, so this ratio cannot be stated.');
  });

  it('still say dividends are not captured, because nothing reads them', async () => {
    const ratios = await packRatios();
    expect(ratios.dividendCover).toBeNull();
    expect(ratios.notMeaningful.dividendCover).toBe('Dividends paid is not captured in this report, so this ratio cannot be stated.');
  });

  it('say none was recorded where the ledger was read and holds none', async () => {
    serve(0, []);
    const ratios = await packRatios();
    expect(ratios.interestCoverage).toBeNull();
    expect(ratios.notMeaningful.interestCoverage).toBe('No interest expense under a finance-cost classification recorded in the period, so this ratio cannot be stated.');
    expect(ratios.notMeaningful.revenuePerEmployee).toBe('No employees recorded in the period, so this ratio cannot be stated.');
    expect(ratios.notMeaningful.employeeCostToRevenue).toBe('No employee cost under a payroll classification recorded in the period, so this ratio cannot be stated.');
    expect(ratios.effectiveTaxRate).toBe(0);
  });
});

describe('the read behind them', () => {
  it('reads the ledger figures once, not once for the pack and again for the ratios', async () => {
    await packRatios();
    expect(getFinancialFiguresMock).toHaveBeenCalledTimes(1);
  });

  it('binds the company to the head count and to every table of the movement read', async () => {
    await packRatios();
    const all = statements();
    const headCount = all.find(([text]) => text.includes('payroll_employees'))!;
    const movement = all.find(([text]) => text.includes('GROUP BY ga.account_type'))!;
    expect(headCount[0]).toMatch(/e\.company_id = \?::uuid/);
    expect(headCount[1]).toEqual([[TO], COMPANY]);
    for (const alias of ['je', 'jl', 'ga']) {
      expect(movement[0]).toMatch(new RegExp(`${alias}\\.company_id = \\?::UUID`));
    }
    expect(movement[1]).toEqual([COMPANY, COMPANY, COMPANY, FROM, TO]);
  });

  it('counts heads as at the END of the window it was asked for', async () => {
    await readReportPackInput(COMPANY, 'Acme Fibre (Pty) Ltd', '2025-03-01', '2025-08-31');
    const headCount = statements().find(([text]) => text.includes('payroll_employees'))!;
    expect(headCount[1][0]).toEqual(['2025-08-31']);
  });

  it('asks for the company and window the pack was asked for, and no other', async () => {
    await packRatios();
    const bound = statements().flatMap(([, values]) => values).filter((v) => typeof v === 'string');
    expect(new Set(bound.filter((v) => /^[0-9a-f-]{36}$/.test(v as string)))).toEqual(new Set([COMPANY]));
  });
});
