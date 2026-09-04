// RED phase — written before the split
/**
 * The income statement and `aggregateFigures` must agree BAND FOR BAND.
 *
 * They did not. `getIncomeStatement` had no other-income line — every revenue
 * row landed in turnover — and no other-expense line, so finance cost and tax
 * sat inside operating expenses. `aggregateFigures` splits both. The two
 * therefore reported DIFFERENT gross profits, by exactly the other-income
 * total, while `mcp/contracts/figures.ts` asserted they "agree on the BOTTOM
 * LINE to the cent". That is true of net profit and false of gross, and the
 * page and the MCP `profit_and_loss` tool printed different numbers with
 * nothing saying so (finding B75).
 *
 * The net-profit invariant is what proves this is a RECLASSIFICATION and not a
 * restatement: moving other income below gross profit, and finance cost out of
 * operating expenses, must leave the bottom line untouched to the cent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import { aggregateFigures } from '@/modules/accounting/services/gl/accountClassification';

const glRow = (
  code: string, name: string, type: 'revenue' | 'expense',
  subtype: string | null, debit: number, credit: number,
) => ({
  account_code: code, account_name: name, account_type: type,
  account_subtype: subtype, total_debit: debit, total_credit: credit,
});

/** The same rows as `aggregateFigures` consumes them. */
const asClassificationRows = (rows: ReturnType<typeof glRow>[]) =>
  rows.map(r => ({
    account_type: r.account_type,
    account_subtype: r.account_subtype,
    debit: r.total_debit,
    credit: r.total_credit,
  }));

const CHART = [
  glRow('4000', 'Sales', 'revenue', 'revenue', 0, 5000000),
  glRow('4300', 'Interest Received', 'revenue', 'other_income', 0, 53787.07),
  glRow('5000', 'Direct Material', 'expense', 'cost_of_sales', 1800000, 0),
  glRow('6000', 'Rent', 'expense', 'operating_expenses', 400000, 0),
  glRow('5810', 'Interest Expense', 'expense', 'finance_cost', 120000, 0),
  glRow('5900', 'Income Tax', 'expense', 'tax_expense', 90000, 0),
];

beforeEach(() => sqlMock.mockReset());

describe('getIncomeStatement agrees with aggregateFigures', () => {
  it('agrees on every band, not just the bottom line', async () => {
    sqlMock.mockResolvedValue(CHART);
    const report = await getIncomeStatement('c-1', '2026-01-01', '2026-12-31');
    const figures = aggregateFigures(asClassificationRows(CHART));

    expect(report.totalRevenue).toBeCloseTo(figures.revenue, 2);
    expect(report.totalOtherIncome).toBeCloseTo(figures.otherIncome, 2);
    expect(report.totalCostOfSales).toBeCloseTo(figures.costOfSales, 2);
    expect(report.totalOperatingExpenses).toBeCloseTo(figures.operatingExpenses, 2);
    expect(report.totalOtherExpenses).toBeCloseTo(figures.otherExpenses, 2);
    expect(report.grossProfit).toBeCloseTo(figures.grossProfit, 2);
    // Operating profit too. A band with no counterpart on the other side is a
    // band that can silently re-diverge — an earlier cut of this change shipped
    // an operatingProfit that disagreed with `profit_and_loss` by exactly the
    // other-income total, which is the B75 defect one row down.
    expect(report.operatingProfit).toBeCloseTo(figures.operatingProfit, 2);
    expect(report.netProfit).toBeCloseTo(figures.netProfit, 2);
  });

  it('keeps other income OUT of turnover and out of gross profit', async () => {
    sqlMock.mockResolvedValue(CHART);
    const report = await getIncomeStatement('c-1', '2026-01-01', '2026-12-31');
    expect(report.totalRevenue).toBeCloseTo(5000000, 2);
    expect(report.revenue.map(i => i.accountCode)).not.toContain('4300');
    expect(report.otherIncome.map(i => i.accountCode)).toContain('4300');
    expect(report.grossProfit).toBeCloseTo(5000000 - 1800000, 2);
  });

  it('keeps finance cost and tax OUT of operating expenses', async () => {
    sqlMock.mockResolvedValue(CHART);
    const report = await getIncomeStatement('c-1', '2026-01-01', '2026-12-31');
    expect(report.totalOperatingExpenses).toBeCloseTo(400000, 2);
    expect(report.operatingExpenses.map(i => i.accountCode)).not.toContain('5810');
    expect(report.otherExpenses.map(i => i.accountCode)).toEqual(
      expect.arrayContaining(['5810', '5900']),
    );
  });

  it('leaves NET PROFIT untouched — this is a reclassification, not a restatement', async () => {
    sqlMock.mockResolvedValue(CHART);
    const report = await getIncomeStatement('c-1', '2026-01-01', '2026-12-31');
    // Bottom line under the OLD lumping: every credit less every debit.
    const oldNet = 5000000 + 53787.07 - 1800000 - 400000 - 120000 - 90000;
    expect(report.netProfit).toBeCloseTo(oldNet, 2);
  });

  it('puts other income ABOVE the operating line and finance cost/tax below it', async () => {
    sqlMock.mockResolvedValue(CHART);
    const report = await getIncomeStatement('c-1', '2026-01-01', '2026-12-31');
    // The operating line is the one finance cost and tax sit BELOW — which is
    // what `profit_and_loss`'s shipped description has always said.
    expect(report.operatingProfit).toBeCloseTo(
      report.grossProfit + report.totalOtherIncome - report.totalOperatingExpenses, 2);
    expect(report.netProfit).toBeCloseTo(report.operatingProfit - report.totalOtherExpenses, 2);
    // Excluding other income here would disagree with the MCP tool by exactly
    // the other-income total.
    expect(report.operatingProfit).not.toBeCloseTo(
      report.grossProfit - report.totalOperatingExpenses, 2);
  });

  it('agrees with the MCP tool formula for operating profit', async () => {
    sqlMock.mockResolvedValue(CHART);
    const report = await getIncomeStatement('c-1', '2026-01-01', '2026-12-31');
    const f = aggregateFigures(asClassificationRows(CHART));
    expect(report.operatingProfit).toBeCloseTo(
      f.revenue + f.otherIncome - f.costOfSales - f.operatingExpenses, 2);
  });

  it('agrees on a chart where nothing is classified', async () => {
    const bare = [
      glRow('4000', 'Sales', 'revenue', null, 0, 5000000),
      glRow('5000', 'Costs', 'expense', null, 1800000, 0),
    ];
    sqlMock.mockResolvedValue(bare);
    const report = await getIncomeStatement('c-1', '2026-01-01', '2026-12-31');
    const figures = aggregateFigures(asClassificationRows(bare));
    expect(report.grossProfit).toBeCloseTo(figures.grossProfit, 2);
    expect(report.netProfit).toBeCloseTo(figures.netProfit, 2);
    expect(report.totalOtherIncome).toBe(0);
    expect(report.totalOtherExpenses).toBe(0);
  });

  it('agrees for the comparative period too', async () => {
    sqlMock.mockResolvedValueOnce(CHART).mockResolvedValueOnce(CHART);
    const report = await getIncomeStatement(
      'c-1', '2026-01-01', '2026-12-31', {}, { start: '2025-01-01', end: '2025-12-31' });
    const figures = aggregateFigures(asClassificationRows(CHART));
    expect(report.priorGrossProfit).toBeCloseTo(figures.grossProfit, 2);
    expect(report.priorTotalOtherIncome).toBeCloseTo(figures.otherIncome, 2);
    expect(report.priorTotalOtherExpenses).toBeCloseTo(figures.otherExpenses, 2);
    expect(report.priorOperatingProfit).toBeCloseTo(figures.operatingProfit, 2);
  });
});

