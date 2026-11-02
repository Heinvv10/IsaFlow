/**
 * calculate_pay_run's dry run answers a locked run the way the live call does: calculatePayrollRun refuses
 * it before anything else, so the dry run reports that refusal alone, without asking about journals, loans
 * or the tax year.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/payroll/payrollLoanWithholding', () => ({ withheldLoansReport: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/payroll/payrollRunService', () => ({ calculatePayrollRun: vi.fn(), getPayrollRun: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollJournalChain', () => ({ payrollJournalInForce: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/payroll/payrollApprovalService', () => ({ approvePayrollRun: vi.fn(), previewPayrollApproval: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollRunLoanApplication', async (orig) => ({
  ...await orig<Record<string, unknown>>(),
  runHasLoanWork: vi.fn(async () => true),
}));

import { getPayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { payrollJournalInForce } from '@/modules/accounting/services/payroll/payrollJournalChain';
import { PayrollRunLockedError } from '@/modules/accounting/services/payroll/payrollRunLock';
import { calculatePayRunTool } from '@/lib/mcp/tools/writePayrollRun';

const RUN = '22222222-2222-4222-8222-222222222222';

describe('calculate_pay_run dry run on a locked run', () => {
  it('reports the lock alone and asks about nothing else', async () => {
    vi.mocked(getPayrollRun).mockResolvedValue({
      id: RUN, companyId: 'c', periodMonth: 3, periodYear: 2031, status: 'approved', journalEntryId: 'j1',
      totalGross: 0, totalPaye: 0, totalUif: 0, totalSdl: 0, totalEti: 0, totalNet: 0, employeeCount: 0,
    } as never);
    const r = await calculatePayRunTool.handler({ run_id: RUN, dry_run: true, idempotency_key: 'k' }, { companyId: 'c', userId: 'u' } as never);
    const out = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    expect(out.skipped).toEqual([new PayrollRunLockedError('approved').message]);
    expect(out.effects).toEqual([]);
    expect(out.withheld_loans).toEqual([]);
    expect(payrollJournalInForce).not.toHaveBeenCalled();
  });
});

describe('calculate_pay_run dry run on a tax year with no tables', () => {
  it('reports that refusal alone: the live call refuses it before any loan or journal work', async () => {
    vi.mocked(payrollJournalInForce).mockClear();
    vi.mocked(getPayrollRun).mockResolvedValue({
      id: RUN, companyId: 'c', periodMonth: 3, periodYear: 2031, status: 'calculated', journalEntryId: 'j1',
      totalGross: 0, totalPaye: 0, totalUif: 0, totalSdl: 0, totalEti: 0, totalNet: 0, employeeCount: 0,
    } as never);
    const r = await calculatePayRunTool.handler({ run_id: RUN, dry_run: true, idempotency_key: 'k' }, { companyId: 'c', userId: 'u' } as never);
    const out = JSON.parse(r.content[0]!.text) as { skipped: string[]; effects: unknown[] };
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toContain('2032');
    expect(out.effects).toEqual([]);
    expect(payrollJournalInForce).not.toHaveBeenCalled();
  });
});
