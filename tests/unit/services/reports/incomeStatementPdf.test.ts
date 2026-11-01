/**
 * The P&L PDF: the row list (every band, the report's own figures, the
 * disclosure beneath gross margin) and the bytes (read back with pdf.js, a
 * reader this repo did not write).
 */
import { describe, expect, it, vi } from 'vitest';
import type { IncomeStatementReport, IncomeStatementLineItem } from '@/modules/accounting/types/gl.report.types';
import type { IncomeStatementSubtypeDisclosure } from '@/modules/accounting/services/reports/incomeStatementDisclosure';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import {
  buildIncomeStatementPdf,
  incomeStatementPdfRows,
} from '@/modules/accounting/services/reports/incomeStatementPdf';
import type { PackPandLBand } from '@/modules/accounting/services/reports/incomeStatementPackRows';
import type { CompanyDetails } from '@/modules/accounting/services/core/pdfShared';

const line = (accountCode: string, accountName: string, amount: number): IncomeStatementLineItem =>
  ({ accountCode, accountName, amount });

const DISCLOSURE: IncomeStatementSubtypeDisclosure = {
  expenseAccounts: 1, expenseAmount: 574253.66, revenueAccounts: 1, revenueAmount: 700.25,
  costOfSalesExposureAtMost: 574253.66, otherIncomeExposureAtMost: 700.25, grossProfitOverstatedByAtMost: 574953.91,
  accounts: [
    { accountCode: '5001', accountName: 'Cost of Goods Sold', accountType: 'expense', amount: 574253.66, reason: 'platform_default' },
    { accountCode: '4001', accountName: 'Product Sales', accountType: 'revenue', amount: 700.25, reason: 'no_subtype' },
  ],
  unnamedAccounts: 3,
  notices: ['Gross profit rests on accounts nobody has classified.'],
  message: 'Gross profit rests on accounts nobody has classified.',
};

const REPORT = {
  periodStart: '2026-04-01', periodEnd: '2026-04-30',
  revenue: [line('4000', 'Sales', 1000000.25)],
  otherIncome: [line('4900', 'Interest Received', 40.5)],
  costOfSales: [line('5000', 'Purchases', 400000.1)],
  operatingExpenses: [line('6000', 'Rent', 100000.03)],
  otherExpenses: [line('7000', 'Finance Costs', 2500.07)],
  totalRevenue: 1000000.25, totalOtherIncome: 40.5, totalCostOfSales: 400000.1,
  totalOperatingExpenses: 100000.03, totalOtherExpenses: 2500.07,
  grossProfit: 600000.15, operatingProfit: 500040.62, netProfit: 497540.55,
  grossMarginPct: 60, netMarginPct: 49.75,
  subtypeDisclosure: DISCLOSURE,
} as unknown as IncomeStatementReport;

const COMPANY = { name: 'Fixture Trading (Pty) Ltd', primaryColor: '#0f766e' } as unknown as CompanyDetails;

const BANDS: Array<[PackPandLBand, number]> = [
  ['revenue', 1000000.25], ['costOfSales', 400000.1], ['grossProfit', 600000.15], ['otherIncome', 40.5],
  ['operatingExpenses', 100000.03], ['operatingProfit', 500040.62], ['otherExpenses', 2500.07], ['netProfit', 497540.55],
];

async function pdfText(pdf: Buffer): Promise<string> {
  const { PDFParse } = (await import('pdf-parse')) as unknown as {
    PDFParse: new (o: { data: Buffer }) => { getText(): Promise<{ text: string }> };
  };
  return (await new PDFParse({ data: pdf }).getText()).text.replace(/\s+/g, ' ');
}

