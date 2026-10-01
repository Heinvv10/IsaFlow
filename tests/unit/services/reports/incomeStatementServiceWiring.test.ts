/**
 * The wiring between `fetchIncomeStatementRows` and the disclosure, over a
 * synthetic row set.
 *
 * WHY MOCKED AND NOT DB-GATED. Three single-line deletions in
 * `incomeStatementService.ts` silence the disclosure — the expense push, the
 * revenue push, and the line that puts it on the returned report. The DB-gated
 * suite catches the first and third, but not the second: the dev database CI
 * runs against has no unclassified revenue account (measured: 4 revenue
 * accounts, all classified), so no query over real data can observe it there.
 * A mock is the only thing that makes that deletion fail on every machine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...args: unknown[]) => sqlMock(...args) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';

/** One `GROUP BY` row as the service's query returns it. */
const glRow = (
  code: string,
  name: string,
  type: 'revenue' | 'expense',
  subtype: string | null,
  debit: number,
  credit: number,
) => ({
  account_code: code, account_name: name, account_type: type,
  account_subtype: subtype, total_debit: debit, total_credit: credit,
});

beforeEach(() => sqlMock.mockReset());

describe('getIncomeStatement — the disclosure reaches the report', () => {
  it('counts an unclassified expense AND an unclassified revenue account', async () => {
    sqlMock.mockResolvedValue([
      glRow('49784351', 'COS - Direct Material', 'expense', null, 46923976.23, 0),
      glRow('6000', 'Rent', 'expense', 'operating_expenses', 100000, 0),
      glRow('49784393', 'Contract Revenue', 'revenue', null, 0, 28438736.86),
      glRow('4000', 'Sales', 'revenue', 'revenue', 0, 5000000),
    ]);

    const report = await getIncomeStatement('c-1', '2026-01-01', '2026-12-31');
    const d = report.subtypeDisclosure;

    expect(d).toBeTruthy();
    expect(d!.expenseAccounts).toBe(1);
    expect(d!.expenseAmount).toBeCloseTo(46923976.23, 2);
    expect(d!.revenueAccounts).toBe(1);
    expect(d!.revenueAmount).toBeCloseTo(28438736.86, 2);
    // BOTH count towards the ceiling. This report has no other-income line, so
    // gross profit is revenue - costOfSales: an unclassified revenue account
    // that is really other income overstates gross profit one-for-one, exactly
    // as an unclassified expense that is really cost of sales does.
    expect(d!.grossProfitOverstatedByAtMost).toBeCloseTo(46923976.23 + 28438736.86, 2);
    // Nothing here is certain — both are conjecture until someone classifies.
    expect(d!.costOfSalesExposureAtMost).toBeCloseTo(46923976.23, 2);
    expect(d!.otherIncomeExposureAtMost).toBeCloseTo(28438736.86, 2);
  });

  it('puts the unclassified expense in operatingExpenses, which is the whole defect', async () => {
    sqlMock.mockResolvedValue([
      glRow('49784351', 'COS - Direct Material', 'expense', null, 46923976.23, 0),
      glRow('4000', 'Sales', 'revenue', 'revenue', 0, 48000000),
    ]);

    const report = await getIncomeStatement('c-1', '2026-01-01', '2026-12-31');
    expect(report.costOfSales).toHaveLength(0);
    expect(report.operatingExpenses.map(i => i.accountCode)).toContain('49784351');
    // Gross profit reads 97.7% margin; the disclosure is the only thing saying so.
    expect(report.grossProfit).toBeCloseTo(48000000, 2);
    expect(report.subtypeDisclosure!.grossProfitOverstatedByAtMost).toBeCloseTo(46923976.23, 2);
  });

  it('is null on a fully classified chart', async () => {
    sqlMock.mockResolvedValue([
      glRow('5000', 'Direct Material', 'expense', 'cost_of_sales', 1000, 0),
      glRow('4000', 'Sales', 'revenue', 'revenue', 0, 5000),
    ]);
    const report = await getIncomeStatement('c-1', '2026-01-01', '2026-12-31');
    expect(report.subtypeDisclosure).toBeNull();
    // The other half of the same claim: a RECOGNISED cost_of_sales must land
    // above the gross profit line. Nothing else in the suite asserts this, so
    // breaking the banding test itself would otherwise go unnoticed.
    expect(report.costOfSales.map(i => i.accountCode)).toContain('5000');
    expect(report.operatingExpenses).toHaveLength(0);
    expect(report.grossProfit).toBeCloseTo(4000, 2);
  });

  it('treats an unrecognised spelling as unclassified, exactly as the banding does', async () => {
    sqlMock.mockResolvedValue([
      glRow('2210', 'Other thing', 'expense', 'other', 5000, 0),
    ]);
    const report = await getIncomeStatement('c-1', '2026-01-01', '2026-12-31');
    expect(report.operatingExpenses.map(i => i.accountCode)).toContain('2210');
    expect(report.subtypeDisclosure!.expenseAccounts).toBe(1);
  });
});

