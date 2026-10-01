/**
 * ONE PRODUCER FOR THE REPORT PACK'S INPUT.
 *
 * The PDF and the deck built their pack from `getReportPackInput`. The
 * interactive screen and the shared link each built the same input by hand,
 * from the same figures, and neither carried the cash flows — so for one
 * company and one period the PDF printed the ledger's cash flow statement
 * and the screen beside it printed a line of reasons.
 *
 * Driven through the real route handler and the real share service, against
 * the pack the PDF route's own path produces from the same ledger read.
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
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/gl/financialFiguresService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getFinancialFigures: (...a: unknown[]) => getFinancialFiguresMock(...a),
}));
vi.mock('@/modules/accounting/services/afs/cashFlowDirectService', () => ({
  getCashFlowDirect: (...a: unknown[]) => getCashFlowDirectMock(...a),
}));
vi.mock('@/modules/accounting/services/reports/companyName', () => ({
  getCompanyName: vi.fn(async () => 'Acme Fibre (Pty) Ltd'),
}));

import reportsPackRoute from '../../../../pages/api/accounting/reports-pack';
import { buildSharedPack } from '@/modules/accounting/services/share/sharedPackService';
import { getReportPackInput } from '@/modules/accounting/services/reports/reportPackDataService';
import { buildReportPack, type PackSection } from '@/modules/accounting/services/reports/reportPackService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const FROM = '2026-03-01';
const TO = '2026-08-31';

const byType = {
  asset: { accounts: 0, amount: 0 }, liability: { accounts: 0, amount: 0 },
  equity: { accounts: 0, amount: 0 }, revenue: { accounts: 0, amount: 0 },
  expense: { accounts: 0, amount: 0 },
};
/** Three accounts with no recognised subtype, so the screen's caveat object
 *  has something in it. */
const classification = {
  unclassifiedCount: 3, unclassifiedTotal: 5_000,
  unclassifiedByType: { ...byType, asset: { accounts: 3, amount: 5_000 } },
};
const FIGURES = {
  inventoryClassified: true,
  retainedEarningsBroughtForward: 250_000,
  period: {
    revenue: 4_200_000.55, otherIncome: 23_323.42, costOfSales: 2_310_000.1, grossProfit: 1_890_000.45,
    operatingExpenses: 1_180_000.2, otherExpenses: 65_035.42, depreciation: 84_250.75,
    operatingProfit: 733_323.67, netProfit: 668_288.25,
    totalAssets: 0, totalLiabilities: 0, totalEquity: 0,
    currentAssets: 0, nonCurrentAssets: 0, currentLiabilities: 0, nonCurrentLiabilities: 0,
    cash: 0, accountsReceivable: 0, accountsPayable: 0, inventory: 0,
    ...classification,
  },
  cumulative: {
    revenue: 0, otherIncome: 0, costOfSales: 0, grossProfit: 0, operatingExpenses: 0,
    otherExpenses: 0, depreciation: 0, operatingProfit: 0, netProfit: 0,
    totalAssets: 3_900_000, totalLiabilities: 1_700_000, totalEquity: 1_281_711.75,
    currentAssets: 1_900_000, nonCurrentAssets: 2_000_000,
    currentLiabilities: 950_000, nonCurrentLiabilities: 750_000,
    cash: 2_046_825.57, accountsReceivable: 720_000, accountsPayable: 430_000, inventory: 310_000,
    ...classification,
  },
};
const CASH_FLOW = {
  operatingTotal: 345_678.12, investingTotal: -98_765.43, financingTotal: 12_345.67,
  netChange: 259_258.36,
};

function mockRes() {
  const res = {
    statusCode: 0, body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    setHeader() { return this; },
  };
  return res as unknown as NextApiResponse & typeof res;
}

