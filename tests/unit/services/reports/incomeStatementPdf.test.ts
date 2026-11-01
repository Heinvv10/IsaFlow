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
  parseComparators,
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
      { kind: 'note', label: 'The amounts above are repeated elsewhere in this statement — do not add them again.' },
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

  it.each([['negative', -1000], ['nil', 0]])('shows no margin on %s turnover, whatever the service computed', (_name, totalRevenue) => {
    // The service keeps a margin on negative turnover; the PDF follows the xlsx and CSV, which print none.
    const rows = incomeStatementPdfRows({ ...REPORT, totalRevenue, grossMarginPct: 150, netMarginPct: 80 });
    expect(rows.find((r) => r.kind === 'band' && r.band === 'grossProfit')).toMatchObject({ margin: null });
    expect(rows.find((r) => r.kind === 'band' && r.band === 'netProfit')).toMatchObject({ margin: null });
  });

  it('keeps the report\'s own margins on positive turnover', () => {
    const rows = incomeStatementPdfRows(REPORT);
    expect(rows.find((r) => r.kind === 'band' && r.band === 'grossProfit')).toMatchObject({ margin: 60 });
    expect(rows.find((r) => r.kind === 'band' && r.band === 'netProfit')).toMatchObject({ margin: 49.75 });
  });

  it('labels the bottom line as the screen and the xlsx do', () => {
    const rows = incomeStatementPdfRows(REPORT);
    expect(rows.find((r) => r.kind === 'band' && r.band === 'netProfit')).toMatchObject({ label: 'Net Profit / (Loss)' });
  });
});

describe('parseComparators', () => {
  it.each([
    [undefined, []], ['prior', ['prior']], ['budget', ['budget']], ['prior,budget', ['prior', 'budget']], ['prior,prior', ['prior']],
  ])('reads %j', (value, expected) => expect(parseComparators(value)).toEqual(expected));

  it.each([[''], ['trend'], ['prior,trend'], ['prior,'], [['prior', 'budget']], ['toString']])('refuses %j', (value) => {
    expect(parseComparators(value)).toBeNull();
  });
});

