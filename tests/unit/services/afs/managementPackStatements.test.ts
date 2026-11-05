/**
 * The pack's Income Statement and Balance Sheet as statement tables: the report's own figures, banded
 * and totalled as the report has them, one column per comparison month.
 */
import { describe, expect, it } from 'vitest';
import type { BalanceSheetReport, IncomeStatementReport } from '@/modules/accounting/types/gl.types';
import {
  balanceSheetTable, incomeStatementTable, longDate, type StatementColumn,
} from '@/modules/accounting/services/afs/managementPackStatements';

const item = (accountCode: string, accountName: string, amount: number) => ({ accountCode, accountName, amount });
const bs = (accountCode: string, accountName: string, balance: number) => ({ accountCode, accountName, balance });
const plain = (s: string) => s.replace(/ /g, ' ');

function income(over: Partial<IncomeStatementReport> = {}): IncomeStatementReport {
  return {
    periodStart: '2026-09-01', periodEnd: '2026-09-30',
    revenue: [item('4100', 'Sales', 120000)], otherIncome: [], costOfSales: [item('5100', 'Materials', 10000)],
    operatingExpenses: [item('5200', 'Labour', 65000), item('5600', 'Admin', 400)], otherExpenses: [],
    totalRevenue: 120000, totalOtherIncome: 0, totalCostOfSales: 10000, totalOperatingExpenses: 65400, totalOtherExpenses: 0,
    grossProfit: 110000, operatingProfit: 44600, netProfit: 44600, ...over,
  } as IncomeStatementReport;
}
const col = (label: string, report: IncomeStatementReport): StatementColumn<IncomeStatementReport> => ({ label, report });
const cells = (t: { rows: string[][] }) => t.rows.map((r) => r.map(plain));

describe('incomeStatementTable', () => {
  it('prints the report\'s bands, account lines and totals, with the kind of each row', () => {
    const { table, empty } = incomeStatementTable([col('This month', income())], false);
    expect(empty).toBe(false);
    expect(table.headers).toEqual(['', 'This month']);
    expect(cells(table)).toEqual([
      ['Revenue', ''],
      ['4100 Sales', 'R 120 000.00'],
      ['Total revenue', 'R 120 000.00'],
      ['Cost of sales', ''],
      ['5100 Materials', 'R 10 000.00'],
      ['Total cost of sales', 'R 10 000.00'],
      ['Gross profit', 'R 110 000.00'],
      ['Operating expenses', ''],
      ['5200 Labour', 'R 65 000.00'],
      ['5600 Admin', 'R 400.00'],
      ['Total operating expenses', 'R 65 400.00'],
      ['Operating profit', 'R 44 600.00'],
      ['Net profit', 'R 44 600.00'],
    ]);
    expect(table.rowKinds).toEqual([
      'heading', 'line', 'subtotal', 'heading', 'line', 'subtotal', 'subtotal', 'heading', 'line', 'line', 'subtotal', 'subtotal', 'total',
    ]);
  });

  it('uses the report\'s totals, never its own sum of the lines', () => {
    const { table } = incomeStatementTable([col('This month', income({ netProfit: 1 }))], false);
    expect(cells(table).at(-1)).toEqual(['Net profit', 'R 1.00']);
  });

  it('matches accounts across months by code, with R 0.00 where a month has none', () => {
    const prior = income({ revenue: [item('4200', 'Fees', 500)], totalRevenue: 500, grossProfit: 500, operatingProfit: 500, netProfit: 500 });
    const { table } = incomeStatementTable([col('This month', income()), col('Prior month', prior)], false);
    const rows = cells(table);
    expect(rows.find((r) => r[0] === '4100 Sales')).toEqual(['4100 Sales', 'R 120 000.00', 'R 0.00']);
    expect(rows.find((r) => r[0] === '4200 Fees')).toEqual(['4200 Fees', 'R 0.00', 'R 500.00']);
  });

  it('adds the change on the same month last year', () => {
    const yearAgo = income({ totalRevenue: 100000, revenue: [item('4100', 'Sales', 100000)] });
    const { table } = incomeStatementTable([col('This month', income()), col('Same month last year', yearAgo)], true);
    expect(table.headers).toEqual(['', 'This month', 'Same month last year', 'Change on last year']);
    expect(cells(table).find((r) => r[0] === '4100 Sales')).toEqual(['4100 Sales', 'R 120 000.00', 'R 100 000.00', 'R 20 000.00']);
  });

  it('a month with no account lines is empty, and prints only the bottom lines', () => {
    const zero = income({ revenue: [], costOfSales: [], operatingExpenses: [], totalRevenue: 0, totalCostOfSales: 0, totalOperatingExpenses: 0, grossProfit: 0, operatingProfit: 0, netProfit: 0 });
    const { table, empty } = incomeStatementTable([col('This month', zero)], false);
    expect(empty).toBe(true);
    expect(cells(table).map((r) => r[0])).toEqual(['Gross profit', 'Operating profit', 'Net profit']);
  });
});

describe('balanceSheetTable', () => {
  const sheet = (over: Partial<BalanceSheetReport> = {}): BalanceSheetReport => ({
    asAtDate: '2026-09-30',
    assets: [bs('1110', 'Bank', 44600)], liabilities: [], equity: [bs('3200', 'Retained Earnings', 44600)],
    totalAssets: 44600, totalLiabilities: 0, totalEquity: 44600, ...over,
  });

  it('prints assets, liabilities and equity as the report has them, and both sides of the equation', () => {
    const { table, empty } = balanceSheetTable([{ label: longDate('2026-09-30'), report: sheet() }], false);
    expect(empty).toBe(false);
    expect(table.headers).toEqual(['', '30 September 2026']);
    expect(cells(table)).toEqual([
      ['Assets', ''], ['1110 Bank', 'R 44 600.00'], ['Total assets', 'R 44 600.00'],
      ['Equity', ''], ['3200 Retained Earnings', 'R 44 600.00'], ['Total equity', 'R 44 600.00'],
      ['Total liabilities and equity', 'R 44 600.00'],
    ]);
  });

  it('a negative total prints with the minus sign', () => {
    const { table } = balanceSheetTable([{ label: 'x', report: sheet({ totalEquity: -5, equity: [bs('3200', 'RE', -5)] }) }], false);
    expect(cells(table).find((r) => r[0] === 'Total equity')?.[1]).toBe('−R 5.00');
  });
});

describe('longDate', () => {
  it('writes a date out, and leaves a non-date alone', () => {
    expect(longDate('2026-08-31')).toBe('31 August 2026');
    expect(longDate('n/a')).toBe('n/a');
  });
});
