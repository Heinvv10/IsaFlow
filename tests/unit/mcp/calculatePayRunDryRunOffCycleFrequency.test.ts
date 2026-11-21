/**
 * Review #1679 codex N7: calculate_pay_run's dry run on an off-cycle run asks the frequency guard about the run's own
 * employees (payroll_off_cycle_employees, listOffCycleEmployees), exactly as calculatePayrollRun does, never about
 * every monthly employee: an unrelated employee's frequency change must not refuse the preview.
 */
import { describe, expect, it, vi } from 'vitest';

const ROW = { id: 'run', company_id: 'c', run_kind: 'off_cycle', off_cycle_reason: 'bonus', pay_frequency: 'monthly', period_month: 11, period_year: 2026 };
vi.mock('@/lib/neon', async (orig) => ({ ...await orig<object>(), sql: vi.fn(async () => [ROW]) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/payrollRunKindGuard', async (orig) => ({
  ...await orig<object>(), assertRunKindSupported: vi.fn(async () => undefined),
}));
vi.mock('@/modules/accounting/services/payroll/payrollPreparerGuard', async (orig) => ({
  ...await orig<object>(), assertPreparerSupported: vi.fn(async () => undefined),
}));
vi.mock('@/modules/accounting/services/payroll/payrollFrequencyGuard', async (orig) => ({
  ...await orig<object>(), frequencyRunOf: vi.fn(() => ({ frequency: 'monthly' })), assertFrequencyCostable: vi.fn(async () => undefined),
}));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeService', async (orig) => ({
  ...await orig<object>(), listPayrollRunEmployees: vi.fn(async () => [{ id: 'all-1' }, { id: 'all-2' }, { id: 'chosen' }]),
}));
vi.mock('@/modules/accounting/services/payroll/payrollOffCyclePopulation', async (orig) => ({
  ...await orig<object>(), listOffCycleEmployees: vi.fn(async () => [{ id: 'chosen' }]),
}));
vi.mock('@/modules/accounting/services/payroll/payrollOffCycleRun', async (orig) => ({
  ...await orig<object>(), assertOffCycleBeforeClose: vi.fn(async () => undefined),
}));
vi.mock('@/modules/accounting/services/payroll/payrollLoanWithholding', () => ({ withheldLoansReport: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/payroll/payrollRunService', () => ({ calculatePayrollRun: vi.fn(), getPayrollRun: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollJournalChain', () => ({ payrollJournalInForce: vi.fn(async () => false) }));
vi.mock('@/modules/accounting/services/payroll/payrollApprovalService', () => ({ approvePayrollRun: vi.fn(), previewPayrollApproval: vi.fn() }));

import { getPayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { assertFrequencyCostable } from '@/modules/accounting/services/payroll/payrollFrequencyGuard';
import { calculatePayRunTool } from '@/lib/mcp/tools/writePayrollRun';

describe('calculate_pay_run dry run on an off-cycle run', () => {
  it('asks the frequency guard about the run\'s chosen employees only', async () => {
    vi.mocked(getPayrollRun).mockResolvedValue({
      id: 'run', companyId: 'c', periodMonth: 11, periodYear: 2026, status: 'calculated', journalEntryId: null, payFrequency: 'monthly',
      runKind: 'off_cycle', totalGross: 0, totalPaye: 0, totalUif: 0, totalSdl: 0, totalEti: 0, totalNet: 0, employeeCount: 1,
    } as never);
    const r = await calculatePayRunTool.handler({ run_id: '22222222-2222-4222-8222-222222222222', dry_run: true, idempotency_key: 'k' },
      { companyId: 'c', userId: 'u' } as never);
    expect(JSON.parse(r.content[0]!.text).dryRun).toBe(true);
    expect(vi.mocked(assertFrequencyCostable)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(assertFrequencyCostable).mock.calls[0]![2]).toEqual(['chosen']);
  });
});