describe('buildIncomeStatementPdf', () => {
  it('writes the figures, labels and disclosure into the PDF', async () => {
    const pdf = await buildIncomeStatementPdf(REPORT, COMPANY, { scope: 'Cost centre: FNO-1 — Fixture', generatedOn: '2026-11-01' });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = await pdfText(pdf);
    for (const expected of [
      'Fixture Trading (Pty) Ltd', 'Income Statement', '01/04/2026', '30/04/2026', 'Cost centre: FNO-1',
      'Total Turnover R 1 000 000.25', 'Gross Profit R 600 000.15 60.0%', 'Other Income R 40.50',
      'Operating Profit R 500 040.62', 'Other Expenses R 2 500.07', 'Net Profit / (Loss) R 497 540.55 49.8%',
      'Expense that could be cost of sales (at most) R 574 253.66',
      'Revenue that could be other income (at most) R 700.25',
      'and 3 further affected account(s)',
      'The amounts above are repeated elsewhere in this statement — do not add them again.',
    ]) expect(text).toContain(expected);
  });

  it('prints a loss and a contra line with their signs, in brackets, and a positive line without', async () => {
    const loss = {
      ...REPORT,
      revenue: [line('4000', 'Sales', 10000), line('4050', 'Sales Returns', -2500.5)],
      otherIncome: [], totalOtherIncome: 0, otherExpenses: [], totalOtherExpenses: 0,
      costOfSales: [line('5000', 'Purchases', 9000.25)],
      operatingExpenses: [line('6000', 'Rent', 1000.1), line('6100', 'Rent rebate', -200)],
      totalRevenue: 7499.5, totalCostOfSales: 9000.25, totalOperatingExpenses: 800.1,
      grossProfit: -1500.75, operatingProfit: -2300.85, netProfit: -2300.85,
      grossMarginPct: -20.01, netMarginPct: -30.68, subtypeDisclosure: null,
    } as unknown as IncomeStatementReport;
    const text = await pdfText(await buildIncomeStatementPdf(loss, COMPANY, { scope: null, generatedOn: '2026-11-01' }));
    for (const expected of [
      '4000 Sales R 10 000.00', '4050 Sales Returns (R 2 500.50)', 'Total Turnover R 7 499.50',
      '5000 Purchases R 9 000.25', 'Gross Profit (R 1 500.75) (20.0%)', '6100 Rent rebate (R 200.00)',
      'Total Operating Expenses R 800.10', 'Operating Profit (R 2 300.85)', 'Net Profit / (Loss) (R 2 300.85) (30.7%)',
    ]) expect(text).toContain(expected);
    expect(text).not.toMatch(/-\s*R|R\s*-/);
  });

  it('prints a line under half a cent as nil, never as a negative zero', async () => {
    const dust = {
      ...REPORT,
      revenue: [line('4000', 'Sales', 1000), line('4060', 'Rounding', -0.004)], netProfit: -0.0049, subtypeDisclosure: null,
    } as unknown as IncomeStatementReport;
    const text = await pdfText(await buildIncomeStatementPdf(dust, COMPANY, { scope: null, generatedOn: '2026-11-01' }));
    expect(text).toContain('4060 Rounding –');
    expect(text).toContain('Net Profit / (Loss) – 49.8%');
    expect(text).not.toMatch(/-0\.00|\(R 0\.00\)/);
  });

  it('prints the no-margin cell on a period with no positive turnover', async () => {
    const none = { ...REPORT, totalRevenue: -500, grossProfit: -400, netProfit: -300, grossMarginPct: 80, netMarginPct: 60 };
    const text = await pdfText(await buildIncomeStatementPdf(none, COMPANY, { scope: null, generatedOn: '2026-11-01' }));
    expect(text).toContain('Gross Profit (R 400.00) –');
    expect(text).toContain('Net Profit / (Loss) (R 300.00) –');
    expect(text).not.toContain('80.0%');
  });

  it('keeps a nine-figure bracketed amount on one line', async () => {
    const large = { ...REPORT, netProfit: -212345678.9 };
    const { PDFParse } = (await import('pdf-parse')) as unknown as {
      PDFParse: new (o: { data: Buffer }) => { getText(): Promise<{ text: string }> };
    };
    const pdf = await buildIncomeStatementPdf(large, COMPANY, { scope: null, generatedOn: '2026-11-01' });
    const raw = (await new PDFParse({ data: pdf }).getText()).text;
    expect(raw).toMatch(/\(R[ \u00a0]212[ \u00a0]345[ \u00a0]678\.90\)/);
  });

  it.each([
    [['prior', 'budget'], 'Comparators on screen, not included in this PDF: Prior period, Budget.'],
    [['prior'], 'Comparators on screen, not included in this PDF: Prior period.'],
    [['budget'], 'Comparators on screen, not included in this PDF: Budget.'],
  ] as const)('says %j are left out', async (comparators, sentence) => {
    const pdf = await buildIncomeStatementPdf(REPORT, COMPANY, { scope: null, generatedOn: '2026-11-01', omittedComparators: comparators });
    expect(await pdfText(pdf)).toContain(sentence);
  });

  it('says nothing of comparators when the screen shows none', async () => {
    const pdf = await buildIncomeStatementPdf(REPORT, COMPANY, { scope: null, generatedOn: '2026-11-01' });
    expect(await pdfText(pdf)).not.toContain('Comparators');
  });

  it('runs to more pages rather than clipping a long statement', async () => {
    const many = Array.from({ length: 120 }, (_, i) => line(`6${String(i).padStart(3, '0')}`, `Expense account ${i}`, i + 1));
    const text = await pdfText(await buildIncomeStatementPdf({ ...REPORT, operatingExpenses: many }, COMPANY, { scope: null, generatedOn: '2026-11-01' }));
    expect(text).toContain('Expense account 0');
    expect(text).toContain('Expense account 119');
  });
});
