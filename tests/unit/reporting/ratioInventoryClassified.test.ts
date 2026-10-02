/**
 * NIL STOCK IS A FACT ONLY WHERE THE CHART CAN HOLD STOCK.
 *
 * On the demo company the management pack printed "Inventory Days 0 days"
 * and "Cash Conversion Cycle (575 days)" while the board pack, from the same
 * figures, said the cycle could not be computed because no inventory could be
 * identified. The board was right: `inventoryClassified` false means the
 * chart has no inventory account at all, so an inventory of nil is not a
 * measurement — and a cycle computed through it reads as fast cash
 * conversion, wrong the dangerous way.
 *
 * One rule now, in the engine: where the caller says the chart classifies no
 * inventory, inventory days, inventory turnover and the cycle are not stated,
 * in the board pack's words. Where it does and holds none, inventory days are
 * nil and the cycle is stated (round 14). Driven through the engine, the
 * real management-pack producer, and the Financial Analysis read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const getFinancialFiguresMock = vi.fn();
const sqlMock = vi.fn();
vi.mock('@/lib/neon', async (orig) => ({ ...(await orig<Record<string, unknown>>()), sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/gl/financialFiguresService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getFinancialFigures: (...a: unknown[]) => getFinancialFiguresMock(...a),
}));
vi.mock('@/modules/accounting/services/afs/cashFlowDirectService', () => ({
  getCashFlowDirect: vi.fn(async () => ({ operatingTotal: 0, investingTotal: 0, financingTotal: 0, netChange: 0 })),
}));

import { calculateExtendedRatios, type FinancialData } from '@/modules/accounting/services/reports/reportingEngineService';
import { NO_INVENTORY_CLASSIFIED_CYCLE, NO_INVENTORY_CLASSIFIED } from '@/modules/accounting/services/reports/ratioBasis';
import { readReportPackInput } from '@/modules/accounting/services/reports/reportPackDataService';
import { buildReportPack } from '@/modules/accounting/services/reports/reportPackService';
import ratiosRoute from '../../../pages/api/accounting/reports-extended-ratios';

const COMPANY: FinancialData = {
  revenue: 101_400, costOfSales: 1_430_581.6, operatingExpenses: 215_059.3, netProfit: -1_544_240.9,
  totalAssets: 900_000, totalLiabilities: 1_300_000, totalEquity: -400_000, currentAssets: 140_000,
  currentLiabilities: 1_000_000, inventory: 0, accountsReceivable: 59_237, accountsPayable: 3_092_000, cash: 20_000,
};
const INVENTORY_KEYS = ['inventoryDays', 'inventoryTurnover', 'cashConversionCycle'] as const;

describe('the engine', () => {
  it('states none of the three where the chart classifies no inventory, in the board pack\'s words', () => {
    const r = calculateExtendedRatios({ ...COMPANY, inventoryClassified: false });
    for (const key of INVENTORY_KEYS) expect(r[key], key).toBeNull();
    expect(r.notMeaningful.cashConversionCycle).toBe(
      'No inventory could be identified in the chart of accounts, so the cash conversion cycle cannot be computed.');
    expect(r.notMeaningful.cashConversionCycle).toBe(NO_INVENTORY_CLASSIFIED_CYCLE);
    expect(r.notMeaningful.inventoryDays).toBe(NO_INVENTORY_CLASSIFIED);
    expect(r.notMeaningful.inventoryTurnover).toBe(NO_INVENTORY_CLASSIFIED);
    expect(NO_INVENTORY_CLASSIFIED).toBe('No inventory could be identified in the chart of accounts, so this ratio cannot be computed.');
  });

  it('states no quick ratio where the chart classifies no inventory: there is nothing established to take off', () => {
    const r = calculateExtendedRatios({ ...COMPANY, inventoryClassified: false });
    expect(r.quickRatio).toBeNull();
    expect(r.notMeaningful.quickRatio).toBe(NO_INVENTORY_CLASSIFIED);
    // The current ratio does not stand on inventory, and stays.
    expect(r.currentRatio).toBe(0.14);
  });

  it('states the quick ratio where inventory is classified, held or not', () => {
    expect(calculateExtendedRatios({ ...COMPANY, inventoryClassified: true }).quickRatio).toBe(0.14);
    expect(calculateExtendedRatios({ ...COMPANY, inventory: 40_000, inventoryClassified: true }).quickRatio).toBe(0.1);
  });

  it('states nil inventory days and the cycle where the chart classifies inventory and holds none', () => {
    const r = calculateExtendedRatios({ ...COMPANY, inventoryClassified: true });
    expect(r.inventoryDays).toBe(0);
    expect(r.cashConversionCycle).not.toBeNull();
  });

  it('is unchanged where it is held, classified', () => {
    const r = calculateExtendedRatios({ ...COMPANY, inventory: 200_000, inventoryClassified: true });
    expect(r.inventoryDays).not.toBeNull();
    expect(r.inventoryTurnover).not.toBeNull();
  });

  it('leaves the other day counts alone', () => {
    const r = calculateExtendedRatios({ ...COMPANY, inventoryClassified: false });
    expect(r.debtorDays).not.toBeNull();
    expect(r.creditorDays).not.toBeNull();
  });
});

const byType = {
  asset: { accounts: 0, amount: 0 }, liability: { accounts: 0, amount: 0 }, equity: { accounts: 0, amount: 0 },
  revenue: { accounts: 0, amount: 0 }, expense: { accounts: 0, amount: 0 },
};
const zero = {
  revenue: 0, otherIncome: 0, costOfSales: 0, grossProfit: 0, operatingExpenses: 0, otherExpenses: 0, depreciation: 0,
  operatingProfit: 0, netProfit: 0, totalAssets: 0, totalLiabilities: 0, totalEquity: 0, currentAssets: 0,
  nonCurrentAssets: 0, currentLiabilities: 0, nonCurrentLiabilities: 0, cash: 0, accountsReceivable: 0,
  accountsPayable: 0, inventory: 0, unclassifiedCount: 0, unclassifiedTotal: 0, unclassifiedByType: byType,
};
const figures = (inventoryClassified: boolean) => ({
  inventoryClassified, retainedEarningsBroughtForward: 0,
  period: { ...zero, revenue: 101_400, costOfSales: 1_430_581.6, grossProfit: -1_329_181.6, operatingExpenses: 215_059.3,
    operatingProfit: -1_544_240.9, netProfit: -1_544_240.9 },
  cumulative: { ...zero, totalAssets: 900_000, totalLiabilities: 1_300_000, totalEquity: -400_000, currentAssets: 140_000,
    currentLiabilities: 1_000_000, cash: 20_000, accountsReceivable: 59_237, accountsPayable: 3_092_000 },
});

async function managementPack(inventoryClassified: boolean) {
  getFinancialFiguresMock.mockResolvedValue(figures(inventoryClassified));
  const { input } = await readReportPackInput('c1', 'Demo', '2026-01-01', '2026-09-07');
  return buildReportPack('management', input, '2026-01-01', '2026-09-07').sections.find((s) => s.type === 'ratios')!
    .data as Record<string, number | null> & { notMeaningful: Record<string, string> };
}

async function financialAnalysis(inventoryClassified: boolean) {
  getFinancialFiguresMock.mockResolvedValue(figures(inventoryClassified));
  let body: unknown;
  const res = { status() { return res; }, json(b: unknown) { body = b; return res; }, setHeader() { return res; } };
  await (ratiosRoute as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(
    { method: 'GET', query: { from: '2026-01-01', to: '2026-09-07' }, companyId: 'c1' } as unknown as NextApiRequest,
    res as unknown as NextApiResponse);
  return (body as { data: { ratios: Record<string, number | null> & { notMeaningful: Record<string, string> } } }).data.ratios;
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockImplementation(async (strings: unknown, ...values: unknown[]) => {
    const text = (strings as readonly string[]).join('?');
    if (text.includes('payroll_employees')) return (values[0] as string[]).map((as_at) => ({ as_at, count: 3 }));
    return [];
  });
});

describe.each([['the management pack', managementPack], ['Financial Analysis', financialAnalysis]])('%s', (_name, read) => {
  it('on the demo (no inventory classified): no inventory days, turnover or cycle', async () => {
    const r = await read(false);
    for (const key of INVENTORY_KEYS) expect(r[key], key).toBeNull();
    expect(r.notMeaningful.cashConversionCycle).toBe(NO_INVENTORY_CLASSIFIED_CYCLE);
    expect(r.quickRatio).toBeNull();
    expect(r.notMeaningful.quickRatio).toBe(NO_INVENTORY_CLASSIFIED);
  });

  it('with inventory classified and none held: nil days and a stated cycle', async () => {
    const r = await read(true);
    expect(r.inventoryDays).toBe(0);
    expect(r.cashConversionCycle).not.toBeNull();
  });
});