/** The pack the PDF route builds: `buildReportPack` over `getReportPackInput`. */
async function referenceSections(type: 'management' | 'board'): Promise<PackSection[]> {
  const input = await getReportPackInput(COMPANY, 'Acme Fibre (Pty) Ltd', FROM, TO);
  return buildReportPack(type, input, FROM, TO).sections;
}

const section = (sections: PackSection[], type: string) =>
  sections.find((s) => s.type === type)!.data as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  getFinancialFiguresMock.mockResolvedValue(FIGURES);
  getCashFlowDirectMock.mockResolvedValue(CASH_FLOW);
  sqlMock.mockResolvedValue([]);
});

describe('the interactive screen (GET /api/accounting/reports-pack)', () => {
  async function screen(): Promise<{ pack: { sections: PackSection[] }; unclassifiedAccounts: unknown }> {
    const res = mockRes();
    await reportsPackRoute({
      method: 'GET', query: { type: 'management', from: FROM, to: TO }, companyId: COMPANY,
    } as unknown as NextApiRequest, res);
    expect(res.statusCode).toBe(200);
    return (res.body as { data: { pack: { sections: PackSection[] }; unclassifiedAccounts: unknown } }).data;
  }

  it('shows the same sections, figure for figure, as the PDF route builds', async () => {
    const { pack } = await screen();
    expect(pack.sections).toEqual(await referenceSections('management'));
  });

  it('shows the ledger\'s cash flows, not net profit standing in for them', async () => {
    const cashFlow = section((await screen()).pack.sections, 'cash_flow');
    expect(cashFlow.operatingCashFlow).toBe(345_678.12);
    expect(cashFlow.investingCashFlow).toBe(-98_765.43);
    expect(cashFlow.financingCashFlow).toBe(12_345.67);
    expect(cashFlow.unavailable).toEqual({});
  });

  it('reads the cash flow statement for the company and window it was asked about', async () => {
    await screen();
    expect(getCashFlowDirectMock).toHaveBeenCalledWith(COMPANY, FROM, TO);
    expect(getFinancialFiguresMock).toHaveBeenCalledTimes(1);
  });

  it('still returns the classification caveat as the object the screen renders', async () => {
    const { unclassifiedAccounts } = await screen();
    expect(unclassifiedAccounts).toMatchObject({ accounts: 3, amount: 5_000 });
  });
});

describe('the shared link (buildSharedPack)', () => {
  const LINK = { id: 'link-1', companyId: COMPANY, params: { type: 'management' as const, from: FROM, to: TO } };

  it('builds the same sections, figure for figure, as the PDF route builds', async () => {
    const shared = await buildSharedPack(LINK);
    expect(shared.pack.sections).toEqual(await referenceSections('management'));
  });

  it('carries the ledger\'s cash flows', async () => {
    const shared = await buildSharedPack(LINK);
    expect(section(shared.pack.sections, 'cash_flow').operatingCashFlow).toBe(345_678.12);
    expect(getCashFlowDirectMock).toHaveBeenCalledWith(COMPANY, FROM, TO);
  });

  it('still returns the classification caveat as an object', async () => {
    expect((await buildSharedPack(LINK)).unclassifiedAccounts).toMatchObject({ accounts: 3, amount: 5_000 });
  });

  it('reads one thing at a time: the ledger, then the cash flows, then the commentary', async () => {
    const order: string[] = [];
    getFinancialFiguresMock.mockImplementation(async () => { order.push('figures:start'); await null; order.push('figures:end'); return FIGURES; });
    getCashFlowDirectMock.mockImplementation(async () => { order.push('cash:start'); await null; order.push('cash:end'); return CASH_FLOW; });
    sqlMock.mockImplementation(async () => { order.push('commentary:start'); await null; order.push('commentary:end'); return []; });
    await buildSharedPack(LINK);
    expect(order).toEqual([
      'figures:start', 'figures:end', 'cash:start', 'cash:end', 'commentary:start', 'commentary:end',
    ]);
  });
});
