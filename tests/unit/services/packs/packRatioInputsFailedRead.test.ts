/**
 * WHERE THE LEDGER'S RATIO INPUTS CANNOT BE READ, THE PACK STILL PRINTS — AND
 * SAYS WHY THOSE RATIOS ARE MISSING.
 *
 * Interest, tax, employee cost and head count come from two queries beside
 * the pack's figures. A statement the database refuses aborts the request's
 * one transaction, so the read sits in its own savepoint (like the cash flow
 * statement's), and only a failed READ degrades: a defect is re-thrown. The
 * ratios that needed those inputs are then unstated with the true reason —
 * not "not captured in this report", which is what the pack said when it
 * never looked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getFinancialFiguresMock = vi.fn();
const getCashFlowDirectMock = vi.fn();

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/financialFiguresService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getFinancialFigures: (...a: unknown[]) => getFinancialFiguresMock(...a),
}));
vi.mock('@/modules/accounting/services/afs/cashFlowDirectService', () => ({
  getCashFlowDirect: (...a: unknown[]) => getCashFlowDirectMock(...a),
}));

import { log } from '@/lib/logger';
import { fakeRequestTx, pgError } from './support/fakeRequestTx';
import {
  readReportPackInput, RATIO_INPUTS_NOT_READ,
} from '@/modules/accounting/services/reports/reportPackDataService';
import { buildReportPack } from '@/modules/accounting/services/reports/reportPackService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const byType = {
  asset: { accounts: 0, amount: 0 }, liability: { accounts: 0, amount: 0 },
  equity: { accounts: 0, amount: 0 }, revenue: { accounts: 0, amount: 0 },
  expense: { accounts: 0, amount: 0 },
};
const none = { unclassifiedCount: 0, unclassifiedTotal: 0, unclassifiedByType: byType };
const zero = {
  revenue: 0, otherIncome: 0, costOfSales: 0, grossProfit: 0, operatingExpenses: 0, otherExpenses: 0,
  depreciation: 0, operatingProfit: 0, netProfit: 0, totalAssets: 0, totalLiabilities: 0, totalEquity: 0,
  currentAssets: 0, nonCurrentAssets: 0, currentLiabilities: 0, nonCurrentLiabilities: 0,
  cash: 0, accountsReceivable: 0, accountsPayable: 0, inventory: 0, ...none,
};
const FIGURES = {
  inventoryClassified: true, retainedEarningsBroughtForward: 0,
  period: { ...zero, revenue: 1_000_000, costOfSales: 600_000, grossProfit: 400_000, operatingExpenses: 250_000, operatingProfit: 150_000, netProfit: 93_000 },
  cumulative: { ...zero, totalAssets: 2_000_000, totalLiabilities: 800_000, totalEquity: 1_107_000, currentAssets: 900_000, currentLiabilities: 450_000, cash: 300_000 },
};

type Ratios = Record<string, number | null> & { notMeaningful: Record<string, string> };

beforeEach(() => {
  vi.clearAllMocks();
  getFinancialFiguresMock.mockResolvedValue(FIGURES);
  getCashFlowDirectMock.mockResolvedValue({ operatingTotal: 1, investingTotal: 0, financingTotal: 0, netChange: 1 });
});

async function read(failOn: (statement: string) => Error | null) {
  const tx = fakeRequestTx(failOn);
  const { input } = await tx.run(() => readReportPackInput(COMPANY, 'Acme', '2026-03-01', '2026-08-31'));
  const ratios = buildReportPack('management', input, '2026-03-01', '2026-08-31')
    .sections.find((s) => s.type === 'ratios')!.data as Ratios;
  return { tx, input, ratios };
}

describe.each([
  ['the head count', 'payroll_employees'],
  ['the period\'s movement', 'GROUP BY ga.account_type'],
])('when %s cannot be read (statement timeout)', (_name, marker) => {
  const failing = (s: string) => (s.includes(marker) ? pgError('57014', 'canceling statement due to statement timeout') : null);

  it('still returns the pack, with the transaction usable', async () => {
    const { tx, input } = await read(failing);
    expect(input.revenue).toBe(1_000_000);
    expect(tx.isAborted()).toBe(false);
    expect(tx.statements).toContain('SAVEPOINT pack_ratio_inputs');
    expect(tx.statements).toContain('ROLLBACK TO SAVEPOINT pack_ratio_inputs');
  });

  it('supplies none of the inputs, rather than some of them', async () => {
    const { input } = await read(failing);
    expect(input.interestExpense).toBeUndefined();
    expect(input.taxExpense).toBeUndefined();
    expect(input.employeeCount).toBeUndefined();
    expect(input.employeeCosts).toBeUndefined();
    expect(input.ratioInputsUnavailable).toBe(RATIO_INPUTS_NOT_READ);
  });

  it('says of each ratio that the figures could not be read, not that the report does not capture them', async () => {
    const { ratios } = await read(failing);
    for (const key of ['interestCoverage', 'pbtToNetInterest', 'effectiveTaxRate', 'revenuePerEmployee', 'employeeCostToRevenue']) {
      expect(ratios[key]).toBeNull();
      expect(ratios.notMeaningful[key]).toBe(RATIO_INPUTS_NOT_READ);
    }
    // Dividends and direct materials were never part of that read.
    expect(ratios.notMeaningful.directMaterialMargin).toBe('Direct material cost is not captured in this report, so this ratio cannot be stated.');
    expect(ratios.notMeaningful.dividendCover).toBe('Dividends paid is not captured in this report, so this ratio cannot be stated.');
  });

  it('logs the class of the failure and nothing of the statement', async () => {
    await read(failing);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(vi.mocked(log.warn).mock.calls[0]);
    expect(logged).toContain('57014');
    expect(logged).not.toContain('canceling statement');
  });
});

describe('when the read fails for a reason that is not a failed read', () => {
  it('re-throws a missing column (42703) — a defect, not weather', async () => {
    await expect(read((s) => (s.includes('GROUP BY ga.account_type') ? pgError('42703', 'column "x" does not exist') : null)))
      .rejects.toMatchObject({ code: '42703' });
  });
});

describe('when the read succeeds', () => {
  it('releases its savepoint and marks nothing unavailable', async () => {
    const { tx, input } = await read(() => null);
    expect(tx.statements).toContain('RELEASE SAVEPOINT pack_ratio_inputs');
    expect(tx.statements).not.toContain('ROLLBACK TO SAVEPOINT pack_ratio_inputs');
    expect(input.ratioInputsUnavailable).toBeUndefined();
    expect(input.interestExpense).toBe(0);
  });
});