describe('incomeStatementPdfRows', () => {
  it('has every band, in order, with the report\'s figure', () => {
    const bands = incomeStatementPdfRows(REPORT).flatMap((r) => (r.kind === 'band' ? [[r.band, r.amount]] : []));
    expect(bands).toEqual(BANDS);
  });

  it('prints the report\'s net profit, never one rebuilt from the bands', () => {
    const rows = incomeStatementPdfRows({ ...REPORT, netProfit: 123.45 });
    expect(rows.find((r) => r.kind === 'band' && r.band === 'netProfit')).toMatchObject({ amount: 123.45 });
  });

  it('carries each account under its band, unsummed', () => {
    const rows = incomeStatementPdfRows({
      ...REPORT, operatingExpenses: [line('6000', 'Rent', 1), line('6100', 'Wages', 2)], totalOperatingExpenses: 99,
    });
    const at = rows.findIndex((r) => r.kind === 'band' && r.band === 'operatingExpenses');
    expect(rows.slice(at - 2, at + 1)).toMatchObject([
      { kind: 'account', code: '6000', label: 'Rent', amount: 1 },
      { kind: 'account', code: '6100', label: 'Wages', amount: 2 },
      { kind: 'band', amount: 99 },
    ]);
  });

  it('keeps the accounts of a band that nets to nil, in the band\'s place', () => {
    const rows = incomeStatementPdfRows({
      ...REPORT, otherIncome: [line('4900', 'Interest', 50), line('4901', 'Interest reversal', -50)], totalOtherIncome: 0,
      otherExpenses: [line('7000', 'Fees', 5), line('7001', 'Fee rebate', -5)], totalOtherExpenses: 0,
    });
    const order = rows.flatMap((r) => (r.kind === 'band' ? [r.band] : r.kind === 'account' ? [r.code] : []));
    expect(order).toEqual(['4000', 'revenue', '5000', 'costOfSales', 'grossProfit', '4900', '4901', 'otherIncome',
      '6000', 'operatingExpenses', 'operatingProfit', '7000', '7001', 'otherExpenses', 'netProfit']);
  });

  it('omits an optional band with no accounts and no amount', () => {
    const rows = incomeStatementPdfRows({ ...REPORT, otherIncome: [], totalOtherIncome: 0, otherExpenses: [], totalOtherExpenses: 0 });
    expect(rows.some((r) => r.kind === 'band' && r.band === 'otherIncome')).toBe(false);
    expect(rows.some((r) => r.kind === 'band' && r.band === 'otherExpenses')).toBe(false);
    expect(rows.some((r) => r.kind === 'band' && r.band === 'operatingProfit')).toBe(true);
  });

  it('prints the disclosure directly beneath gross profit, both ceilings and never their sum', () => {
    const rows = incomeStatementPdfRows(REPORT);
    const at = rows.findIndex((r) => r.kind === 'band' && r.band === 'grossProfit');
    expect(rows.slice(at + 1, at + 8)).toEqual([
      { kind: 'warning', label: 'Expense that could be cost of sales (at most)', amount: 574253.66 },
      { kind: 'warning', label: 'Revenue that could be other income (at most)', amount: 700.25 },
      { kind: 'note', label: 'Gross profit rests on accounts nobody has classified.' },
      { kind: 'warning', code: '5001', label: 'Cost of Goods Sold — carries the platform default subtype, i.e. nobody classified it', amount: 574253.66 },
      { kind: 'warning', code: '4001', label: 'Product Sales — no recognised account_subtype', amount: 700.25 },
      { kind: 'note', label: 'and 3 further affected account(s)' },
      { kind: 'note', label: 'The amounts above are repeated elsewhere in this sheet — do not add them again.' },
    ]);
    expect(JSON.stringify(rows)).not.toContain('574953.91');
  });

  it('prints no disclosure when the report has none', () => {
    const rows = incomeStatementPdfRows({ ...REPORT, subtypeDisclosure: null });
    expect(rows.some((r) => r.kind === 'warning' || r.kind === 'note')).toBe(false);
  });

  it('shows no margin rather than 0% on a period with no turnover', () => {
    const rows = incomeStatementPdfRows({ ...REPORT, grossMarginPct: null, netMarginPct: null });
    expect(rows.find((r) => r.kind === 'band' && r.band === 'grossProfit')).toMatchObject({ margin: null });
  });
});

describe('buildIncomeStatementPdf', () => {
  it('writes the figures, labels and disclosure into the PDF', async () => {
    const pdf = await buildIncomeStatementPdf(REPORT, COMPANY, { scope: 'Cost centre: FNO-1 — Fixture', generatedOn: '2026-11-01' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = await pdfText(pdf);
    for (const expected of [
      'Fixture Trading (Pty) Ltd', 'Income Statement', '01/04/2026', '30/04/2026', 'Cost centre: FNO-1',
      'Total Turnover', 'R 1,000,000.25', 'Gross Profit', 'R 600,000.15', '60.0%', 'Other Income', 'R 40.50',
      'Operating Profit', 'R 500,040.62', 'Other Expenses', 'R 2,500.07', 'Net Profit', 'R 497,540.55', '49.8%',
      'Expense that could be cost of sales (at most)', 'R 574,253.66',
      'Revenue that could be other income (at most)', 'R 700.25',
      'and 3 further affected account(s)',
      'The amounts above are repeated elsewhere in this sheet — do not add them again.',
    ]) expect(text).toContain(expected);
  });

  it('runs to more pages rather than clipping a long statement', async () => {
    const many = Array.from({ length: 120 }, (_, i) => line(`6${String(i).padStart(3, '0')}`, `Expense account ${i}`, i + 1));
    const text = await pdfText(await buildIncomeStatementPdf({ ...REPORT, operatingExpenses: many }, COMPANY, { scope: null, generatedOn: '2026-11-01' }));
    expect(text).toContain('Expense account 0');
    expect(text).toContain('Expense account 119');
  });
});
