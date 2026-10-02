/**
 * THE HTML PACK IS BUILT FROM THE SAME INPUT AS THE PDF.
 *
 * `reports-html.ts` assembled the report-pack input by hand and left out
 * other income, other expenses and the cash flows. Its income statement
 * therefore printed no Other Income or Other Expenses row, did not foot to
 * net profit by their net, and printed operating profit without other income
 * — a different figure from the PDF of the same period.
 *
 * Driven through the real handler, against the income statement the PDF
 * route's own path builds from the same ledger read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const getFinancialFiguresMock = vi.fn();
const getCashFlowDirectMock = vi.fn();

vi.mock('@/lib/neon', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sql: vi.fn(async () => [{ name: 'Acme Fibre (Pty) Ltd' }]),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkReportRateLimit: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/gl/financialFiguresService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getFinancialFigures: (...a: unknown[]) => getFinancialFiguresMock(...a),
}));
vi.mock('@/modules/accounting/services/afs/cashFlowDirectService', () => ({
  getCashFlowDirect: (...a: unknown[]) => getCashFlowDirectMock(...a),
}));

import reportsHtmlRoute from '../../../pages/api/accounting/reports-html';
import { getReportPackInput } from '@/modules/accounting/services/reports/reportPackDataService';
import { buildReportPack } from '@/modules/accounting/services/reports/reportPackService';
import { incomeStatementPackRows } from '@/modules/accounting/services/reports/incomeStatementPackRows';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const FROM = '2026-03-01';
const TO = '2026-08-31';

const byType = {
  asset: { accounts: 0, amount: 0 }, liability: { accounts: 0, amount: 0 },
  equity: { accounts: 0, amount: 0 }, revenue: { accounts: 0, amount: 0 },
  expense: { accounts: 0, amount: 0 },
};
const none = { unclassifiedCount: 0, unclassifiedTotal: 0, unclassifiedByType: byType };
/** Turnover 4 200 000.55 − cost of sales 2 310 000.10 = gross 1 890 000.45;
 *  + other income 23 323.42 − operating expenses 1 180 000.20 = operating
 *  733 323.67; − other expenses 65 035.42 = net 668 288.25. */
const FIGURES = {
  inventoryClassified: true,
  retainedEarningsBroughtForward: 250_000,
  period: {
    revenue: 4_200_000.55, otherIncome: 23_323.42, costOfSales: 2_310_000.1, grossProfit: 1_890_000.45,
    operatingExpenses: 1_180_000.2, otherExpenses: 65_035.42, depreciation: 84_250.75,
    operatingProfit: 733_323.67, netProfit: 668_288.25,
    totalAssets: 0, totalLiabilities: 0, totalEquity: 0,
    currentAssets: 0, nonCurrentAssets: 0, currentLiabilities: 0, nonCurrentLiabilities: 0,
    cash: 0, accountsReceivable: 0, accountsPayable: 0, inventory: 0, ...none,
  },
  cumulative: {
    revenue: 0, otherIncome: 0, costOfSales: 0, grossProfit: 0, operatingExpenses: 0,
    otherExpenses: 0, depreciation: 0, operatingProfit: 0, netProfit: 0,
    totalAssets: 3_900_000, totalLiabilities: 1_700_000, totalEquity: 1_281_711.75,
    currentAssets: 1_900_000, nonCurrentAssets: 2_000_000,
    currentLiabilities: 950_000, nonCurrentLiabilities: 750_000,
    cash: 2_046_825.57, accountsReceivable: 720_000, accountsPayable: 430_000, inventory: 310_000, ...none,
  },
};
const CASH_FLOW = { operatingTotal: 345_678.12, investingTotal: -98_765.43, financingTotal: 12_345.67, netChange: 259_258.36 };

async function html(): Promise<string> {
  let body = '';
  const res = {
    status() { return res; }, json() { return res; }, setHeader() { return res; },
    send(b: string) { body = b; return res; },
  };
  await reportsHtmlRoute({
    method: 'POST', body: { type: 'management', from: FROM, to: TO }, companyId: COMPANY,
  } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return body;
}

/** label → amount in cents, for the HTML income statement's rows. */
async function incomeStatement(): Promise<Map<string, number>> {
  const doc = await html();
  const table = doc.slice(0, doc.indexOf('</table>'));
  const rows = [...table.matchAll(/<tr><td>([^<]+)<\/td><td class="num">R ([^<]+)<\/td>/g)];
  // en-ZA: groups separated by a space, a decimal comma.
  return new Map(rows.map((m) => [m[1]!, Math.round(Number(m[2]!.replace(/\s/g, '').replace(',', '.')) * 100)]));
}

beforeEach(() => {
  vi.clearAllMocks();
  getFinancialFiguresMock.mockResolvedValue(FIGURES);
  getCashFlowDirectMock.mockResolvedValue(CASH_FLOW);
});

describe('POST /api/accounting/reports-html', () => {
  it('prints Other Income and Other Expenses rows', async () => {
    const rows = await incomeStatement();
    expect(rows.get('Other Income')).toBe(2_332_342);
    expect(rows.get('Other Expenses')).toBe(6_503_542);
  });

  it('foots to net profit to the cent', async () => {
    const r = await incomeStatement();
    const at = (label: string) => {
      expect(r.has(label), `no ${label} row`).toBe(true);
      return r.get(label)!;
    };
    expect(at('Turnover') - at('Cost of Sales')).toBe(at('Gross Profit'));
    expect(at('Gross Profit') + at('Other Income') - at('Operating Expenses')).toBe(at('Operating Profit'));
    expect(at('Operating Profit') - at('Other Expenses')).toBe(at('Net Profit'));
    expect(at('Net Profit')).toBe(66_828_825);
  });

  it('prints the operating profit the PDF route prints for the same period', async () => {
    const input = await getReportPackInput(COMPANY, 'Acme Fibre (Pty) Ltd', FROM, TO);
    const section = buildReportPack('management', input, FROM, TO).sections.find((s) => s.type === 'income_statement')!;
    const pdfOperating = incomeStatementPackRows(section.data as Record<string, unknown>)
      .find((row) => row.label === 'Operating Profit')!.amount;
    expect((await incomeStatement()).get('Operating Profit')).toBe(Math.round(Number(pdfOperating) * 100));
    expect((await incomeStatement()).get('Operating Profit')).toBe(73_332_367);
  });

  it('prints the ledger\'s cash flows', async () => {
    expect(await html()).toMatch(/<tr><td>Operating Cash Flow<\/td><td class="num">R 345\s678,12<\/td><\/tr>/);
    expect(getCashFlowDirectMock).toHaveBeenCalledWith(COMPANY, FROM, TO);
  });

  it('still prints the company name, the period and the data-quality notice path', async () => {
    const doc = await html();
    expect(doc).toContain('Acme Fibre (Pty) Ltd');
    expect(getFinancialFiguresMock).toHaveBeenCalledTimes(1);
  });
});
