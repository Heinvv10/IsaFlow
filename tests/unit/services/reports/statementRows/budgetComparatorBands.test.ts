/**
 * The statement Budget column beyond account rows (budgets P3 PR-C, review r1 R6/R7, browser F1/F3/F6,
 * arch M2): lines without a budget print absent with the engine's reason; an unspent budgeted
 * account gets its row; band and profit rows take the ENGINE's band budget, absent when it is null.
 */
import { describe, expect, it } from 'vitest';
import { applyBudgetComparator } from '@/modules/accounting/services/reports/statementRows/comparators';
import { applyBudgetBands, withBudgetedLines } from '@/modules/accounting/services/reports/statementRows/budgetComparatorBands';
import { toIncomeStatementRows } from '@/modules/accounting/services/reports/statementRows/incomeStatementRows';
import type { TrackedLine } from '@/modules/accounting/services/reports/budgetVarianceTracked';
import type { IncomeStatementReport } from '@/modules/accounting/types/gl.report.types';

const item = (accountCode: string, accountName: string, amount: number) => ({ accountCode, accountName, amount }) as IncomeStatementReport['revenue'][number];
const REPORT = {
  periodStart: '2026-09-01', periodEnd: '2026-09-30',
  revenue: [item('4100', 'Sales', 1000)], otherIncome: [], costOfSales: [], operatingExpenses: [item('5200', 'Wages', 600)], otherExpenses: [],
  totalRevenue: 1000, totalOtherIncome: 0, totalCostOfSales: 0, totalOperatingExpenses: 600, totalOtherExpenses: 0,
  grossProfit: 1000, operatingProfit: 400, netProfit: 400,
} as unknown as IncomeStatementReport;

const tracked = (code: string, name: string, band: TrackedLine['band'], verdict: TrackedLine['budget_verdict'], budget: number, actual: number): TrackedLine => ({
  account_id: `id-${code}`, account_code: code, account_name: name, account_type: band === 'turnover' || band === 'other_income' ? 'revenue' : 'expense',
  budgeted: verdict === 'budgeted', budget_amount: verdict === 'budgeted' ? budget : 0, actual_amount: actual,
  variance: 0, movement: 0, variance_pct: null, movement_pct: null, favourable: null, budget_verdict: verdict, band,
});

describe('applyBudgetComparator with the engine verdicts', () => {
  const rows = () => toIncomeStatementRows({
    ...REPORT, operatingExpenses: [item('5200', 'Wages', 600), item('5300', 'Rent', 50), item('5400', 'Fuel', 20)],
  }, { comparative: false });
  it('a budgeted zero is a figure; unbudgeted is absent with no reason; partial and above-filter carry theirs', () => {
    const out = applyBudgetComparator(rows(), [
      tracked('4100', 'Sales', 'turnover', 'budgeted', 0, 1000),
      tracked('5200', 'Wages', 'operating_expense', 'unbudgeted', 0, 600),
      tracked('5300', 'Rent', 'operating_expense', 'partial', 0, 50),
      tracked('5400', 'Fuel', 'operating_expense', 'above-filter', 0, 20),
    ]);
    const b = (code: string) => out.find((r) => r.accountCode === code)!.budget;
    expect(b('4100')).toMatchObject({ value: 0, variance: 1000 });
    expect(b('4100')!.absent).toBeUndefined();
    expect(b('5200')).toEqual({ value: 0, absent: true });
    expect(b('5300')).toEqual({ value: 0, absent: true, absentReason: 'partial' });
    expect(b('5400')).toEqual({ value: 0, absent: true, absentReason: 'above-filter' });
  });

  it('a statement row the comparator does not name (no budget, no actual) prints absent too', () => {
    const out = applyBudgetComparator(rows(), [tracked('4100', 'Sales', 'turnover', 'budgeted', 900, 1000)]);
    expect(out.find((r) => r.accountCode === '5300')!.budget).toEqual({ value: 0, absent: true });
  });

  it("P0's lines (no verdict) leave an unbudgeted row's cells empty, as before", () => {
    const p0 = { ...tracked('5200', 'Wages', 'operating_expense', 'unbudgeted', 0, 600) } as Partial<TrackedLine>;
    delete p0.budget_verdict;
    const out = applyBudgetComparator(rows(), [p0 as TrackedLine]);
    expect(out.find((r) => r.accountCode === '5200')!.budget).toBeUndefined();
  });
});

