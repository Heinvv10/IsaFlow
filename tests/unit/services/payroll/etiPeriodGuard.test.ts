/**
 * Hein ruling R-A (wave 5 ET round 1): no approve, reopen or recalculation of a month while a LATER month of the same
 * ETI period (March-August, September-February; Fourth Schedule para 14(3)(a), ETI Act s9(1) and s10) has a posted run
 * journal. The guard, and the recalculation and reopen that call it (the approval gate returns it as a blocker).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/payroll/payrollRunLoanComponents', () => ({
  appendLoanComponents: (components: unknown[]) => components,
  loadLoanComponents: async () => ({ deduction: { id: 'loan' }, fringe: { id: 'fringe' } }),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({
  isPayrollRunLocked: () => false,
  lockCompanyPayrollApprovals: vi.fn(),
  lockPayrollRunHeader: vi.fn(),
  PayrollRunLockedError: class extends Error {},
  REOPENABLE_STATUSES: new Set(['approved']),
  saveCalculatedRunTotals: vi.fn(),
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunLoanApplication', () => ({ applyRunLoans: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeService', () => ({
  listPayrollRunEmployees: vi.fn(async () => []),
  listTaxNumbersForCompany: vi.fn(async () => []),
}));

import { sql } from '@/lib/neon';
import { lockPayrollRunHeader } from '@/modules/accounting/services/payroll/payrollRunLock';
import { applyRunLoans } from '@/modules/accounting/services/payroll/payrollRunLoanApplication';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { reopenPayrollRun } from '@/modules/accounting/services/payroll/payrollRunReopen';
import {
  EtiLaterMonthPostedError, laterEtiJournalRefusal, reconciliationEnd,
} from '@/modules/accounting/services/payroll/etiPeriodGuard';

const CO = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const postedLater = (year: number, month: number) => vi.mocked(sql).mockResolvedValueOnce([{ period_year: year, period_month: month }] as never);

beforeEach(() => vi.clearAllMocks());

describe('the guard', () => {
  it('the period ends in August or February', () => {
    expect(reconciliationEnd({ year: 2026, month: 5 })).toEqual({ year: 2026, month: 8 });
    expect(reconciliationEnd({ year: 2026, month: 10 })).toEqual({ year: 2027, month: 2 });
    expect(reconciliationEnd({ year: 2027, month: 1 })).toEqual({ year: 2027, month: 2 });
  });
  it('names the posted later month, and asks within this month\'s period only, company-scoped', async () => {
    postedLater(2026, 6);
    const r = await laterEtiJournalRefusal(CO, { year: 2026, month: 5 });
    expect(r).toMatch(/June 2026 payroll journal is already posted/);
    expect(r).toMatch(/May 2026/);
    const call = vi.mocked(sql).mock.calls[0]!;
    const q = (call[0] as TemplateStringsArray).join('?');
    expect(q).toContain('h.company_id = ?::UUID');
    expect(q).toContain('h.journal_entry_id IS NOT NULL');
    expect(call.slice(1)).toEqual([CO, 2026, 5, 2026, 8]);
  });
  it('nothing later posted: no refusal', async () => {
    expect(await laterEtiJournalRefusal(CO, { year: 2026, month: 5 })).toBeNull();
  });
});

describe('its callers', () => {
  it('a recalculation of May is refused (409) before loans are applied when June is posted', async () => {
    vi.mocked(lockPayrollRunHeader).mockResolvedValueOnce({ id: RUN, company_id: CO, status: 'calculated', period_month: 5, period_year: 2026 } as never);
    postedLater(2026, 6);
    const err = await calculatePayrollRun(RUN, CO).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EtiLaterMonthPostedError);
    expect((err as EtiLaterMonthPostedError).status).toBe(409);
    expect(applyRunLoans).not.toHaveBeenCalled();
  });
  it('a reopen of May is refused before its UPDATE when June is posted', async () => {
    vi.mocked(lockPayrollRunHeader).mockResolvedValueOnce({ id: RUN, company_id: CO, status: 'approved', period_month: 5, period_year: 2026 } as never);
    postedLater(2026, 6);
    await expect(reopenPayrollRun({ runId: RUN, companyId: CO, userId: 'u', reason: 'fix May hours' })).rejects.toThrow(/June 2026/);
    expect(vi.mocked(sql).mock.calls.some((c) => (c[0] as TemplateStringsArray).join('?').includes('UPDATE payroll_run_headers'))).toBe(false);
  });
});
