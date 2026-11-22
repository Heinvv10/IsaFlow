/**
 * Review L4 of f37f0f15a6: calculate_pay_run returns a named off-cycle refusal's code (TERMINATION_REASON_MISSING), as
 * the calculate route does in details.refusal, so an agent can act on it; an unnamed refusal stays plain text.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/payrollLoanWithholding', () => ({ withheldLoansReport: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/payroll/payrollRunService', () => ({ calculatePayrollRun: vi.fn(), getPayrollRun: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollApprovalService', () => ({ approvePayrollRun: vi.fn(), previewPayrollApproval: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollPreparerGuard', async (orig) => ({
  ...await orig<object>(), assertPreparerSupported: vi.fn(async () => undefined),
}));
// The dry run's reads (review L4 of e8a2d72dbc): the run's row, then its off-cycle employees, which refuse.
vi.mock('@/lib/neon', async (orig) => ({ ...await orig<object>(), sql: vi.fn(async () => [{ id: 'r', run_kind: 'off_cycle', pay_frequency: 'monthly', period_month: 11, period_year: 2026 }]) }));
vi.mock('@/modules/accounting/services/payroll/payrollOffCyclePopulation', async (orig) => ({
  ...await orig<object>(), listOffCycleEmployees: vi.fn(),
}));
vi.mock('@/modules/accounting/services/payroll/payrollRunKindGuard', async (orig) => ({
  ...await orig<object>(), assertRunKindSupported: vi.fn(async () => undefined),
}));

import { calculatePayrollRun, getPayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { OffCycleRunRefusedError } from '@/modules/accounting/services/payroll/payrollOffCycleRun';
import { calculatePayRunTool } from '@/lib/mcp/tools/writePayrollRun';
import { listOffCycleEmployees } from '@/modules/accounting/services/payroll/payrollOffCyclePopulation';

const RUN = '22222222-2222-4222-8222-222222222222';
const call = () => calculatePayRunTool.handler({ run_id: RUN, idempotency_key: 'k' }, { companyId: 'c', userId: 'u' } as never);

describe('calculate_pay_run: an off-cycle refusal', () => {
  it('names its refusal code', async () => {
    vi.mocked(getPayrollRun).mockResolvedValue({ id: RUN, status: 'draft', periodMonth: 11, periodYear: 2026, runKind: 'off_cycle' } as never);
    vi.mocked(calculatePayrollRun).mockRejectedValue(new OffCycleRunRefusedError('Ruby (E1): leaving with no termination reason', 409, 'TERMINATION_REASON_MISSING'));
    const r = await call();
    expect(r.isError).toBe(true);
    // As the calculate route answers it (review L3 of e8a2d72dbc): 409 CONFLICT, details { code, refusal }.
    const body = JSON.parse(r.content[0]!.text) as { error: { code: string; message: string; details: { code: string; refusal: string } } };
    expect(body.error).toMatchObject({ code: 'CONFLICT', details: { code: 'OFF_CYCLE_RUN_REFUSED', refusal: 'TERMINATION_REASON_MISSING' } });
    expect(body.error.message).toMatch(/no termination reason/);
  });
  it('an unnamed refusal stays its message', async () => {
    vi.mocked(calculatePayrollRun).mockRejectedValue(new OffCycleRunRefusedError('paid after the close', 409));
    const r = await call();
    expect(r.content[0]!.text).toBe('paid after the close');
  });
  it('the dry run names it too, when the off-cycle employees refuse (review L4 of e8a2d72dbc)', async () => {
    vi.mocked(getPayrollRun).mockResolvedValue({ id: RUN, status: 'draft', periodMonth: 11, periodYear: 2026, runKind: 'off_cycle', payFrequency: 'monthly' } as never);
    vi.mocked(listOffCycleEmployees).mockRejectedValue(new OffCycleRunRefusedError('Ruby (E1): leaving with no termination reason', 409, 'TERMINATION_REASON_MISSING'));
    const r = await calculatePayRunTool.handler({ run_id: RUN, dry_run: true, idempotency_key: 'k' }, { companyId: 'c', userId: 'u' } as never);
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text).error).toMatchObject({ code: 'CONFLICT', details: { refusal: 'TERMINATION_REASON_MISSING' } });
  });
});