describe('getIncomeStatement — the new bands reach the report', () => {
  it('applies the same business unit to current and comparative SQL', async () => {
    sqlMock.mockResolvedValue([]);
    const businessUnitId = '20000000-0000-4000-8000-000000000001';

    const report = await getIncomeStatement(
      'c-1',
      '2026-01-01',
      '2026-12-31',
      { businessUnitId },
      { start: '2025-01-01', end: '2025-12-31' },
    );

    expect(report.businessUnitId).toBe(businessUnitId);
    expect(sqlMock).toHaveBeenCalledTimes(2);
    for (const call of sqlMock.mock.calls) {
      expect(call.slice(1)).toContain(businessUnitId);
    }
  });

  it('reports other income on its own line, outside turnover and outside gross profit', async () => {
    sqlMock.mockResolvedValue([
      glRow('4000', 'Sales', 'revenue', 'revenue', 0, 5000000),
      glRow('4300', 'Other Income', 'revenue', 'other_income', 0, 53787.07),
    ]);
    const report = await getIncomeStatement('c-1', '2026-01-01', '2026-12-31');
    // B75: this used to read 5053787.07, and gross profit with it.
    expect(report.totalRevenue).toBeCloseTo(5000000, 2);
    expect(report.totalOtherIncome).toBeCloseTo(53787.07, 2);
    expect(report.grossProfit).toBeCloseTo(5000000, 2);
    // Correctly classified and correctly placed, so nothing to disclose.
    expect(report.subtypeDisclosure).toBeNull();
  });

  it('flags the platform default subtype on a system account', async () => {
    sqlMock.mockResolvedValue([
      glRow('5001', 'Cost of Goods Sold', 'expense', 'default_expense', 574253.66, 0),
      glRow('4000', 'Sales', 'revenue', 'revenue', 0, 13508486.83),
    ]);
    const report = await getIncomeStatement('c-1', '2026-01-01', '2026-12-31');
    // Brightsphere's shape: 100% margin, R0.00 cost of sales, and the account
    // named Cost of Goods Sold banded as an operating expense.
    expect(report.totalCostOfSales).toBe(0);
    expect(report.operatingExpenses.map(i => i.accountCode)).toContain('5001');
    expect(report.subtypeDisclosure!.grossProfitOverstatedByAtMost).toBeCloseTo(574253.66, 2);
  });

  it('gives the comparative period its own disclosure', async () => {
    sqlMock
      .mockResolvedValueOnce([glRow('5000', 'Expenses', 'expense', null, 1000, 0)])
      .mockResolvedValueOnce([glRow('5001', 'CoGS', 'expense', 'default_expense', 2000, 0)]);
    const report = await getIncomeStatement(
      'c-1', '2026-01-01', '2026-12-31', {}, { start: '2025-01-01', end: '2025-12-31' },
    );
    expect(report.subtypeDisclosure!.grossProfitOverstatedByAtMost).toBeCloseTo(1000, 2);
    // A variance column is a difference between two independently mis-banded
    // numbers; one banner over the current period does not qualify the prior.
    expect(report.priorSubtypeDisclosure!.grossProfitOverstatedByAtMost).toBeCloseTo(2000, 2);
  });

  it('includes prior-only accounts so comparative lines reconcile to prior totals', async () => {
    sqlMock
      .mockResolvedValueOnce([glRow('4000', 'Current Sales', 'revenue', 'revenue', 0, 20)])
      .mockResolvedValueOnce([
        glRow('4000', 'Current Sales', 'revenue', 'revenue', 0, 11),
        glRow('4100', 'Prior-only Sales', 'revenue', 'revenue', 0, 13),
      ]);

    const report = await getIncomeStatement(
      'c-1', '2026-01-01', '2026-12-31', {}, { start: '2025-01-01', end: '2025-12-31' },
    );

    expect(report.revenue).toEqual([
      expect.objectContaining({accountCode:'4000', amount:20, priorAmount:11}),
      expect.objectContaining({accountCode:'4100', amount:0, priorAmount:13, variance:-13}),
    ]);
    expect(report.revenue.reduce((sum, line) => sum + (line.priorAmount ?? 0), 0))
      .toBe(report.priorTotalRevenue);
  });
});
