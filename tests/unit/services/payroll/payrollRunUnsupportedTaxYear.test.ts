/**
 * P1: a run in a tax year with no loaded tables is refused up front.
 *
 * getTaxYearConfig used to fall back to the latest year, so a March 2027 run
 * was costed on 2026/27 figures with nothing said. It now throws, and
 * calculatePayrollRun must raise it BEFORE applyRunLoans (which commits loan
 * deductions in its own locked transaction) and before any line is built, so
 * a refusal leaves nothing half-written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({
  isPayrollRunLocked: () => false,
  lockCompanyPayrollApprovals: vi.fn(),
  lockPayrollRunHeader: vi.fn(),
  PayrollRunLockedError: class extends Error {},
  saveCalculatedRunTotals: vi.fn(),
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunLoanApplication', () => ({
  applyRunLoans: vi.fn(),
}));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeService', () => ({
  listPayrollRunEmployees: vi.fn(async () => []),
  listTaxNumbersForCompany: vi.fn(async () => []),
}));
vi.mock('@/modules/accounting/services/payroll/payrollJournalChain', () => ({
  journalInForceOrNull: vi.fn(async () => null),
}));

import { sql, withTransaction } from '@/lib/neon';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { lockPayrollRunHeader } from '@/modules/accounting/services/payroll/payrollRunLock';
import { applyRunLoans } from '@/modules/accounting/services/payroll/payrollRunLoanApplication';
import { listPayrollRunEmployees } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { UnsupportedTaxYearError } from '@/modules/accounting/services/payroll/taxTables';

const RUN = '22222222-2222-4222-8222-222222222222';
const CO = '11111111-1111-4111-8111-111111111111';

function lockRun(month: number, year: number) {
  vi.mocked(lockPayrollRunHeader).mockResolvedValueOnce({
    id: RUN, company_id: CO, status: 'draft', period_month: month, period_year: year,
  } as never);
}

beforeEach(() => vi.clearAllMocks());

describe('calculatePayrollRun - tax year not loaded', () => {
  it('refuses March 2027 (tax year 2028) before loans or lines are touched', async () => {
    lockRun(3, 2027);

    await expect(calculatePayrollRun(RUN, CO)).rejects.toBeInstanceOf(UnsupportedTaxYearError);

    expect(applyRunLoans).not.toHaveBeenCalled();
    expect(listPayrollRunEmployees).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
    expect(sql).not.toHaveBeenCalled();
  });

  it('names the tax year in the message', async () => {
    lockRun(3, 2027);
    await expect(calculatePayrollRun(RUN, CO)).rejects.toThrow(/tax year 2028/);
  });

  it('refuses a period before the earliest loaded tax year', async () => {
    lockRun(1, 2024);
    await expect(calculatePayrollRun(RUN, CO)).rejects.toThrow(/tax year 2024/);
    expect(applyRunLoans).not.toHaveBeenCalled();
  });

  it('goes on to apply loans for a loaded year (February 2027 is tax year 2027)', async () => {
    lockRun(2, 2027);
    vi.mocked(applyRunLoans).mockRejectedValueOnce(new Error('stop here'));

    await expect(calculatePayrollRun(RUN, CO)).rejects.toThrow('stop here');
    expect(applyRunLoans).toHaveBeenCalledTimes(1);
  });
});