describe('the comparative carries every new band', () => {
  // Deleting priorOperatingProfit, or the mergeLineItems calls for the new
  // sections, left the whole suite green — and the page gates its prior column
  // on `priorOperatingProfit !== undefined`, so the comparative would vanish
  // with no test tell.
  const PRIOR = [
    glRow('4000', 'Sales', 'revenue', 'revenue', 0, 4000000),
    glRow('4300', 'Interest Received', 'revenue', 'other_income', 0, 40000),
    glRow('5000', 'Direct Material', 'expense', 'cost_of_sales', 1500000, 0),
    glRow('6000', 'Rent', 'expense', 'operating_expenses', 300000, 0),
    glRow('5810', 'Interest Expense', 'expense', 'finance_cost', 100000, 0),
  ];

  it('sets every prior total, including operating profit', async () => {
    sqlMock.mockResolvedValueOnce(CHART).mockResolvedValueOnce(PRIOR);
    const r = await getIncomeStatement(
      'c-1', '2026-01-01', '2026-12-31', {}, { start: '2025-01-01', end: '2025-12-31' });
    const f = aggregateFigures(asClassificationRows(PRIOR));
    expect(r.priorOperatingProfit).toBeCloseTo(f.operatingProfit, 2);
    expect(r.priorGrossProfit).toBeCloseTo(f.grossProfit, 2);
    expect(r.priorNetProfit).toBeCloseTo(f.netProfit, 2);
    expect(r.priorTotalOtherIncome).toBeCloseTo(40000, 2);
    expect(r.priorTotalOtherExpenses).toBeCloseTo(100000, 2);
  });

  it('merges prior amounts into the OTHER INCOME line items', async () => {
    sqlMock.mockResolvedValueOnce(CHART).mockResolvedValueOnce(PRIOR);
    const r = await getIncomeStatement(
      'c-1', '2026-01-01', '2026-12-31', {}, { start: '2025-01-01', end: '2025-12-31' });
    const oi = r.otherIncome.find(i => i.accountCode === '4300');
    expect(oi?.priorAmount).toBeCloseTo(40000, 2);
    expect(oi?.variance).toBeCloseTo(53787.07 - 40000, 2);
  });

  it('merges prior amounts into the OTHER EXPENSES line items', async () => {
    sqlMock.mockResolvedValueOnce(CHART).mockResolvedValueOnce(PRIOR);
    const r = await getIncomeStatement(
      'c-1', '2026-01-01', '2026-12-31', {}, { start: '2025-01-01', end: '2025-12-31' });
    const oe = r.otherExpenses.find(i => i.accountCode === '5810');
    expect(oe?.priorAmount).toBeCloseTo(100000, 2);
    expect(oe?.variance).toBeCloseTo(20000, 2);
    // 5900 Income Tax has no prior, so it must merge to a zero prior, not vanish.
    expect(r.otherExpenses.find(i => i.accountCode === '5900')?.priorAmount).toBe(0);
  });
});
