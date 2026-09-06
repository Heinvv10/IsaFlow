import { describe, it, expect } from 'vitest';
import { toIncomeStatementRows } from '@/modules/accounting/services/reports/statementRows/incomeStatementRows';
import type { IncomeStatementReport } from '@/modules/accounting/types/gl.report.types';

const line = (accountCode: string, accountName: string, amount: number, priorAmount?: number) =>
  ({ accountCode, accountName, amount, priorAmount, variance: priorAmount === undefined ? undefined : amount - priorAmount });

const R: IncomeStatementReport = {
  periodStart: '2026-01-01', periodEnd: '2026-12-31',
  revenue: [line('4000', 'Sales', 5000000, 4100000)],
  otherIncome: [line('4300', 'Interest Received', 53787.07, 40000)],
  costOfSales: [line('5000', 'Direct Material', 1800000, 1700000)],
  operatingExpenses: [line('6000', 'Rent', 400000, 380000)],
  otherExpenses: [line('5810', 'Interest Expense', 120000, 100000)],
  totalRevenue: 5000000, totalOtherIncome: 53787.07, totalCostOfSales: 1800000,
  totalOperatingExpenses: 400000, totalOtherExpenses: 120000,
  grossProfit: 3200000, operatingProfit: 2853787.07, netProfit: 2733787.07,
  priorTotalRevenue: 4100000, priorGrossProfit: 2400000, priorOperatingProfit: 2060000, priorNetProfit: 1960000,
  priorTotalOtherIncome: 40000, priorTotalCostOfSales: 1700000, priorTotalOperatingExpenses: 380000, priorTotalOtherExpenses: 100000,
  subtypeDisclosure: null, priorSubtypeDisclosure: null,
} as IncomeStatementReport;

const labels = (rows: ReturnType<typeof toIncomeStatementRows>) => rows.map(r => r.label);

describe('toIncomeStatementRows', () => {
  it('emits every band in reconciling order', () => {
    const l = labels(toIncomeStatementRows(R, { comparative: false }));
    const at = (s: string) => l.indexOf(s);
    expect(at('Turnover')).toBeGreaterThanOrEqual(0);
    expect(at('Cost of Sales')).toBeGreaterThan(at('Turnover'));
    expect(at('Gross Profit')).toBeGreaterThan(at('Cost of Sales'));
    expect(at('Other Income')).toBeGreaterThan(at('Gross Profit'));
    expect(at('Operating Expenses')).toBeGreaterThan(at('Other Income'));
    expect(at('Operating Profit')).toBeGreaterThan(at('Operating Expenses'));
    expect(at('Other Expenses')).toBeGreaterThan(at('Operating Profit'));
    expect(at('Net Profit / (Loss)')).toBeGreaterThan(at('Other Expenses'));
  });

  it('copies every figure from the report and derives none', () => {
    const rows = toIncomeStatementRows(R, { comparative: true });
    const reportNumbers = new Set<number>();
    const walk = (v: unknown) => {
      if (typeof v === 'number') reportNumbers.add(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(R);
    for (const row of rows) {
      expect(reportNumbers, `${row.label} actual`).toContain(row.actual);
      if (row.prior !== undefined) expect(reportNumbers, `${row.label} prior`).toContain(row.prior.value);
    }
  });

  it('pins every named total to the report field it must come from', () => {
    const rows = toIncomeStatementRows(R, { comparative: true });
    const at = (id: string) => rows.find(r => r.id === id)!;
    // Set membership is not enough: wiring Gross Profit to r.operatingProfit
    // leaves the "copies every figure" test above green.
    expect(at('sub:revenue').actual).toBe(R.totalRevenue);
    expect(at('sub:costOfSales').actual).toBe(R.totalCostOfSales);
    expect(at('total:grossProfit').actual).toBe(R.grossProfit);
    expect(at('sub:otherIncome').actual).toBe(R.totalOtherIncome);
    expect(at('sub:operatingExpenses').actual).toBe(R.totalOperatingExpenses);
    expect(at('total:operatingProfit').actual).toBe(R.operatingProfit);
    expect(at('sub:otherExpenses').actual).toBe(R.totalOtherExpenses);
    expect(at('grand:netProfit').actual).toBe(R.netProfit);
    expect(at('total:grossProfit').prior?.value).toBe(R.priorGrossProfit);
    expect(at('total:operatingProfit').prior?.value).toBe(R.priorOperatingProfit);
    expect(at('grand:netProfit').prior?.value).toBe(R.priorNetProfit);
  });

  it('omits Other Income and Other Expenses sections when empty', () => {
    const l = labels(toIncomeStatementRows({ ...R, otherIncome: [], otherExpenses: [], totalOtherIncome: 0, totalOtherExpenses: 0 }, { comparative: false }));
    expect(l).not.toContain('Other Income');
    expect(l).not.toContain('Other Expenses');
    expect(l).toContain('Operating Profit');
  });

  it('names its comparator: every movement hangs off `prior`, never a bare field', () => {
    const rows = toIncomeStatementRows(R, { comparative: true });
    const sales = rows.find(r => r.accountCode === '4000')!;
    // A budget column must be addable without renaming any of these. That is
    // the whole point of the Comparison shape. variancePct is computed by
    // baseComparison from variance and value (900000 / 4100000 * 100), not
    // passed through from the report — see comparators.ts.
    expect(sales.prior).toEqual({
      value: 4100000, variance: 900000, variancePct: 900000 / 4100000 * 100, favourable: true,
    });
    expect(sales.budget).toBeUndefined();
  });

  it('marks favourability by sign convention: revenue up is good, expense up is bad', () => {
    const rows = toIncomeStatementRows(R, { comparative: true });
    expect(rows.find(r => r.accountCode === '4000')?.prior?.favourable).toBe(true);
    expect(rows.find(r => r.accountCode === '6000')?.prior?.favourable).toBe(false);
  });

  it('carries no prior or variance when comparative is off', () => {
    const rows = toIncomeStatementRows(R, { comparative: false });
    expect(rows.every(r => r.prior === undefined)).toBe(true);
  });

  it('gives line rows the account code and depth 1; totals depth 0 and no code', () => {
    const rows = toIncomeStatementRows(R, { comparative: false });
    const sales = rows.find(r => r.accountCode === '4000')!;
    expect(sales.kind).toBe('line'); expect(sales.depth).toBe(1);
    const np = rows.find(r => r.id === 'grand:netProfit')!;
    expect(np.kind).toBe('grand'); expect(np.depth).toBe(0); expect(np.accountCode).toBeUndefined();
  });
});
