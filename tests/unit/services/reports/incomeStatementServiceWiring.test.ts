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
    expect(d!.grossProfitOverstatedByAtMost).toBeCloseTo(46923976.23, 2);
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