describe('withBudgetedLines: an unspent budget is on the statement', () => {
  it('adds the budgeted account with no actual inside its section, above the section total', () => {
    const out = withBudgetedLines(toIncomeStatementRows(REPORT, { comparative: false }), [
      tracked('5250', 'Training', 'operating_expense', 'budgeted', 300, 0),
      tracked('5300', 'Rent', 'operating_expense', 'partial', 0, 0),
    ]);
    const ids = out.map((r) => r.id);
    expect(ids.slice(ids.indexOf('sec:operatingExpenses'), ids.indexOf('sub:operatingExpenses') + 1))
      .toEqual(['sec:operatingExpenses', 'acc:5200', 'acc:5250', 'sub:operatingExpenses']);
    expect(out.find((r) => r.id === 'acc:5250')).toMatchObject({ kind: 'line', label: 'Training', actual: 0, depth: 1 });
    // A partial account is not added: it has no figure to show.
    expect(ids).not.toContain('acc:5300');
  });

  it('adds a missing band section (cost of sales) with a zero header and total, before gross profit', () => {
    const out = withBudgetedLines(toIncomeStatementRows(REPORT, { comparative: false }), [tracked('5010', 'Goods', 'cost_of_sales', 'budgeted', 80, 0)]);
    const ids = out.map((r) => r.id);
    expect(ids.slice(ids.indexOf('sub:revenue') + 1, ids.indexOf('total:grossProfit') + 1))
      .toEqual(['sec:costOfSales', 'acc:5010', 'sub:costOfSales', 'total:grossProfit']);
    expect(out.find((r) => r.id === 'sub:costOfSales')).toMatchObject({ kind: 'subtotal', label: 'Total Cost of Sales', actual: 0 });
  });

  it('leaves rows untouched when every budgeted account is listed', () => {
    const rows = toIncomeStatementRows(REPORT, { comparative: false });
    expect(withBudgetedLines(rows, [tracked('4100', 'Sales', 'turnover', 'budgeted', 900, 1000)])).toBe(rows);
  });
});

describe('applyBudgetBands: the engine band budgets, never a sum of lines', () => {
  it('copies each band and profit total, movement from the printed actual, favourable by polarity', () => {
    const out = applyBudgetBands(toIncomeStatementRows(REPORT, { comparative: false }), [
      // A sentinel: the turnover band is NOT the sum of any line here.
      { key: 'turnover', budget: 1234 }, { key: 'gross_profit', budget: 1234 },
      { key: 'operating_expense', budget: 500 }, { key: 'operating_profit', budget: 734 }, { key: 'net_profit', budget: 734 },
    ]);
    const b = (id: string) => out.find((r) => r.id === id)!.budget;
    expect(b('sub:revenue')).toMatchObject({ value: 1234, variance: -234, favourable: false });
    expect(b('sub:operatingExpenses')).toMatchObject({ value: 500, variance: 100, favourable: false });
    expect(b('grand:netProfit')).toMatchObject({ value: 734, variance: -334, favourable: false });
    // A section head carries no budget; neither does a line.
    expect(b('sec:revenue')).toBeUndefined();
    expect(b('acc:4100')).toBeUndefined();
  });

  it('a null band budget (a partial line under it, or no window budget) prints absent', () => {
    const out = applyBudgetBands(toIncomeStatementRows(REPORT, { comparative: false }), [
      { key: 'turnover', budget: 900 }, { key: 'operating_expense', budget: null }, { key: 'net_profit', budget: null },
    ]);
    expect(out.find((r) => r.id === 'sub:operatingExpenses')!.budget).toEqual({ value: 0, absent: true });
    expect(out.find((r) => r.id === 'grand:netProfit')!.budget).toEqual({ value: 0, absent: true });
    expect(out.find((r) => r.id === 'total:operatingProfit')!.budget).toBeUndefined();
  });
});
