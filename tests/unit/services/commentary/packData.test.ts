/**
 * The pack assembler, with the ledger mocked and the real ratio engine.
 *
 * One property carries this file: a debt-to-equity that does not exist must
 * arrive at the draft builder as null, with the reason attached. A `?? 0` here
 * would be invisible — every assertion about sentences would still pass, and
 * insolvent companies would simply stop being told they are geared.
 *
 * Mutation check: restore `?? 0` on debtEquityRatio and the first two tests go
 * red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClassifiedFigures } from '@/modules/accounting/services/gl/accountClassification';
import type { PeriodFigures } from '@/modules/accounting/services/gl/financialFiguresService';

const figuresMock = vi.fn();
const sqlMock = vi.fn();

vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/modules/accounting/services/gl/financialFiguresService', async () => ({
  ...(await vi.importActual<typeof import('@/modules/accounting/services/gl/financialFiguresService')>(
    '@/modules/accounting/services/gl/financialFiguresService',
  )),
  getFinancialFigures: (...a: unknown[]) => figuresMock(...a),
}));

import { buildManagementPackData } from '@/modules/accounting/services/commentary/packData';
import type { SharePackParams } from '@/modules/accounting/services/reports/packParamsHash';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const PARAMS: SharePackParams = { type: 'board', from: '2026-04-01', to: '2026-06-30' };

const zero: ClassifiedFigures = {
  revenue: 0, otherIncome: 0, costOfSales: 0, grossProfit: 0,
  operatingExpenses: 0, otherExpenses: 0, depreciation: 0, operatingProfit: 0, netProfit: 0,
  totalAssets: 0, totalLiabilities: 0, totalEquity: 0,
  currentAssets: 0, nonCurrentAssets: 0, currentLiabilities: 0, nonCurrentLiabilities: 0,
  cash: 0, accountsReceivable: 0, accountsPayable: 0, inventory: 0,
  unclassifiedCount: 0, unclassifiedTotal: 0,
  unclassifiedByType: {
    asset: { accounts: 0, amount: 0 },
    liability: { accounts: 0, amount: 0 },
    equity: { accounts: 0, amount: 0 },
    revenue: { accounts: 0, amount: 0 },
    expense: { accounts: 0, amount: 0 },
  },
};

const figures = (
  period: Partial<ClassifiedFigures>, cumulative: Partial<ClassifiedFigures>, broughtForward = 0,
): PeriodFigures => ({
  inventoryClassified: true,
  retainedEarningsBroughtForward: broughtForward,
  period: { ...zero, ...period },
  cumulative: { ...zero, ...cumulative },
});

const SOLVENT = figures(
  { revenue: 1_000_000, costOfSales: 600_000, grossProfit: 400_000, operatingExpenses: 250_000, netProfit: 150_000 },
  { totalAssets: 2_000_000, totalLiabilities: 800_000, totalEquity: 1_050_000, currentAssets: 900_000, currentLiabilities: 500_000 },
);
// Liabilities exceed assets: equity ends up negative, so debt-to-equity inverts.
const INSOLVENT = figures(
  { revenue: 400_000, costOfSales: 380_000, grossProfit: 20_000, operatingExpenses: 300_000, netProfit: -280_000 },
  { totalAssets: 300_000, totalLiabilities: 900_000, totalEquity: 0, currentAssets: 100_000, currentLiabilities: 700_000 },
);

beforeEach(() => {
  sqlMock.mockReset().mockResolvedValue([{ name: 'Britech' }]);
  figuresMock.mockReset();
});

describe('buildManagementPackData', () => {
  it('carries a non-existent debt-to-equity through as null, with the reason', async () => {
    figuresMock.mockResolvedValue(INSOLVENT);
    const data = await buildManagementPackData(COMPANY, PARAMS);

    expect(data.balanceSheet.equity).toBeLessThan(0);
    expect(data.balanceSheet.debtEquityRatio).toBeNull();
    expect(data.balanceSheet.debtEquityRatio).not.toBe(0);
    expect(data.balanceSheet.debtEquityUnavailableReason).toContain('Equity is negative');
  });

  it('reports a real ratio when equity is sound', async () => {
    figuresMock.mockResolvedValue(SOLVENT);
    const data = await buildManagementPackData(COMPANY, PARAMS);

    expect(data.balanceSheet.debtEquityRatio).toBeGreaterThan(0);
    expect(data.balanceSheet.debtEquityUnavailableReason).toBeUndefined();
  });

  it('reads the comparative window from priorPeriod, company-scoped', async () => {
    figuresMock.mockResolvedValue(SOLVENT);
    await buildManagementPackData(COMPANY, PARAMS);

    expect(figuresMock).toHaveBeenCalledWith(COMPANY, '2026-04-01', '2026-06-30');
    expect(figuresMock).toHaveBeenCalledWith(COMPANY, '2026-01-01', '2026-03-31');
    expect(sqlMock.mock.calls[0]!.slice(1)).toContain(COMPANY);
  });

  it('reports no prior period at all when the comparative window never traded', async () => {
    figuresMock.mockImplementation((_c: string, from: string) =>
      Promise.resolve(from === PARAMS.from ? SOLVENT : figures({}, { totalAssets: 10 })));
    const data = await buildManagementPackData(COMPANY, PARAMS);

    // Not zeros: zeros would have the draft builder announce that revenue
    // "remained flat" over a period nobody traded in.
    expect(data.priorPeriod).toBeUndefined();
  });
});
